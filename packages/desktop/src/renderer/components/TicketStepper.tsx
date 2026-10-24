// UI-05b：需求单步骤条（docs/ui-design.md §4.4）。
// - 当前所在步只看快照 `tickets` 里的状态（TicketView.status），事件不参与；
// - `ticket_status_changed` 事件只用来打「冲突」「重新评审」小标记，按 ticket_id 过滤；T-085 之前的旧单没有事件，就没有标记；
// - 评审步骤显示「第 N 轮 / 上限」，上限由调用方传入（页面里读 settings:config-get，本组件不读）；
// - escalated 整行标红，给「需要你处理」按钮，点击交给 onEscalationAction。
import type { TicketStatus } from "@bakacoding/types";
import { GitCompareArrows, RefreshCw } from "lucide-react";
import type { TicketView, UiEvent } from "../../shared/api";
import {
  STEPPER_COPY,
  TICKET_STATUS_LABEL,
  TICKET_STEPS,
  TICKET_STEP_LABEL,
  type TicketStep,
} from "../lib/copy";
import { cn } from "../lib/utils";
import { StatusIcon } from "./StatusIcon";
import { Button } from "./ui/button";

/** 9 个状态各落在哪一步；escalated 不落在任何一步（整行标红）。 */
export const STATUS_STEP: Record<TicketStatus, TicketStep | null> = {
  pending: "pending",
  coding: "coding",
  resubmitting: "coding",
  in_review: "in_review",
  re_reviewing: "in_review",
  merge_queued: "merge_queued",
  conflict: "merge_queued",
  merged: "merged",
  escalated: null,
};

export interface StepMarks {
  conflict: number;
  reReview: number;
}

/** 只数本单的 `ticket_status_changed`：进入 conflict / re_reviewing 各算一次。 */
export function stepMarks(ticket_id: string, events: readonly UiEvent[]): StepMarks {
  const marks: StepMarks = { conflict: 0, reReview: 0 };
  for (const e of events) {
    if (e.type !== "ticket_status_changed" || e.ticket_id !== ticket_id) continue;
    if (e.payload.to === "conflict") marks.conflict++;
    else if (e.payload.to === "re_reviewing") marks.reReview++;
  }
  return marks;
}

function Mark({ kind, count }: { kind: "conflict" | "re_review"; count: number }) {
  const Icon = kind === "conflict" ? GitCompareArrows : RefreshCw;
  const text = kind === "conflict" ? STEPPER_COPY.conflictMark : STEPPER_COPY.reReviewMark;
  return (
    <span
      data-mark={kind}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md px-1 text-xs",
        kind === "conflict" ? "text-danger" : "text-accent",
      )}
    >
      <Icon size={12} strokeWidth={1.5} aria-hidden />
      {text}
      {count > 1 && <span className="tabular-nums">{STEPPER_COPY.markCount(count)}</span>}
    </span>
  );
}

export function TicketStepper({
  ticket,
  events,
  reviewLimit,
  onEscalationAction,
}: {
  ticket: TicketView;
  /** 快照 + 增量事件；组件自己按 ticket_id 过滤 */
  events: readonly UiEvent[];
  /** 评审轮次上限：页面从 settings:config-get 读出后传入，本组件不读配置 */
  reviewLimit: number;
  onEscalationAction?: (ticket_id: string) => void;
}) {
  const status = ticket.status;
  const current = STATUS_STEP[status];
  const currentIdx = current ? TICKET_STEPS.indexOf(current) : -1;
  const escalated = status === "escalated";
  const marks = stepMarks(ticket.ticket_id, events);
  const round = ticket.resubmit_count + 1;

  return (
    <div
      role="group"
      aria-label={STEPPER_COPY.label(ticket.ticket_id)}
      data-ticket={ticket.ticket_id}
      data-status={status}
      data-escalated={escalated || undefined}
      className={cn(
        "flex items-center gap-3 rounded-lg px-3 py-2 text-sm",
        escalated && "bg-danger-soft text-danger ring-1 ring-danger/30",
      )}
    >
      <StatusIcon status={status} resubmitCount={ticket.resubmit_count} />
      <span className="w-14 shrink-0 font-mono text-xs text-muted-foreground">
        {ticket.ticket_id}
      </span>
      <span className="min-w-0 flex-1 truncate" title={ticket.title}>
        {ticket.title}
      </span>
      <ol className="flex shrink-0 items-center gap-1">
        {TICKET_STEPS.map((step, i) => {
          const state = i < currentIdx ? "done" : i === currentIdx ? "current" : "todo";
          return (
            <li key={step} data-step={step} data-state={state} className="flex items-center gap-1">
              {i > 0 && (
                <span
                  aria-hidden
                  className={cn("h-px w-4", i <= currentIdx ? "bg-foreground/60" : "bg-border")}
                />
              )}
              <span
                aria-current={state === "current" ? "step" : undefined}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs",
                  state === "current" && "bg-hover font-medium text-foreground",
                  state === "done" && "text-foreground/80",
                  state === "todo" && "text-muted-foreground",
                )}
              >
                {state === "current" ? TICKET_STATUS_LABEL[status] : TICKET_STEP_LABEL[step]}
                {step === "in_review" && state !== "todo" && (
                  <span data-round className="tabular-nums text-muted-foreground">
                    {STEPPER_COPY.reviewRound(round, reviewLimit)}
                  </span>
                )}
              </span>
              {step === "in_review" && marks.reReview > 0 && (
                <Mark kind="re_review" count={marks.reReview} />
              )}
              {step === "merge_queued" && marks.conflict > 0 && (
                <Mark kind="conflict" count={marks.conflict} />
              )}
            </li>
          );
        })}
      </ol>
      {escalated && (
        <Button
          variant="secondary"
          size="sm"
          className="text-danger"
          onClick={() => onEscalationAction?.(ticket.ticket_id)}
        >
          {STEPPER_COPY.needsYou}
        </Button>
      )}
    </div>
  );
}
