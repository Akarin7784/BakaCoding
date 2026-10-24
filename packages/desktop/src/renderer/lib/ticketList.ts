// UI-06a：右面板「概览」的需求单列表与「动态」底部状态行（§4.5 / §4.5.1）。
// 数据只来自快照 tickets（由 ticket_status_changed 维护），不读 prs、不轮询。
import type { TicketStatus } from "@bakacoding/types";
import type { TicketView } from "../../shared/api";
import { ACTIVE_TICKET_STATUSES } from "./activity";
import { TICKET_STATUS_LABEL } from "./copy";
import { redactForView } from "./redact";

export type TicketStatusFilter = "all" | TicketStatus;

export interface TicketRow {
  ticket_id: string;
  requirement_id: string;
  /** 已脱敏的标题 */
  title: string;
  status: TicketStatus;
  resubmit_count: number;
}

function byCreated(a: TicketView, b: TicketView): number {
  return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
}

/** 当前项目的单（按创建时间升序）；没有项目时为空。标题先 redactForView。 */
export function projectTicketRows(
  tickets: readonly TicketView[],
  projectId: string | undefined,
): TicketRow[] {
  if (!projectId) return [];
  return tickets
    .filter((t) => t.project_id === projectId)
    .sort(byCreated)
    .map((t) => ({
      ticket_id: t.ticket_id,
      requirement_id: t.requirement_id,
      title: redactForView(t.title),
      status: t.status,
      resubmit_count: t.resubmit_count,
    }));
}

/** 过滤下拉的选项：本项目单子里出现过的状态，按 TICKET_STATUS_LABEL 的顺序。 */
export function statusFilterOptions(rows: readonly TicketRow[]): TicketStatus[] {
  const present = new Set(rows.map((r) => r.status));
  return (Object.keys(TICKET_STATUS_LABEL) as TicketStatus[]).filter((s) => present.has(s));
}

export function filterTicketRows(
  rows: readonly TicketRow[],
  filter: TicketStatusFilter,
): TicketRow[] {
  return filter === "all" ? [...rows] : rows.filter((r) => r.status === filter);
}

/** 筛选值不在选项里（切项目 / 状态变了）时按「全部」。 */
export function effectiveStatusFilter(
  filter: TicketStatusFilter,
  options: readonly TicketStatus[],
): TicketStatusFilter {
  return filter === "all" || options.includes(filter) ? filter : "all";
}

/** 「动态」底部状态行：「T-2 编码中 · T-3 评审中」；没有在跑的单给空串。 */
export function activeTicketLine(
  tickets: readonly TicketView[],
  projectId: string | undefined,
): string {
  if (!projectId) return "";
  return tickets
    .filter((t) => t.project_id === projectId && ACTIVE_TICKET_STATUSES.includes(t.status))
    .sort(byCreated)
    .map((t) => `${t.ticket_id} ${TICKET_STATUS_LABEL[t.status]}`)
    .join(" · ");
}
