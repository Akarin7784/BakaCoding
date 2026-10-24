import { useEffect, useMemo, useState } from "react";
import { Download, GitBranch, GitMerge, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
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
import type {
  DesktopGitStatusResult,
  DesktopIntegrationReviewResult,
  DesktopMainMergeResult,
  DesktopSyncState,
  TicketView,
} from "../../shared/api";
import {
  GIT_COPY,
  INTEGRATION_REVIEW_COPY,
  MAIN_MERGE_COPY,
  integrationBlockedLines,
  mergeInvalidatesReview,
  gitAheadLabel,
  gitCurrentLabel,
  gitSyncView,
  mainMergeBlocker,
} from "../lib/gitStatus";
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
 * UI-06c：真实 Git 区——git:status（当前分支、集成领先 main）+ 最后一次成功同步时间 + 同步出错时的固定提示。
 * UI-06d：按 main_merge 显示合入入口——user 时「合入 main」按钮（走 main:merge，透传审查过的 head_sha），
 * supervisor 时一句固定说明；合入中 / 结果 / 错误（主进程给的固定文案）显示在按钮下面。
 */
export type MainMergeUi =
  { kind: "idle" } | { kind: "merging" } | { kind: "done"; result: DesktopMainMergeResult };

/** UI-06d2：审查集成分支的界面状态。 */
export type IntegrationReviewUi =
  | { kind: "idle" }
  | { kind: "reviewing" }
  | { kind: "done"; result: DesktopIntegrationReviewResult };

function MainMergeEntry({
  status,
  readonly,
  reviewedHead: initialHead,
  onMergeMain,
  onReviewIntegration,
  initial,
  reviewInitial,
}: {
  status: Extract<DesktopGitStatusResult, { ok: true }>;
  readonly: boolean;
  reviewedHead: string | null | undefined;
  onMergeMain?: (head_sha: string) => Promise<DesktopMainMergeResult>;
  onReviewIntegration?: () => Promise<DesktopIntegrationReviewResult>;
  initial?: MainMergeUi;
  reviewInitial?: IntegrationReviewUi;
}) {
  const [ui, setUi] = useState<MainMergeUi>(initial ?? { kind: "idle" });
  const [review, setReview] = useState<IntegrationReviewUi>(reviewInitial ?? { kind: "idle" });
  // UI-06d2：审查 ok 时保存的 head_sha（透传给 main:merge）；stale_head / not_reviewed 时清掉
  const [reviewedHead, setReviewedHead] = useState<string | null>(initialHead ?? null);
  if (status.main_merge === "supervisor")
    return (
      <p data-testid="main-merge-auto" className="text-xs text-muted-foreground">
        {MAIN_MERGE_COPY.supervisorMode}
      </p>
    );
  const blocker = readonly
    ? READONLY_COPY.mergeMainDisabled
    : mainMergeBlocker(status, reviewedHead);
  const merging = ui.kind === "merging";
  const reviewing = review.kind === "reviewing";
  const run = async () => {
    if (!onMergeMain || !reviewedHead) return;
    setUi({ kind: "merging" });
    let result: DesktopMainMergeResult;
    try {
      result = await onMergeMain(reviewedHead);
    } catch {
      result = { ok: false, code: "error", reason: MAIN_MERGE_COPY.failed };
    }
    if (mergeInvalidatesReview(result)) {
      setReviewedHead(null);
      setReview({ kind: "idle" });
    }
    setUi({ kind: "done", result });
  };
  const runReview = async () => {
    if (!onReviewIntegration) return;
    setReview({ kind: "reviewing" });
    setReviewedHead(null);
    let result: DesktopIntegrationReviewResult;
    try {
      result = await onReviewIntegration();
    } catch {
      result = { ok: false, code: "error", reason: INTEGRATION_REVIEW_COPY.failed };
    }
    if (result.ok && result.review.result === "ok") {
      setReviewedHead(result.review.head_sha);
      setUi({ kind: "idle" });
    }
    setReview({ kind: "done", result });
  };
  const rv = review.kind === "done" ? review.result : null;
  const r = ui.kind === "done" ? ui.result : null;
  return (
    <div data-testid="main-merge" className="space-y-1">
      <div className="flex flex-wrap gap-2">
        <Button
          data-testid="integration-review"
          variant="secondary"
          size="sm"
          disabled={readonly || reviewing || merging || !onReviewIntegration}
          aria-busy={reviewing || undefined}
          onClick={() => void runReview()}
        >
          {reviewing ? (
            <RefreshCw strokeWidth={1.5} className="animate-spin" />
          ) : (
            <ShieldCheck strokeWidth={1.5} />
          )}
          {reviewing ? INTEGRATION_REVIEW_COPY.reviewing : INTEGRATION_REVIEW_COPY.action}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          data-testid="main-merge-button"
          /* UI-06e：审查进行中一律不能合入（不依赖 runReview 清掉 reviewedHead） */
          disabled={blocker !== null || reviewing || merging || !onMergeMain}
          aria-busy={merging || undefined}
          title={blocker ?? undefined}
          onClick={() => void run()}
        >
          {merging ? (
            <RefreshCw strokeWidth={1.5} className="animate-spin" />
          ) : (
            <GitMerge strokeWidth={1.5} />
          )}
          {merging ? MAIN_MERGE_COPY.merging : MERGE_COPY.mergeMainAction}
        </Button>
      </div>
      {rv &&
        (rv.ok ? (
          rv.review.result === "ok" ? (
            reviewedHead && (
              <p
                data-testid="integration-review-ok"
                role="status"
                className="text-xs text-muted-foreground"
              >
                {INTEGRATION_REVIEW_COPY.passed}
              </p>
            )
          ) : (
            <div data-testid="integration-review-blocked" role="alert" className="space-y-0.5">
              {integrationBlockedLines(rv.review.reasons).map((line) => (
                <p key={line} className="text-xs text-danger">
                  {line}
                </p>
              ))}
            </div>
          )
        ) : (
          <p data-testid="integration-review-error" role="alert" className="text-xs text-danger">
            {rv.reason}
          </p>
        ))}
      {blocker && !merging && (
        <p data-testid="main-merge-hint" className="text-xs text-muted-foreground">
          {blocker}
        </p>
      )}
      {r &&
        (r.ok ? (
          <p
            data-testid="main-merge-result"
            role="status"
            className="text-xs text-muted-foreground"
          >
            {r.result === "merged" ? MAIN_MERGE_COPY.merged(r.sha) : MAIN_MERGE_COPY.notified}
          </p>
        ) : (
          <p data-testid="main-merge-error" role="alert" className="text-xs text-danger">
            {r.reason}
          </p>
        ))}
    </div>
  );
}

function LiveGit({
  status,
  sync,
  readonly = false,
  reviewedHead,
  onMergeMain,
  onReviewIntegration,
  mergeInitial,
  reviewInitial,
}: {
  status: DesktopGitStatusResult | "loading";
  sync: DesktopSyncState | null;
  readonly?: boolean;
  reviewedHead?: string | null;
  onMergeMain?: (head_sha: string) => Promise<DesktopMainMergeResult>;
  onReviewIntegration?: () => Promise<DesktopIntegrationReviewResult>;
  mergeInitial?: MainMergeUi;
  reviewInitial?: IntegrationReviewUi;
}) {
  const syncView = gitSyncView(sync);
  return (
    <div data-testid="git-live" className="space-y-2">
      {status === "loading" ? (
        <p className="text-xs text-muted-foreground">{GIT_COPY.loading}</p>
      ) : status.ok ? (
        <>
          <div data-testid="git-current" className="flex items-center gap-2">
            <GitBranch size={14} strokeWidth={1.5} aria-hidden />
            {gitCurrentLabel(status)}
          </div>
          <div data-testid="git-ahead" className="flex items-center gap-2">
            <GitBranch size={14} strokeWidth={1.5} aria-hidden />
            {gitAheadLabel(status)}
          </div>
          <MainMergeEntry
            status={status}
            readonly={readonly}
            reviewedHead={reviewedHead}
            {...(onMergeMain && { onMergeMain })}
            {...(onReviewIntegration && { onReviewIntegration })}
            {...(mergeInitial && { initial: mergeInitial })}
            {...(reviewInitial && { reviewInitial })}
          />
        </>
      ) : (
        <p data-testid="git-unavailable" className="text-xs text-muted-foreground">
          {status.reason}
        </p>
      )}
      {syncView.lastSync && (
        <div
          data-testid="git-last-sync"
          className="flex items-center gap-2 text-xs text-muted-foreground"
        >
          <RefreshCw size={12} strokeWidth={1.5} aria-hidden />
          {syncView.lastSync}
        </div>
      )}
      {syncView.error && (
        <p data-testid="git-sync-error" role="alert" className="text-xs text-danger">
          {syncView.error}
        </p>
      )}
    </div>
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
  gitStatus,
  sync = null,
  pool: poolLive,
  mainMergeHead,
  onMergeMain,
  onReviewIntegration,
  mainMergeInitial,
  reviewInitial,
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
  /** UI-06c：接了 git:status 时传（null = 读取中）；不传（undefined）= 示例数据 */
  gitStatus?: DesktopGitStatusResult | null;
  /** UI-06c：同步状态（从左下状态卡挪到 Git 区） */
  sync?: DesktopSyncState | null;
  /** UI-06b：真实编码池状态；不给时回退 view.pool */
  pool?: PoolLive | null;
  /** UI-06d：初始的审查通过 head（40 位 sha）；UI-06d2 起由「审查集成分支」得到，这里只作初值 */
  mainMergeHead?: string | null;
  /** UI-06d：点「合入 main」→ main:merge；不给 = 按钮禁用 */
  onMergeMain?: (head_sha: string) => Promise<DesktopMainMergeResult>;
  /** UI-06d2：点「审查集成分支」→ integration:review；ok 时保存 head_sha 给合入用；不给 = 按钮禁用 */
  onReviewIntegration?: () => Promise<DesktopIntegrationReviewResult>;
  /** 仅测试 / 截图用：合入区初始状态 */
  mainMergeInitial?: MainMergeUi;
  /** 仅测试 / 截图用：审查区初始状态 */
  reviewInitial?: IntegrationReviewUi;
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
        {gitStatus !== undefined ? (
          <LiveGit
            status={gitStatus ?? "loading"}
            sync={sync}
            readonly={readonly}
            reviewedHead={mainMergeHead}
            {...(onMergeMain && { onMergeMain })}
            {...(onReviewIntegration && { onReviewIntegration })}
            {...(mainMergeInitial && { mergeInitial: mainMergeInitial })}
            {...(reviewInitial && { reviewInitial })}
          />
        ) : git ? (
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
