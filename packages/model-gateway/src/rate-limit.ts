import type { RateLimitEntry, RateLimitState, RateLimitTarget } from "./types.js";

export interface RateLimitOptions {
  /** 每个服务商（账号）桶容量，默认 8 */
  capacity?: number;
  /** 每秒补充令牌数，默认 4 */
  refill_per_sec?: number;
  /** 429、500/502/503/504、连接错误和超时合计最多重试次数，默认 3 */
  max_retries?: number;
  /** 指数退避基数，默认 1000ms：第 n 次重试等 base × 2^(n-1)，加 0~50% 抖动，上限 max_backoff_ms */
  base_backoff_ms?: number;
  /** 默认 60000ms */
  max_backoff_ms?: number;
}

export interface Clock {
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  random: () => number;
  /** 定时器（请求超时用），返回取消函数 */
  setTimer: (ms: number, fn: () => void) => () => void;
}

interface Bucket {
  tokens: number;
  last: number;
  waiters: { resolve: () => void; reject: (e: unknown) => void }[];
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * 令牌桶 + 429 退避状态。桶按服务商（即账号）全局共享，不按 key、项目或模型分；
 * 退避状态按 provider/model 记，供 rateLimitState({ provider, model }) 查询。
 */
export class RateLimiter {
  readonly capacity: number;
  readonly refillPerSec: number;
  readonly maxRetries: number;
  private readonly base: number;
  private readonly maxBackoff: number;
  private readonly buckets = new Map<string, Bucket>();
  private readonly models = new Map<string, { until: number; total: number }>();

  constructor(
    opts: RateLimitOptions,
    private readonly clock: Clock,
  ) {
    this.capacity = opts.capacity ?? 8;
    this.refillPerSec = opts.refill_per_sec ?? 4;
    this.maxRetries = opts.max_retries ?? 3;
    this.base = opts.base_backoff_ms ?? 1000;
    this.maxBackoff = opts.max_backoff_ms ?? 60_000;
    if (!(this.capacity >= 1) || !(this.refillPerSec > 0))
      throw new RangeError("令牌桶 capacity 必须 ≥ 1，refill_per_sec 必须 > 0");
  }

  private bucket(provider: string): Bucket {
    let b = this.buckets.get(provider);
    if (!b) {
      b = { tokens: this.capacity, last: this.clock.now(), waiters: [], timer: null };
      this.buckets.set(provider, b);
    }
    const now = this.clock.now();
    b.tokens = Math.min(this.capacity, b.tokens + ((now - b.last) / 1000) * this.refillPerSec);
    b.last = now;
    return b;
  }

  /** 取一个令牌；没有就排队（先来先得），signal 取消时出队并 reject。 */
  async acquire(provider: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const b = this.bucket(provider);
    if (b.waiters.length === 0 && b.tokens >= 1) {
      b.tokens -= 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const w = { resolve, reject };
      b.waiters.push(w);
      const onAbort = () => {
        const i = b.waiters.indexOf(w);
        if (i >= 0) b.waiters.splice(i, 1);
        reject(signal!.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      w.resolve = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      this.schedule(provider);
    });
  }

  private schedule(provider: string): void {
    const b = this.bucket(provider);
    while (b.waiters.length && b.tokens >= 1) {
      b.tokens -= 1;
      b.waiters.shift()!.resolve();
    }
    if (!b.waiters.length || b.timer) return;
    const wait = Math.ceil(((1 - b.tokens) / this.refillPerSec) * 1000);
    b.timer = setTimeout(() => {
      b.timer = null;
      this.schedule(provider);
    }, wait);
  }

  /** 第 attempt 次（从 1 起）重试前等多久；服务商给了 retry-after 就取两者较大值。 */
  backoff(attempt: number, retryAfterMs?: number): number {
    const exp = Math.min(this.maxBackoff, this.base * 2 ** (attempt - 1));
    const jittered = Math.min(this.maxBackoff, Math.round(exp * (1 + 0.5 * this.clock.random())));
    return Math.max(jittered, retryAfterMs ?? 0);
  }

  /** 记一次 429：该模型进入退避期到 now + waitMs。 */
  mark429(provider: string, model: string, waitMs: number): void {
    const key = `${provider}\u0000${model}`;
    const m = this.models.get(key) ?? { until: 0, total: 0 };
    m.total += 1;
    m.until = Math.max(m.until, this.clock.now() + waitMs);
    this.models.set(key, m);
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return this.clock.sleep(ms, signal);
  }

  state(target?: RateLimitTarget): RateLimitState {
    const now = this.clock.now();
    const models: RateLimitEntry[] = [];
    for (const [key, m] of this.models) {
      const [provider, model] = key.split("\u0000") as [string, string];
      if (target && (provider !== target.provider || (target.model && model !== target.model)))
        continue;
      const limited = m.until > now;
      models.push({
        provider,
        model,
        limited,
        until: limited ? new Date(m.until).toISOString() : null,
        rate_limited_total: m.total,
      });
    }
    if (target?.model && models.length === 0)
      models.push({
        provider: target.provider,
        model: target.model,
        limited: false,
        until: null,
        rate_limited_total: 0,
      });
    const providers = target ? [target.provider] : [...this.buckets.keys()];
    const buckets = providers.map((p) => {
      const b = this.bucket(p);
      return {
        provider: p,
        capacity: this.capacity,
        available: Math.floor(b.tokens),
        waiting: b.waiters.length,
      };
    });
    return { buckets, models };
  }
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimer: (ms, fn) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
  random: () => Math.random(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const t = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        reject(signal!.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
};
