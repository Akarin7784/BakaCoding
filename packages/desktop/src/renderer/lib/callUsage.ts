// UI-06e：主管对话 spinner 的计时与调用结束后的 token / 费用。
// 数据只用已有事件：模块 1 的 call_completed（tokens.input + tokens.output、cost 微美元）；不改别的模块接口。
// 10 的 chat() 回复里没有用量，所以按「本次等待的时间窗口内、role = supervisor 的 call_completed」汇总。
import type { UiEvent } from "../../shared/api";

export const CALL_USAGE_COPY = {
  elapsed: (s: number) => `已用 ${s} 秒`,
  usage: (tokens: string, cost: string, calls: number) =>
    `本次约 ${calls} 次调用 · ${tokens} tokens · ${cost}`,
} as const;

/** 本次等待的时间窗口（本地毫秒时间戳）。 */
export interface CallWindow {
  from: number;
  to: number;
}

export interface CallUsage {
  calls: number;
  tokens: number;
  cost_micro_usd: number;
}

/** 事件时间戳和本地时钟差一点也能落进窗口：两端各放宽 1 秒。 */
export const CALL_WINDOW_SLACK_MS = 1000;

export function summarizeCalls(events: readonly UiEvent[], w: CallWindow): CallUsage | null {
  let calls = 0;
  let tokens = 0;
  let cost = 0;
  for (const e of events) {
    if (e.type !== "call_completed" || e.payload.role !== "supervisor") continue;
    const t = Date.parse(e.ts);
    if (!(t >= w.from - CALL_WINDOW_SLACK_MS && t <= w.to + CALL_WINDOW_SLACK_MS)) continue;
    calls += 1;
    tokens += e.payload.tokens.input + e.payload.tokens.output;
    cost += e.payload.cost;
  }
  return calls ? { calls, tokens, cost_micro_usd: cost } : null;
}

export const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** 微美元 → 美元，4 位小数（单次调用常见是几十到几千微美元）。 */
export function fmtCost(micro: number): string {
  const v = Number.isFinite(micro) && micro > 0 ? micro : 0;
  return `$${(v / 1_000_000).toFixed(4)}`;
}

export function usageLine(u: CallUsage): string {
  return CALL_USAGE_COPY.usage(fmtTokens(u.tokens), fmtCost(u.cost_micro_usd), u.calls);
}
