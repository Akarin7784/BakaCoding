// 把主进程下发的事件和需求单摘要整理成界面的视图数据。纯函数，不碰 Node。
import type { DesktopSnapshot, DesktopUpdate, TicketView, UiEvent } from "../../shared/api";
import type {
  EscalationView,
  FlashCallSummary,
  ProjectView,
  Requirement,
  TicketWarningView,
} from "../mock/types";

export interface LiveState {
  db: DesktopSnapshot["db"];
  events: UiEvent[];
  tickets: TicketView[];
  last_seq: number;
}

export function fromSnapshot(s: DesktopSnapshot): LiveState {
  return { db: s.db, events: s.events, tickets: s.tickets, last_seq: s.last_seq };
}

/** 合并增量：按 event_id 去重，保持 seq 升序；tickets 有就整表替换。 */
export function applyUpdate(state: LiveState, u: DesktopUpdate): LiveState {
  const seen = new Set(state.events.map((e) => e.event_id));
  const fresh = u.events.filter((e) => !seen.has(e.event_id));
  const events = fresh.length
    ? [...state.events, ...fresh].sort((a, b) => a.seq - b.seq)
    : state.events;
  return {
    db: u.db,
    events,
    tickets: u.tickets ?? state.tickets,
    last_seq: Math.max(state.last_seq, u.last_seq),
  };
}

export interface LiveViews {
  projects: ProjectView[];
  flashCalls: Record<string, FlashCallSummary>;
  /** 找不到所属项目的上报（如 `unattributed:<pr_id>`、需求号对不上任何项目），按 seq 顺序。 */
  unattributed: EscalationView[];
  /** 找不到所属项目的 ticket_warning（项目号对不上任何项目），按 seq 顺序（T-050）。 */
  unattributedWarnings: TicketWarningView[];
}

export function buildViews(state: LiveState): LiveViews {
  const flashCalls: Record<string, FlashCallSummary> = {};
  const projects = new Map<string, ProjectView>();
  const reqProject = new Map<string, string>();
  const reqOrder = new Map<string, string[]>();

  const addRequirement = (project_id: string, requirement_id: string) => {
    reqProject.set(requirement_id, project_id);
    const list = reqOrder.get(project_id) ?? [];
    if (!list.includes(requirement_id)) list.push(requirement_id);
    reqOrder.set(project_id, list);
  };

  for (const e of state.events) {
    if (e.type === "project_created" && !projects.has(e.payload.project_id)) {
      projects.set(e.payload.project_id, {
        project: e,
        requirements: [],
        messages: [],
        prs: [],
        escalations: [],
        warnings: [],
        git: null,
        pool: null,
      });
    }
  }
  for (const t of state.tickets) addRequirement(t.project_id, t.requirement_id);

  for (const e of state.events) {
    if (e.type === "group_message") {
      const view = projects.get(e.payload.project_id);
      if (!view) continue;
      addRequirement(e.payload.project_id, e.requirement_id);
      view.messages.push(e);
    } else if (e.type === "call_completed") {
      flashCalls[e.event_id] = {
        event_id: e.event_id,
        model: e.payload.model,
        effort: e.payload.effort,
        latency_ms: e.payload.latency_ms,
        tokens: e.payload.tokens,
        output: e.payload.output,
      };
    }
  }

  const unattributed: EscalationView[] = [];
  for (const e of state.events) {
    if (e.type !== "escalated") continue;
    const pid = reqProject.get(e.requirement_id);
    const view = pid ? projects.get(pid) : undefined;
    const esc: EscalationView = {
      event_id: e.event_id,
      ts: e.ts,
      requirement_id: e.requirement_id,
      ticket_id: e.ticket_id,
      reason: e.payload.reason,
      ...(e.payload.detail !== undefined ? { detail: e.payload.detail } : {}),
    };
    // 找不到项目的不丢，放进「未归属」（T-049）。
    if (view) view.escalations.push(esc);
    else unattributed.push(esc);
  }

  const unattributedWarnings: TicketWarningView[] = [];
  for (const e of state.events) {
    if (e.type !== "ticket_warning") continue;
    const w: TicketWarningView = {
      event_id: e.event_id,
      ts: e.ts,
      requirement_id: e.requirement_id,
      ticket_id: e.ticket_id,
      code: e.payload.code,
      detail: e.payload.detail,
    };
    const view = projects.get(e.payload.project_id);
    if (view) view.warnings.push(w);
    else unattributedWarnings.push(w);
  }

  for (const t of state.tickets) {
    projects.get(t.project_id)?.prs.push({
      // 模块 6 的 pr_id 还没和单号关联起来，先显示单号。
      pr_id: t.ticket_id,
      ticket_id: t.ticket_id,
      requirement_id: t.requirement_id,
      title: t.title,
      status: t.status,
      resubmit_count: t.resubmit_count,
    });
  }

  for (const [pid, view] of projects) {
    // 存储里没有需求标题，话题名先用需求号。
    view.requirements = (reqOrder.get(pid) ?? []).map((requirement_id): Requirement => ({
      requirement_id,
      title: requirement_id,
    }));
  }
  return { projects: [...projects.values()], flashCalls, unattributed, unattributedWarnings };
}
