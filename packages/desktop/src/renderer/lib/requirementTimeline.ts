// UI-05c：需求页时间线（docs/ui-design.md §4.4）。纯函数：
// - 只取本需求（按 requirement_id 过滤）的 group_message / call_completed / escalated / ticket_warning / ticket_status_changed；
// - 相邻的 call_completed 折叠成一行（「Flash 调用 · low · 2.3k tokens · 4.1s」），点开再看每次的输出；
// - 状态变成 merged 只显示「已合入」，不带任何 sha；
// - 所有文本过 redactForView。
import type { UiEvent } from "../../shared/api";
import { ticketWarningLabel } from "../components/Escalations";
import {
  ESCALATION_REASON_LABEL,
  GROUP_MESSAGE_KIND_LABEL,
  REQUIREMENT_PAGE_COPY,
  TICKET_STATUS_LABEL,
} from "./copy";
import { redactForView } from "./redact";

export interface FlashCallLine {
  key: string;
  model: string;
  effort: string;
  output: string;
}

export type TimelineItem =
  | {
      kind: "message";
      key: string;
      supervisor: boolean;
      who: string;
      tag: string;
      text: string;
    }
  | { kind: "calls"; key: string; summary: string; calls: FlashCallLine[] }
  | { kind: "escalated"; key: string; ticket_id: string | null; tag: string; text: string }
  | { kind: "warning"; key: string; ticket_id: string | null; tag: string; text: string }
  | { kind: "status"; key: string; ticket_id: string | null; text: string };

const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const fmtSecs = (ms: number) => (ms / 1000).toFixed(1);

export function buildTimeline(requirement_id: string, events: readonly UiEvent[]): TimelineItem[] {
  const out: TimelineItem[] = [];
  let run: Extract<UiEvent, { type: "call_completed" }>[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const tokens = run.reduce((s, c) => s + c.payload.tokens.input + c.payload.tokens.output, 0);
    const ms = run.reduce((s, c) => s + c.payload.latency_ms, 0);
    const efforts = [...new Set(run.map((c) => c.payload.effort))].join("/");
    const flash = run.every((c) => c.payload.role === "coder");
    const row = flash ? REQUIREMENT_PAGE_COPY.flashRow : REQUIREMENT_PAGE_COPY.modelRow;
    out.push({
      kind: "calls",
      key: run[0]!.event_id,
      summary: row(efforts, fmtTokens(tokens), fmtSecs(ms), run.length),
      calls: run.map((c) => ({
        key: c.event_id,
        model: redactForView(c.payload.model),
        effort: c.payload.effort,
        output: redactForView(c.payload.output),
      })),
    });
    run = [];
  };
  for (const e of events) {
    if (e.requirement_id !== requirement_id) continue;
    if (e.type === "call_completed") {
      run.push(e);
      continue;
    }
    if (e.type === "project_created") continue;
    flush();
    switch (e.type) {
      case "group_message": {
        const supervisor = e.payload.sender === "supervisor";
        out.push({
          kind: "message",
          key: e.event_id,
          supervisor,
          who: supervisor
            ? REQUIREMENT_PAGE_COPY.supervisor
            : REQUIREMENT_PAGE_COPY.subAgent(e.ticket_id),
          tag: GROUP_MESSAGE_KIND_LABEL[e.payload.kind],
          text: redactForView(e.payload.content),
        });
        break;
      }
      case "escalated":
        out.push({
          kind: "escalated",
          key: e.event_id,
          ticket_id: e.ticket_id,
          tag: ESCALATION_REASON_LABEL[e.payload.reason],
          text: redactForView(e.payload.detail ?? ""),
        });
        break;
      case "ticket_warning":
        out.push({
          kind: "warning",
          key: e.event_id,
          ticket_id: e.ticket_id,
          tag: ticketWarningLabel(e.payload.code),
          text: redactForView(e.payload.detail),
        });
        break;
      case "ticket_status_changed": {
        const to = TICKET_STATUS_LABEL[e.payload.to];
        out.push({
          kind: "status",
          key: e.event_id,
          ticket_id: e.ticket_id,
          text:
            e.payload.from === null
              ? to
              : REQUIREMENT_PAGE_COPY.statusChange(TICKET_STATUS_LABEL[e.payload.from], to),
        });
        break;
      }
    }
  }
  flush();
  return out;
}
