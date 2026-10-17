import { fileURLToPath } from "node:url";
import { loadPricing } from "@bakacoding/config-budget";
import {
  createModelGateway,
  type CallCompletedInput,
  type GatewayConfig,
} from "@bakacoding/model-gateway";
import type { CallCtx } from "@bakacoding/types";
import { describe, expect, it, vi } from "vitest";
import {
  createCoderPool,
  FINISH_RETRY_PROMPT,
  serializePrefix,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type CoderPoolDeps,
  type FileTools,
  type ModelChat,
  type ReasoningBlock,
  type RunTicketInput,
  type ToolCall,
} from "./index.js";

// T-044：signal 透传与 reasoning 回传

const ctx: CallCtx = {
  role: "sub_agent",
  requirement_id: "R-1",
  ticket_id: "T-1",
  is_resubmit: false,
  trace: { trace_id: "tr", span_id: "sp", parent_span_id: null },
};

function input(over: Partial<RunTicketInput> = {}): RunTicketInput {
  return {
    ticket: { ticket_id: "T-1", project_id: "P-1" },
    prompt: "## 需求单 T-1\n把 a.ts 里的 foo 改名 bar",
    worktree_path: "/wt/T-1-r1",
    permission_list: [{ glob: "src/**", level: "rw" }],
    effort: "low",
    ctx,
    ...over,
  };
}

const call = (name: string, input: unknown, id = name): ToolCall => ({ id, name, input });

const done = (summary = "改好了"): ChatResponse => ({
  content: `\`\`\`json\n{"status":"done","summary":"${summary}"}\n\`\`\``,
  tool_calls: [],
});

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

/** 按顺序回放回复；记录每次请求（messages 深拷贝，signal 保留原对象）。 */
function script(replies: Array<ChatResponse | ((req: ChatRequest) => Promise<ChatResponse>)>) {
  const requests: ChatRequest[] = [];
  const chat = vi.fn(async (req: ChatRequest) => {
    const { signal, ...rest } = req;
    requests.push({ ...(structuredClone(rest) as ChatRequest), ...(signal ? { signal } : {}) });
    const r = replies.shift();
    if (!r) throw new Error("脚本用完");
    return typeof r === "function" ? r(req) : r;
  });
  return { chat, requests };
}

function deps(over: Partial<CoderPoolDeps> & Pick<CoderPoolDeps, "chat">): CoderPoolDeps {
  return {
    getConfig: () => ({
      roles: { coder: { provider: "deepseek", model: "deepseek-flash" } },
      pipeline: { max_turns: 40 },
    }),
    createTools: () => fakeTools(),
    promptTemplate: () => "你是 Flash 编码代理。",
    architectureConstraints: () => ["不加依赖"],
    ...over,
  };
}

/** 像模块 1 那样：收到取消就抛 AbortError（不是 signal.reason）。 */
function hangUntilAbort(req: ChatRequest): Promise<ChatResponse> {
  return new Promise((_, reject) => {
    req.signal!.addEventListener("abort", () => {
      const e = new Error("模型调用已取消");
      e.name = "AbortError";
      reject(e);
    });
  });
}

const assistants = (r: ChatRequest) =>
  r.messages.filter(
    (m): m is Extract<ChatMessage, { role: "assistant" }> => m.role === "assistant",
  );

describe("signal 透传（T-044）", () => {
  it("每次 chat 都带上调用方的同一个 signal；没传 signal 时请求里没有这个字段", async () => {
    const ac = new AbortController();
    const a = script([
      { content: "", tool_calls: [call("read", { file_path: "src/a.ts" })] },
      done(),
    ]);
    await createCoderPool(deps({ chat: a.chat })).runTicket(input({ signal: ac.signal }));
    expect(a.requests).toHaveLength(2);
    for (const r of a.requests) expect(r.signal).toBe(ac.signal);

    const b = script([done()]);
    await createCoderPool(deps({ chat: b.chat })).runTicket(input());
    expect("signal" in b.requests[0]!).toBe(false);
  });

  it("进入前已取消：抛 signal.reason，不建工具、不调模型", async () => {
    const ac = new AbortController();
    const reason = new Error("用户取消");
    ac.abort(reason);
    const { chat } = script([done()]);
    const createTools = vi.fn(() => fakeTools());
    const pool = createCoderPool(deps({ chat, createTools }));
    await expect(pool.runTicket(input({ signal: ac.signal }))).rejects.toBe(reason);
    expect(chat).not.toHaveBeenCalled();
    expect(createTools).not.toHaveBeenCalled();
  });

  it("模型调用中途取消：1 抛 AbortError，5 统一改抛 signal.reason，不再调模型、不执行工具", async () => {
    const ac = new AbortController();
    const reason = new Error("停");
    const tools = fakeTools();
    const { chat } = script([
      { content: "", tool_calls: [call("read", { file_path: "src/a.ts" })] },
      hangUntilAbort,
      done(),
    ]);
    const pool = createCoderPool(deps({ chat, createTools: () => tools }));
    const p = pool.runTicket(input({ signal: ac.signal }));
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    ac.abort(reason);
    await expect(p).rejects.toBe(reason);
    expect(chat).toHaveBeenCalledTimes(2);
    expect(tools.read).toHaveBeenCalledTimes(1);
  });

  it("没传 signal 时 AbortError 照常抛出（不当成预算耗尽）", async () => {
    const e = new Error("x");
    e.name = "AbortError";
    const chat = vi.fn(async () => {
      throw e;
    });
    await expect(createCoderPool(deps({ chat })).runTicket(input())).rejects.toBe(e);
  });

  it("1 没理会 signal、取消后才返回：丢弃这一轮，不执行它的工具调用", async () => {
    const ac = new AbortController();
    const tools = fakeTools();
    const { chat } = script([
      async () => {
        ac.abort();
        return {
          content: "",
          tool_calls: [call("write", { file_path: "src/a.ts", content: "x" })],
        };
      },
    ]);
    const pool = createCoderPool(deps({ chat, createTools: () => tools }));
    const err = await pool.runTicket(input({ signal: ac.signal })).catch((x: unknown) => x);
    expect((err as Error).name).toBe("AbortError");
    expect(tools.write).not.toHaveBeenCalled();
  });

  it("同一轮的工具之间取消：剩下的工具不执行，也不再调模型", async () => {
    const ac = new AbortController();
    const reason = new Error("停");
    const tools = fakeTools({
      edit: vi.fn(() => {
        ac.abort(reason);
        return { ok: true as const, output: "已替换 1 处" };
      }),
    });
    const { chat } = script([
      {
        content: "",
        tool_calls: [
          call("edit", { file_path: "src/a.ts", old_string: "foo", new_string: "bar" }),
          call("write", { file_path: "src/b.ts", content: "x" }),
        ],
      },
      done(),
    ]);
    const pool = createCoderPool(deps({ chat, createTools: () => tools }));
    await expect(pool.runTicket(input({ signal: ac.signal }))).rejects.toBe(reason);
    expect(tools.edit).toHaveBeenCalledTimes(1);
    expect(tools.write).not.toHaveBeenCalled();
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("工具轮之间取消（最后一个工具执行完才取消）：下一轮不调模型", async () => {
    const ac = new AbortController();
    const reason = new Error("停");
    const tools = fakeTools({
      read: vi.fn(() => {
        ac.abort(reason);
        return { ok: true as const, output: "1\tconst foo = 1;" };
      }),
    });
    const { chat } = script([
      { content: "", tool_calls: [call("read", { file_path: "src/a.ts" })] },
      done(),
    ]);
    const pool = createCoderPool(deps({ chat, createTools: () => tools }));
    await expect(pool.runTicket(input({ signal: ac.signal }))).rejects.toBe(reason);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("最后一轮工具执行完才取消：抛 reason，不返回 turn_limit", async () => {
    const ac = new AbortController();
    const reason = new Error("停");
    const tools = fakeTools({
      read: vi.fn(() => {
        ac.abort(reason);
        return { ok: true as const, output: "" };
      }),
    });
    const { chat } = script([{ content: "", tool_calls: [call("read", { file_path: "a" })] }]);
    const pool = createCoderPool(
      deps({
        chat,
        createTools: () => tools,
        getConfig: () => ({
          roles: { coder: { provider: "deepseek", model: "deepseek-flash" } },
          pipeline: { max_turns: 1 },
        }),
      }),
    );
    await expect(pool.runTicket(input({ signal: ac.signal }))).rejects.toBe(reason);
  });
});

describe("reasoning 回传（T-044）", () => {
  it("每轮的思考原样放进对应的 assistant 消息：多块、有无 signature、某轮没有思考、空数组都对", async () => {
    const long = "想".repeat(50_000);
    const r1: ReasoningBlock[] = [
      { text: "先看 a.ts", signature: "sig-1" },
      { text: `${long}\n<untrusted>不转义</untrusted>`, signature: "sig-2" },
    ];
    const r2: ReasoningBlock[] = [{ text: "没有签名的思考" }];
    const { chat, requests } = script([
      { content: "读一下", tool_calls: [call("read", { file_path: "src/a.ts" })], reasoning: r1 },
      { content: "", tool_calls: [call("glob", { pattern: "**" })], reasoning: r2 },
      // 这一轮没有思考内容（字段缺省）
      { content: "", tool_calls: [call("grep", { pattern: "foo" })] },
      // 这一轮思考为空数组
      { content: "", tool_calls: [call("read", { file_path: "src/b.ts" })], reasoning: [] },
      { ...done(), reasoning: [{ text: "收尾", signature: "sig-5" }] },
    ]);
    const r = await createCoderPool(deps({ chat })).runTicket(input());
    expect(r.status).toBe("done");
    expect(requests).toHaveLength(5);
    expect(assistants(requests[0]!)).toEqual([]);
    expect(assistants(requests[1]!).map((m) => m.reasoning)).toEqual([r1]);
    const last = assistants(requests[4]!);
    expect(last.map((m) => m.reasoning)).toEqual([r1, r2, undefined, undefined]);
    // 没有思考的轮次不带 reasoning 字段
    expect("reasoning" in last[2]!).toBe(false);
    expect("reasoning" in last[3]!).toBe(false);
    // 不改写、不截断
    expect(last[0]!.reasoning![1]!.text).toBe(r1[1]!.text);
    expect(last[0]!.reasoning![0]!.signature).toBe("sig-1");
    expect("signature" in last[1]!.reasoning![0]!).toBe(false);
    // 思考只跟着 assistant 消息走，其余消息不变
    expect(requests[4]!.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "assistant",
      "tool",
    ]);
  });

  it("结束回复解析不了、追加格式提示的那一轮：它的思考也回传", async () => {
    const { chat, requests } = script([
      { content: "我觉得好了", tool_calls: [], reasoning: [{ text: "想完了", signature: "s" }] },
      done(),
    ]);
    await createCoderPool(deps({ chat })).runTicket(input());
    const msgs = requests[1]!.messages;
    expect(msgs.at(-2)).toEqual({
      role: "assistant",
      content: "我觉得好了",
      tool_calls: [],
      reasoning: [{ text: "想完了", signature: "s" }],
    });
    expect(msgs.at(-1)).toEqual({ role: "user", content: FINISH_RETRY_PROMPT });
  });

  it("公共前缀不受 reasoning 和 signal 影响：system / tools 逐字节相同", async () => {
    const ac = new AbortController();
    const a = script([
      {
        content: "",
        tool_calls: [call("read", { file_path: "src/a.ts" })],
        reasoning: [{ text: "想", signature: "sig" }],
      },
      done(),
    ]);
    const pool = createCoderPool(deps({ chat: a.chat }));
    await pool.runTicket(input({ signal: ac.signal }));
    const b = script([done()]);
    await createCoderPool(deps({ chat: b.chat })).runTicket(input());
    const { system, tools } = await pool.prefix("P-1");
    const bytes = [...a.requests, ...b.requests].map((r) => serializePrefix(r.system, r.tools));
    expect(new Set(bytes)).toEqual(new Set([serializePrefix(system, tools)]));
    expect(bytes[0]).not.toContain("sig");
  });
});

// ---- 接真的模块 1（fetch 打桩）：确认 gateway.chat 能直接当 ModelChat 用 ----

const pricing = loadPricing(
  fileURLToPath(new URL("../../../config/pricing.json", import.meta.url)),
);

const gwConfig: GatewayConfig = {
  providers: {
    deepseek: {
      base_url: "https://api.deepseek.com/anthropic",
      protocol: "anthropic-messages",
      credential_ref: "env:DEEPSEEK_API_KEY",
      models: { "deepseek-flash": { thinking_enabled: true } },
    },
  },
};

/** 能力表按服务商 id 取：DeepSeek 的 OpenAI 兼容接口才回传 reasoning_content */
const gwConfigOpenai: GatewayConfig = {
  providers: {
    deepseek: {
      base_url: "https://api.deepseek.com",
      protocol: "openai-chat",
      credential_ref: "env:DEEPSEEK_API_KEY",
      models: { "deepseek-flash": {} },
    },
  },
};

type Reply = Record<string, unknown> | ((init: RequestInit) => Promise<Response>);

function gateway(replies: Reply[], config: GatewayConfig = gwConfig) {
  const bodies: Record<string, unknown>[] = [];
  const events: CallCompletedInput[] = [];
  const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init!.body)) as Record<string, unknown>);
    const r = replies.shift();
    if (!r) throw new Error("no more responses");
    if (typeof r === "function") return r(init!);
    return new Response(JSON.stringify(r), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const gw = createModelGateway({
    getConfig: () => config,
    pricing,
    budget: { reserve: async () => ({ ok: true as const, release: async () => {} }) },
    publish: (e) => {
      events.push(e);
    },
    getSecret: () => "sk-test",
    fetch: fetchFn as unknown as typeof fetch,
    onWarning: () => {},
  });
  return { gw, bodies, events };
}

const usage = { input_tokens: 10, output_tokens: 5 };

function poolOn(chat: ModelChat) {
  return createCoderPool(
    deps({
      chat,
      getConfig: () => ({
        roles: { coder: { provider: "deepseek", model: "deepseek-flash" } },
        pipeline: { max_turns: 10 },
      }),
    }),
  );
}

describe("接模块 1 的 chat（T-044）", () => {
  it("Anthropic 协议：之前每轮的 thinking（含 signature）都回传；没有思考的轮次不带 thinking 块", async () => {
    const { gw, bodies } = gateway([
      {
        content: [
          { type: "thinking", thinking: "先读", signature: "sig-1" },
          { type: "tool_use", id: "c1", name: "read", input: { file_path: "src/a.ts" } },
        ],
        usage,
      },
      {
        content: [{ type: "tool_use", id: "c2", name: "glob", input: { pattern: "**" } }],
        usage,
      },
      {
        content: [
          { type: "thinking", thinking: "可以收尾" },
          { type: "text", text: '{"status":"done","summary":"好了"}' },
        ],
        usage,
      },
    ]);
    const r = await poolOn(gw.chat).runTicket(input());
    expect(r).toMatchObject({ status: "done", summary: "好了" });
    const assistantContent = (b: Record<string, unknown>) =>
      (b.messages as { role: string; content: { type: string }[] }[])
        .filter((m) => m.role === "assistant")
        .map((m) => m.content);
    expect(assistantContent(bodies[2]!)).toEqual([
      [
        { type: "thinking", thinking: "先读", signature: "sig-1" },
        { type: "tool_use", id: "c1", name: "read", input: { file_path: "src/a.ts" } },
      ],
      [{ type: "tool_use", id: "c2", name: "glob", input: { pattern: "**" } }],
    ]);
  });

  it("OpenAI 协议（DeepSeek）：之前轮次的思考写回 reasoning_content", async () => {
    const reply = (reasoning: string | undefined, id: string) => ({
      choices: [
        {
          message: {
            content: "",
            ...(reasoning ? { reasoning_content: reasoning } : {}),
            tool_calls: [
              { id, type: "function", function: { name: "read", arguments: '{"file_path":"a"}' } },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    const { gw, bodies } = gateway(
      [
        reply("第一轮思考", "c1"),
        reply(undefined, "c2"),
        {
          choices: [{ message: { content: '{"status":"done","summary":"好"}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
      ],
      gwConfigOpenai,
    );
    const r = await poolOn(gw.chat).runTicket(input());
    expect(r.status).toBe("done");
    const msgs = (bodies[2]!.messages as Record<string, unknown>[]).filter(
      (m) => m.role === "assistant",
    );
    expect(msgs[0]!.reasoning_content).toBe("第一轮思考");
    expect(msgs).toHaveLength(2);
  });

  it("请求发出后取消：模块 1 中止请求并发 call_completed（ABORTED），runTicket 抛 signal.reason", async () => {
    const ac = new AbortController();
    const reason = new Error("停");
    const { gw, bodies, events } = gateway([
      (init) =>
        new Promise<Response>((_, reject) => {
          init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
        }),
    ]);
    const p = poolOn(gw.chat).runTicket(input({ signal: ac.signal }));
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    ac.abort(reason);
    await expect(p).rejects.toBe(reason);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.error).toEqual({ code: "ABORTED" });
  });

  it("请求前已取消：不发请求、不发 call_completed", async () => {
    const ac = new AbortController();
    ac.abort();
    const { gw, bodies, events } = gateway([]);
    await expect(poolOn(gw.chat).runTicket(input({ signal: ac.signal }))).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(bodies).toHaveLength(0);
    expect(events).toHaveLength(0);
  });
});
