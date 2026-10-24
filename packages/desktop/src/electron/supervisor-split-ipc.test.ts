// UI-04c：supervisor:split 的主进程侧——确实调 10 的 split()（不经 chat）、只读回固定失败、失败原因脱敏不带路径。
import { describe, expect, it, vi } from "vitest";
import type { SplitRequest, SplitResult } from "@bakacoding/supervisor";
import { IPC_CHANNELS, type DesktopSplitResult } from "../shared/api.js";
import { serveSupervisorSplit, type IpcMainLike } from "./ipc.js";
import { createDesktopApi } from "./preload-api.js";
import {
  CHAT_REASON_MAX,
  runSupervisorSplit,
  SPLIT_READONLY_REASON,
  toSplitRequest,
} from "./supervisor-chat.js";
import { BackendSwitcher, readonlyBackend } from "./backend-switcher.js";
import type { BackendHandle } from "./backend.js";

const SECRET = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
const ENV = { DEEPSEEK_API_KEY: SECRET };

const result = (requirement_id: string, ids: string[]): SplitResult =>
  ({
    requirement_id,
    trace_id: "tr-1",
    summary: "在 /home/eva/secret 下改了文件",
    tickets: ids.map((ticket_id) => ({ ticket_id })),
    attempts: 1,
  }) as unknown as SplitResult;

describe("runSupervisorSplit（UI-04c）", () => {
  it("ok：调 10 的 split()，text / requirement_id 原样传，结果只带需求 id 和单号", async () => {
    const split = vi.fn(async (_r: SplitRequest) => result("req-1", ["T-1", "T-2"])); // eslint-disable-line @typescript-eslint/no-unused-vars
    const r = await runSupervisorSplit(
      split,
      { project_id: "p-1", text: " 做个登录页 ", requirement_id: "req-1" },
      ENV,
    );
    expect(split).toHaveBeenCalledWith({
      project_id: "p-1",
      text: "做个登录页",
      requirement_id: "req-1",
    });
    expect(r).toEqual({ ok: true, requirement_id: "req-1", ticket_ids: ["T-1", "T-2"] });
    expect(JSON.stringify(r)).not.toContain("/home");
  });

  it("没有 requirement_id 时不传", async () => {
    const split = vi.fn(async (_r: SplitRequest) => result("req-n", ["T-3"])); // eslint-disable-line @typescript-eslint/no-unused-vars
    await runSupervisorSplit(split, { project_id: "p-1", text: "x" }, ENV);
    expect(split).toHaveBeenCalledWith({ project_id: "p-1", text: "x" });
  });

  it("只读（没有 split）：固定失败", async () => {
    await expect(
      runSupervisorSplit(undefined, { project_id: "p", text: "x" }, ENV),
    ).resolves.toEqual({ ok: false, reason: SPLIT_READONLY_REASON });
  });

  it("缺项目 / 空需求：不调 split", async () => {
    const split = vi.fn(async () => result("r", []));
    expect((await runSupervisorSplit(split, { project_id: "", text: "x" }, ENV)).ok).toBe(false);
    expect((await runSupervisorSplit(split, { project_id: "p", text: "  " }, ENV)).ok).toBe(false);
    expect(split).not.toHaveBeenCalled();
  });

  it("抛错：ok:false，reason 走 sanitizeChatReason（无密钥、无路径）并截断", async () => {
    const split = vi.fn(async () => {
      throw new Error(
        `写入 /home/eva/.bakacoding/state.db 失败 C:\\Users\\eva\\x.db ~/repo/a.ts ${SECRET} ${"x".repeat(5000)}`,
      );
    });
    const r = await runSupervisorSplit(split, { project_id: "p", text: "x" }, ENV);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("重试拆单失败");
    expect(r.reason).not.toContain(SECRET);
    expect(r.reason).not.toContain("/home/eva");
    expect(r.reason).not.toContain("C:\\Users");
    expect(r.reason).not.toContain("~/repo");
    expect([...r.reason].length).toBeLessThanOrEqual(CHAT_REASON_MAX + 1);
  });

  it("toSplitRequest：非法字段丢掉", () => {
    expect(toSplitRequest({ project_id: "p", text: "t", requirement_id: "r" })).toEqual({
      project_id: "p",
      text: "t",
      requirement_id: "r",
    });
    expect(toSplitRequest({ project_id: 1, text: 2, requirement_id: 3 })).toEqual({
      project_id: "",
      text: "",
    });
    expect(toSplitRequest(null)).toEqual({ project_id: "", text: "" });
  });
});

describe("serveSupervisorSplit / preload / 只读 / BackendSwitcher（UI-04c）", () => {
  function fakeIpc() {
    const handlers = new Map<string, (...a: unknown[]) => unknown>();
    const ipc: IpcMainLike = {
      handle: (c, h) => void handlers.set(c, h),
      removeHandler: (c) => void handlers.delete(c),
    };
    return { ipc, handlers };
  }

  it("ok：args[1] 收成拆单请求交给后端；停掉后注销", async () => {
    const { ipc, handlers } = fakeIpc();
    const supervisorSplit = vi.fn(async (): Promise<DesktopSplitResult> => ({
      ok: true,
      requirement_id: "req-1",
      ticket_ids: ["T-1"],
    }));
    const stop = serveSupervisorSplit(ipc, { supervisorSplit });
    const h = handlers.get(IPC_CHANNELS.supervisorSplit)!;
    await expect(
      h({ sender: {} }, { project_id: "p-1", text: "做个登录页", requirement_id: "req-1", x: 1 }),
    ).resolves.toEqual({ ok: true, requirement_id: "req-1", ticket_ids: ["T-1"] });
    expect(supervisorSplit).toHaveBeenCalledWith({
      project_id: "p-1",
      text: "做个登录页",
      requirement_id: "req-1",
    });
    stop();
    expect(handlers.has(IPC_CHANNELS.supervisorSplit)).toBe(false);
  });

  it("出错原因经 IPC 原样（已脱敏）返回，不含路径", async () => {
    const { ipc, handlers } = fakeIpc();
    const split = vi.fn(async () => {
      throw new Error("拆单写 /Users/eva/repo/x.ts 失败");
    });
    serveSupervisorSplit(ipc, {
      supervisorSplit: (r) => runSupervisorSplit(split, r, ENV),
    });
    const r = (await handlers.get(IPC_CHANNELS.supervisorSplit)!(
      { sender: {} },
      { project_id: "p", text: "x" },
    )) as DesktopSplitResult;
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("/Users/eva");
  });

  it("preload supervisorSplit 走 supervisor:split 通道", async () => {
    const ipc = {
      invoke: vi.fn(async () => ({ ok: false, reason: "x" })),
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    const api = createDesktopApi(ipc as never, "linux");
    await api.supervisorSplit({ project_id: "p", text: "t", requirement_id: "r" });
    expect(ipc.invoke).toHaveBeenCalledWith(IPC_CHANNELS.supervisorSplit, {
      project_id: "p",
      text: "t",
      requirement_id: "r",
    });
  });

  it("只读后端：固定失败，不带路径", async () => {
    const b = readonlyBackend("/repo/secret-path", "缺少环境变量 DEEPSEEK_API_KEY");
    const r = await b.supervisorSplit({ project_id: "p", text: "x" });
    expect(r).toEqual({ ok: false, reason: SPLIT_READONLY_REASON });
    expect(JSON.stringify(r)).not.toContain("/repo");
  });

  it("BackendSwitcher.supervisorSplit 原样转给当前后端，结果原样返回", async () => {
    const supervisorSplit = vi.fn(async (): Promise<DesktopSplitResult> => ({
      ok: true,
      requirement_id: "req-9",
      ticket_ids: ["T-9"],
    }));
    const current = {
      onNotify: () => () => {},
      onPendingHighRisk: () => () => {},
      supervisorSplit,
    } as unknown as BackendHandle;
    const sw = new BackendSwitcher(current, async () => current);
    const req = { project_id: "p-9", text: "需求", requirement_id: "req-9" };
    await expect(sw.supervisorSplit(req)).resolves.toEqual({
      ok: true,
      requirement_id: "req-9",
      ticket_ids: ["T-9"],
    });
    expect(supervisorSplit).toHaveBeenCalledWith(req);
  });
});
