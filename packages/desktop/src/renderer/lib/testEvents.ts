// UI-05c：需求页测试共用的事件 / 单子构造（只给测试用）。
import type { TicketStatus } from "@bakacoding/types";
import type { DesktopPendingHighRisk, TicketView, UiEvent } from "../../shared/api";

let seq = 0;
const base = (requirement_id: string | null, ticket_id: string | null) => ({
  event_id: `e-${++seq}`,
  seq,
  ts: "2026-10-24T00:00:00Z",
  requirement_id,
  ticket_id,
});

export function ticketOf(over: Partial<TicketView> = {}): TicketView {
  return {
    ticket_id: "T-1",
    project_id: "p1",
    requirement_id: "r1",
    created_at: "2026-10-24T02:30:00Z",
    title: "加登录页",
    status: "in_review",
    resubmit_count: 0,
    ...over,
  };
}

export function msg(req: string | null, content: string, ticket: string | null = "T-1"): UiEvent {
  return {
    ...base(req, ticket),
    type: "group_message",
    payload: { project_id: "p1", sender: "sub_agent", kind: "report", content, flash_calls: [] },
  } as unknown as UiEvent;
}

export function call(req: string | null, output = "ok", role = "coder"): UiEvent {
  return {
    ...base(req, "T-1"),
    type: "call_completed",
    payload: {
      role,
      provider: "deepseek",
      model: "deepseek-flash",
      effort: "low",
      prompt: "p",
      output,
      tokens: { input: 1000, output: 150, cache_hit_input: 0 },
      cache_hit: false,
      latency_ms: 2000,
      cost: 1,
      is_resubmit: false,
      rate_limited_retry: 0,
    },
  } as unknown as UiEvent;
}

export function changed(req: string | null, to: TicketStatus, ticket = "T-1"): UiEvent {
  return {
    ...base(req, ticket),
    type: "ticket_status_changed",
    payload: { project_id: "p1", from: null, to },
  } as unknown as UiEvent;
}

/** UI-05d：待裁决高风险的测试数据。 */
export function hr(over: Partial<DesktopPendingHighRisk> = {}): DesktopPendingHighRisk {
  return {
    ticket_id: "T-1",
    project_id: "p1",
    pr_id: "pr-1",
    reasons: ["dependency_file"],
    files: [{ path: "package.json" }],
    files_more: 0,
    held_at: "2026-10-24T02:30:00Z",
    ...over,
  };
}
