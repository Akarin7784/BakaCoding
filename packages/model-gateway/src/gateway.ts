import { randomUUID } from "node:crypto";
import {
  computeCost,
  getSecret as defaultGetSecret,
  SECRET_NAMES,
  type Pricing,
  type SecretName,
} from "@bakacoding/config-budget";
import {
  CallCtxSchema,
  EffortSchema,
  RoleSchema,
  type CallCtx,
  type Effort,
  type EventOf,
  type Role,
} from "@bakacoding/types";
import { capabilitiesFor, mapEffort, type Capabilities, type Protocol } from "./capabilities.js";
import { abortError, BudgetExceededError, isAbortError, ModelGatewayError } from "./errors.js";
import { RateLimiter, realClock, type Clock, type RateLimitOptions } from "./rate-limit.js";
import type {
  CallResult,
  ChatRequest,
  ChatResult,
  RateLimitState,
  RateLimitTarget,
  Tokens,
} from "./types.js";
import {
  anthropicAdapter,
  checkToolPairing,
  classifyError,
  openaiAdapter,
  type ProtocolAdapter,
} from "./wire.js";

/** 读到的配置子集；模块 3 的 Config 在结构上满足它。 */
export interface GatewayConfig {
  providers: Record<
    string,
    {
      base_url: string;
      protocol: Protocol;
      credential_ref: string;
      models: Record<string, { thinking_enabled?: boolean }>;
    }
  >;
}

/** 只用到 budgetState 的这几个字段；模块 3 的 Budget 在结构上满足它。 */
export interface GatewayBudget {
  budgetState(ticket_id?: string): Promise<{
    daily_exhausted: boolean;
    ticket?: { exhausted: boolean };
  }>;
}

type CallCompleted = EventOf<"call_completed">;
/** 与模块 0 的 PublishInput 兼容：seq / event_id / ts 由总线补。 */
export type CallCompletedInput = Omit<CallCompleted, "seq" | "event_id" | "ts">;

export interface EffortWarning {
  provider: string;
  model: string;
  requested: Effort;
  effort: Effort;
  message: string;
}

export interface CreateModelGatewayOptions {
  getConfig: () => GatewayConfig;
  pricing: Pricing;
  budget: GatewayBudget;
  /** 发 call_completed；通常是总线的 publish */
  publish: (event: CallCompletedInput) => unknown;
  /** 默认用模块 3 的 getSecret（只读 DEEPSEEK_API_KEY 等环境变量） */
  getSecret?: (name: SecretName) => string;
  fetch?: typeof fetch;
  clock?: Partial<Clock>;
  rateLimit?: RateLimitOptions;
  /** 覆盖能力表里的 max_tokens 默认值 */
  maxTokens?: number;
  /** 降档警告，默认 console.warn */
  onWarning?: (w: EffortWarning) => void;
  /** 发 call_completed 失败（调用本身已成功），默认 console.error */
  onPublishError?: (error: unknown) => void;
  newId?: () => string;
}

export interface ModelGateway {
  chat(req: ChatRequest): Promise<ChatResult>;
  /** 单轮调用：chat 的包装，prompt 作为唯一一条 user 消息 */
  call(
    role: Role,
    provider: string,
    model: string,
    effort: Effort,
    prompt: string,
    ctx: CallCtx,
    options?: { signal?: AbortSignal },
  ): Promise<CallResult>;
  rateLimitState(target?: RateLimitTarget): RateLimitState;
  capabilities(provider: string): Capabilities;
}

const ADAPTERS: Record<Protocol, ProtocolAdapter> = {
  "anthropic-messages": anthropicAdapter,
  "openai-chat": openaiAdapter,
};
const ZERO: Tokens = { input: 0, output: 0, cache_hit_input: 0 };

export function createModelGateway(opts: CreateModelGatewayOptions): ModelGateway {
  const clock: Clock = { ...realClock, ...opts.clock };
  const limiter = new RateLimiter(opts.rateLimit ?? {}, clock);
  const doFetch = opts.fetch ?? globalThis.fetch;
  const getSecret = opts.getSecret ?? ((n: SecretName) => defaultGetSecret(n));
  const newId = opts.newId ?? randomUUID;
  const warn = opts.onWarning ?? ((w: EffortWarning) => console.warn(`[model-gateway] ${w.message}`));
  const onPublishError =
    opts.onPublishError ?? ((e: unknown) => console.error("[model-gateway] call_completed 发布失败", e));

  function providerConf(provider: string) {
    const p = opts.getConfig().providers[provider];
    if (!p) throw new ModelGatewayError(`配置里没有服务商 ${provider}`, "CONFIG");
    return p;
  }

  function capabilities(provider: string): Capabilities {
    return capabilitiesFor(provider, providerConf(provider).protocol);
  }

  function apiKey(credential_ref: string): string {
    const name = credential_ref.startsWith("env:") ? credential_ref.slice(4) : "";
    if (!(SECRET_NAMES as readonly string[]).includes(name))
      throw new ModelGatewayError(`不支持的凭据引用 ${credential_ref}`, "CONFIG");
    return getSecret(name as SecretName);
  }

  async function publishCompleted(
    req: ChatRequest,
    effort: Effort,
    prompt: string,
    output: string,
    stats: { tokens: Tokens; latency_ms: number; cost: number; rate_limited_retry: number },
  ) {
    const ctx = req.ctx;
    try {
      await opts.publish({
        type: "call_completed",
        trace_id: ctx.trace.trace_id,
        // 每次调用是需求单 span 下的一个子 span
        span_id: newId(),
        parent_span_id: ctx.trace.span_id,
        requirement_id: ctx.requirement_id,
        ticket_id: ctx.ticket_id,
        payload: {
          role: req.role,
          provider: req.provider,
          model: req.model,
          effort,
          prompt,
          output,
          tokens: stats.tokens,
          cache_hit: stats.tokens.cache_hit_input > 0,
          latency_ms: stats.latency_ms,
          cost: stats.cost,
          is_resubmit: ctx.is_resubmit,
          rate_limited_retry: stats.rate_limited_retry,
        },
      });
    } catch (e) {
      onPublishError(e);
    }
  }

  async function run(req: ChatRequest, promptText?: string): Promise<ChatResult> {
    // ---- 校验（不发请求、不发事件） ----
    const ctx = CallCtxSchema.parse(req.ctx);
    RoleSchema.parse(req.role);
    EffortSchema.parse(req.effort);
    if (ctx.role !== req.role)
      throw new TypeError(`role（${req.role}）与 ctx.role（${ctx.role}）不一致`);
    const conf = providerConf(req.provider);
    const modelConf = conf.models[req.model];
    if (!modelConf)
      throw new ModelGatewayError(`服务商 ${req.provider} 下没有配置模型 ${req.model}`, "CONFIG");
    if (!opts.pricing.models[req.model])
      throw new ModelGatewayError(`pricing.json 里没有模型 ${req.model} 的单价`, "CONFIG");
    checkToolPairing(req.messages);
    const caps = capabilitiesFor(req.provider, conf.protocol);
    const mapped = mapEffort(caps, req.effort, modelConf.thinking_enabled ?? true);
    if (mapped.warning)
      warn({
        provider: req.provider,
        model: req.model,
        requested: req.effort,
        effort: mapped.effort,
        message: `${req.provider}/${req.model}：${mapped.warning}`,
      });
    const effort = mapped.effort;
    req.signal?.throwIfAborted();

    // ---- 预算：调用前查 3 ----
    const state = await opts.budget.budgetState(ctx.ticket_id ?? undefined);
    if (state.daily_exhausted) throw new BudgetExceededError("daily", "当日预算已用完");
    if (state.ticket?.exhausted)
      throw new BudgetExceededError("ticket", `需求单 ${ctx.ticket_id} 的预算已用完`);

    const key = apiKey(conf.credential_ref);
    const adapter = ADAPTERS[conf.protocol];
    const http = adapter.build(
      {
        base_url: conf.base_url,
        api_key: key,
        model: req.model,
        effort,
        max_tokens: opts.maxTokens ?? caps.default_max_tokens,
        system: req.system,
        tools: req.tools,
        messages: req.messages,
      },
      caps,
    );
    const scrub = (s: string) => (key ? s.split(key).join("***") : s);
    const prompt = promptText ?? JSON.stringify({ system: req.system, messages: req.messages });
    const startedAt = new Date(clock.now());
    let retries = 0;
    const elapsed = () => Math.max(0, Math.round(clock.now() - startedAt.getTime()));

    try {
      for (;;) {
        await limiter.acquire(req.provider, req.signal);
        let res: Response;
        try {
          res = await doFetch(http.url, {
            method: "POST",
            headers: http.headers,
            body: JSON.stringify(http.body),
            redirect: "error",
            ...(req.signal ? { signal: req.signal } : {}),
          });
        } catch (e) {
          if (isAbortError(e) || req.signal?.aborted) throw e;
          throw new ModelGatewayError(scrub(`请求服务商失败：${(e as Error).message}`), "NETWORK");
        }
        if (!res.ok) {
          const text = await res.text();
          let raw: unknown;
          try {
            raw = JSON.parse(text);
          } catch {
            // 网关返回非 JSON 时以 HTTP 状态为准
          }
          const c = classifyError(res.status, raw, res.headers);
          if (c.code === "RATE_LIMIT") {
            const wait = limiter.backoff(retries + 1, c.retryAfterMs);
            limiter.mark429(req.provider, req.model, wait);
            if (retries < limiter.maxRetries) {
              retries += 1;
              await limiter.sleep(wait, req.signal);
              continue;
            }
          }
          throw new ModelGatewayError(scrub(c.message), c.code, res.status);
        }
        let json: unknown;
        try {
          json = await res.json();
        } catch (e) {
          if (isAbortError(e) || req.signal?.aborted) throw e;
          throw new ModelGatewayError("服务商返回的不是 JSON", "BAD_RESPONSE", res.status);
        }
        const parsed = adapter.parse(json);
        const tokens = parsed.tokens ?? ZERO;
        const cost = computeCost(opts.pricing, req.model, tokens, startedAt).cost_micro_usd;
        const stats = {
          tokens,
          cache_hit: tokens.cache_hit_input > 0,
          latency_ms: elapsed(),
          cost,
          rate_limited_retry: retries,
        };
        const names = parsed.tool_calls.map((c) => c.name);
        const output =
          promptText !== undefined || names.length === 0
            ? parsed.content
            : `${parsed.content}\n[tool_calls] ${names.join(", ")}`;
        await publishCompleted(req, effort, prompt, output, stats);
        return { ...parsed, tool_calls: parsed.tool_calls, ...stats, effort };
      }
    } catch (e) {
      // 已经开始调用：失败或取消也发 call_completed，用量未知时按 0 记
      await publishCompleted(req, effort, prompt, "", {
        tokens: ZERO,
        latency_ms: elapsed(),
        cost: 0,
        rate_limited_retry: retries,
      });
      if (isAbortError(e) || req.signal?.aborted) throw abortError(e);
      throw e;
    }
  }

  return {
    chat: (req) => run(req),
    async call(role, provider, model, effort, prompt, ctx, options) {
      const r = await run(
        {
          role,
          provider,
          model,
          effort,
          system: "",
          tools: [],
          messages: [{ role: "user", content: prompt }],
          ctx,
          ...(options?.signal ? { signal: options.signal } : {}),
        },
        prompt,
      );
      return {
        output: r.content,
        tokens: r.tokens,
        cache_hit: r.cache_hit,
        latency_ms: r.latency_ms,
        cost: r.cost,
        rate_limited_retry: r.rate_limited_retry,
      };
    },
    rateLimitState: (target) => limiter.state(target),
    capabilities,
  };
}
