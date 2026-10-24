import { Download, GitBranch, GitMerge, TriangleAlert } from "lucide-react";
import { Button } from "./ui/button";
import { READONLY_COPY } from "../lib/readonly";
import { Separator } from "./ui/separator";
import { StatusBadge } from "./ui/badge";
import { cn } from "../lib/utils";
import { MERGE_COPY, RESUBMIT_COPY } from "../lib/copy";
import { ticketWarningLabel } from "./Escalations";
import type { ProjectView } from "../mock/types";
import { poolRowLabel, poolRowTitle, type PoolRow } from "../lib/poolState";

/** 编码池行的外部输入（UI-06b）：live 时由 pool:state + 快照算出；没有就回退 view.pool（假数据）。 */
export type PoolLive = { ok: true; row: PoolRow } | { ok: false; reason: string };

function LivePool({ pool }: { pool: PoolLive }) {
  if (!pool.ok) return <span className="text-muted-foreground">{pool.reason}</span>;
  const title = poolRowTitle(pool.row);
  return (
    <span
      data-backpressure={pool.row.backpressure ? "on" : "off"}
      title={title || undefined}
      className={cn(
        "transition-colors duration-300",
        pool.row.backpressure ? "text-accent" : "text-muted-foreground",
      )}
    >
      {poolRowLabel(pool.row)}
    </span>
  );
}

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

/** PR 行上的提示图标：这张单有 ticket_warning 时显示，悬停看文案（T-050）。 */
function PrWarning({ codes }: { codes: string[] }) {
  if (codes.length === 0) return null;
  const text = [...new Set(codes)].map(ticketWarningLabel).join("；");
  return (
    <span role="img" aria-label={`提示：${text}`} title={text} className="text-muted-foreground">
      <TriangleAlert size={14} strokeWidth={1.5} aria-hidden />
    </span>
  );
}

/** 右面板「概览」标签的内容：跟随当前项目（1:1 时显示最近操作过的项目）。外壳见 RightPanelShell（UI-02）。 */
export function RightPanel({
  view,
  onOpenTopic,
  readonly = false,
  pool: poolLive,
}: {
  view: ProjectView;
  onOpenTopic: (requirementId: string) => void;
  /** 后端只读（UI-08）：合入 main、导出禁用并说明 */
  readonly?: boolean;
  /** UI-06b：真实编码池状态；不给时回退 view.pool */
  pool?: PoolLive | null;
}) {
  const { pool, git, prs } = view;
  return (
    <div data-testid="project-overview" className="flex flex-col text-sm">
      <div data-testid="pool-status" className="flex gap-3 px-4 py-2 text-xs">
        {poolLive ? (
          <LivePool pool={poolLive} />
        ) : pool ? (
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
      <div className="flex-1 overflow-y-auto px-4 py-3">
        <div className="mb-2 text-xs text-muted-foreground">PR 列表</div>
        {prs.length === 0 && <p className="text-xs text-muted-foreground">暂无 PR</p>}
        <ul className="space-y-1">
          {prs.map((pr) => (
            <li key={pr.pr_id} className="flex items-center gap-2">
              <button
                className="min-w-0 flex-1 truncate rounded px-1 py-1 text-left hover:bg-muted"
                onClick={() => onOpenTopic(pr.requirement_id)}
              >
                {pr.pr_id} {pr.title}
              </button>
              <PrWarning
                codes={view.warnings.filter((w) => w.ticket_id === pr.ticket_id).map((w) => w.code)}
              />
              <StatusBadge status={pr.status} />
              <span className="text-xs text-muted-foreground" title={RESUBMIT_COPY.countTitle}>
                ×{pr.resubmit_count}
              </span>
              <Button
                variant="secondary"
                size="icon-sm"
                aria-label={`导出 ${pr.ticket_id} 诊断包`}
                disabled={readonly}
                title={readonly ? READONLY_COPY.exportDisabled : undefined}
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
