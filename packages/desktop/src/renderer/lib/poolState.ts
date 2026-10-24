import type { BackpressureReason, BackpressureState, TicketView } from "../../shared/api";

/** 每种反压原因的固定中文文案（穷举，新增原因编译不过）。 */
export const BACKPRESSURE_REASON_LABEL: Record<BackpressureReason, string> = {
  review_backlog_halve: "评审积压：并发减半",
  review_backlog_recovering: "评审积压：恢复中",
  review_backlog_pause: "评审积压：暂停派单",
  supervisor_backlog: "主管积压",
  pending_pr_limit: "待合入 PR 达到上限",
  daily_budget: "今日预算已用完",
};

/**
 * 编码池一行的数据。X 数全部项目快照里 status === "coding" 的单（桌面快照不带 9 的
 * QueueEntryView.coding 字段，只能按状态数；resubmitting 不算），Y 取 9 的 concurrency。
 */
export interface PoolRow {
  coding: number;
  limit: number;
  reasons: BackpressureReason[];
  backpressure: boolean;
}

export function poolRowOf(state: BackpressureState, tickets: readonly TicketView[]): PoolRow {
  return {
    coding: tickets.filter((t) => t.status === "coding").length,
    limit: state.concurrency,
    reasons: [...state.reasons],
    backpressure: state.paused,
  };
}

const reasonText = (row: PoolRow, sep: string) =>
  row.reasons.map((r) => BACKPRESSURE_REASON_LABEL[r]).join(sep);

/** 「并发 X/Y · 反压 开/关」；暂停时行尾跟原因文字，只降并发不另标。 */
export function poolRowLabel(row: PoolRow): string {
  const head = `并发 ${row.coding}/${row.limit} · 反压 ${row.backpressure ? "开" : "关"}`;
  return row.backpressure && row.reasons.length > 0 ? `${head} · ${reasonText(row, "、")}` : head;
}

/** 悬停提示：逐条列出全部原因；没有原因为空串。 */
export function poolRowTitle(row: PoolRow): string {
  return reasonText(row, "\n");
}
