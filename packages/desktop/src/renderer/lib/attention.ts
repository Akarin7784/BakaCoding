// UI-05d：哪些需求 / 项目「需要你处理」（左栏红点）。
// 两类：高风险 PR 待裁决（9 扣着、等用户放行 / 拒绝），或需求下有单已上报（escalated）。
// 高风险清单只带 ticket_id / project_id，需求归属按快照 tickets 的 ticket_id → requirement_id 查；
// 快照里查不到这张单时，项目照样标红（按清单自带的 project_id），需求无从归属就不标。
import type { DesktopPendingHighRisk, TicketView } from "../../shared/api";

export interface Attention {
  /** 需要处理的需求 id（05e 左栏需求列表用） */
  requirements: ReadonlySet<string>;
  /** 需要处理的项目 id（左栏项目行红点） */
  projects: ReadonlySet<string>;
}

export function attentionOf(
  tickets: readonly TicketView[],
  highRisk: readonly DesktopPendingHighRisk[],
): Attention {
  const requirements = new Set<string>();
  const projects = new Set<string>();
  const byId = new Map(tickets.map((t) => [t.ticket_id, t]));
  for (const t of tickets) {
    if (t.status !== "escalated") continue;
    requirements.add(t.requirement_id);
    projects.add(t.project_id);
  }
  for (const h of highRisk) {
    projects.add(h.project_id);
    const t = byId.get(h.ticket_id);
    if (t) requirements.add(t.requirement_id);
  }
  return { requirements, projects };
}

/** 属于这个需求的待裁决高风险（按快照里本需求的单号过滤）。 */
export function highRiskOfRequirement(
  requirementId: string,
  tickets: readonly TicketView[],
  highRisk: readonly DesktopPendingHighRisk[],
): DesktopPendingHighRisk[] {
  const ids = new Set(
    tickets.filter((t) => t.requirement_id === requirementId).map((t) => t.ticket_id),
  );
  return highRisk.filter((h) => ids.has(h.ticket_id));
}
