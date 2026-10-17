/**
 * 高风险 PR 裁决的错误码（T-041c）：9 的 `releaseHighRisk` / `rejectHighRisk` / `checkHighRisk` 和
 * 10 的 `decideHighRisk` 抛的 `HighRiskDecisionError` 都带其中一个，T-062 的界面按码出文案。
 * - `not_found`：9 里没登记这张单；
 * - `terminal`：单子已是终态（merged / escalated）；
 * - `gate_off`：高风险闸门没开（只在单独使用 9 时可能），不需要放行；
 * - `not_high_risk`：不是高风险单；
 * - `not_held`：不在闸门里等裁决（不在 merge_queued、还没有 PR，或当前 PR 已放行）；
 * - `stale_pr`：传入的 pr_id 不是当前被扣的 PR（冲突复投换了新 PR）——界面提示「PR 已更新，请重新查看」；
 * - `merge_in_progress`：正在合并或后台复投 / 重审中，稍后再试；
 * - `already_merged`：（10）拒绝时发现 PR 其实已合入，不拒绝、不上报；
 * - `unavailable`：（10）没接上 9 的高风险闸门（单独使用 10）。
 */
export const HIGH_RISK_DECISION_ERROR_CODES = [
  "not_found",
  "terminal",
  "gate_off",
  "not_high_risk",
  "not_held",
  "stale_pr",
  "merge_in_progress",
  "already_merged",
  "unavailable",
] as const;
export type HighRiskDecisionErrorCode = (typeof HIGH_RISK_DECISION_ERROR_CODES)[number];

/** 高风险裁决失败（T-041c）：`code` 见 `HIGH_RISK_DECISION_ERROR_CODES`。 */
export class HighRiskDecisionError extends Error {
  override readonly name = "HighRiskDecisionError";
  constructor(
    readonly code: HighRiskDecisionErrorCode,
    readonly ticket_id: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** `stale_pr` 的那种：方便 T-062 / 调用方单独判断。 */
export function isStalePrError(err: unknown): err is HighRiskDecisionError {
  return err instanceof HighRiskDecisionError && err.code === "stale_pr";
}
