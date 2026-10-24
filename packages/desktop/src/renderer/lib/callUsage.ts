// UI-06e：主管对话 spinner 的计时与调用结束后的 token / 费用。
// 数据只用已有事件：模块 1 的 call_completed（tokens.input + tokens.output、cost 微美元）；不改别的模块接口。
// 按回复的 requirement_id 精确对应（10 每条聊天消息生成新的 requirement_id，call_completed 信封带它），
// 只算不晚于回复到达的调用：立项后的拆单 / 评审 / 重拆用同一 id，但在回复之后，不计入，数字冻结。
import type { UiEvent } from "../../shared/api";

export const CALL_USAGE_COPY = {
  elapsed: (s: number) => `已用 ${s} 秒`,
  usage: (tokens: string, cost: string, calls: number) =>
    `本次 ${calls} 次调用 · ${tokens} tokens · ${cost}`,
} as const;

/** 统计范围：回复的 requirement_id，和回复到达的本地毫秒时间戳。 */
export interface CallScope {
  requirement_id: string;
  until: number;
}

export interface CallUsage {
  calls: number;
  tokens: number;
  cost_micro_usd: number;
}

export function summarizeCalls(events: readonly UiEvent[], scope: CallScope): CallUsage | null {
  let calls = 0;
  let tokens = 0;
  let cost = 0;
  for (const e of events) {
    if (e.type !== "call_completed" || e.payload.role !== "supervisor") continue;
    if (e.requirement_id !== scope.requirement_id) continue;
    if (!(Date.parse(e.ts) <= scope.until)) continue;
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
