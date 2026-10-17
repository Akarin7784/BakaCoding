import type { CallCtx } from "@bakacoding/types";
import { describe, expect, it, vi } from "vitest";
import {
  appendSystemNote,
  buildTicketMessage,
  createCoderPool,
  FILE_TOOL_DEFINITIONS,
  parseFinish,
  serializePrefix,
  type ChatRequest,
  type ChatResponse,
  type ChatMessage,
  type CoderPoolDeps,
  type FileTools,
  type RunTicketInput,
  type ToolCall,
} from "./index.js";

const ctx: CallCtx = {
  role: "coder",
  requirement_id: "R-1",
  ticket_id: "T-1",
  is_resubmit: true,
  trace: "tr-1",
} as CallCtx;

function input(over: Partial<RunTicketInput> = {}): RunTicketInput {
  return {
    ticket: { ticket_id: "T-1", project_id: "P-1" },
    prompt: "## 需求单 T-1\n把 a.ts 里的 foo 改名 bar",
    worktree_path: "/wt/T-1-r1",
    permission_list: [{ glob: "src/**", level: "rw" }],
    effort: "high",
    ctx,
    ...over,
  };
}

function call(name: string, input: unknown, id = name): ToolCall {
  return { id, name, input };
}

function fakeTools(over: Partial<FileTools> = {}): FileTools {
  return {
    read: vi.fn(() => ({ ok: true as const, output: "1\tconst foo = 1;" })),
    write: vi.fn(() => ({ ok: true as const, output: "已写入" })),
    edit: vi.fn(() => ({ ok: true as const, output: "已替换 1 处" })),
    glob: vi.fn(() => ({ ok: true as const, output: "src/a.ts" })),
    grep: vi.fn(() => ({ ok: true as const, output: "src/a.ts:1:foo" })),
    ...over,
  };
}

/** 按顺序回放模型回复的假 chat；记录每次请求（messages 深拷贝）。 */
function script(replies: Array<ChatResponse | Error>) {
  const requests: ChatRequest[] = [];
  const chat = vi.fn(async (req: ChatRequest) => {
    requests.push(structuredClone(req) as ChatRequest);
    const r = replies.shift();
    if (!r) throw new Error("脚本用完");
    if (r instanceof Error) throw r;
    return r;
  });
  return { chat, requests };
}

const done = (summary = "改好了"): ChatResponse => ({
  content: `\`\`\`json\n{"status":"done","summary":"${summary}"}\n\`\`\``,
  tool_calls: [],
});

function deps(over: Partial<CoderPoolDeps> & Pick<CoderPoolDeps, "chat">): CoderPoolDeps {
  return {
    getConfig: () => ({
      roles: { coder: { provider: "deepseek", model: "deepseek-flash" } },
      pipeline: { max_turns: 40 },
    }),
    createTools: () => fakeTools(),
    promptTemplate: () => "你是 Flash 编码代理。",
    architectureConstraints: () => ["模块之间只通过 types 包共享类型", "不加依赖"],
    ...over,
  };
}

describe("runTicket 基本流程（5-1 / 5-3）", () => {
  it("多轮工具调用后模型说做完：返回 done、summary 和改过的文件，不返回补丁", async () => {
    const { chat, requests } = script([
      { content: "先看看", tool_calls: [call("read", { path: "src/a.ts" })] },
      {
        content: "",
        tool_calls: [
          call("edit", { path: "src/a.ts", old_string: "foo", new_string: "bar" }, "e1"),
          call("write", { path: "./src/b.ts", content: "x" }, "w1"),
          call("edit", { path: "src/a.ts", old_string: "1", new_string: "2" }, "e2"),
        ],
      },
      done("foo 改成 bar"),
    ]);
    const tools = fakeTools();
    const pool = createCoderPool(deps({ chat, createTools: () => tools }));
    const r = await pool.runTicket(input());
    expect(r).toEqual({
      status: "done",
      summary: "foo 改成 bar",
      changed_files: ["src/a.ts", "src/b.ts"],
    });
    expect(chat).toHaveBeenCalledTimes(3);
    expect(tools.read).toHaveBeenCalledWith({ path: "src/a.ts" });
    // 第三轮看到的历史：需求单、助手、工具结果……
    const last = requests[2]!.messages;
    expect(last.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "tool",
      "tool",
    ]);
    expect(last[2]).toMatchObject({
      role: "tool",
      tool_call_id: "read",
      content: "1\tconst foo = 1;",
      is_error: false,
    });
  });

  it("模型说做不了：返回 gave_up", async () => {
    const { chat } = script([
      {
        content: '{"status":"gave_up","summary":"需求单要求改的文件不在权限清单里"}',
        tool_calls: [],
      },
    ]);
    const r = await createCoderPool(deps({ chat })).runTicket(input());
    expect(r).toEqual({
      status: "gave_up",
      summary: "需求单要求改的文件不在权限清单里",
      changed_files: [],
    });
  });

  it("结束回复不是约定的 JSON：按 done 处理，summary 用原文", async () => {
    const { chat } = script([{ content: "  全部改完了。 ", tool_calls: [] }]);
    const r = await createCoderPool(deps({ chat })).runTicket(input());
    expect(r).toEqual({ status: "done", summary: "全部改完了。", changed_files: [] });
  });

  it("role 固定 coder；provider/model 取 roles.coder；effort 和 ctx（含 is_resubmit）原样传给 1", async () => {
    const { chat, requests } = script([done()]);
    await createCoderPool(deps({ chat })).runTicket(input({ effort: "max" }));
    const req = requests[0]!;
    expect(req).toMatchObject({
      role: "coder",
      provider: "deepseek",
      model: "deepseek-flash",
      effort: "max",
    });
    expect(req.ctx).toEqual({ ...ctx, role: "coder" });
    expect(req.ctx.is_resubmit).toBe(true);
  });

  it("5 自己不提交、不建 worktree：只把传进来的 worktree_path 和权限清单交给 4 的工具", async () => {
    const createTools = vi.fn(() => fakeTools());
    const { chat } = script([done()]);
    await createCoderPool(deps({ chat, createTools })).runTicket(input());
    expect(createTools).toHaveBeenCalledWith({
      ticket_id: "T-1",
      worktree_path: "/wt/T-1-r1",
      permission_list: [{ glob: "src/**", level: "rw" }],
    });
  });
});

describe("工具结果原样交还模型（5-5）", () => {
  it("拒绝、FS_* 错误、未知工具、工具抛错都作为工具结果返回，不中断；失败的写不计入 changed_files", async () => {
    const tools = fakeTools({
      write: vi.fn(() => ({
        ok: false as const,
        code: "PERMISSION_DENIED",
        message: "src/x.ts 不在写入范围",
      })),
      edit: vi.fn(() => ({
        ok: false as const,
        code: "FS_EDIT_NOT_FOUND",
        message: "old_string not found",
      })),
      grep: vi.fn(() => {
        throw new Error("磁盘坏了");
      }),
    });
    const { chat, requests } = script([
      {
        content: "",
        tool_calls: [
          call("write", { path: "src/x.ts", content: "" }),
          call("edit", { path: "src/a.ts", old_string: "zz", new_string: "y" }),
          call("shell", { cmd: "rm -rf /" }),
          call("grep", { pattern: "foo" }),
        ],
      },
      done(),
    ]);
    const r = await createCoderPool(deps({ chat, createTools: () => tools })).runTicket(input());
    expect(r.changed_files).toEqual([]);
    const results = requests[1]!.messages.filter((m) => m.role === "tool");
    expect(results).toEqual([
      {
        role: "tool",
        tool_call_id: "write",
        name: "write",
        content: "PERMISSION_DENIED: src/x.ts 不在写入范围",
        is_error: true,
      },
      {
        role: "tool",
        tool_call_id: "edit",
        name: "edit",
        content: "FS_EDIT_NOT_FOUND: old_string not found",
        is_error: true,
      },
      {
        role: "tool",
        tool_call_id: "shell",
        name: "shell",
        content: "UNKNOWN_TOOL: 没有名为 shell 的工具",
        is_error: true,
      },
      {
        role: "tool",
        tool_call_id: "grep",
        name: "grep",
        content: "TOOL_ERROR: 磁盘坏了",
        is_error: true,
      },
    ]);
  });

  it("只给五个文件工具，没有 shell、网络、git", () => {
    expect(FILE_TOOL_DEFINITIONS.map((t) => t.name)).toEqual([
      "read",
      "write",
      "edit",
      "glob",
      "grep",
    ]);
  });
});

describe("公共前缀（5-2）", () => {
  it("同一项目不同单、不同轮次、不同 effort、带不带 feedback：system 和 tools 逐字节相同", async () => {
    const { chat, requests } = script([
      { content: "", tool_calls: [call("read", { path: "src/a.ts" })] },
      done(),
      done(),
      done(),
    ]);
    const pool = createCoderPool(deps({ chat }));
    await pool.runTicket(input());
    await pool.runTicket(
      input({
        ticket: { ticket_id: "T-99", project_id: "P-1" },
        prompt: "## 需求单 T-99\n别的事",
        effort: "low",
        feedback: "评审：漏了测试",
      }),
    );
    // 另建一个池（模拟重启）也一样
    await createCoderPool(deps({ chat })).runTicket(
      input({ ticket: { ticket_id: "T-5", project_id: "P-1" } }),
    );
    const bytes = requests.map((r) => serializePrefix(r.system, r.tools));
    expect(new Set(bytes).size).toBe(1);
    expect(bytes[0]).not.toMatch(/T-1|T-99|T-5/);
    expect(bytes[0]).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(requests[0]!.system).toContain("你是 Flash 编码代理。");
    expect(requests[0]!.system).toContain("- 不加依赖");
  });

  it("前缀固定快照：改动工具定义或结束协议会让这个测试失败（提醒只增不改）", async () => {
    const pool = createCoderPool(deps({ chat: script([]).chat }));
    const { system, tools } = await pool.prefix("P-1");
    expect(serializePrefix(system, tools)).toMatchSnapshot();
  });

  it("前缀在前、需求单在后、feedback 接在需求单后面", async () => {
    const { chat, requests } = script([done()]);
    await createCoderPool(deps({ chat })).runTicket(input({ feedback: "冲突文件：src/a.ts" }));
    const first = requests[0]!.messages[0] as ChatMessage & { content: string };
    expect(first.role).toBe("user");
    expect(first.content.startsWith("## 需求单 T-1")).toBe(true);
    expect(first.content.indexOf("冲突文件：src/a.ts")).toBeGreaterThan(
      first.content.indexOf("需求单"),
    );
    expect(first.content).toMatch(/不可信输入/);
    expect(requests[0]!.system).not.toContain("冲突文件");
  });

  it("不同项目的架构约束不同，前缀不同；同一项目只拼一次", async () => {
    const architectureConstraints = vi.fn((p: string) => [`约束-${p}`]);
    const pool = createCoderPool(deps({ chat: script([]).chat, architectureConstraints }));
    const a = await pool.prefix("P-1");
    await pool.prefix("P-1");
    const b = await pool.prefix("P-2");
    expect(a.system).not.toBe(b.system);
    expect(architectureConstraints).toHaveBeenCalledTimes(2);
  });

  it("feedback 超长会截断", () => {
    const msg = buildTicketMessage("P", "x".repeat(50), 10);
    expect(msg).toContain(`${"x".repeat(10)}\n…（已截断）`);
    expect(msg).not.toContain("x".repeat(11));
    expect(buildTicketMessage("P", undefined, 10)).toBe("P");
  });

  it("后备做法：中途改提示追加 system 消息到末尾，不动开头", () => {
    const m: ChatMessage[] = [{ role: "user", content: "需求单" }];
    appendSystemNote(m, "补充：别改 README");
    expect(m).toEqual([
      { role: "user", content: "需求单" },
      { role: "system", content: "补充：别改 README" },
    ]);
  });
});

describe("轮数上限（5-8）与预算", () => {
  it("到 pipeline.max_turns 仍在调工具：返回 turn_limit，已改文件照报", async () => {
    const chat = vi.fn(async (): Promise<ChatResponse> => ({
      content: "继续",
      tool_calls: [call("edit", { path: "src/a.ts", old_string: "a", new_string: "b" })],
    }));
    const pool = createCoderPool(
      deps({
        chat,
        getConfig: () => ({
          roles: { coder: { provider: "deepseek", model: "deepseek-flash" } },
          pipeline: { max_turns: 3 },
        }),
      }),
    );
    const r = await pool.runTicket(input());
    expect(chat).toHaveBeenCalledTimes(3);
    expect(r.status).toBe("turn_limit");
    expect(r.summary).toMatch(/3 轮/);
    expect(r.changed_files).toEqual(["src/a.ts"]);
  });

  it("1 报预算耗尽：返回 budget_exceeded，不再调用", async () => {
    const err = Object.assign(new Error("budget"), { code: "BUDGET_EXCEEDED" });
    const { chat } = script([
      { content: "", tool_calls: [call("write", { path: "src/c.ts", content: "c" })] },
      err,
    ]);
    const r = await createCoderPool(deps({ chat })).runTicket(input());
    expect(r.status).toBe("budget_exceeded");
    expect(r.changed_files).toEqual(["src/c.ts"]);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("可注入预算判断；其他错误照常抛出", async () => {
    class Over extends Error {}
    const a = script([new Over("x")]);
    const r = await createCoderPool(
      deps({ chat: a.chat, isBudgetExceeded: (e) => e instanceof Over }),
    ).runTicket(input());
    expect(r.status).toBe("budget_exceeded");
    const b = script([new Error("网络断了")]);
    await expect(createCoderPool(deps({ chat: b.chat })).runTicket(input())).rejects.toThrow(
      "网络断了",
    );
  });
});

describe("每单一个代理（不共享会话状态）", () => {
  it("两单并发跑，各自的历史互不混入", async () => {
    const requests: ChatRequest[] = [];
    const chat = vi.fn(async (req: ChatRequest): Promise<ChatResponse> => {
      requests.push(structuredClone(req) as ChatRequest);
      return req.messages.length === 1
        ? { content: "", tool_calls: [call("read", { path: `${req.ctx.ticket_id}.ts` })] }
        : done();
    });
    const pool = createCoderPool(deps({ chat }));
    await Promise.all([
      pool.runTicket(input({ ctx: { ...ctx, ticket_id: "T-A" } as CallCtx, prompt: "A" })),
      pool.runTicket(input({ ctx: { ...ctx, ticket_id: "T-B" } as CallCtx, prompt: "B" })),
    ]);
    for (const r of requests) {
      const text = JSON.stringify(r.messages);
      expect(text.includes('"A"') && text.includes('"B"')).toBe(false);
      expect(r.messages.length).toBeLessThanOrEqual(3);
    }
  });
});

describe("parseFinish", () => {
  it("```json 代码块优先于其他代码块和正文", () => {
    const text =
      '思考 {"status":"gave_up","summary":"正文"}\n```ts\n{"status":"gave_up","summary":"ts"}\n```\n```json\n{"status":"done","summary":"json"}\n```';
    expect(parseFinish(text)).toEqual({ status: "done", summary: "json" });
    expect(parseFinish('```\n{"status":"gave_up","summary":"s"}\n```')).toEqual({
      status: "gave_up",
      summary: "s",
    });
    expect(parseFinish('{"status":"maybe","summary":"s"}')).toBeUndefined();
    expect(parseFinish("没有 JSON")).toBeUndefined();
  });
});
