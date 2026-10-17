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
  DEEPSEEK_OPENAI,
  DEFAULT_REQUEST_TIMEOUT_MS,
  realClock,
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
    responses?: (Response | Error | ((init: RequestInit) => Promise<Response>))[];
    config?: GatewayConfig;
    budget?: { ok: false; scope: "daily" | "ticket" };
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
    if (typeof next === "function") return next(init!);
    return next;
  });
  const warnings: string[] = [];
  const timers: { ms: number; fn: () => void }[] = [];
  let cancelled = 0;
  const releasedAtPublish: number[] = [];
  const holds: { ticket_id: string | null; amount_micro_usd: number; released: number }[] = [];
  const reserve = vi.fn(async (r: { ticket_id: string | null; amount_micro_usd: number }) => {
    if (opts.budget) return opts.budget;
    const h = { ...r, released: 0 };
    holds.push(h);
    return {
      ok: true as const,
      release: async () => {
        h.released += 1;
      },
    };
  });
  const gw = createModelGateway({
    getConfig: () => opts.config ?? config,
    pricing,
    budget: { reserve },
    publish: (e) => {
      events.push(e);
      releasedAtPublish.push(holds.reduce((a, h) => a + h.released, 0));
    },
    getSecret: () => KEY,
    fetch: fetchFn as unknown as typeof fetch,
    clock: {
      now: () => now,
      random: () => 0,
      sleep: async (ms, signal) => {
        signal?.throwIfAborted();
        sleeps.push(ms);
        now += ms;
      },
      setTimer: (ms, fn) => {
        timers.push({ ms, fn });
        return () => {
          cancelled += 1;
        };
      },
    },
    ...(opts.rateLimit ? { rateLimit: opts.rateLimit } : {}),
    onWarning: (w) => warnings.push(w.message),
    newId: () => "span-new",
  });
  return {
    gw,
    events,
    requests,
    sleeps,
    fetchFn,
    warnings,
    reserve,
    holds,
    releasedAtPublish,
    timers,
    cancelled: () => cancelled,
  };
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
      system: "SYS",
      thinking: { type: "enabled" },
      output_config: { effort: "low" },
      tools: [{ name: "read", description: "Read a file", input_schema: { type: "object" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "改 a.ts" }] }],
    });
    expect(r.body).not.toHaveProperty("budget_tokens");
    // 模型配置没填 max_tokens：不传，用服务端默认值
    expect(r.body).not.toHaveProperty("max_tokens");
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
    const { gw, fetchFn, events } = setup({ budget: { ok: false, scope: "daily" } });
    const p = gw.chat({ ...baseReq, ctx: ctx() });
    await expect(p).rejects.toBeInstanceOf(BudgetExceededError);
    await expect(p).rejects.toMatchObject({ code: "BUDGET_EXCEEDED", scope: "daily" });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it("本单预算用完：按 ticket_id 预占", async () => {
    const { gw, reserve } = setup({ budget: { ok: false, scope: "ticket" } });
    await expect(gw.chat({ ...baseReq, ctx: ctx() })).rejects.toMatchObject({
      code: "BUDGET_EXCEEDED",
      scope: "ticket",
    });
    expect(reserve.mock.calls[0]![0].ticket_id).toBe("T-1");
  });

  it("没有单号（主管）：ticket_id 为 null，只占每日预算", async () => {
    const { gw, reserve } = setup();
    await gw.call(
      "supervisor",
      "deepseek",
      "deepseek-flash",
      "max",
      "hi",
      ctx({ role: "supervisor", ticket_id: null }),
    );
    expect(reserve.mock.calls[0]![0].ticket_id).toBeNull();
  });

  it("预占 = 请求体字符数按未命中价 + 输出上限按输出价；发完事件后释放一次", async () => {
    const { gw, holds, requests, events, releasedAtPublish } = setup();
    const r = await gw.chat({ ...baseReq, ctx: ctx() });
    const bodyLen = String(requests[0]!.init.body).length;
    const expected = computeCost(
      pricing,
      "deepseek-flash",
      { input: bodyLen, output: DEEPSEEK_ANTHROPIC.default_max_tokens, cache_hit_input: 0 },
      new Date(T0),
    ).cost_micro_usd;
    expect(holds[0]!.amount_micro_usd).toBe(expected);
    expect(holds[0]!.amount_micro_usd).toBeGreaterThan(r.cost);
    // 发事件时还没释放（总线会等台账写完），之后释放一次
    expect(releasedAtPublish).toEqual([0]);
    expect(holds[0]!.released).toBe(1);
    expect(events).toHaveLength(1);
  });

  it("模型配了 max_tokens：请求里带上，预占按它估", async () => {
    const cfg: GatewayConfig = {
      providers: {
        deepseek: {
          ...config.providers.deepseek!,
          models: { "deepseek-flash": { max_tokens: 4096 } },
        },
      },
    };
    const { gw, holds, requests } = setup({ config: cfg });
    await gw.chat({ ...baseReq, ctx: ctx() });
    expect(requests[0]!.body.max_tokens).toBe(4096);
    const bodyLen = String(requests[0]!.init.body).length;
    expect(holds[0]!.amount_micro_usd).toBe(
      computeCost(
        pricing,
        "deepseek-flash",
        { input: bodyLen, output: 4096, cache_hit_input: 0 },
        new Date(T0),
      ).cost_micro_usd,
    );
  });

  it("失败也释放预占", async () => {
    const { gw, holds } = setup({ responses: [json(400, { error: { message: "bad" } })] });
    await expect(gw.chat({ ...baseReq, ctx: ctx() })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    expect(holds[0]!.released).toBe(1);
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
    expect(events[0]!.payload).toMatchObject({
      cost: 0,
      output: "",
      rate_limited_retry: 2,
      error: { code: "RATE_LIMIT" },
    });
    expect(
      gw.rateLimitState({ provider: "deepseek", model: "deepseek-flash" }).models[0]!.limited,
    ).toBe(true);
  });

  it("令牌桶按服务商共享：容量用完后排队，补充后放行", async () => {
    const lim = new RateLimiter(
      { capacity: 1, refill_per_sec: 50 },
      { ...realClock, random: () => 0, sleep: async () => {} },
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
      { ...realClock, random: () => 0, sleep: async () => {} },
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
  it("请求还没发出去就取消：抛 AbortError，不发 call_completed", async () => {
    const ac = new AbortController();
    ac.abort();
    const a = setup();
    await expect(a.gw.chat({ ...baseReq, ctx: ctx(), signal: ac.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    // chat() 返回后、fetch 之前取消
    const ac2 = new AbortController();
    const b = setup();
    const p = b.gw.chat({ ...baseReq, ctx: ctx(), signal: ac2.signal });
    ac2.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(a.fetchFn).not.toHaveBeenCalled();
    expect(b.fetchFn).not.toHaveBeenCalled();
    expect(a.events).toHaveLength(0);
    expect(b.events).toHaveLength(0);
    expect(b.holds[0]!.released).toBe(1);
  });

  it("请求中途取消：中止 HTTP 请求，抛 AbortError，发 call_completed（error ABORTED）", async () => {
    const ac = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const { gw, events } = setup({
      responses: [
        (init) =>
          new Promise<Response>((_, reject) => {
            seenSignal = init.signal!;
            init.signal!.addEventListener("abort", () =>
              reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            );
            ac.abort();
          }),
      ],
    });
    await expect(gw.chat({ ...baseReq, ctx: ctx(), signal: ac.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(seenSignal!.aborted).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ cost: 0, output: "", error: { code: "ABORTED" } });
  });

  it("重试前检查 signal：退避期间取消就不再发请求", async () => {
    const ac = new AbortController();
    const { gw, fetchFn, events } = setup({
      responses: [
        async () => {
          ac.abort();
          return json(503, { error: { message: "busy" } });
        },
        anthropicOk(),
      ],
    });
    await expect(gw.chat({ ...baseReq, ctx: ctx(), signal: ac.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(events[0]!.payload.error).toEqual({ code: "ABORTED" });
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

describe("重试：5xx、连接错误、超时", () => {
  it("500/502/503/504 重试后成功；rate_limited_retry 只数 429", async () => {
    const { gw, sleeps, events, fetchFn } = setup({
      responses: [
        json(503, { error: { message: "busy" } }),
        json(502, "bad gateway"),
        json(500, { error: { message: "oops" } }),
        anthropicOk(),
      ],
    });
    const r = await gw.chat({ ...baseReq, ctx: ctx() });
    expect(fetchFn).toHaveBeenCalledTimes(4);
    expect(sleeps).toEqual([1000, 2000, 4000]);
    expect(r.rate_limited_retry).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.error).toBeNull();
  });

  it("最多重试 3 次：第 4 次失败抛 SERVER，事件标 error", async () => {
    const r504 = () => json(504, { error: { message: "timeout" } });
    const { gw, fetchFn, events } = setup({ responses: [r504(), r504(), r504(), r504()] });
    await expect(gw.chat({ ...baseReq, ctx: ctx() })).rejects.toMatchObject({
      code: "SERVER",
      status: 504,
    });
    expect(fetchFn).toHaveBeenCalledTimes(4);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ cost: 0, error: { code: "SERVER" } });
  });

  it("429 与 5xx 合计算重试次数", async () => {
    const { gw, fetchFn } = setup({
      responses: [
        json(429, { error: { type: "rate_limit_error", message: "x" } }),
        json(503, {}),
        json(429, { error: { type: "rate_limit_error", message: "x" } }),
        json(503, {}),
      ],
    });
    await expect(gw.chat({ ...baseReq, ctx: ctx() })).rejects.toMatchObject({ status: 503 });
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it("响应到达前的连接错误重试；400 和 501 不重试", async () => {
    const ok = setup({ responses: [new TypeError("fetch failed"), anthropicOk()] });
    await ok.gw.chat({ ...baseReq, ctx: ctx() });
    expect(ok.fetchFn).toHaveBeenCalledTimes(2);

    const net = setup({
      responses: [1, 2, 3, 4].map(() => new TypeError(`connect ECONNREFUSED ${KEY}`)),
    });
    const p = net.gw.chat({ ...baseReq, ctx: ctx() });
    await expect(p).rejects.toMatchObject({ code: "NETWORK" });
    await expect(p).rejects.not.toThrow(KEY);
    expect(net.events[0]!.payload.error).toEqual({ code: "NETWORK" });

    for (const status of [400, 501]) {
      const s = setup({ responses: [json(status, { error: { message: "no" } }), anthropicOk()] });
      await expect(s.gw.chat({ ...baseReq, ctx: ctx() })).rejects.toBeInstanceOf(ModelGatewayError);
      expect(s.fetchFn).toHaveBeenCalledTimes(1);
    }
  });

  it("请求超时（默认 10 分钟，可按服务商配置）：中止请求，按连接错误重试", async () => {
    const hang = (init: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init.signal!.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      });
    const s = setup({ responses: [hang, anthropicOk()] });
    const p = s.gw.chat({ ...baseReq, ctx: ctx() });
    await vi.waitFor(() => expect(s.timers).toHaveLength(1));
    expect(s.timers[0]!.ms).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(600_000);
    s.timers[0]!.fn();
    const r = await p;
    expect(s.fetchFn).toHaveBeenCalledTimes(2);
    expect(r.content).toBe("先读文件");
    expect(s.cancelled()).toBe(2);

    const cfg: GatewayConfig = {
      providers: { deepseek: { ...config.providers.deepseek!, request_timeout_ms: 5000 } },
    };
    const t = setup({ config: cfg, responses: [hang] });
    const p2 = t.gw.chat({ ...baseReq, ctx: ctx() });
    p2.catch(() => {});
    await vi.waitFor(() => expect(t.timers).toHaveLength(1));
    expect(t.timers[0]!.ms).toBe(5000);
  });
});

describe("用量与失败计费", () => {
  it("Anthropic usage 换算：input = input_tokens + cache_read + cache_creation，cache_hit_input = cache_read，费用按命中 / 未命中两档", async () => {
    const { gw, events } = setup({
      responses: [
        anthropicOk({
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 900,
            cache_creation_input_tokens: 30,
            output_tokens: 50,
          },
        }),
      ],
    });
    const r = await gw.chat({ ...baseReq, ctx: ctx() });
    expect(r.tokens).toEqual({ input: 1030, output: 50, cache_hit_input: 900 });
    const rate = pricing.models["deepseek-flash"]!.offpeak;
    expect(r.cost).toBe(
      Math.ceil(
        (900 * rate.input_cache_hit + 130 * rate.input_cache_miss + 50 * rate.output) / 1e6,
      ),
    );
    expect(events[0]!.payload.tokens).toEqual(r.tokens);
    expect(events[0]!.payload.error).toBeNull();
  });

  it("回复里有用量、内容解析失败：抛 BAD_RESPONSE，按实际 token 计费", async () => {
    const { gw, events } = setup({
      responses: [
        json(200, {
          content: [{ type: "tool_use", name: "read" }],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      ],
    });
    await expect(gw.chat({ ...baseReq, ctx: ctx() })).rejects.toMatchObject({
      code: "BAD_RESPONSE",
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.tokens).toEqual({ input: 10, output: 5, cache_hit_input: 0 });
    expect(events[0]!.payload.cost).toBeGreaterThan(0);
    expect(events[0]!.payload.error).toEqual({ code: "BAD_RESPONSE" });
  });
});

describe("DeepSeek OpenAI 兼容接口", () => {
  it("thinking 开关、max 档、带 tools 时 assistant 回传 reasoning_content", async () => {
    const cfg: GatewayConfig = {
      providers: {
        deepseek: {
          base_url: "https://api.deepseek.com",
          protocol: "openai-chat",
          credential_ref: "env:DEEPSEEK_API_KEY",
          models: { "deepseek-flash": {} },
        },
      },
    };
    const { gw, requests, warnings } = setup({
      config: cfg,
      responses: [
        json(200, {
          choices: [{ message: { content: "ok", reasoning_content: "r2" } }],
          usage: { prompt_tokens: 20, completion_tokens: 3, prompt_cache_hit_tokens: 5 },
        }),
      ],
    });
    expect(gw.capabilities("deepseek")).toBe(DEEPSEEK_OPENAI);
    const r = await gw.chat({
      ...baseReq,
      effort: "max",
      messages: [
        { role: "user", content: "x" },
        {
          role: "assistant",
          content: "",
          reasoning: [{ text: "r1" }],
          tool_calls: [{ id: "c1", name: "read", input: {} }],
        },
        { role: "tool", tool_call_id: "c1", name: "read", content: "1", is_error: false },
      ],
      ctx: ctx(),
    });
    const body = requests[0]!.body;
    expect(requests[0]!.url).toBe("https://api.deepseek.com/chat/completions");
    expect(body).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "max" });
    expect(body).not.toHaveProperty("max_tokens");
    expect((body.messages as Record<string, unknown>[])[2]).toMatchObject({
      role: "assistant",
      reasoning_content: "r1",
    });
    expect(warnings).toHaveLength(0);
    expect(r.reasoning).toEqual([{ text: "r2" }]);
    expect(r.tokens).toEqual({ input: 20, output: 3, cache_hit_input: 5 });
  });

  it("通用 OpenAI 接口不带 thinking，也不回传 reasoning_content", async () => {
    const { gw, requests } = setup({
      responses: [json(200, { choices: [{ message: { content: "ok" } }] })],
    });
    await gw.chat({
      ...baseReq,
      provider: "oai",
      messages: [
        { role: "user", content: "x" },
        { role: "assistant", content: "a", reasoning: [{ text: "r1" }], tool_calls: [] },
        { role: "user", content: "y" },
      ],
      ctx: ctx(),
    });
    const body = requests[0]!.body;
    expect(body).not.toHaveProperty("thinking");
    expect((body.messages as Record<string, unknown>[])[2]).not.toHaveProperty("reasoning_content");
  });
});
