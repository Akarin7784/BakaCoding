// UI-01：界面文案表（docs/ui-design.md §5.6）。状态、消息类型、上报原因等面向用户的叫法都集中在这里，
// 组件只按 key 取文案，不各自写字面量。
// - `merged` 一律叫「已合入」（合入集成分支）；合入 main 单独叫「已合入 main」；全界面不出现另一种说法。
// - 面向用户的「复投」统一叫「重写」（内部术语、类型名、事件名不变）。
import type { TicketStatus } from "@bakacoding/types";
import type { EscalationView, GroupMessageKind } from "../mock/types";

/** 合入相关叫法。 */
export const MERGE_COPY = {
  /** 合入集成分支（TicketStatus `merged`） */
  merged: "已合入",
  /** 集成分支合入 main */
  mergedMain: "已合入 main",
  /** 合入 main 的按钮 */
  mergeMainAction: "合入 main",
} as const;

/** 复投在界面上的叫法。 */
export const RESUBMIT_COPY = {
  label: "重写",
  count: (n: number) => `重写 ${n} 次`,
  countTitle: "重写次数",
} as const;

/** 需求单状态（以 `@bakacoding/types` 的 TicketStatus 为准，新增状态时这里编译不过）。 */
export const TICKET_STATUS_LABEL: Record<TicketStatus, string> = {
  pending: "排队",
  coding: "编码中",
  in_review: "评审中",
  resubmitting: RESUBMIT_COPY.label,
  merge_queued: "合并队列",
  conflict: "冲突",
  re_reviewing: "重新评审",
  merged: MERGE_COPY.merged,
  escalated: "需要人工介入",
};

/** 需求页步骤条的五步（§4.4）。 */
export const TICKET_STEPS = ["pending", "coding", "in_review", "merge_queued", "merged"] as const;
export type TicketStep = (typeof TICKET_STEPS)[number];
export const TICKET_STEP_LABEL: Record<TicketStep, string> = {
  pending: "排队",
  coding: "编码",
  in_review: "评审",
  merge_queued: "合并队列",
  merged: MERGE_COPY.merged,
};

/** 群消息类型（§4.5.1 类型标签）。 */
export const GROUP_MESSAGE_KIND_LABEL: Record<GroupMessageKind, string> = {
  dispatch: "派单",
  report: "汇报",
  review_verdict: "评审结论",
  resubmit: RESUBMIT_COPY.label,
  escalation: "上报",
};

/** escalated 的原因。 */
export const ESCALATION_REASON_LABEL: Record<EscalationView["reason"], string> = {
  review_limit: "评审重写超限",
  conflict_limit: "冲突重写超限",
  scope_lock_failed: "写入范围锁定失败",
  resplit_limit: "重新拆单超限",
  github_manual: "需人工处理 GitHub",
  coder_failed: "编码多次未完成",
  budget_exceeded: "本单预算用完",
  internal_error: "内部错误",
  merged_but: "合并后续步骤失败",
  high_risk_rejected: "用户拒绝了高风险 PR",
};

/** 退出收尾中（T-106）：固定文案，不带路径和原因。 */
export const QUIT_COPY = {
  title: "正在退出…",
  detail: "正在等后台任务收尾，完成后窗口会自动关闭",
} as const;
