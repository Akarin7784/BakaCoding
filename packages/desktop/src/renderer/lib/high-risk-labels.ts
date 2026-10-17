// T-062：高风险裁决错误码、理由、命中文件展示文案。
import type { HighRiskDecisionErrorCode, HighRiskFile, HighRiskReason } from "../../shared/api.js";

/** HighRiskDecisionError 九个码的中文（stale_pr 固定「PR 已更新，请重新查看」）。 */
export const HIGH_RISK_DECISION_ERROR_LABEL: Record<HighRiskDecisionErrorCode, string> = {
  not_found: "找不到这张单",
  terminal: "单子已结束，不能再裁决",
  gate_off: "高风险闸门未开启",
  not_high_risk: "不是高风险单",
  not_held: "当前没有扣住等待裁决的高风险 PR",
  stale_pr: "PR 已更新，请重新查看",
  merge_in_progress: "正在合并或后台处理中，请稍后再试",
  already_merged: "PR 已合入，不能拒绝",
  unavailable: "高风险裁决不可用（只读或未接线）",
};

export function highRiskDecisionErrorLabel(code: string): string {
  return Object.hasOwn(HIGH_RISK_DECISION_ERROR_LABEL, code)
    ? HIGH_RISK_DECISION_ERROR_LABEL[code as HighRiskDecisionErrorCode]
    : code;
}

/** HighRiskReason 四个理由的中文（与 10 通知文案对齐，界面单独出口）。 */
export const HIGH_RISK_REASON_LABEL: Record<HighRiskReason, string> = {
  dependency_kind: "依赖类单",
  dependency_file: "改动了依赖清单 / 锁文件",
  diff_unavailable: "取不到 diff，按高风险处理",
  unverified: "未能确认最新 diff，按高风险处理",
};

export function highRiskReasonLabel(reason: HighRiskReason): string {
  return HIGH_RISK_REASON_LABEL[reason];
}

/**
 * 命中文件展示（T-065）：有 old_path 写成「package.json → x.json」，否则只写 path。
 * 类型用模块 8 的 HighRiskFile，桌面不另定义。
 */
export function formatHighRiskFile(file: HighRiskFile): string {
  return file.old_path !== undefined ? `${file.old_path} → ${file.path}` : file.path;
}
