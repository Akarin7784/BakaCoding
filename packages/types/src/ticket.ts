import { z } from "zod";

/**
 * 需求单在流水线中的状态，由编排层（模块 9 调度器）维护，界面显示的就是它。
 * 与 PR 自身生命周期的 PrStatus（模块 6）不同。
 */
export const TICKET_STATUSES = [
  "pending", // 已入队，等待派单（等编码槽位、依赖或写入锁）
  "coding", // Flash 编码中
  "in_review", // 评审中
  "resubmitting", // 评审未过或冲突后原地复投
  "merge_queued", // 评审通过，在合并队列中等待
  "conflict", // 合并前检测到冲突
  "re_reviewing", // 基线前进且涉及接口或依赖变化，重新评审，不计复投
  "merged", // 已合入集成分支
  "escalated", // 超限或需人工介入，已上报
] as const;

export const TicketStatusSchema = z
  .enum(TICKET_STATUSES)
  .describe("需求单流水线状态，由模块 9 维护");
export type TicketStatus = z.infer<typeof TicketStatusSchema>;

/** 终态：不会再迁移。 */
export const TERMINAL_TICKET_STATUSES = [
  "merged",
  "escalated",
] as const satisfies readonly TicketStatus[];
