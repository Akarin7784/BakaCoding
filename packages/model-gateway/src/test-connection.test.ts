import { fileURLToPath } from "node:url";
import { loadPricing } from "@bakacoding/config-budget";
import { describe, expect, it, vi } from "vitest";
import {
  createModelGateway,
  PROVIDER_TEST_REQUIREMENT_ID,
  type CallCompletedInput,
  type GatewayConfig,
} from "./index.js";

// T-089：测试连接。
const pricing = loadPricing(
  fileURLToPath(new URL("../../../config/pricing.json", import.meta.url)),
);
const KEY = "sk-test-T089-connection-0123456789";

const config: GatewayConfig = {
  providers: {
    deepseek: {
      base_url: "https://api.deepseek.com/anthropic",
      protocol: "anthropic-messages",
      credential_ref: "env:DEEPSEEK_API_KEY",
      models: { "deepseek-flash": { thinking_enabled: true, max_tokens: 8000 } },
    },
    oai: {
      base_url: "https://example.test/v1/",
      protocol: "openai-chat",
      credential_ref: "env:DEEPSEEK_API_KEY",
      models: { "deepseek-flash": {} },
    },
    empty: {
      base_url: "https://example.test/v1/",
      protocol: "openai-chat",
      credential_ref: "env:DEEPSEEK_API_KEY",
      models: {},
    },
  },
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ok = () =>
  json(200, {
    content: [{ type: "text", text: "p" }],
    usage: { input_tokens: 5, output_tokens: 1 },
  });

function setup(
  o: {
    responses?: (Response | Error)[];
    budget?: { ok: false; scope: "daily" | "ticket" };
    getSecret?: () => string;
    /** 请求挂住，直到 signal 取消才 reject（模拟请求途中取消） */
    hang?: boolean;
  } = {},
) {
  const events: CallCompletedInput[] = [];
  const bodies: Record<string, unknown>[] = [];
  const warnings: string[] = [];
  const sleeps: number[] = [];
  const holds: { ticket_id: string | null; amount_micro_usd: number; released: number }[] = [];
  const queue = [...(o.responses ?? [ok()])];
  let now = Date.parse("2026-10-17T12:00:00Z");
  let onSent: () => void = () => {};
  const sent = new Promise<void>((r) => (onSent = r));
  const fetchFn = vi.fn(async (_u: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init!.body)));
    now += 100;
    onSent();
    if (o.hang) {
      return await new Promise<Response>((_, reject) => {
        const sig = init!.signal!;
        if (sig.aborted) reject(sig.reason);
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    }
    const next = queue.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  });
  const reserve = vi.fn(async (r: { ticket_id: string | null; amount_micro_usd: number }) => {
    if (o.budget) return o.budget;
    const h = { ...r, released: 0 };
    holds.push(h);
    return { ok: true as const, release: async () => void (h.released += 1) };
  });
  const gw = createModelGateway({
    getConfig: () => config,
    pricing,
    budget: { reserve },
    publish: (e) => void events.push(e),
    getSecret: o.getSecret ?? (() => KEY),
    fetch: fetchFn as unknown as typeof fetch,
    clock: {
      now: () => now,
      random: () => 0,
      sleep: async (ms: number) => void sleeps.push(ms),
      setTimer: () => () => {},
    },
    onWarning: (w) => warnings.push(w.message),
  });
  return { gw, events, bodies, warnings, holds, reserve, fetchFn, sent, sleeps };
}

describe("testConnection", () => {
  it("成功：只发一个请求，max_tokens 1、关思考；预占按 1 个输出估；记台账，记在主管名下", async () => {
    const s = setup();
    const r = await s.gw.testConnection({ provider: "deepseek" });
    expect(r).toMatchObject({ ok: true });
    expect(r.ok && r.cost_micro_usd).toBeGreaterThan(0);
    expect(s.fetchFn).toHaveBeenCalledTimes(1);
    expect(s.bodies[0]).toMatchObject({
      model: "deepseek-flash",
      max_tokens: 1,
      thinking: { type: "disabled" },
    });
    expect(s.reserve).toHaveBeenCalledTimes(1);
    expect(s.holds[0]!.ticket_id).toBeNull();
    expect(s.holds[0]!.released).toBe(1);
    expect(s.events).toHaveLength(1);
    const e = s.events[0]!;
    expect(e.requirement_id).toBe(PROVIDER_TEST_REQUIREMENT_ID);
    expect(e.ticket_id).toBeNull();
    expect(e.payload.role).toBe("supervisor");
    expect(e.payload.error).toBeNull();
    expect(JSON.stringify(s.events)).not.toContain(KEY);
    expect(s.warnings).toEqual([]);
  });

  it("预占按 max_tokens 1 估，比按配置的 8000 小得多", async () => {
    const s = setup();
    await s.gw.testConnection({ provider: "deepseek" });
    const tiny = s.holds[0]!.amount_micro_usd;
    const s2 = setup();
    await s2.gw.chat({
      role: "supervisor",
      provider: "deepseek",
      model: "deepseek-flash",
      effort: "off",
      system: "",
      tools: [],
      messages: [{ role: "user", content: "ping" }],
      ctx: {
        role: "supervisor",
        requirement_id: "R",
        ticket_id: null,
        is_resubmit: false,
        trace: { trace_id: "t", span_id: "s", parent_span_id: null },
      },
    });
    expect(tiny).toBeLessThan(s2.holds[0]!.amount_micro_usd / 100);
  });

  it("OpenAI 协议也传 max_tokens 1", async () => {
    const s = setup({
      responses: [
        json(200, {
          choices: [{ message: { content: "p" } }],
          usage: { prompt_tokens: 5, completion_tokens: 1 },
        }),
      ],
    });
    expect((await s.gw.testConnection({ provider: "oai", model: "deepseek-flash" })).ok).toBe(true);
    expect(s.bodies[0]).toMatchObject({ max_tokens: 1 });
  });

  it("预算不够 → budget_exhausted，不发请求、不报连接失败", async () => {
    const s = setup({ budget: { ok: false, scope: "daily" } });
    expect(await s.gw.testConnection({ provider: "deepseek" })).toEqual({
      ok: false,
      reason: "budget_exhausted",
    });
    expect(s.fetchFn).not.toHaveBeenCalled();
    expect(s.events).toHaveLength(0);
  });

  it("没有密钥 → no_secret，不预占、不发请求", async () => {
    const s = setup({
      getSecret: () => {
        throw new Error("缺少环境变量 DEEPSEEK_API_KEY");
      },
    });
    expect(await s.gw.testConnection({ provider: "deepseek" })).toEqual({
      ok: false,
      reason: "no_secret",
    });
    expect(s.reserve).not.toHaveBeenCalled();
    expect(s.fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    [401, { error: { type: "authentication_error", message: `bad key ${KEY}` } }, "auth_failed"],
    [402, { error: { message: "Insufficient Balance" } }, "quota_exhausted"],
    [429, { error: { type: "rate_limit_error", message: "slow" } }, "rate_limited"],
    [400, { error: { type: "invalid_request_error", message: "bad" } }, "http_error"],
    [500, { error: { message: "oops" } }, "http_error"],
  ] as const)("HTTP %i → %s，带 status，不重试，失败也记台账", async (status, body, reason) => {
    const s = setup({ responses: [json(status, body), ok(), ok()] });
    const r = await s.gw.testConnection({ provider: "deepseek" });
    expect(r).toEqual({ ok: false, reason: expect.any(String), status });
    expect(r.ok === false && r.reason).toBe(reason);
    expect(s.fetchFn).toHaveBeenCalledTimes(1);
    expect(s.events).toHaveLength(1);
    expect(s.events[0]!.payload.error).not.toBeNull();
    expect(JSON.stringify(r)).not.toContain(KEY);
    // T-111：台账事件里也不能有密钥（401 的服务商报错里带了密钥）
    expect(JSON.stringify(s.events)).not.toContain(KEY);
    expect(s.holds[0]!.released).toBe(1);
  });

  it("401 报错带密钥：台账事件和结果里都没有密钥", async () => {
    const s = setup({
      responses: [
        json(401, { error: { type: "authentication_error", message: `invalid key ${KEY}` } }),
      ],
    });
    expect(await s.gw.testConnection({ provider: "deepseek" })).toEqual({
      ok: false,
      reason: "auth_failed",
      status: 401,
    });
    expect(s.events).toHaveLength(1);
    expect(s.events[0]!.payload.error).toMatchObject({ code: "AUTH" });
    expect(JSON.stringify(s.events)).not.toContain(KEY);
    expect(JSON.stringify(s.events)).not.toContain(KEY.slice(-12));
  });

  it("429 只记入共享退避状态：rateLimitState 显示该模型在退避中", async () => {
    const s = setup({
      responses: [
        new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "slow" } }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "5" },
        }),
      ],
    });
    const target = { provider: "deepseek", model: "deepseek-flash" };
    expect(s.gw.rateLimitState(target).models).toEqual([
      expect.objectContaining({ limited: false, rate_limited_total: 0 }),
    ]);
    expect(await s.gw.testConnection({ provider: "deepseek" })).toMatchObject({
      ok: false,
      reason: "rate_limited",
      status: 429,
    });
    // 与正式调用共用同一份账号级退避状态（retry-after 5s）
    expect(s.gw.rateLimitState(target).models).toEqual([
      expect.objectContaining({ limited: true, until: expect.any(String), rate_limited_total: 1 }),
    ]);
  });

  it("网络错误 → network，不重试", async () => {
    const s = setup({ responses: [new TypeError("fetch failed"), ok()] });
    expect(await s.gw.testConnection({ provider: "deepseek" })).toEqual({
      ok: false,
      reason: "network",
    });
    expect(s.fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ provider: "nope" }],
    [{ provider: "empty" }],
    [{ provider: "deepseek", model: "unknown-model" }],
  ])("配置不对 → config_error：%j", async (t) => {
    const s = setup();
    expect(await s.gw.testConnection(t)).toEqual({ ok: false, reason: "config_error" });
    expect(s.fetchFn).not.toHaveBeenCalled();
  });

  it("取消 → 抛 AbortError", async () => {
    const s = setup();
    const ac = new AbortController();
    ac.abort();
    await expect(
      s.gw.testConnection({ provider: "deepseek" }, { signal: ac.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(s.fetchFn).not.toHaveBeenCalled();
  });

  it("429 不阻塞后续请求：退避期内再测一次照常发出，不等待", async () => {
    const s = setup({
      responses: [
        new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "slow" } }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "30" },
        }),
        ok(),
      ],
    });
    expect(await s.gw.testConnection({ provider: "deepseek" })).toMatchObject({
      reason: "rate_limited",
    });
    const target = { provider: "deepseek", model: "deepseek-flash" };
    expect(s.gw.rateLimitState(target).models[0]).toMatchObject({ limited: true });
    expect(await s.gw.testConnection({ provider: "deepseek" })).toMatchObject({ ok: true });
    expect(s.fetchFn).toHaveBeenCalledTimes(2);
    expect(s.sleeps).toEqual([]);
  });

  it("请求途中取消 → 抛 AbortError；只发过一次请求，记一条 ABORTED 台账，释放预占", async () => {
    const s = setup({ hang: true });
    const ac = new AbortController();
    const p = s.gw.testConnection({ provider: "deepseek" }, { signal: ac.signal });
    await s.sent;
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(s.fetchFn).toHaveBeenCalledTimes(1);
    expect(s.events).toHaveLength(1);
    expect(s.events[0]!.requirement_id).toBe(PROVIDER_TEST_REQUIREMENT_ID);
    expect(s.events[0]!.payload.error).toMatchObject({ code: "ABORTED" });
    expect(JSON.stringify(s.events)).not.toContain(KEY);
    expect(s.holds).toHaveLength(1);
    expect(s.holds[0]!.released).toBe(1);
  });
});
