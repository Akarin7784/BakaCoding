import type { BackpressureState, TicketView } from "../../shared/api";

/** 编码池一行的数据（UI-06b）。X 数快照里 coding 的单（池是全局的，不分项目），Y 取 9 的 concurrency。 */
export interface PoolRow {
  coding: number;
  limit: number;
  throttled: number;
  backpressure: boolean;
}

export function poolRowOf(state: BackpressureState, tickets: readonly TicketView[]): PoolRow {
  return {
    coding: tickets.filter((t) => t.status === "coding").length,
    limit: state.concurrency,
    throttled: state.reasons.length,
    backpressure: state.paused,
  };
}

/** 「并发 X/Y · 限流 N · 反压 开/关」 */
export function poolRowLabel(row: PoolRow): string {
  return `并发 ${row.coding}/${row.limit} · 限流 ${row.throttled} · 反压 ${row.backpressure ? "开" : "关"}`;
}
