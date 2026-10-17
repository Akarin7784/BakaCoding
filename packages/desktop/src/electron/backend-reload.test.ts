// T-093：backend:reload / backend:reconnect——空闲时同仓库停起、有在途单排队、合并重复请求、失败退只读、预算恢复。
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DefaultDepsHandle } from "@bakacoding/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../shared/api.js";
import {
  countRunning,
  NotifyBuffer,
  startBackend,
  type BackendHandle,
  type BackendMode,
} from "./backend.js";
import { BackendSwitcher, readonlyBackend } from "./backend-switcher.js";
import { serveBackendReload, type IpcMainLike } from "./ipc.js";

const examplePath = fileURLToPath(
  new URL("../../../../config/models.example.json", import.meta.url),
);
const pricingPath = fileURLToPath(new URL("../../../../config/pricing.json", import.meta.url));

let dirs: string[] = [];
const switchers: BackendSwitcher[] = [];
afterEach(async () => {
  for (const s of switchers.splice(0)) await s.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function fake(repo: string, opts: { mode?: BackendMode; reason?: string; running?: number } = {}) {
  const buf = new NotifyBuffer(200);
  const state = { running: opts.running ?? 0 };
  const stop = vi.fn(async () => {});
  const handle = {
    status: () => ({
      mode: opts.mode ?? "live",
      ...(opts.reason !== undefined && { reason: opts.reason }),
    }),
    markRendererReady: () => buf.markReady(),
    onNotify: (l: Parameters<BackendHandle["onNotify"]>[0]) => buf.onNotify(l),
    onPendingHighRisk: () => () => {},
    busyCount: () => state.running,
    runningCount: () => state.running,
    repoRoot: () => repo,
    stop,
  } as unknown as BackendHandle;
  return { handle, state, stop };
}

function make(current: BackendHandle, start: (repo: string) => Promise<BackendHandle>, env = {}) {
  const sw = new BackendSwitcher(current, start, env, { reloadPollMs: 5 });
  switchers.push(sw);
  return sw;
}

describe("countRunning（T-093）", () => {
  it("编码 / 评审 / 重写 / 重新评审 / 合并队列 / 冲突算在途；pending 与终态不算；高风险待裁决并集去重", () => {
    const tickets = [
      "pending",
      "coding",
      "in_review",
      "resubmitting",
      "re_reviewing",
      "merge_queued",
      "conflict",
      "merged",
      "escalated",
    ].map((status, i) => ({ ticket_id: `T${i}`, status }));
    expect(countRunning(tickets, [])).toBe(6);
    expect(countRunning(tickets, ["T5", "X"])).toBe(7);
    expect(countRunning([{ ticket_id: "a", status: null }], [])).toBe(0);
  });
});

describe("BackendSwitcher.reload（T-093）", () => {
  it("空闲：拆旧、在同一仓库重新组装，返回 reloaded，onSwap 触发", async () => {
    const old = fake("/repo-a");
    const next = fake("/repo-a");
    const start = vi.fn(async () => next.handle);
    const sw = make(old.handle, start);
    const swapped = vi.fn();
    sw.onSwap(swapped);
    await expect(sw.reload()).resolves.toEqual({ state: "reloaded" });
    expect(old.stop).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith("/repo-a");
    expect(swapped).toHaveBeenCalledTimes(1);
    expect(sw.status()).toEqual({ mode: "live" });
  });

  it("重载前渲染已就绪：重建后新后端的通知直接送达", async () => {
    const old = fake("/r");
    const buf = new NotifyBuffer(200);
    const next = {
      ...fake("/r").handle,
      onNotify: buf.onNotify.bind(buf),
      markRendererReady: () => buf.markReady(),
    } as BackendHandle;
    const sw = make(old.handle, async () => next);
    sw.markRendererReady();
    const got = vi.fn();
    sw.onNotify(got);
    await sw.reload();
    buf.push({ text: "hi" });
    expect(got).toHaveBeenCalledWith({ text: "hi" });
  });

  it("有在途单：排队返回 queued 与张数，不拆旧；最后一张跑完后自动重载", async () => {
    const old = fake("/r", { running: 2 });
    const next = fake("/r");
    const start = vi.fn(async () => next.handle);
    const sw = make(old.handle, start);
    await expect(sw.reload()).resolves.toEqual({ state: "queued", waitingTickets: 2 });
    expect(sw.status().reload).toEqual({ state: "queued", waitingTickets: 2 });
    await new Promise((r) => setTimeout(r, 30));
    expect(start).not.toHaveBeenCalled();
    expect(old.stop).not.toHaveBeenCalled();
    old.state.running = 1;
    await new Promise((r) => setTimeout(r, 30));
    expect(sw.status().reload).toEqual({ state: "queued", waitingTickets: 1 });
    expect(start).not.toHaveBeenCalled();
    old.state.running = 0;
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(sw.status()).toEqual({ mode: "live" }));
    expect(old.stop).toHaveBeenCalledTimes(1);
  });

  it("排队中切换项目被拒绝", async () => {
    const old = fake("/r", { running: 1 });
    const sw = make(old.handle, vi.fn());
    await sw.reload();
    const r = await sw.switchTo("/other");
    expect(r.ok).toBe(false);
    expect(old.stop).not.toHaveBeenCalled();
  });

  it("合并：排队中再请求不重复排队，空闲后只重载一次", async () => {
    const old = fake("/r", { running: 1 });
    const start = vi.fn(async () => fake("/r").handle);
    const sw = make(old.handle, start);
    const a = await sw.reload();
    const b = await sw.reload();
    expect(a).toEqual({ state: "queued", waitingTickets: 1 });
    expect(b).toEqual({ state: "queued", waitingTickets: 1 });
    old.state.running = 0;
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 40));
    expect(start).toHaveBeenCalledTimes(1);
    expect(old.stop).toHaveBeenCalledTimes(1);
  });

  it("合并：停起进行中再请求，拿到同一个结果，只组装一次", async () => {
    const old = fake("/r");
    let release!: (h: BackendHandle) => void;
    const start = vi.fn(() => new Promise<BackendHandle>((r) => (release = r)));
    const sw = make(old.handle, start);
    const p1 = sw.reload();
    const p2 = sw.reload();
    const p3 = sw.reconnect();
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(sw.status().reload).toEqual({ state: "running" });
    release(fake("/r").handle);
    const results = await Promise.all([p1, p2, p3]);
    expect(results).toEqual([{ state: "reloaded" }, { state: "reloaded" }, { state: "reloaded" }]);
    expect(start).toHaveBeenCalledTimes(1);
    expect(old.stop).toHaveBeenCalledTimes(1);
  });

  it("重启抛错：退只读，原因脱敏（不含绝对路径和密钥值）", async () => {
    const secret = "sk-reload-secret-123456789";
    const old = fake("/home/eva/proj");
    const start = vi.fn(async () => {
      throw new Error(`boom at /home/eva/proj/config/models.json key=${secret}`);
    });
    const sw = make(old.handle, start, { DEEPSEEK_API_KEY: secret });
    const r = await sw.reload();
    expect(r.state).toBe("failed");
    const reason = r.state === "failed" ? r.reason : "";
    expect(reason).toContain("只读");
    expect(reason).not.toContain(secret);
    expect(reason).not.toContain("/home/eva");
    const st = sw.status();
    expect(st.mode).toBe("readonly");
    expect(st.reason).not.toContain(secret);
    expect(st.reason).toContain("重载后端失败");
    expect(st.reason).not.toContain("/home/eva");
    expect(sw.repoRoot()).toBe("/home/eva/proj");
  });

  it("重启后没进 live：拆掉它，退只读并带上它的原因", async () => {
    const old = fake("/r");
    const bad = fake("/r", { mode: "readonly", reason: "缺少环境变量 DEEPSEEK_API_KEY" });
    const sw = make(old.handle, async () => bad.handle);
    const r = await sw.reload();
    expect(r).toEqual({
      state: "failed",
      reason: expect.stringContaining("缺少环境变量 DEEPSEEK_API_KEY"),
    });
    expect(bad.stop).toHaveBeenCalledTimes(1);
    expect(sw.status().mode).toBe("readonly");
    expect(sw.status().reason).toContain("重载后端失败");
    expect(sw.status().reason).toContain("缺少环境变量 DEEPSEEK_API_KEY");
  });

  it("只读重新连接：不看在途单，直接重新组装，成功回到 live", async () => {
    const ro = readonlyBackend("/r", "写入锁被占用（pid 1）");
    const next = fake("/r");
    const start = vi.fn(async () => next.handle);
    const sw = make(ro, start);
    await expect(sw.reconnect()).resolves.toEqual({ state: "reloaded" });
    expect(start).toHaveBeenCalledWith("/r");
    expect(sw.status().mode).toBe("live");
  });
});

describe("serveBackendReload（T-093）", () => {
  function fakeIpc() {
    const handlers = new Map<string, (event: unknown, ...a: unknown[]) => unknown>();
    const ipc: IpcMainLike = {
      handle: (c, l) => void handlers.set(c, l),
      removeHandler: (c) => void handlers.delete(c),
    };
    return { ipc, handlers };
  }
  it("两条通道都转给切换器；意外异常转 failed 且脱敏；拆除时移除", async () => {
    const secret = "sk-ipc-secret-abcdefghijk";
    const { ipc, handlers } = fakeIpc();
    const sw = {
      reload: vi.fn(async () => ({ state: "queued" as const, waitingTickets: 3 })),
      reconnect: vi.fn(async () => {
        throw new Error(`x ${secret}`);
      }),
    };
    const off = serveBackendReload(ipc, sw, { DEEPSEEK_API_KEY: secret });
    await expect(handlers.get(IPC_CHANNELS.backendReload)!({})).resolves.toEqual({
      state: "queued",
      waitingTickets: 3,
    });
    const r = (await handlers.get(IPC_CHANNELS.backendReconnect)!({})) as {
      state: string;
      reason: string;
    };
    expect(r.state).toBe("failed");
    expect(r.reason).not.toContain(secret);
    off();
    expect(handlers.size).toBe(0);
  });
});

describe("重载后预算当日已用额度从台账恢复（T-093，真实组装）", () => {
  function repo(): string {
    const root = mkdtempSync(join(tmpdir(), "bc-reload-"));
    dirs.push(root);
    execFileSync("git", ["init", "-b", "main"], { cwd: root });
    execFileSync("git", ["config", "user.email", "t@test"], { cwd: root });
    execFileSync("git", ["config", "user.name", "t"], { cwd: root });
    writeFileSync(join(root, "README.md"), "x\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-m", "init"], { cwd: root });
    mkdirSync(join(root, "config"), { recursive: true });
    copyFileSync(examplePath, join(root, "config", "models.json"));
    return root;
  }

  it("重载前记的调用费用，重建后 budgetState 的 spent_today 不变且不为 0", async () => {
    const root = repo();
    const deps: DefaultDepsHandle[] = [];
    const start = (r: string) =>
      startBackend({
        argv: ["node", "app"],
        env: { DEEPSEEK_API_KEY: "sk-t093-budget" },
        cwd: r,
        lastRepo: r,
        pricingPath,
        logger: { warn: () => {} },
        onDeps: (h) => deps.push(h),
      });
    const sw = new BackendSwitcher(await start(root), start, {}, { reloadPollMs: 5 });
    switchers.push(sw);
    expect(sw.status().mode).toBe("live");
    await deps[0]!.bus.publish({
      type: "call_completed",
      trace_id: "tr",
      span_id: "sp",
      parent_span_id: null,
      requirement_id: "req-1",
      ticket_id: null,
      payload: {
        role: "supervisor",
        provider: "deepseek",
        model: "deepseek-flash",
        effort: "max",
        prompt: "p",
        output: "o",
        tokens: { input: 1_000_000, output: 1_000_000, cache_hit_input: 0 },
        cache_hit: false,
        latency_ms: 1,
        cost: 1_000_000,
        is_resubmit: false,
        rate_limited_retry: 0,
        error: null,
      },
    });
    await vi.waitFor(async () =>
      expect((await deps[0]!.deps.budget.budgetState()).spent_today_micro_usd).toBeGreaterThan(0),
    );
    const before = (await deps[0]!.deps.budget.budgetState()).spent_today_micro_usd;
    await expect(sw.reload()).resolves.toEqual({ state: "reloaded" });
    expect(deps).toHaveLength(2);
    const after = (await deps[1]!.deps.budget.budgetState()).spent_today_micro_usd;
    expect(after).toBe(before);
  });
});

describe("sanitizeReloadReason（T-093）", () => {
  it("换掉仓库根与 Unix / Windows 绝对路径，保留中文说明", async () => {
    const { sanitizeReloadReason } = await import("./backend-switcher.js");
    const out = sanitizeReloadReason(
      "打不开 /home/eva/proj/x.db，另见 C:\\Users\\eva\\a.json 和（/etc/y）",
      "/home/eva/proj",
      {},
    );
    expect(out).not.toMatch(/home|Users|etc/);
    expect(out).toContain("打不开");
    expect(out).toContain("<仓库>");
    expect(out).toContain("<路径>");
  });
});
