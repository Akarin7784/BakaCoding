// 右面板「动态」的纯函数（§4.5.1，T-127）：把 group_message 事件整理成界面条目。
// 不新增事件、不改后端：数据来自现有快照里的 group_message（event 公共字段带 requirement_id / ticket_id）。
import type { TicketStatus } from "@bakacoding/types";
import type { ProjectView } from "../mock/types";
import { ACTIVITY_COPY, GROUP_MESSAGE_KIND_LABEL, TICKET_STATUS_LABEL } from "./copy";

/** 「在跑」的单：与全局状态点、退出 / 重载的忙判定同一套状态集合（§4.8）。 */
export const ACTIVE_TICKET_STATUSES: readonly TicketStatus[] = [
  "coding",
  "in_review",
  "resubmitting",
  "re_reviewing",
  "merge_queued",
  "conflict",
] as const;

export interface ActivityItem {
  event_id: string;
  seq: number;
  ts: string;
  /** HH:mm，解析不了时给「—」 */
  time: string;
  sender: string;
  receiver: string;
  /** 头像用：主管消息是主管，其余是副 Agent */
  supervisorSender: boolean;
  kindLabel: string;
  content: string;
  ticket_id: string | null;
}

/** ISO 时间 → 本地 HH:mm；解析不了给「—」（不抛错，动态只是展示）。 */
export function formatActivityTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 发送方 / 接收方：事件只有 sender，接收方按 kind 推（dispatch 给副 Agent，其余回主管）。 */
export function messageParties(
  sender: "supervisor" | "sub_agent",
  ticket_id: string | null,
): { sender: string; receiver: string; supervisorSender: boolean } {
  const agent = ACTIVITY_COPY.subAgent(ticket_id);
  if (sender === "supervisor")
    return { sender: ACTIVITY_COPY.supervisor, receiver: agent, supervisorSender: true };
  return { sender: agent, receiver: ACTIVITY_COPY.supervisor, supervisorSender: false };
}

/** 按 seq 升序；只取 group_message（现在 messages 里也只有它）。 */
export function activityItems(project: ProjectView | undefined): ActivityItem[] {
  if (!project) return [];
  return [...project.messages]
    .sort((a, b) => a.seq - b.seq)
    .map((m) => {
      const parties = messageParties(m.payload.sender, m.ticket_id ?? null);
      return {
        event_id: m.event_id,
        seq: m.seq,
        ts: m.ts,
        time: formatActivityTime(m.ts),
        ...parties,
        kindLabel: GROUP_MESSAGE_KIND_LABEL[m.payload.kind],
        content: m.payload.content,
        ticket_id: m.ticket_id ?? null,
      };
    });
}

/** 过滤下拉的选项：消息里出现过的单号，按首次出现顺序；没有单号的（项目级）不进选项。 */
export function activityFilterOptions(project: ProjectView | undefined): string[] {
  const ids: string[] = [];
  for (const m of activityItems(project)) {
    if (m.ticket_id && !ids.includes(m.ticket_id)) ids.push(m.ticket_id);
  }
  return ids;
}

export function filterActivity(items: ActivityItem[], ticket_id: string): ActivityItem[] {
  return ticket_id === "all" ? items : items.filter((m) => m.ticket_id === ticket_id);
}

/**
 * 实际生效的筛选值（T-127 评审 P2）：切项目后旧单号可能不在新项目的选项里，
 * 这时退回「全部」，否则会显示「还没有动态」但其实有消息。
 */
export function effectiveTicketFilter(filter: string, options: readonly string[]): string {
  return filter === "all" || options.includes(filter) ? filter : "all";
}

/** 底部状态行：「T-2 重写 · T-3 评审中」或空串（没有在跑的单）。 */
export function activeTicketLine(project: ProjectView | undefined): string {
  return (project?.prs ?? [])
    .filter((p) => ACTIVE_TICKET_STATUSES.includes(p.status))
    .map((p) => `${p.ticket_id} ${TICKET_STATUS_LABEL[p.status]}`)
    .join(" · ");
}

/** 是否贴着列表底部（自动滚到底的判断；抽成纯函数方便单测）。 */
export function isNearBottom(m: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight <= 24;
}
