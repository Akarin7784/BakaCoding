// UI-05e：项目页需求列表 / 左栏需求列表的数据（docs/ui-design.md §4.3、§2）。纯函数，只看快照 tickets + 事件：
// - 需求名 = 本需求最早一张单的原文第一行（快照 `title` 已是第一行），过 redactForView，再截到 80 字；
// - 分类：需要处理（attention 集合，来自 lib/attention.ts）> 已完成（全部 merged）> 进行中；
// - 最近活动 = 本需求单子 created_at 与事件 ts 里最晚的一个，列表按它倒序。
import type { TicketStatus } from "@bakacoding/types";
import type { TicketView, UiEvent } from "../../shared/api";
import { PROJECT_PAGE_COPY as C, TICKET_STATUS_LABEL } from "./copy";
import { redactForView } from "./redact";

export const REQUIREMENT_NAME_MAX = 80;

export type RequirementCategory = "attention" | "active" | "done";

export interface RequirementRow {
  requirement_id: string;
  project_id: string;
  name: string;
  category: RequirementCategory;
  /** 「3 张单 · 2 已合入 · 1 评审中」 */
  summary: string;
  /** 最近活动的 ISO 时间（可能为空串） */
  last: string;
}

export function requirementName(firstLine: string): string {
  const text = redactForView(firstLine.split("\n")[0] ?? "").trim();
  const chars = [...text];
  return chars.length > REQUIREMENT_NAME_MAX ? chars.slice(0, REQUIREMENT_NAME_MAX).join("") : text;
}

function summaryOf(mine: readonly TicketView[], category: RequirementCategory): string {
  const total = C.tickets(mine.length);
  if (category === "done") return `${total} · ${C.allMerged}`;
  if (category === "attention") {
    const n = mine.filter((t) => t.status === "escalated").length;
    return `${total} · ${n > 0 ? C.needsYou(n) : C.highRisk}`;
  }
  const counts = new Map<TicketStatus, number>();
  for (const t of mine) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
  const parts = [...counts].map(([s, n]) => `${n} ${TICKET_STATUS_LABEL[s]}`);
  return [total, ...parts].join(" · ");
}

export function listRequirements(
  project_id: string,
  tickets: readonly TicketView[],
  events: readonly UiEvent[],
  attention: ReadonlySet<string>,
): RequirementRow[] {
  const groups = new Map<string, TicketView[]>();
  for (const t of tickets) {
    if (t.project_id !== project_id) continue;
    const g = groups.get(t.requirement_id);
    if (g) g.push(t);
    else groups.set(t.requirement_id, [t]);
  }
  const lastEvent = new Map<string, string>();
  for (const e of events) {
    if (!e.requirement_id || !groups.has(e.requirement_id)) continue;
    const prev = lastEvent.get(e.requirement_id) ?? "";
    if (e.ts > prev) lastEvent.set(e.requirement_id, e.ts);
  }
  const rows: RequirementRow[] = [];
  for (const [requirement_id, list] of groups) {
    const mine = [...list].sort((a, b) =>
      a.created_at === b.created_at
        ? a.ticket_id.localeCompare(b.ticket_id)
        : a.created_at < b.created_at
          ? -1
          : 1,
    );
    const category: RequirementCategory = attention.has(requirement_id)
      ? "attention"
      : mine.every((t) => t.status === "merged")
        ? "done"
        : "active";
    const last = [lastEvent.get(requirement_id) ?? "", ...mine.map((t) => t.created_at)].reduce(
      (a, b) => (b > a ? b : a),
      "",
    );
    rows.push({
      requirement_id,
      project_id,
      name: requirementName(mine[0]!.title) || requirement_id,
      category,
      summary: summaryOf(mine, category),
      last,
    });
  }
  return rows.sort((a, b) =>
    a.last === b.last ? a.requirement_id.localeCompare(b.requirement_id) : a.last < b.last ? 1 : -1,
  );
}

/** 行尾时间：今天显示 HH:MM，昨天显示「昨天」，更早显示 M月D日。 */
export function fmtActivity(iso: string, now: Date = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff <= 0) return `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (diff === 1) return C.yesterday;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
