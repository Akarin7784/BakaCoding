// UI-05c：「第 N 轮 / 上限」里的上限。
// 查证（8 副 Agent，packages/sub-agent/src/sub-agent.ts 的 loop()）：评审不过时先判
// `if (s.counts.review >= limit) return escalate(s, "review_limit")`，没到才 countResubmit → counts.review++ 再编码、再评审。
// limit = pipeline.resubmit_limits.review 是「复投次数」上限：第 1 轮是首评，最多再复投 limit 次，
// 所以评审最多 limit + 1 轮（默认 3 → 4 轮）。N = resubmit_count + 1，与之同一口径。
import type { DesktopModelConfigResult } from "../../shared/api";

/** 3 的 ConfigSchema 默认值（packages/config-budget/src/config.ts，resubmit_limits.review 默认 3）。 */
export const DEFAULT_REVIEW_RESUBMIT_LIMIT = 3;

/** 复投上限 → 评审轮次上限（+1，首评那一轮）。 */
export function reviewRoundLimit(resubmitLimit: number): number {
  return resubmitLimit + 1;
}

/** 从 settings:config-get 的结果取复投上限；读不到按默认值。 */
export function reviewResubmitLimitOf(r: DesktopModelConfigResult | null | undefined): number {
  const v = r?.ok ? r.pipeline?.resubmit_limits.review : undefined;
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : DEFAULT_REVIEW_RESUBMIT_LIMIT;
}
