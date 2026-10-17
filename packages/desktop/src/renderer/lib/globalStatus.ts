// UI-08：全局状态点（§4.8）。灰 = 空闲；强调色呼吸 = 有单在跑；红 = 有需要你处理的事。
import type { TicketStatus } from "@bakacoding/types";
import type { ProjectView } from "../mock/types";

export type GlobalLevel = "idle" | "running" | "attention";

export const GLOBAL_LEVEL_LABEL: Record<GlobalLevel, string> = {
  idle: "空闲",
  running: "有单在跑",
  attention: "需要你处理",
};

/** 「在跑」的需求单状态（§5.2 里转圈 / 重写 / 排队合入的那些）。 */
export const RUNNING_STATUSES: readonly TicketStatus[] = [
  "coding",
  "in_review",
  "re_reviewing",
  "resubmitting",
  "merge_queued",
];
/** 需要你处理的需求单状态。 */
export const ATTENTION_STATUSES: readonly TicketStatus[] = ["conflict", "escalated"];

export interface GlobalStatusInput {
  projects: ProjectView[];
  readonly: boolean;
  /** 数据库打不开（missing 不算：首次启动还没建库） */
  dbError: boolean;
  /** 同步鉴权停 / 失败 / 限流（describeSyncState 的 error / warn） */
  syncAlert: boolean;
  pendingHighRisk: number;
  unattributed: number;
}

/** 需要你处理的事，一条一句，状态卡里列出来。 */
export function attentionItems(i: GlobalStatusInput): string[] {
  const out: string[] = [];
  if (i.readonly) out.push("后端处于只读模式");
  if (i.dbError) out.push("数据库打不开");
  if (i.syncAlert) out.push("GitHub 同步出了问题");
  if (i.pendingHighRisk > 0) out.push(`${i.pendingHighRisk} 个高风险 PR 待裁决`);
  const stuck = i.projects.flatMap((p) =>
    p.prs.filter((pr) => ATTENTION_STATUSES.includes(pr.status)),
  ).length;
  if (stuck > 0) out.push(`${stuck} 张单需要人工介入`);
  if (i.unattributed > 0) out.push(`${i.unattributed} 条未归属上报`);
  return out;
}

export function runningCount(projects: ProjectView[]): number {
  return projects.flatMap((p) => p.prs.filter((pr) => RUNNING_STATUSES.includes(pr.status))).length;
}

export function globalLevel(i: GlobalStatusInput): GlobalLevel {
  if (attentionItems(i).length > 0) return "attention";
  return runningCount(i.projects) > 0 ? "running" : "idle";
}
