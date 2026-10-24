import { useEffect, useMemo, useState } from "react";
import { Download, GitBranch, GitMerge, TriangleAlert } from "lucide-react";
import { Button } from "./ui/button";
import { READONLY_COPY } from "../lib/readonly";
import { Separator } from "./ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { StatusIcon } from "./StatusIcon";
import { cn } from "../lib/utils";
import { MERGE_COPY, RESUBMIT_COPY, TICKET_LIST_COPY, TICKET_STATUS_LABEL } from "../lib/copy";
import { ticketWarningLabel } from "./Escalations";
import {
  effectiveStatusFilter,
  filterTicketRows,
  projectTicketRows,
  statusFilterOptions,
  type TicketStatusFilter,
} from "../lib/ticketList";
import type { TicketView } from "../../shared/api";
import type { ProjectView } from "../mock/types";

function Flag({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      className={cn("transition-colors duration-300", on ? "text-accent" : "text-muted-foreground")}
    >
      {label}
      {on ? "中" : "：无"}
    </span>
  );
}

/** 单行上的提示图标：这张单有 ticket_warning 时显示，悬停看文案（T-050）。 */
function TicketWarning({ codes }: { codes: string[] }) {
  if (codes.length === 0) return null;
  const text = [...new Set(codes)].map(ticketWarningLabel).join("；");
  return (
    <span role="img" aria-label={`提示：${text}`} title={text} className="text-muted-foreground">
      <TriangleAlert size={14} strokeWidth={1.5} aria-hidden />
    </span>
  );
}

/**
 * 右面板「概览」标签的内容（§4.5）：跟随当前项目；主管对话里跟随输入框选中的项目。外壳见 RightPanelShell（UI-02）。
 * UI-06a：需求单列表只看快照 tickets（状态图标 + 脱敏标题 + ×重写次数，可按状态筛选）。
 */
export function RightPanel({
  view,
  tickets,
  onOpenTicket,
  onExportTicket,
  exportBusy = false,
  readonly = false,
}: {
  view: ProjectView;
  /** 快照 tickets（全部项目；这里按当前项目过滤） */
  tickets: readonly TicketView[];
  /** 点单：打开所属需求页并选中该单 */
  onOpenTicket: (requirementId: string, ticketId: string) => void;
  /** 行内导出：diagnostics:export scope {kind:"ticket"} */
  onExportTicket?: (ticketId: string) => void;
  exportBusy?: boolean;
  /** 后端只读（UI-08）：合入 main、导出禁用并说明 */
  readonly?: boolean;
}) {
  const { pool, git } = view;
  const projectId = view.project.payload.project_id;
  const rows = useMemo(() => projectTicketRows(tickets, projectId), [tickets, projectId]);
  const options = useMemo(() => statusFilterOptions(rows), [rows]);
  const [filter, setFilter] = useState<TicketStatusFilter>("all");
  useEffect(() => setFilter("all"), [projectId]);
  const active = effectiveStatusFilter(filter, options);
  const shown = filterTicketRows(rows, active);
  return (
    <div data-testid="project-overview" className="flex flex-col text-sm">
      <div data-testid="pool-status" className="flex gap-3 px-4 py-2 text-xs">
        {pool ? (
          <>
            <span>
              并发 {pool.concurrency.active}/{pool.concurrency.limit}
            </span>
            <Flag on={pool.rate_limited} label="限流" />
            <Flag on={pool.backpressure} label="反压" />
          </>
        ) : (
          <span className="text-muted-foreground">编码池状态：未接入</span>
        )}
      </div>
      <Separator />
      <div className="space-y-2 px-4 py-3">
        <div className="text-xs text-muted-foreground">Git · {view.project.payload.name}</div>
        {git ? (
          <>
            <div className="flex items-center gap-2">
              <GitBranch size={14} strokeWidth={1.5} aria-hidden />
              当前 {git.current_branch}
            </div>
            <div className="flex items-center gap-2">
              <GitBranch size={14} strokeWidth={1.5} aria-hidden />
              集成 {git.integration_branch}（领先 main {git.integration_ahead_of_main}）
            </div>
            {git.main_merge === "user" && (
              <Button
                variant="secondary"
                size="sm"
                disabled={readonly || git.integration_ahead_of_main === 0}
                title={readonly ? READONLY_COPY.mergeMainDisabled : undefined}
              >
                <GitMerge strokeWidth={1.5} />
                {MERGE_COPY.mergeMainAction}
              </Button>
            )}
          </>
        ) : (
          <p className="text-xs text-muted-foreground">Git 状态：未接入</p>
        )}
      </div>
      <Separator />
      <div data-testid="ticket-list" className="flex-1 overflow-y-auto px-4 py-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="flex-1 text-xs text-muted-foreground">{TICKET_LIST_COPY.title}</span>
          {rows.length > 0 && (
            <Select value={active} onValueChange={(v) => setFilter(v as TicketStatusFilter)}>
              <SelectTrigger
                aria-label={TICKET_LIST_COPY.filterLabel}
                className="h-7 w-28 text-xs"
                data-testid="ticket-status-filter"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{TICKET_LIST_COPY.filterAll}</SelectItem>
                {options.map((s) => (
                  <SelectItem key={s} value={s}>
                    {TICKET_STATUS_LABEL[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
        {rows.length === 0 && (
          <p className="text-xs text-muted-foreground">{TICKET_LIST_COPY.empty}</p>
        )}
        <ul className="space-y-1">
          {shown.map((t) => (
            <li
              key={t.ticket_id}
              data-testid="ticket-row"
              data-ticket={t.ticket_id}
              className="flex items-center gap-2"
            >
              <StatusIcon status={t.status} />
              <button
                type="button"
                className="min-w-0 flex-1 truncate rounded px-1 py-1 text-left hover:bg-muted"
                onClick={() => onOpenTicket(t.requirement_id, t.ticket_id)}
              >
                {t.ticket_id} {t.title}
              </button>
              <TicketWarning
                codes={view.warnings.filter((w) => w.ticket_id === t.ticket_id).map((w) => w.code)}
              />
              <span className="text-xs text-muted-foreground" title={RESUBMIT_COPY.countTitle}>
                ×{t.resubmit_count}
              </span>
              <Button
                variant="secondary"
                size="icon-sm"
                aria-label={TICKET_LIST_COPY.exportLabel(t.ticket_id)}
                disabled={readonly || exportBusy || !onExportTicket}
                title={readonly ? READONLY_COPY.exportDisabled : undefined}
                onClick={() => onExportTicket?.(t.ticket_id)}
              >
                <Download strokeWidth={1.5} />
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
