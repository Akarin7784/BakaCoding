import { Download, GitBranch, GitMerge } from "lucide-react";
import { Button } from "./ui/button";
import { Separator } from "./ui/separator";
import { StatusBadge } from "./ui/badge";
import { cn } from "../lib/utils";
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

/** 右侧边栏：跟随当前群（1:1 时显示最近操作过的项目）。 */
export function RightPanel({
  view,
  onOpenTopic,
}: {
  view: ProjectView;
  onOpenTopic: (requirementId: string) => void;
}) {
  const { pool, git, prs } = view;
  return (
    <aside
      aria-label="侧边栏"
      className="flex w-72 shrink-0 flex-col border-l border-border text-sm animate-fade-in"
    >
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
              <Button variant="outline" size="sm" disabled={git.integration_ahead_of_main === 0}>
                <GitMerge strokeWidth={1.5} />
                合入 main
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
              <StatusBadge status={pr.status} />
              <span className="text-xs text-muted-foreground" title="复投次数">
                ×{pr.resubmit_count}
              </span>
              <Button variant="ghost" size="icon" aria-label={`导出 ${pr.ticket_id} 诊断包`}>
                <Download strokeWidth={1.5} />
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
