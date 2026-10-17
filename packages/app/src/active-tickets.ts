// 「进行中的单」的共用判定：状态不是 merged、也不是 escalated（没有状态按 pending 算）。
// 10 的 integrationIdle（T-042）和桌面端切换项目前的检查（T-072）共用。
import { TERMINAL_TICKET_STATUSES } from "@bakacoding/types";

const TERMINAL: readonly string[] = TERMINAL_TICKET_STATUSES;

export function isTicketActive(status: string | null | undefined): boolean {
  return !TERMINAL.includes(status ?? "pending");
}

export function countActiveTickets(rows: readonly { status?: string | null }[]): number {
  return rows.filter((r) => isTicketActive(r.status)).length;
}
