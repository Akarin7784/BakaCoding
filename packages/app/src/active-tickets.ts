// 「进行中的单」的共用判定：状态不是 merged、也不是 escalated（没有状态按 pending 算）。
// 10 的 integrationIdle（T-042）和桌面端切换项目前的检查（T-072）共用。
export function isTicketActive(status: string | null | undefined): boolean {
  const s = status ?? "pending";
  return s !== "merged" && s !== "escalated";
}

export function countActiveTickets(rows: readonly { status?: string | null }[]): number {
  return rows.filter((r) => isTicketActive(r.status)).length;
}
