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
  type Parsed,
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
      request_timeout_ms?: number;
      models: Record<string, { thinking_enabled?: boolean; max_tokens?: number }>;
    }
  >;
}

/** 只用到 reserve；模块 3 的 Budget 在结构上满足它。 */
export interface GatewayBudget {
  reserve(req: {
    ticket_id: string | null;
    amount_micro_usd: number;
  }): Promise<{ ok: true; release(): Promise<void> } | { ok: false; scope: "daily" | "ticket" }>;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;
const RETRY_STATUS = new Set([500, 502, 503, 504]);

type CallCompleted = EventOf<"call_completed">;
/** 与模块 0 的 PublishInput 兼容：seq / event_id / ts 由总线补。payload.error 成功为 null，失败为 { code }。 */
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
  const warn =
    opts.onWarning ?? ((w: EffortWarning) => console.warn(`[model-gateway] ${w.message}`));
  const onPublishError =
    opts.onPublishError ??
    ((e: unknown) => console.error("[model-gateway] call_completed 发布失败", e));

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
    error: { code: string } | null,
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
          error,
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

    const key = apiKey(conf.credential_ref);
    const maxTokens =
      modelConf.max_tokens ??
      (conf.protocol === "anthropic-messages" ? caps.default_max_tokens : undefined);
    const adapter = ADAPTERS[conf.protocol];
    const http = adapter.build(
      {
        base_url: conf.base_url,
        api_key: key,
        model: req.model,
        effort,
        // Anthropic 协议 max_tokens 必填：一律传（配置值，没配就用能力表输出上限）；OpenAI 协议填了才传
        ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
        system: req.system,
        tools: req.tools,
        messages: req.messages,
      },
      caps,
    );
    const body = JSON.stringify(http.body);

    // ---- 预算：按「输入估算 + 输出上限」预占，结束后按实际费用结算 ----
    // 输入按请求体字符数估（每个字符最多算一个 token，偏高），按未命中价；输出按 max_tokens（没配就按能力表默认值）
    const estimate = computeCost(
      opts.pricing,
      req.model,
      {
        input: body.length,
        output: modelConf.max_tokens ?? caps.default_max_tokens,
        cache_hit_input: 0,
      },
      new Date(clock.now()),
    ).cost_micro_usd;
    const scrub = (s: string) => (key ? s.split(key).join("***") : s);
    // prompt 记全部模型输入；本轮回复的思考内容也只记在这里（桌面会遮蔽 prompt），不进 output
    const promptOf = (reasoning: readonly { text: string; signature?: string }[]) => {
      if (promptText !== undefined)
        return reasoning.length
          ? `${promptText}\n\n[reasoning]\n${reasoning.map((r) => r.text).join("\n")}`
          : promptText;
      return JSON.stringify({
        system: req.system,
        messages: req.messages,
        ...(reasoning.length ? { reply_reasoning: reasoning } : {}),
      });
    };
    const timeoutMs = conf.request_timeout_ms ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const startedAt = new Date(clock.now());
    const elapsed = () => Math.max(0, Math.round(clock.now() - startedAt.getTime()));
    let retries = 0;
    let rateLimited = 0;
    let sent = false;
    // 回复里已经拿到的用量：之后才失败也按实际 token 计费
    let tokens: Tokens = ZERO;
    let reasoning: Parsed["reasoning"] = [];

    const hold = await opts.budget.reserve({
      ticket_id: ctx.ticket_id,
      amount_micro_usd: estimate,
    });
    if (!hold.ok)
      throw hold.scope === "daily"
        ? new BudgetExceededError("daily", "当日预算已用完")
        : new BudgetExceededError("ticket", `需求单 ${ctx.ticket_id} 的预算已用完`);

    // 预占成功后立刻进 try：之后任何失败、取消、异常都在 finally 里退还
    try {
      for (;;) {
        req.signal?.throwIfAborted();
        await limiter.acquire(req.provider, req.signal);
        const timeout = new AbortController();
        const cancelTimer = clock.setTimer(timeoutMs, () => timeout.abort());
        const signal = req.signal ? AbortSignal.any([req.signal, timeout.signal]) : timeout.signal;
        let failure: { error: ModelGatewayError; retryAfterMs?: number; retryable: boolean };
        let json: unknown;
        try {
          sent = true;
          const res = await doFetch(http.url, {
            method: "POST",
            headers: http.headers,
            body,
            redirect: "error",
            signal,
          });
          if (res.ok) {
            json = await res.json();
          } else {
            const text = await res.text();
            let raw: unknown;
            try {
              raw = JSON.parse(text);
            } catch {
              // 网关返回非 JSON 时以 HTTP 状态为准
            }
            const c = classifyError(res.status, raw, res.headers);
            throw Object.assign(new ModelGatewayError(scrub(c.message), c.code, res.status), {
              retryAfterMs: c.retryAfterMs,
              retryable: c.code === "RATE_LIMIT" || RETRY_STATUS.has(res.status),
            });
          }
        } catch (e) {
          if (req.signal?.aborted) throw e;
          if (e instanceof ModelGatewayError) {
            const x = e as ModelGatewayError & { retryAfterMs?: number; retryable?: boolean };
            failure = {
              error: x,
              ...(x.retryAfterMs !== undefined ? { retryAfterMs: x.retryAfterMs } : {}),
              retryable: x.retryable ?? false,
            };
          } else if (timeout.signal.aborted) {
            failure = {
              error: new ModelGatewayError(`请求服务商超时（${timeoutMs}ms）`, "NETWORK"),
              retryable: true,
            };
          } else if (e instanceof SyntaxError) {
            failure = {
              error: new ModelGatewayError("服务商返回的不是 JSON", "BAD_RESPONSE"),
              retryable: false,
            };
          } else {
            failure = {
              error: new ModelGatewayError(
                scrub(`请求服务商失败：${(e as Error).message}`),
                "NETWORK",
              ),
              retryable: true,
            };
          }
        } finally {
          cancelTimer();
        }

        if (json !== undefined) {
          tokens = adapter.usage(json) ?? ZERO;
          const parsed = adapter.parse(json);
          reasoning = parsed.reasoning;
          const cost = computeCost(opts.pricing, req.model, tokens, startedAt).cost_micro_usd;
          const stats = {
            tokens,
            cache_hit: tokens.cache_hit_input > 0,
            latency_ms: elapsed(),
            cost,
            rate_limited_retry: rateLimited,
          };
          const names = parsed.tool_calls.map((c) => c.name);
          const output =
            promptText !== undefined || names.length === 0
              ? parsed.content
              : `${parsed.content}\n[tool_calls] ${names.join(", ")}`;
          await publishCompleted(req, effort, promptOf(parsed.reasoning), output, stats, null);
          return { ...parsed, ...stats, effort };
        }

        const f = failure!;
        if (f.error.code === "RATE_LIMIT") {
          const wait = limiter.backoff(retries + 1, f.retryAfterMs);
          limiter.mark429(req.provider, req.model, wait);
        }
        if (!f.retryable || retries >= limiter.maxRetries) throw f.error;
        retries += 1;
        if (f.error.code === "RATE_LIMIT") rateLimited += 1;
        // 每次重试前检查 signal：sleep 收到取消会立刻 reject
        await limiter.sleep(limiter.backoff(retries, f.retryAfterMs), req.signal);
      }
    } catch (e) {
      const aborted = isAbortError(e) || req.signal?.aborted === true;
      // 请求一次都没发出去就取消：不发 call_completed
      if (sent) {
        const code = aborted ? "ABORTED" : e instanceof ModelGatewayError ? e.code : "BAD_RESPONSE";
        let cost = 0;
        try {
          cost = computeCost(opts.pricing, req.model, tokens, startedAt).cost_micro_usd;
        } catch {
          // 用量本身不合法时按 0 记，错误码已经标明失败
        }
        await publishCompleted(
          req,
          effort,
          promptOf(reasoning),
          "",
          { tokens, latency_ms: elapsed(), cost, rate_limited_retry: rateLimited },
          { code },
        );
      }
      if (aborted) throw abortError(e);
      throw e;
    } finally {
      // call_completed 发布时总线会等台账写完，所以释放放在最后
      // release 自身出错不能盖住原始错误
      try {
        await hold.release();
      } catch (e) {
        warn({
          provider: req.provider,
          model: req.model,
          requested: req.effort,
          effort,
          message: `${req.provider}/${req.model}：释放预算预占失败：${e instanceof Error ? e.message : String(e)}`,
        });
      }
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
