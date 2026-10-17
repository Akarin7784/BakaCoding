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
  } = {},
) {
  const events: CallCompletedInput[] = [];
  const bodies: Record<string, unknown>[] = [];
  const warnings: string[] = [];
  const holds: { ticket_id: string | null; amount_micro_usd: number; released: number }[] = [];
  const queue = [...(o.responses ?? [ok()])];
  let now = Date.parse("2026-10-17T12:00:00Z");
  const fetchFn = vi.fn(async (_u: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init!.body)));
    now += 100;
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
      sleep: async () => {},
      setTimer: () => () => {},
    },
    onWarning: (w) => warnings.push(w.message),
  });
  return { gw, events, bodies, warnings, holds, reserve, fetchFn };
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
    expect(s.holds[0]!.released).toBe(1);
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
});
