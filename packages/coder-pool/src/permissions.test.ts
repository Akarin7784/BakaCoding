// T-045：runTicket 结束时释放本单权限清单；scope_requests 原样传给 4 的 createTools。
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallCtx } from "@bakacoding/types";
import {
  defaultPermissionRegistry,
  PermissionRegistry,
  type ScopeBus,
  type ScopeRequestOptions,
} from "@bakacoding/workspace";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCoderPool,
  type ChatRequest,
  type ChatResponse,
  type CoderPoolDeps,
  type CreateFileTools,
  type FileTools,
  type RunTicketInput,
  type ToolCall,
} from "./index.js";

const ctx = {
  role: "coder",
  requirement_id: "R-1",
  ticket_id: "T-1",
  is_resubmit: false,
  trace: { trace_id: "tr", span_id: "sp", parent_span_id: null },
} as CallCtx;

function input(over: Partial<RunTicketInput> = {}): RunTicketInput {
  return {
    ticket: { ticket_id: "T-1", project_id: "P-1" },
    prompt: "## 需求单 T-1\n改 src/a.ts",
    worktree_path: "/wt/T-1-r0",
    permission_list: [{ glob: "src/**", level: "rw" }],
    effort: "low",
    ctx,
    ...over,
  };
}

const call = (name: string, args: unknown, id = name): ToolCall => ({ id, name, input: args });
const done = (summary = "改好了"): ChatResponse => ({
  content: `{"status":"done","summary":"${summary}"}`,
  tool_calls: [],
});
const toolTurn = (): ChatResponse => ({
  content: "",
  tool_calls: [call("read", { file_path: "src/a.ts" })],
});

function fakeTools(): FileTools {
  const ok = () => ({ ok: true as const, output: "ok" });
  return { read: vi.fn(ok), write: vi.fn(ok), edit: vi.fn(ok), glob: vi.fn(ok), grep: vi.fn(ok) };
}

/** 按顺序回放回复的假 chat；函数项可以在调用时做事（比如取消）。 */
function script(replies: Array<ChatResponse | Error | ((req: ChatRequest) => ChatResponse)>) {
  const requests: ChatRequest[] = [];
  const chat = vi.fn(async (req: ChatRequest) => {
    requests.push(req);
    const r = replies.shift();
    if (!r) throw new Error("脚本用完");
    if (r instanceof Error) throw r;
    return typeof r === "function" ? r(req) : r;
  });
  return { chat, requests };
}

/** 带 release 计数的独立登记表。 */
function spiedRegistry() {
  const registry = new PermissionRegistry();
  const release = vi.spyOn(registry, "release");
  return { registry, release };
}

function deps(over: Partial<CoderPoolDeps> & Pick<CoderPoolDeps, "chat">): CoderPoolDeps {
  return {
    getConfig: () => ({
      roles: { coder: { provider: "deepseek", model: "deepseek-flash" } },
      pipeline: { max_turns: 3 },
    }),
    createTools: () => fakeTools(),
    promptTemplate: () => "你是 Flash 编码代理。",
    architectureConstraints: () => ["不加依赖"],
    ...over,
  };
}

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  vi.restoreAllMocks();
});
function worktree(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "bc-coder-t045-")));
  dirs.push(d);
  mkdirSync(join(d, "src"), { recursive: true });
  mkdirSync(join(d, "docs"), { recursive: true });
  writeFileSync(join(d, "src", "a.ts"), "const a = 1;\n");
  return d;
}

/** 内存总线：reply 决定批准还是拒绝。 */
function fakeBus(reply: (scope: string[]) => { granted?: string[]; denied?: string }) {
  const handlers: Record<string, Array<(e: unknown) => void>> = {};
  const requested: string[][] = [];
  const bus = {
    async publish(e: {
      ticket_id: string;
      payload: { request_id: string; requested_scope: string[] };
    }) {
      requested.push(e.payload.requested_scope);
      const r = reply(e.payload.requested_scope);
      const emit = (type: string, payload: object) => {
        for (const h of handlers[type] ?? []) h({ type, ticket_id: e.ticket_id, payload });
      };
      if (r.granted)
        emit("write_scope_granted", { request_id: e.payload.request_id, granted_scope: r.granted });
      else
        emit("write_scope_denied", {
          request_id: e.payload.request_id,
          requested_scope: e.payload.requested_scope,
          reason: r.denied ?? "不同意",
        });
      return undefined;
    },
    subscribe(type: string, h: (e: never) => void) {
      (handlers[type] ??= []).push(h as (e: unknown) => void);
      return () => {
        handlers[type] = (handlers[type] ?? []).filter((x) => x !== h);
      };
    },
  };
  return { bus: bus as unknown as ScopeBus, requested };
}

describe("runTicket 结束时释放本单权限清单（T-045）", () => {
  it("done：释放刚好一次，用的是传给 createTools 的同一个登记表", async () => {
    const { registry, release } = spiedRegistry();
    const createTools = vi.fn<CreateFileTools>(() => fakeTools());
    const { chat } = script([toolTurn(), done()]);
    const r = await createCoderPool(deps({ chat, createTools, registry })).runTicket(input());
    expect(r.status).toBe("done");
    expect(createTools.mock.calls[0]![0].registry).toBe(registry);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith("T-1");
  });

  it("gave_up：释放一次", async () => {
    const { registry, release } = spiedRegistry();
    const { chat } = script([
      { content: '{"status":"gave_up","summary":"做不了"}', tool_calls: [] },
    ]);
    const r = await createCoderPool(deps({ chat, registry })).runTicket(input());
    expect(r.status).toBe("gave_up");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("turn_limit：释放一次", async () => {
    const { registry, release } = spiedRegistry();
    const { chat } = script([toolTurn(), toolTurn(), toolTurn()]);
    const r = await createCoderPool(deps({ chat, registry })).runTicket(input());
    expect(r.status).toBe("turn_limit");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("预算耗尽：返回 budget_exceeded，释放一次", async () => {
    const { registry, release } = spiedRegistry();
    const { chat } = script([
      toolTurn(),
      Object.assign(new Error("超预算"), { code: "BUDGET_EXCEEDED" }),
    ]);
    const r = await createCoderPool(deps({ chat, registry })).runTicket(input());
    expect(r.status).toBe("budget_exceeded");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("模型调用抛错：原样抛出，释放一次", async () => {
    const { registry, release } = spiedRegistry();
    const boom = new Error("网络断了");
    const { chat } = script([toolTurn(), boom]);
    await expect(createCoderPool(deps({ chat, registry })).runTicket(input())).rejects.toBe(boom);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("createTools 抛错：原样抛出，释放一次", async () => {
    const { registry, release } = spiedRegistry();
    const boom = new Error("worktree 不存在");
    const { chat } = script([done()]);
    const pool = createCoderPool(
      deps({
        chat,
        registry,
        createTools: () => {
          throw boom;
        },
      }),
    );
    await expect(pool.runTicket(input())).rejects.toBe(boom);
    expect(chat).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("中途取消：抛 signal.reason，释放一次", async () => {
    const { registry, release } = spiedRegistry();
    const ac = new AbortController();
    const reason = new Error("用户停止");
    const { chat } = script([
      () => {
        ac.abort(reason);
        return toolTurn();
      },
    ]);
    await expect(
      createCoderPool(deps({ chat, registry })).runTicket(input({ signal: ac.signal })),
    ).rejects.toBe(reason);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("进入前已取消：不建工具（没登记过），也不释放", async () => {
    const { registry, release } = spiedRegistry();
    const createTools = vi.fn<CreateFileTools>(() => fakeTools());
    const ac = new AbortController();
    ac.abort(new Error("早就停了"));
    const { chat } = script([done()]);
    await expect(
      createCoderPool(deps({ chat, registry, createTools })).runTicket(
        input({ signal: ac.signal }),
      ),
    ).rejects.toThrow("早就停了");
    expect(createTools).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it("release 自己抛错：记 warn，不覆盖成功结果，也不覆盖原始错误", async () => {
    const registry = new PermissionRegistry();
    vi.spyOn(registry, "release").mockImplementation(() => {
      throw new Error("登记表坏了");
    });
    const warn = vi.fn();

    const ok = script([done()]);
    const r = await createCoderPool(deps({ chat: ok.chat, registry, logger: { warn } })).runTicket(
      input(),
    );
    expect(r.status).toBe("done");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("登记表坏了");

    const boom = new Error("原始错误");
    const bad = script([boom]);
    await expect(
      createCoderPool(deps({ chat: bad.chat, registry, logger: { warn } })).runTicket(input()),
    ).rejects.toBe(boom);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("没传 registry：用 4 的 defaultPermissionRegistry，注入了 createTools 替身也由 5 释放", async () => {
    const release = vi.spyOn(defaultPermissionRegistry, "release");
    const createTools = vi.fn<CreateFileTools>(() => fakeTools());
    const { chat } = script([done()]);
    await createCoderPool(deps({ chat, createTools })).runTicket(input());
    expect(createTools.mock.calls[0]![0].registry).toBe(defaultPermissionRegistry);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith("T-1");
  });

  it("真实 createTools + 默认登记表：跑的时候清单在，结束后清掉", async () => {
    const root = worktree();
    let during: unknown;
    const { chat } = script([
      () => {
        during = defaultPermissionRegistry.get("T-real");
        return done();
      },
    ]);
    const pool = createCoderPool({ ...deps({ chat }), createTools: undefined });
    await pool.runTicket(
      input({ ticket: { ticket_id: "T-real", project_id: "P-1" }, worktree_path: root }),
    );
    expect(during).toEqual([{ glob: "src/**", level: "rw" }]);
    expect(defaultPermissionRegistry.get("T-real")).toBeUndefined();
  });
});

describe("scope_requests 原样传给 createTools（T-045）", () => {
  it("给了就原样传（同一个对象）；没给就不带这个字段", async () => {
    const createTools = vi.fn<CreateFileTools>(() => fakeTools());
    const scope: ScopeRequestOptions = {
      bus: fakeBus(() => ({ denied: "x" })).bus,
      ctx: { requirement_id: "R-1", trace: { trace_id: "tr", span_id: "sp" } },
      timeout_ms: 50,
    };
    const registry = new PermissionRegistry();
    const a = script([done()]);
    await createCoderPool(deps({ chat: a.chat, createTools, registry })).runTicket(
      input({ scope_requests: scope }),
    );
    expect(createTools.mock.calls[0]![0].scope_requests).toBe(scope);

    const b = script([done()]);
    await createCoderPool(deps({ chat: b.chat, createTools, registry })).runTicket(input());
    expect(createTools.mock.calls[1]![0]).toEqual({
      ticket_id: "T-1",
      worktree_path: "/wt/T-1-r0",
      permission_list: [{ glob: "src/**", level: "rw" }],
      registry,
    });
    expect("scope_requests" in createTools.mock.calls[1]![0]).toBe(false);
  });

  it("真实 createTools：给了 scope_requests，越界写走申请，批准后写成；不给就直接 FS_PERMISSION_DENIED", async () => {
    const write = (id: string) => ({
      content: "",
      tool_calls: [call("write", { file_path: "docs/new.md", content: "hi\n" }, id)],
    });
    const scopeCtx = { requirement_id: "R-1", trace: { trace_id: "tr", span_id: "sp" } };

    // 不给：直接拒绝，不发申请
    const root1 = worktree();
    const r1 = script([write("w"), done()]);
    const registry = new PermissionRegistry();
    const res1 = await createCoderPool({
      ...deps({ chat: r1.chat, registry }),
      createTools: undefined,
    }).runTicket(input({ worktree_path: root1 }));
    const tool1 = r1.requests[1]!.messages.find((m) => m.role === "tool")!;
    expect(tool1).toMatchObject({ is_error: true });
    expect((tool1 as { content: string }).content).toMatch(/^FS_PERMISSION_DENIED/);
    expect(res1.changed_files).toEqual([]);

    // 给了：4 发申请、拿到批准后写入
    const root2 = worktree();
    const { bus, requested } = fakeBus(() => ({ granted: ["docs/**"] }));
    const r2 = script([write("w"), done()]);
    const res2 = await createCoderPool({
      ...deps({ chat: r2.chat, registry }),
      createTools: undefined,
    }).runTicket(input({ worktree_path: root2, scope_requests: { bus, ctx: scopeCtx } }));
    expect(requested).toEqual([["docs/new.md"]]);
    expect(readFileSync(join(root2, "docs/new.md"), "utf8")).toBe("hi\n");
    expect(res2.changed_files).toEqual(["docs/new.md"]);
    // 批准的范围只在本进程登记表里，runTicket 结束就随清单释放（跨轮次保留归 8 / T-048）
    expect(registry.get("T-1")).toBeUndefined();

    // 公共前缀不受 scope_requests 影响
    expect(r2.requests[0]!.system).toBe(r1.requests[0]!.system);
    expect(r2.requests[0]!.tools).toBe(r1.requests[0]!.tools);
  });
});
