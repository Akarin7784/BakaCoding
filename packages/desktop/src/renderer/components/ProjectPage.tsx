// UI-05e：项目页（docs/ui-design.md §4.3）。只读：
// - 上报 / 警告提示沿用项目群的（EscalationItem / TicketWarningList），放在最上面；
// - 一行汇总「进行中 / 需要处理 / 已完成」计数，点数字过滤，再点一次取消；
// - 需求列表按最近活动倒序，每行：状态图标、需求名、单子摘要、时间；点开进需求页（#requirement=<id>）；
// - 空状态：「还没有需求，去主管对话里提一个」+ 按钮。
import { useMemo, useState } from "react";
import { Circle, CircleAlert, CircleCheck } from "lucide-react";
import type { TicketView, UiEvent } from "../../shared/api";
import { PROJECT_PAGE_COPY as C } from "../lib/copy";
import { CONTENT_COLUMN } from "../lib/layout";
import {
  fmtActivity,
  listRequirements,
  type RequirementCategory,
  type RequirementRow,
} from "../lib/requirementList";
import { cn } from "../lib/utils";
import type { ProjectView } from "../mock/types";
import { EscalationItem, TicketWarningList } from "./Escalations";
import { Button } from "./ui/button";

const CATEGORIES: RequirementCategory[] = ["active", "attention", "done"];

const ICON: Record<RequirementCategory, { icon: typeof Circle; className: string }> = {
  active: { icon: Circle, className: "text-accent fill-current" },
  attention: { icon: CircleAlert, className: "text-danger" },
  done: { icon: CircleCheck, className: "text-muted-foreground" },
};

function Row({
  row,
  now,
  onOpen,
}: {
  row: RequirementRow;
  now: Date | undefined;
  onOpen: (id: string) => void;
}) {
  const { icon: Icon, className } = ICON[row.category];
  return (
    <li>
      <button
        type="button"
        data-testid="requirement-row"
        data-requirement={row.requirement_id}
        data-category={row.category}
        onClick={() => onOpen(row.requirement_id)}
        className={cn(
          "flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-hover",
          row.category === "attention" && "bg-danger-soft",
        )}
      >
        <Icon size={12} strokeWidth={2} className={cn("shrink-0", className)} aria-hidden />
        <span className="min-w-0 flex-1 truncate font-medium">{row.name}</span>
        <span
          className={cn(
            "shrink-0 text-xs",
            row.category === "attention" ? "text-danger" : "text-muted-foreground",
          )}
        >
          {row.summary}
        </span>
        <span className="w-12 shrink-0 text-right text-xs text-muted-foreground">
          {fmtActivity(row.last, now)}
        </span>
      </button>
    </li>
  );
}

export function ProjectPage({
  view,
  tickets,
  events,
  attention,
  onOpenRequirement,
  onNewRequirement,
  now,
}: {
  view: ProjectView;
  tickets: readonly TicketView[];
  events: readonly UiEvent[];
  /** 需要处理的需求 id（lib/attention.ts 的 attentionOf().requirements） */
  attention: ReadonlySet<string>;
  onOpenRequirement: (requirement_id: string) => void;
  onNewRequirement?: () => void;
  /** 测试注入「现在」 */
  now?: Date;
}) {
  const projectId = view.project.payload.project_id;
  const rows = useMemo(
    () => listRequirements(projectId, tickets, events, attention),
    [projectId, tickets, events, attention],
  );
  const [filter, setFilter] = useState<RequirementCategory | null>(null);
  const shown = filter ? rows.filter((r) => r.category === filter) : rows;
  const count = (c: RequirementCategory) => rows.filter((r) => r.category === c).length;

  return (
    <section aria-label={C.label} className="flex min-h-0 min-w-0 flex-1 flex-col">
      {view.escalations.length > 0 && (
        <ul
          role="alert"
          aria-label="需要人工介入"
          className="border-b border-border px-4 py-2 text-sm"
        >
          {view.escalations.map((e) => (
            <EscalationItem key={e.event_id} e={e} />
          ))}
        </ul>
      )}
      <TicketWarningList warnings={view.warnings} />
      <div className="flex-1 overflow-y-auto px-4 py-3">
        <div className={cn(CONTENT_COLUMN, "space-y-3")}>
          {rows.length === 0 ? (
            <div className="space-y-3 py-8 text-center" data-testid="project-empty">
              <p className="text-sm text-muted-foreground">{C.empty}</p>
              {onNewRequirement && (
                <Button variant="secondary" size="sm" onClick={onNewRequirement}>
                  {C.emptyAction}
                </Button>
              )}
            </div>
          ) : (
            <>
              <div role="group" aria-label="需求汇总" className="flex flex-wrap gap-2">
                {CATEGORIES.map((c) => (
                  <Button
                    key={c}
                    size="sm"
                    variant="secondary"
                    aria-pressed={filter === c}
                    data-testid={`filter-${c}`}
                    className={cn(
                      filter === c && "ring-1 ring-ring",
                      c === "attention" && count(c) > 0 && "text-danger",
                    )}
                    onClick={() => setFilter((f) => (f === c ? null : c))}
                  >
                    {C.filter[c]} {count(c)}
                  </Button>
                ))}
              </div>
              {shown.length === 0 ? (
                <p className="py-4 text-sm text-muted-foreground">{C.emptyFiltered}</p>
              ) : (
                <ul aria-label={C.list} className="space-y-0.5">
                  {shown.map((r) => (
                    <Row key={r.requirement_id} row={r} now={now} onOpen={onOpenRequirement} />
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
