// UI-05c：需求页（docs/ui-design.md §4.4）。
// - 顶部：需求原文（超过 3 行折叠）、拆单时间、拆单推理摘要（默认折叠）。原文 / 摘要来自 requirement:detail（主进程已脱敏），
//   渲染前再过一遍 redactForView；后端只读或读不到时显示固定提示，进度照样从快照出。
// - 单子进度：每张单一行 TicketStepper，当前状态只看快照 tickets；事件只给 stepper 打标记。
// - 评审上限：settings:config-get 的 pipeline.resubmit_limits.review + 1（查证见 lib/reviewLimit.ts）。
// - 时间线：按 requirement_id 聚合，相邻模型调用折叠成一行（lib/requirementTimeline.ts）。
// - 高风险待办卡片（UI-05d）：本需求的单有待裁决高风险 PR 时，在单子进度上方显示；顶部高风险横条保留兜底。
// 「查看需求」按钮、「⋯」菜单留给 05f。
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type {
  BakaDesktopApi,
  DesktopPendingHighRisk,
  DesktopRequirementDetailResult,
  TicketView,
  UiEvent,
} from "../../shared/api";
import { REQUIREMENT_PAGE_COPY as C } from "../lib/copy";
import { CONTENT_COLUMN } from "../lib/layout";
import { redactForView } from "../lib/redact";
import { buildTimeline, type TimelineItem } from "../lib/requirementTimeline";
import { reviewResubmitLimitOf, reviewRoundLimit } from "../lib/reviewLimit";
import { cn } from "../lib/utils";
import { highRiskOfRequirement } from "../lib/attention";
import { AgentIcon } from "./AgentIcon";
import { RequirementHighRiskCards, type HighRiskDecide } from "./RequirementHighRiskCard";
import { TicketStepper } from "./TicketStepper";
import { Button } from "./ui/button";

/** 超过 3 行就折叠：按换行数，或按每行约 60 字估算的折行数。 */
export const ORIGINAL_MAX_LINES = 3;
const CHARS_PER_LINE = 60;
export function needsFold(text: string): boolean {
  const lines = text
    .split("\n")
    .reduce((n, l) => n + Math.max(1, Math.ceil([...l].length / CHARS_PER_LINE)), 0);
  return lines > ORIGINAL_MAX_LINES;
}

function fmtTime(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

type DetailState = { state: "loading" } | DesktopRequirementDetailResult;

function Original({ text }: { text: string }) {
  const fold = needsFold(text);
  const [open, setOpen] = useState(false);
  const collapsed = fold && !open;
  return (
    <div>
      <p
        data-testid="requirement-original"
        data-collapsed={collapsed || undefined}
        className={cn("whitespace-pre-wrap text-sm", collapsed && "line-clamp-3")}
      >
        {text}
      </p>
      {fold && (
        <Button variant="secondary" size="sm" className="mt-1" onClick={() => setOpen((o) => !o)}>
          {open ? C.collapse : C.expand}
        </Button>
      )}
    </div>
  );
}

function TimelineRow({ item }: { item: TimelineItem }) {
  switch (item.kind) {
    case "message":
      return (
        <li className="flex gap-2 text-sm" data-kind="message">
          <AgentIcon supervisor={item.supervisor} />
          <div className="min-w-0">
            <div className="text-xs text-muted-foreground">
              {item.who} · {item.tag}
            </div>
            <p className="whitespace-pre-wrap">{item.text}</p>
          </div>
        </li>
      );
    case "calls":
      return (
        <li data-kind="calls">
          <details className="text-xs text-muted-foreground" data-testid="flash-calls">
            <summary className="cursor-pointer select-none">{item.summary}</summary>
            <ul className="mt-1 space-y-1 border-l border-border pl-3">
              {item.calls.map((c) => (
                <li key={c.key}>
                  {c.model} · {c.effort}：{c.output}
                </li>
              ))}
            </ul>
          </details>
        </li>
      );
    case "escalated":
    case "warning":
      return (
        <li
          data-kind={item.kind}
          className={cn("text-sm", item.kind === "escalated" ? "text-danger" : "text-accent")}
        >
          <span className="text-xs">
            {item.kind === "escalated" ? C.escalated : C.warning}
            {item.ticket_id ? ` · ${item.ticket_id}` : ""} · {item.tag}
          </span>
          {item.text && <p className="whitespace-pre-wrap text-foreground">{item.text}</p>}
        </li>
      );
    case "status":
      return (
        <li data-kind="status" className="text-xs text-muted-foreground">
          {item.ticket_id ? `${item.ticket_id} ` : ""}
          {item.text}
        </li>
      );
  }
}

export function RequirementPage({
  requirementId,
  tickets,
  events,
  api,
  onEscalationAction,
  highRisk = [],
  onDecideHighRisk,
  readonly = false,
}: {
  requirementId: string;
  /** 快照里的需求单（页面自己按 requirement_id 过滤） */
  tickets: readonly TicketView[];
  /** 快照 + 增量事件（页面自己按 requirement_id 过滤） */
  events: readonly UiEvent[];
  api?: Pick<BakaDesktopApi, "getRequirementDetail" | "getModelConfig"> | undefined;
  onEscalationAction?: (ticket_id: string) => void;
  /** 全部待裁决高风险（页面自己按本需求的单号过滤） */
  highRisk?: readonly DesktopPendingHighRisk[];
  onDecideHighRisk?: HighRiskDecide;
  /** 后端只读时禁用裁决按钮 */
  readonly?: boolean;
}) {
  const [detail, setDetail] = useState<DetailState>({ state: "loading" });
  const [resubmitLimit, setResubmitLimit] = useState(() => reviewResubmitLimitOf(null));

  useEffect(() => {
    let alive = true;
    setDetail({ state: "loading" });
    if (!api) {
      setDetail({ ok: false, reason: C.detailUnavailable });
      return;
    }
    api
      .getRequirementDetail({ requirement_id: requirementId })
      .then((r) => alive && setDetail(r))
      .catch(() => alive && setDetail({ ok: false, reason: C.detailUnavailable }));
    return () => {
      alive = false;
    };
  }, [api, requirementId]);

  useEffect(() => {
    let alive = true;
    void api
      ?.getModelConfig?.()
      .then((r) => alive && setResubmitLimit(reviewResubmitLimitOf(r)))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [api]);

  const mine = useMemo(
    () => tickets.filter((t) => t.requirement_id === requirementId),
    [tickets, requirementId],
  );
  const myHighRisk = useMemo(
    () => highRiskOfRequirement(requirementId, tickets, highRisk),
    [requirementId, tickets, highRisk],
  );
  const timeline = useMemo(() => buildTimeline(requirementId, events), [requirementId, events]);
  const splitAt = fmtTime(mine.map((t) => t.created_at).sort()[0]);
  const ok = "ok" in detail && detail.ok ? detail.detail : null;
  const title = redactForView(ok?.name ?? mine[0]?.title ?? requirementId);
  const limit = reviewRoundLimit(resubmitLimit);

  return (
    <section aria-label={C.label} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto px-4 py-3">
        <div className={cn(CONTENT_COLUMN, "space-y-4")}>
          <header className="space-y-2">
            <h2 className="text-base font-medium" data-testid="requirement-title">
              {title}
            </h2>
            {splitAt && <p className="text-xs text-muted-foreground">{C.splitAt(splitAt)}</p>}
            {"state" in detail ? (
              <p className="text-sm text-muted-foreground">{C.loading}</p>
            ) : ok ? (
              <>
                {ok.requirement_text && <Original text={redactForView(ok.requirement_text)} />}
                {ok.decomposition_summary && (
                  <details className="group text-sm" data-testid="decomposition-summary">
                    <summary className="flex cursor-pointer select-none items-center gap-1 text-xs text-muted-foreground [&::-webkit-details-marker]:hidden">
                      <ChevronRight size={14} className="group-open:hidden" aria-hidden />
                      <ChevronDown size={14} className="hidden group-open:inline" aria-hidden />
                      {C.summary}
                    </summary>
                    <p className="mt-1 whitespace-pre-wrap pl-5">
                      {redactForView(ok.decomposition_summary)}
                    </p>
                  </details>
                )}
              </>
            ) : (
              <p
                role="status"
                className="text-sm text-muted-foreground"
                data-testid="detail-unavailable"
              >
                {C.detailUnavailable}
              </p>
            )}
          </header>

          {onDecideHighRisk && (
            <RequirementHighRiskCards
              items={myHighRisk}
              disabled={readonly}
              onDecide={onDecideHighRisk}
            />
          )}

          <section aria-label={C.tickets} className="space-y-1">
            <h3 className="text-xs font-medium text-muted-foreground">{C.tickets}</h3>
            {mine.length === 0 ? (
              <p className="text-sm text-muted-foreground">{C.noTickets}</p>
            ) : (
              mine.map((t) => (
                <TicketStepper
                  key={t.ticket_id}
                  ticket={{ ...t, title: redactForView(t.title) }}
                  events={events}
                  reviewLimit={limit}
                  {...(onEscalationAction && { onEscalationAction })}
                />
              ))
            )}
          </section>

          <section aria-label={C.timeline} className="space-y-2">
            <h3 className="text-xs font-medium text-muted-foreground">{C.timeline}</h3>
            {timeline.length === 0 ? (
              <p className="text-sm text-muted-foreground">{C.noTimeline}</p>
            ) : (
              <ol className="space-y-3">
                {timeline.map((item) => (
                  <TimelineRow key={item.key} item={item} />
                ))}
              </ol>
            )}
          </section>
        </div>
      </div>
    </section>
  );
}
