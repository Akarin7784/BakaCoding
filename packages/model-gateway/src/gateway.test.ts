import { fileURLToPath } from "node:url";
import { computeCost, loadPricing } from "@bakacoding/config-budget";
import type { CallCtx } from "@bakacoding/types";
import { describe, expect, it, vi } from "vitest";
import {
  BudgetExceededError,
  createModelGateway,
  mapEffort,
  DEEPSEEK_ANTHROPIC,
  OPENAI_CHAT,
  ModelGatewayError,
  RateLimiter,
  type CallCompletedInput,
  type ChatMessage,
  type GatewayConfig,
} from "./index.js";

const pricing = loadPricing(
  fileURLToPath(new URL("../../../config/pricing.json", import.meta.url)),
);
const KEY = "sk-test-secret-123";
// 周六 UTC 12:00：闲时
const T0 = Date.parse("2026-10-17T12:00:00Z");

const config: GatewayConfig = {
  providers: {
    deepseek: {
      base_url: "https://api.deepseek.com/anthropic",
      protocol: "anthropic-messages",
      credential_ref: "env:DEEPSEEK_API_KEY",
      models: {
        "deepseek-flash": { thinking_enabled: true },
        "deepseek-v4-pro": { thinking_enabled: false },
      },
    },
    oai: {
      base_url: "https://example.test/v1/",
      protocol: "openai-chat",
      credential_ref: "env:DEEPSEEK_API_KEY",
      models: { "deepseek-flash": {} },
    },
  },
};

const ctx = (over: Partial<CallCtx> = {}): CallCtx => ({
  role: "coder",
  requirement_id: "R-1",
  ticket_id: "T-1",
  is_resubmit: false,
  trace: { trace_id: "tr", span_id: "sp", parent_span_id: null },
  ...over,
});

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const anthropicOk = (over: Record<string, unknown> = {}) =>
  json(200, {
    content: [
      { type: "thinking", thinking: "想一想", signature: "sig" },
      { type: "text", text: "先读文件" },
      { type: "tool_use", id: "c1", name: "read", input: { file_path: "a.ts" } },
    ],
    usage: { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 50 },
    ...over,
  });

function setup(
  opts: {
    responses?: (Response | Error)[];
    budget?: { daily_exhausted: boolean; ticket?: { exhausted: boolean } };
    rateLimit?: ConstructorParameters<typeof RateLimiter>[0];
  } = {},
) {
  const events: CallCompletedInput[] = [];
  const requests: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  const sleeps: number[] = [];
  let now = T0;
  const queue = [...(opts.responses ?? [anthropicOk()])];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init!, body: JSON.parse(String(init!.body)) });
    now += 1234;
    const next = queue.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  });
  const warnings: string[] = [];
  const budgetState = vi.fn(async () => opts.budget ?? { daily_exhausted: false });
  const gw = createModelGateway({
    getConfig: () => config,
    pricing,
    budget: { budgetState },
    publish: (e) => {
      events.push(e);
    },
    getSecret: () => KEY,
    fetch: fetchFn as unknown as typeof fetch,
    clock: {
      now: () => now,
      random: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    },
    ...(opts.rateLimit ? { rateLimit: opts.rateLimit } : {}),
    onWarning: (w) => warnings.push(w.message),
    newId: () => "span-new",
  });
  return { gw, events, requests, sleeps, fetchFn, warnings, budgetState };
}

const baseReq = {
  role: "coder" as const,
  provider: "deepseek",
  model: "deepseek-flash",
  effort: "low" as const,
  system: "SYS",
  tools: [{ name: "read", description: "Read a file", input_schema: { type: "object" } }],
  messages: [{ role: "user", content: "改 a.ts" }] as ChatMessage[],
};

describe("chat：DeepSeek Anthropic 兼容接口", () => {
  it("请求体：档位写 output_config.effort，工具和 system 放对位置，带 x-api-key", async () => {
    const { gw, requests } = setup();
    await gw.chat({ ...baseReq, ctx: ctx() });
    const r = requests[0]!;
    expect(r.url).toBe("https://api.deepseek.com/anthropic/v1/messages");
    expect((r.init.headers as Record<string, string>)["x-api-key"]).toBe(KEY);
    expect(r.body).toMatchObject({
      model: "deepseek-flash",
      stream: false,
      max_tokens: 256_000,
      system: "SYS",
      thinking: { type: "enabled" },
      output_config: { effort: "low" },
      tools: [{ name: "read", description: "Read a file", input_schema: { type: "object" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "改 a.ts" }] }],
    });
    expect(r.body).not.toHaveProperty("budget_tokens");
  });

  it("off 档：thinking disabled，不带 output_config", async () => {
    const { gw, requests } = setup();
    await gw.chat({ ...baseReq, effort: "off", ctx: ctx() });
    expect(requests[0]!.body.thinking).toEqual({ type: "disabled" });
    expect(requests[0]!.body).not.toHaveProperty("output_config");
  });

  it("历史：工具调用与结果、思考内容回传、结果排在 user 消息最前", async () => {
    const { gw, requests } = setup();
    await gw.chat({
      ...baseReq,
      messages: [
        { role: "user", content: "改 a.ts" },
        {
          role: "assistant",
          content: "读一下",
          tool_calls: [{ id: "c1", name: "read", input: { file_path: "a.ts" } }],
          reasoning: [{ text: "先读", signature: "s1" }],
        },
        { role: "tool", tool_call_id: "c1", name: "read", content: "内容", is_error: false },
        { role: "system", content: "注意格式" },
      ],
      ctx: ctx(),
    });
    expect(requests[0]!.body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "改 a.ts" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "先读", signature: "s1" },
          { type: "text", text: "读一下" },
          { type: "tool_use", id: "c1", name: "read", input: { file_path: "a.ts" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "c1",
            content: [{ type: "text", text: "内容" }],
            is_error: false,
          },
        ],
      },
      { role: "system", content: [{ type: "text", text: "注意格式" }] },
    ]);
  });

  it("返回内容、工具调用、思考；token 含缓存命中，费用按 pricing.json 计", async () => {
    const { gw } = setup();
    const r = await gw.chat({ ...baseReq, ctx: ctx() });
    expect(r.content).toBe("先读文件");
    expect(r.tool_calls).toEqual([{ id: "c1", name: "read", input: { file_path: "a.ts" } }]);
    expect(r.reasoning).toEqual([{ text: "想一想", signature: "sig" }]);
    expect(r.tokens).toEqual({ input: 1000, output: 50, cache_hit_input: 900 });
    expect(r.cache_hit).toBe(true);
    expect(r.cost).toBe(
      computeCost(pricing, "deepseek-flash", r.tokens, new Date(T0)).cost_micro_usd,
    );
    expect(r.latency_ms).toBe(1234);
    expect(r.rate_limited_retry).toBe(0);
    expect(r.effort).toBe("low");
  });

  it("call_completed：子 span；prompt 含 messages 和本轮思考，output 只有回复文字加工具名", async () => {
    const { gw, events } = setup();
    const r = await gw.chat({ ...baseReq, ctx: ctx() });
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e).toMatchObject({
      type: "call_completed",
      trace_id: "tr",
      span_id: "span-new",
      parent_span_id: "sp",
      requirement_id: "R-1",
      ticket_id: "T-1",
    });
    expect(e.payload).toMatchObject({
      role: "coder",
      provider: "deepseek",
      model: "deepseek-flash",
      effort: "low",
      output: "先读文件\n[tool_calls] read",
      tokens: r.tokens,
      cost: r.cost,
      is_resubmit: false,
      rate_limited_retry: 0,
    });
    const prompt = JSON.parse(e.payload.prompt);
    expect(prompt.system).toBe("SYS");
    expect(prompt.messages).toEqual(baseReq.messages);
    expect(prompt.reply_reasoning).toEqual([{ text: "想一想", signature: "sig" }]);
    expect(e.payload.output).not.toContain("想一想");
    expect(JSON.stringify(e)).not.toContain(KEY);
  });
});

describe("档位映射", () => {
  it("能力表：DeepSeek 四档都支持；OpenAI 兼容 max 降到 high 并警告", () => {
    expect(mapEffort(DEEPSEEK_ANTHROPIC, "max")).toEqual({ effort: "max" });
    const m = mapEffort(OPENAI_CHAT, "max");
    expect(m.effort).toBe("high");
    expect(m.warning).toContain("max");
  });

  it("模型关了思考：只能 off，降档并警告，不报错", async () => {
    const { gw, requests, warnings } = setup();
    const r = await gw.chat({ ...baseReq, model: "deepseek-v4-pro", effort: "high", ctx: ctx() });
    expect(r.effort).toBe("off");
    expect(requests[0]!.body.thinking).toEqual({ type: "disabled" });
    expect(warnings[0]).toContain("deepseek-v4-pro");
  });

  it("capabilities(provider)", () => {
    const { gw } = setup();
    expect(gw.capabilities("deepseek").effort_field).toBe("output_config.effort");
    expect(gw.capabilities("oai").effort_field).toBe("reasoning_effort");
    expect(() => gw.capabilities("nope")).toThrow(ModelGatewayError);
  });
});

describe("chat：OpenAI 兼容接口", () => {
  it("reasoning_effort、Bearer、工具调用解析、cached_tokens", async () => {
    const { gw, requests, warnings } = setup({
      responses: [
        json(200, {
          choices: [
            {
              message: {
                content: null,
                reasoning_content: "r",
                tool_calls: [
                  {
                    id: "x",
                    type: "function",
                    function: { name: "grep", arguments: '{"pattern":"a"}' },
                  },
                ],
              },
            },
          ],
          usage: {
            prompt_tokens: 200,
            completion_tokens: 10,
            prompt_tokens_details: { cached_tokens: 150 },
          },
        }),
      ],
    });
    const r = await gw.chat({ ...baseReq, provider: "oai", effort: "max", ctx: ctx() });
    const q = requests[0]!;
    expect(q.url).toBe("https://example.test/v1/chat/completions");
    expect((q.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(q.body.reasoning_effort).toBe("high");
    expect(q.body.messages).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "改 a.ts" },
    ]);
    expect(q.body.tools).toEqual([
      {
        type: "function",
        function: { name: "read", description: "Read a file", parameters: { type: "object" } },
      },
    ]);
    expect(warnings).toHaveLength(1);
    expect(r.tool_calls).toEqual([{ id: "x", name: "grep", input: { pattern: "a" } }]);
    expect(r.reasoning).toEqual([{ text: "r" }]);
    expect(r.tokens).toEqual({ input: 200, output: 10, cache_hit_input: 150 });
  });
});

describe("预算", () => {
  it("当日预算用完：抛 BUDGET_EXCEEDED，不发请求也不发事件", async () => {
    const { gw, fetchFn, events } = setup({ budget: { daily_exhausted: true } });
    const p = gw.chat({ ...baseReq, ctx: ctx() });
    await expect(p).rejects.toBeInstanceOf(BudgetExceededError);
    await expect(p).rejects.toMatchObject({ code: "BUDGET_EXCEEDED", scope: "daily" });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it("本单预算用完：按 ticket_id 查", async () => {
    const { gw, budgetState } = setup({
      budget: { daily_exhausted: false, ticket: { exhausted: true } },
    });
    await expect(gw.chat({ ...baseReq, ctx: ctx() })).rejects.toMatchObject({
      code: "BUDGET_EXCEEDED",
      scope: "ticket",
    });
    expect(budgetState).toHaveBeenCalledWith("T-1");
  });

  it("没有单号（主管）：不传 ticket_id", async () => {
    const { gw, budgetState } = setup();
    await gw.call(
      "supervisor",
      "deepseek",
      "deepseek-flash",
      "max",
      "hi",
      ctx({ role: "supervisor", ticket_id: null }),
    );
    expect(budgetState).toHaveBeenCalledWith(undefined);
  });
});

describe("429 与限流", () => {
  it("429 指数退避后成功：rate_limited_retry 计数，retry-after 取较大值，rateLimitState 按模型记", async () => {
    const { gw, sleeps, events } = setup({
      responses: [
        json(429, { error: { type: "rate_limit_error", message: "slow down" } }),
        json(
          429,
          { error: { type: "rate_limit_error", message: "slow down" } },
          { "retry-after": "10" },
        ),
        anthropicOk(),
      ],
    });
    const r = await gw.chat({ ...baseReq, ctx: ctx() });
    expect(r.rate_limited_retry).toBe(2);
    expect(sleeps).toEqual([1000, 10_000]);
    expect(events[0]!.payload.rate_limited_retry).toBe(2);
    const s = gw.rateLimitState({ provider: "deepseek", model: "deepseek-flash" });
    expect(s.models[0]).toMatchObject({
      provider: "deepseek",
      model: "deepseek-flash",
      rate_limited_total: 2,
    });
    expect(
      gw.rateLimitState({ provider: "deepseek", model: "deepseek-v4-pro" }).models[0],
    ).toMatchObject({
      limited: false,
      rate_limited_total: 0,
    });
  });

  it("超过重试上限：抛 RATE_LIMIT，仍发 call_completed（费用 0），退避期内 limited", async () => {
    const r429 = () => json(429, { error: { type: "rate_limit_error", message: "x" } });
    const { gw, events } = setup({
      responses: [r429(), r429(), r429()],
      rateLimit: { max_retries: 2 },
    });
    await expect(gw.chat({ ...baseReq, ctx: ctx() })).rejects.toMatchObject({
      code: "RATE_LIMIT",
      status: 429,
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ cost: 0, output: "", rate_limited_retry: 2 });
    expect(
      gw.rateLimitState({ provider: "deepseek", model: "deepseek-flash" }).models[0]!.limited,
    ).toBe(true);
  });

  it("令牌桶按服务商共享：容量用完后排队，补充后放行", async () => {
    const lim = new RateLimiter(
      { capacity: 1, refill_per_sec: 50 },
      { now: Date.now, random: () => 0, sleep: async () => {} },
    );
    await lim.acquire("deepseek");
    let done = false;
    const p = lim.acquire("deepseek").then(() => (done = true));
    expect(lim.state({ provider: "deepseek" }).buckets[0]!.waiting).toBe(1);
    expect(done).toBe(false);
    await p;
    expect(done).toBe(true);
  });

  it("排队时取消：出队并 reject", async () => {
    const lim = new RateLimiter(
      { capacity: 1, refill_per_sec: 0.001 },
      { now: Date.now, random: () => 0, sleep: async () => {} },
    );
    await lim.acquire("p");
    const ac = new AbortController();
    const p = lim.acquire("p", ac.signal);
    ac.abort();
    await expect(p).rejects.toBeTruthy();
    expect(lim.state({ provider: "p" }).buckets[0]!.waiting).toBe(0);
  });
});

describe("取消与错误", () => {
  it("请求中途取消：抛 AbortError，仍发 call_completed", async () => {
    const ac = new AbortController();
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    const { gw, events } = setup({ responses: [abortErr] });
    ac.abort();
    // 先放行一次：signal 在 acquire 前已取消也应抛 AbortError
    await expect(gw.chat({ ...baseReq, ctx: ctx(), signal: ac.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    const ac2 = new AbortController();
    const s2 = setup({ responses: [abortErr] });
    const p = s2.gw.chat({ ...baseReq, ctx: ctx(), signal: ac2.signal });
    ac2.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(s2.events).toHaveLength(1);
    expect(s2.events[0]!.payload).toMatchObject({ cost: 0, output: "" });
    expect(events).toHaveLength(0);
  });

  it("401：AUTH，错误信息里不带密钥", async () => {
    const { gw } = setup({
      responses: [
        json(401, { error: { type: "authentication_error", message: `bad key ${KEY}` } }),
      ],
    });
    const p = gw.chat({ ...baseReq, ctx: ctx() });
    await expect(p).rejects.toMatchObject({ code: "AUTH", status: 401 });
    await expect(p).rejects.not.toThrow(KEY);
  });

  it("入参校验：role 与 ctx.role 不一致、未配置的模型、工具结果不配对", async () => {
    const { gw, fetchFn } = setup();
    await expect(gw.chat({ ...baseReq, ctx: ctx({ role: "reviewer" }) })).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(gw.chat({ ...baseReq, model: "gpt-x", ctx: ctx() })).rejects.toMatchObject({
      code: "CONFIG",
    });
    await expect(
      gw.chat({
        ...baseReq,
        messages: [
          { role: "user", content: "x" },
          { role: "assistant", content: "", tool_calls: [{ id: "c1", name: "read", input: {} }] },
        ],
        ctx: ctx(),
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("call()：单轮包装", () => {
  it("output 只有回复文字，prompt 原文记录（本轮思考追加在 prompt 里）", async () => {
    const { gw, events, requests } = setup();
    const r = await gw.call(
      "reviewer",
      "deepseek",
      "deepseek-flash",
      "high",
      "评审这个 diff",
      ctx({ role: "reviewer" }),
    );
    expect(r.output).toBe("先读文件");
    expect(Object.keys(r).sort()).toEqual([
      "cache_hit",
      "cost",
      "latency_ms",
      "output",
      "rate_limited_retry",
      "tokens",
    ]);
    expect(requests[0]!.body).not.toHaveProperty("tools");
    expect(requests[0]!.body).not.toHaveProperty("system");
    expect(events[0]!.payload.prompt).toBe("评审这个 diff\n\n[reasoning]\n想一想");
    expect(events[0]!.payload.output).toBe("先读文件");
  });
});
