import { randomUUID } from "node:crypto";
import {
  INTEGRATION_BRANCH,
  type EventContext,
  type MergeResult,
  type SyncChange,
} from "@bakacoding/pr";
import type { TicketStatus } from "@bakacoding/types";
import { BackpressureController } from "./backpressure.js";
import { matchesAny } from "./glob.js";
import type {
  BackpressureState,
  ChangedInterface,
  DependencyState,
  MergeResultRecord,
  PublishInput,
  Scheduler,
  SchedulerClock,
  SchedulerDeps,
  SchedulerPr,
  SchedulerTicket,
  SubAgentOutcome,
} from "./types.js";

/** 连续限流超过这个次数（第 4 次）发上报（modules.md §9，已定） */
export const RATE_LIMIT_ESCALATE_AFTER = 3;
export const DEFAULT_TARGET_DIRTY_RETRY_MS = 30_000;
/** target_dirty 连续重试上限，超过（第 11 次）发 escalated(github_manual) */
export const TARGET_DIRTY_MAX_RETRIES = 10;
/** 找不到所属单的 PR：最小上下文里 requirement_id / trace_id 的前缀（types 要求 requirement_id 非空） */
export const UNATTRIBUTED_PREFIX = "unattributed:";

const defaultClock: SchedulerClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** 6 已经自己发过 escalated(github_manual) 的错误，9 不重复上报。 */
const ESCALATED_BY_PR = new Set(["GithubAuthError", "GithubBranchDivergedError"]);

function errorName(e: unknown): string {
  return (e as Error | undefined)?.name ?? "Error";
}
function errorMessage(e: unknown): string {
  const m = (e as Error | undefined)?.message;
  return typeof m === "string" && m ? m : String(e);
}

function rateLimitWait(e: unknown): number | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  const x = e as { retryable?: unknown; retry_after_ms?: unknown; name?: unknown };
  if (x.name === "GithubRateLimitError" || x.retryable === true) {
    if (typeof x.retry_after_ms === "number" && x.retry_after_ms >= 0) return x.retry_after_ms;
  }
  return undefined;
}

interface MergeLogItem {
  ticket_id: string;
  sha: string;
  files: string[];
  changed_interfaces: ChangedInterface[];
}

interface Entry {
  ticket: SchedulerTicket;
  status: TicketStatus;
  pr_id: string | null;
  worktree_path: string | null;
  round: number;
  /** 本轮基线对应的合并日志位置：之后的合并都算「基线前进」 */
  base_seq: number;
  /**
   * 合并日志定不了本单基线（重启后、基线不是本会话见过的提交）：合并前和目标分支当前 HEAD 比，
   * 不同就保守地重审。base_commit 为 submit 带的或 6 的 diff 给的 base_sha。
   */
  base_unknown: boolean;
  base_commit: string | undefined;
  counts: { review: number; conflict: number };
  rate_limit_streak: number;
  target_dirty_streak: number;
  /** worktree_path 是 9 冲突复投时建的（最终上报时由 9 清掉） */
  own_worktree: boolean;
  /** 9 的后台任务（冲突复投 / 重审）进行中 */
  busy: boolean;
  /** 当日预算用完放回 pending 时 8 给的续跑凭据（9 不解析） */
  resume_token: unknown;
  /** 冲突复投途中因预算暂停：新 PR 开出（8 续跑后调 submit）时要关掉的旧 PR 和旧 worktree */
  pending_replace: { old_pr_id: string; old_worktree: string | null } | undefined;
  /** 正在 resume 中（8 会在评审通过时调 submit，所以不设 busy） */
  resuming: boolean;
  conflicted: boolean;
  base_changed: boolean;
  re_reviewed: boolean;
}

const TERMINAL: ReadonlySet<TicketStatus> = new Set(["merged", "escalated"]);

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const clock = deps.clock ?? defaultClock;
  const newId = deps.newId ?? randomUUID;
  const target = deps.target ?? INTEGRATION_BRANCH;
  const dirtyRetryMs = deps.target_dirty_retry_ms ?? DEFAULT_TARGET_DIRTY_RETRY_MS;
  const onError =
    deps.onError ??
    ((e: unknown, t: string) => console.warn(`[scheduler] ${t}: ${(e as Error)?.message ?? e}`));
  const limits = deps.config.pipeline.resubmit_limits;
  const bp = new BackpressureController(deps.config);

  const entries = new Map<string, Entry>();
  const prToTicket = new Map<string, string>();
  /** 被冲突复投取代、由 9 自己关闭的旧 PR：sync 报上来的变化一律跳过（不当用户手动关闭） */
  const superseded = new Set<string>();
  const results = new Map<string, MergeResultRecord>();
  const mergeLog: MergeLogItem[] = [];
  /** 合并队列（merge_queued 的单号，先来先合；依赖未就绪的跳过不出队） */
  const queue: string[] = [];
  const background = new Set<Promise<void>>();
  const unsubs: Array<() => void> = [];
  let pr: SchedulerPr | undefined;
  let reviewBacklog = { pending: 0, capacity: deps.config.backpressure.reviews_per_member };
  let supervisorBacklog: { pending: number; capacity: number } | null = null;
  let pumping: Promise<void> | undefined;
  let pumpAgain = false;
  let stopped = false;
  /** 正在 step 里处理的单（出错时上报它） */
  let current: Entry | undefined;
  const sleepers = new Set<() => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  /** start() 时目标分支的 HEAD：合并日志第 0 条之前的基线 */
  let startHead: string | undefined;

  const requirePr = (): SchedulerPr => {
    if (!pr) throw new Error("调度器尚未 start()");
    return pr;
  };
  const getEntry = (ticket_id: string): Entry => {
    const e = entries.get(ticket_id);
    if (!e) throw new Error(`未登记的单：${ticket_id}`);
    return e;
  };

  async function setStatus(e: Entry, status: TicketStatus): Promise<void> {
    e.status = status;
    await deps.tickets.setStatus(e.ticket.ticket_id, status);
  }

  function removeFromQueue(ticket_id: string): void {
    const i = queue.indexOf(ticket_id);
    if (i >= 0) queue.splice(i, 1);
  }

  function common(t: SchedulerTicket) {
    return {
      event_id: newId(),
      ts: new Date(clock.now()).toISOString(),
      requirement_id: t.requirement_id,
      ticket_id: t.ticket_id,
      trace_id: t.trace_id,
      span_id: t.span_id,
      parent_span_id: t.parent_span_id,
    };
  }

  async function escalate(
    e: Entry,
    reason: "github_manual" | "conflict_limit",
    detail?: string,
  ): Promise<void> {
    removeFromQueue(e.ticket.ticket_id);
    e.status = "escalated"; // 先改内存状态：后面持久化或发事件失败也不会再出队
    await setStatus(e, "escalated");
    await cleanupOwnWorktree(e);
    const payload: PublishInput<"escalated">["payload"] =
      reason === "github_manual"
        ? { reason, detail: detail ?? "" }
        : { reason, resubmit_counts: { ...e.counts }, ...(detail ? { detail } : {}) };
    await deps.bus.publish({ ...common(e.ticket), type: "escalated", payload });
  }

  /** 最终上报时清掉 9 自己建的 r<n+1> worktree（尽力而为，失败只调 onError）。 */
  async function cleanupOwnWorktree(e: Entry): Promise<void> {
    if (!e.own_worktree || !e.worktree_path) return;
    const path = e.worktree_path;
    e.own_worktree = false;
    try {
      await deps.worktrees.cleanup(path);
    } catch (err) {
      onError(err, e.ticket.ticket_id);
    }
  }

  /** 出错的单直接上报 github_manual；上报本身再失败也只调 onError，保证队列继续。 */
  async function escalateOnError(e: Entry, prefix: string, err: unknown): Promise<void> {
    onError(err, e.ticket.ticket_id);
    try {
      await escalate(e, "github_manual", `${prefix}: ${errorMessage(err)}`.slice(0, 500));
    } catch (err2) {
      removeFromQueue(e.ticket.ticket_id);
      e.status = "escalated";
      onError(err2, e.ticket.ticket_id);
    }
  }

  function dependencyState(ticket_id: string, seen = new Set<string>()): DependencyState {
    const e = entries.get(ticket_id);
    if (!e) return "waiting";
    let waiting = false;
    for (const dep of e.ticket.depends_on ?? []) {
      if (seen.has(dep)) continue; // 依赖成环：不无限递归，按未就绪处理
      seen.add(dep);
      const d = entries.get(dep);
      if (!d) {
        waiting = true;
        continue;
      }
      if (d.status === "escalated") return "held";
      if (dependencyState(dep, seen) === "held") return "held";
      if (d.status !== "merged") waiting = true;
    }
    return waiting ? "waiting" : "ready";
  }

  function isRelevant(t: SchedulerTicket, m: MergeLogItem): boolean {
    if ((t.depends_on ?? []).includes(m.ticket_id)) return true;
    const mine = t.interfaces ?? [];
    for (const ci of m.changed_interfaces) {
      if (mine.some((i) => i.file === ci.file && i.symbol === ci.symbol)) return true;
    }
    return m.files.some((f) => mine.some((i) => i.file === f));
  }

  /**
   * 后台任务（冲突复投、重审）。抛错时调 onError 并直接上报 github_manual，状态改 escalated，
   * 不让单子停在 resubmitting / re_reviewing。
   */
  function track(e: Entry, kind: "resubmit" | "re_review", task: () => Promise<void>): void {
    e.busy = true;
    const p = task()
      .catch(async (err) => {
        if (e.status === "escalated") {
          onError(err, e.ticket.ticket_id);
          return;
        }
        await escalateOnError(e, `${kind}_error`, err);
      })
      .finally(() => {
        e.busy = false;
        background.delete(p);
        kick();
      });
    background.add(p);
  }

  function record(e: Entry, pr_id: string, r: MergeResultRecord): void {
    results.set(pr_id, r);
    if (r.merged) e.conflicted = e.conflicted || r.conflict;
  }

  async function changedFiles(pr_id: string): Promise<string[]> {
    try {
      return (await requirePr().diff(pr_id)).files.map((f) => f.path);
    } catch (err) {
      onError(err, prToTicket.get(pr_id) ?? pr_id);
      return [];
    }
  }

  async function onMerged(e: Entry, pr_id: string, sha: string): Promise<void> {
    removeFromQueue(e.ticket.ticket_id);
    await setStatus(e, "merged");
    const files = await changedFiles(pr_id);
    const changed = (e.ticket.interfaces ?? []).filter((i) => files.includes(i.file));
    mergeLog.push({ ticket_id: e.ticket.ticket_id, sha, files, changed_interfaces: changed });
    const affected = [...entries.values()]
      .filter((o) => o !== e && !TERMINAL.has(o.status))
      .filter(
        (o) =>
          files.some((f) => matchesAny(f, o.ticket.write_scope ?? [])) ||
          (o.ticket.interfaces ?? []).some(
            (i) =>
              files.includes(i.file) ||
              changed.some((c) => c.file === i.file && c.symbol === i.symbol),
          ),
      )
      .map((o) => o.ticket.ticket_id);
    const r: MergeResultRecord = {
      conflict: e.conflicted,
      base_changed: e.base_changed,
      re_reviewed: e.re_reviewed,
      merged: true,
    };
    record(e, pr_id, r);
    await deps.saveMergeResult?.(e.ticket.ticket_id, {
      conflicted: e.conflicted,
      base_changed: e.base_changed,
      re_reviewed: e.re_reviewed,
      merged: true,
    });
    await deps.bus.publish({
      ...common(e.ticket),
      type: "interface_changed",
      payload: {
        pr_id,
        base_commit: sha,
        changed_interfaces: changed,
        summary: `${e.ticket.ticket_id} 已合入 ${target}（${sha.slice(0, 7)}），改动 ${files.length} 个文件${
          changed.length
            ? `，涉及接口 ${changed.map((c) => `${c.file}#${c.symbol}`).join("、")}`
            : ""
        }`,
        affected_ticket_ids: affected,
      },
    });
  }

  async function finishSubAgent(
    e: Entry,
    res: SubAgentOutcome,
    base_seq: number,
    replace?: {
      old_pr_id: string;
      old_worktree: string | null;
      old_own_worktree: boolean;
      new_worktree: string;
      round: number;
    },
  ): Promise<void> {
    if ("requeue_budget" in res) {
      await requeueForBudget(e, res.resume, replace);
      return;
    }
    const new_pr = "pr_id" in res && res.pr_id ? res.pr_id : undefined;
    const supersedes =
      replace !== undefined && new_pr !== undefined && new_pr !== replace.old_pr_id;
    // 先记新 PR，再关旧 PR：关闭期间的 sync / eventContext 都已指向新 PR
    if (new_pr) {
      prToTicket.set(new_pr, e.ticket.ticket_id);
      if (!TERMINAL.has(e.status)) e.pr_id = new_pr;
    }
    if (replace) {
      if (!TERMINAL.has(e.status)) {
        e.worktree_path = replace.new_worktree;
        e.own_worktree = true;
        e.round = replace.round;
      }
    }
    if (supersedes) {
      // 新 PR 已开出：关旧 PR（closed_by: bakacoding），再清旧 worktree。先标记，close 期间的 sync 也跳过它
      superseded.add(replace.old_pr_id);
      await requirePr().close(replace.old_pr_id, `冲突复投，由 ${new_pr} 取代`);
      if (replace.old_worktree) await deps.worktrees.cleanup(replace.old_worktree);
    }
    if (TERMINAL.has(e.status)) {
      // 等 8 的期间单子已到终态（如用户手动关闭）：不覆盖状态；9 建的新 worktree 清掉
      if (replace) {
        try {
          await deps.worktrees.cleanup(replace.new_worktree);
        } catch (err) {
          onError(err, e.ticket.ticket_id);
        }
      }
      return;
    }
    if ("escalated" in res) {
      // 8 已自己上报，9 只更新状态，并清掉 9 建的新 worktree
      removeFromQueue(e.ticket.ticket_id);
      e.status = "escalated";
      await setStatus(e, "escalated");
      await cleanupOwnWorktree(e);
      return;
    }
    if (res.review_resubmits !== undefined) e.counts.review = res.review_resubmits;
    e.base_seq = base_seq;
    e.base_unknown = false;
    await setStatus(e, "merge_queued");
  }

  /**
   * 当日预算用完（8 返回 requeue_budget）：不上报、不计复投，状态 pending（9 写），存续跑凭据，
   * 等 resumeBudgetPaused() 交回 8。冲突复投途中暂停时记下旧 PR / 旧 worktree，新 PR 开出时再关。
   */
  async function requeueForBudget(
    e: Entry,
    token: unknown,
    replace?: {
      old_pr_id: string;
      old_worktree: string | null;
      new_worktree: string;
      round: number;
    },
  ): Promise<void> {
    if (TERMINAL.has(e.status)) {
      if (replace) {
        try {
          await deps.worktrees.cleanup(replace.new_worktree);
        } catch (err) {
          onError(err, e.ticket.ticket_id);
        }
      }
      return;
    }
    removeFromQueue(e.ticket.ticket_id);
    e.resume_token = token;
    if (replace) {
      e.pending_replace ??= { old_pr_id: replace.old_pr_id, old_worktree: replace.old_worktree };
      e.worktree_path = replace.new_worktree;
      e.own_worktree = true;
      e.round = replace.round;
    }
    await setStatus(e, "pending");
  }

  /** 新 PR 开出：关掉冲突复投前的旧 PR、清旧 worktree（先标记已取代，sync 跳过它）。 */
  async function supersede(e: Entry, new_pr_id: string): Promise<void> {
    const r = e.pending_replace;
    if (!r || r.old_pr_id === new_pr_id) return;
    e.pending_replace = undefined;
    superseded.add(r.old_pr_id);
    await requirePr().close(r.old_pr_id, `冲突复投，由 ${new_pr_id} 取代`);
    if (r.old_worktree) await deps.worktrees.cleanup(r.old_worktree);
  }

  function startResume(e: Entry): void {
    const token = e.resume_token;
    e.resume_token = undefined;
    e.resuming = true;
    const p = (async () => {
      const res = await deps.subAgent.resume(e.ticket, token);
      if (res.kind === "requeue_budget") {
        // 又碰上预算用完：继续等
        if (!TERMINAL.has(e.status)) e.resume_token = res.resume;
        return;
      }
      if (res.kind === "escalated") {
        // 8 已上报：9 写终态、关掉没用的旧 PR、清 9 建的 worktree
        if (res.pr_id) await supersede(e, res.pr_id);
        if (!TERMINAL.has(e.status)) {
          removeFromQueue(e.ticket.ticket_id);
          e.status = "escalated";
          await setStatus(e, "escalated");
          await cleanupOwnWorktree(e);
        }
        return;
      }
      // merge_queued：8 已调 submit，9 的 submit 已入队（和关旧 PR）；这里只核对
      if (!TERMINAL.has(e.status) && e.status !== "merge_queued")
        throw new Error(`resume 返回 merge_queued，但 ${e.ticket.ticket_id} 未经 submit 入队`);
    })()
      .catch(async (err) => {
        if (e.status === "escalated") {
          onError(err, e.ticket.ticket_id);
          return;
        }
        await escalateOnError(e, "resume_error", err);
      })
      .finally(() => {
        e.resuming = false;
        background.delete(p);
        kick();
      });
    background.add(p);
  }

  function startConflictResubmit(e: Entry, conflicted_files: string[]): void {
    const old_pr_id = e.pr_id!;
    const old_worktree = e.worktree_path;
    const old_own_worktree = e.own_worktree;
    const round = e.round + 1;
    track(e, "resubmit", async () => {
      await setStatus(e, "resubmitting");
      const base_seq = mergeLog.length;
      const wt = await deps.worktrees.create(e.ticket.ticket_id, target, round);
      let res: SubAgentOutcome;
      try {
        res = await deps.subAgent.resubmitConflict({
          ticket: e.ticket,
          round,
          worktree_path: wt.path,
          branch: wt.branch,
          base_commit: target,
          conflicted_files,
          previous_pr_id: old_pr_id,
          resubmit_counts: { ...e.counts },
        });
      } catch (err) {
        // 8 失败：新 worktree 归 9 管，上报时一起清掉
        e.worktree_path = wt.path;
        e.own_worktree = true;
        throw err;
      }
      await finishSubAgent(e, res, base_seq, {
        old_pr_id,
        old_worktree,
        old_own_worktree,
        new_worktree: wt.path,
        round,
      });
      if (e.status === "merge_queued" && !queue.includes(e.ticket.ticket_id))
        queue.push(e.ticket.ticket_id);
    });
  }

  function startReReview(e: Entry, since: MergeLogItem[], target_head?: string): void {
    const pr_id = e.pr_id!;
    removeFromQueue(e.ticket.ticket_id);
    e.re_reviewed = true;
    track(e, "re_review", async () => {
      await setStatus(e, "re_reviewing");
      const base_seq = mergeLog.length;
      const res = await deps.subAgent.reReview({
        ticket: e.ticket,
        pr_id,
        merged_since: since.map((m) => ({ ticket_id: m.ticket_id, sha: m.sha, files: m.files })),
        ...(target_head !== undefined ? { base_unknown: true, target_head } : {}),
      });
      await finishSubAgent(e, res, base_seq);
      // 重审不改变排队位置：回到队首
      if (e.status === "merge_queued" && !queue.includes(e.ticket.ticket_id))
        queue.unshift(e.ticket.ticket_id);
    });
  }

  /** 尝试合并一张；返回 false 表示队列里没有可出队的单。 */
  async function step(): Promise<boolean> {
    if (stopped) return false;
    const id = queue.find((t) => dependencyState(t) === "ready");
    if (!id) return false;
    const e = getEntry(id);
    current = e;
    if (e.status !== "merge_queued" || e.busy || !e.pr_id) {
      // 状态不对（不该在队里）：拿掉，不合并
      removeFromQueue(id);
      return true;
    }
    const pr_id = e.pr_id;

    // 合并日志定不了基线：和目标分支当前 HEAD 比，不同（或连基线都不知道）就保守地重审
    if (e.base_unknown) {
      const head = await deps.targetHead();
      if (e.base_commit !== undefined && head === e.base_commit) {
        e.base_unknown = false;
        e.base_seq = mergeLog.length;
      } else {
        e.base_changed = true;
        startReReview(e, [], head);
        return true;
      }
    }

    // 基线前进：涉及本单接口或依赖 → 重新评审（不计复投）；否则直接合
    const since = mergeLog.slice(e.base_seq);
    if (since.length > 0) {
      e.base_changed = true;
      if (since.some((m) => isRelevant(e.ticket, m))) {
        startReReview(e, since);
        return true;
      }
      e.base_seq = mergeLog.length;
    }

    let res: MergeResult;
    try {
      res = await requirePr().merge(pr_id, target);
    } catch (err) {
      const wait = rateLimitWait(err);
      if (wait !== undefined) {
        e.rate_limit_streak++;
        if (e.rate_limit_streak > RATE_LIMIT_ESCALATE_AFTER) {
          record(e, pr_id, { ...flags(e), merged: false, reason: "rate_limit" });
          await escalate(e, "github_manual", "rate_limit");
        } else {
          await sleep(wait);
        }
        return true;
      }
      e.rate_limit_streak = 0;
      e.target_dirty_streak = 0;
      const name = errorName(err);
      if (ESCALATED_BY_PR.has(name)) {
        // 6 已发 escalated(github_manual)，这里只改状态，不重复上报
        removeFromQueue(id);
        await setStatus(e, "escalated");
      } else {
        await escalate(e, "github_manual", `merge_error: ${errorMessage(err)}`.slice(0, 500));
      }
      return true;
    }
    e.rate_limit_streak = 0;
    if (!(!res.merged && !res.conflict && res.reason === "target_dirty")) e.target_dirty_streak = 0;

    if (res.merged) {
      await onMerged(e, pr_id, res.sha);
    } else if (res.conflict) {
      record(e, pr_id, { ...flags(e), conflict: true, merged: false });
      e.conflicted = true;
      removeFromQueue(id);
      if (e.counts.conflict >= limits.conflict) {
        await escalate(e, "conflict_limit", `conflicted_files: ${res.conflicted_files.join(", ")}`);
      } else {
        e.counts.conflict++;
        await setStatus(e, "conflict");
        startConflictResubmit(e, res.conflicted_files);
      }
    } else if (res.reason === "target_dirty") {
      record(e, pr_id, { ...flags(e), merged: false, reason: "target_dirty" });
      e.target_dirty_streak++;
      if (e.target_dirty_streak > TARGET_DIRTY_MAX_RETRIES) {
        await escalate(e, "github_manual", `target_dirty: ${res.worktree_path}`.slice(0, 500));
      } else {
        await sleep(dirtyRetryMs);
      }
    } else {
      record(e, pr_id, { ...flags(e), merged: false, reason: "merge_blocked" });
      await escalate(e, "github_manual", res.detail);
    }
    return true;
  }

  function flags(e: Entry) {
    return { conflict: false, base_changed: e.base_changed, re_reviewed: e.re_reviewed };
  }

  function pump(): Promise<void> {
    if (pumping) {
      pumpAgain = true;
      return pumping;
    }
    pumping = (async () => {
      do {
        pumpAgain = false;
        for (;;) {
          current = undefined;
          let more: boolean;
          try {
            more = await step();
          } catch (err) {
            // 出错的单上报 github_manual，队列继续
            const e = current as Entry | undefined;
            if (e) await escalateOnError(e, "merge_error", err);
            else onError(err, "(queue)");
            more = !stopped;
          }
          if (!more) break;
        }
      } while (pumpAgain && !stopped);
    })()
      .catch((err) => onError(err, "(queue)"))
      .finally(() => {
        pumping = undefined;
        current = undefined;
      });
    return pumping;
  }

  /** 触发合并循环；不会产生未处理的 rejection。 */
  function kick(): void {
    if (stopped) return;
    pump().catch((err) => onError(err, "(queue)"));
  }

  /** 可被 stop() 打断的等待：默认时钟的定时器会被清掉。 */
  function sleep(ms: number): Promise<void> {
    if (stopped) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        sleepers.delete(done);
        resolve();
      };
      sleepers.add(done);
      if (deps.clock) {
        deps.clock.sleep(ms).then(done, done);
      } else {
        const t = setTimeout(done, ms);
        timers.add(t);
        sleepers.add(() => clearTimeout(t));
      }
    });
  }

  const eventContext = ({
    pr_id,
    ticket_id,
  }: {
    pr_id: string;
    ticket_id: string | null;
  }): EventContext => {
    const id =
      (ticket_id && entries.has(ticket_id) ? ticket_id : undefined) ?? prToTicket.get(pr_id);
    const e = id ? entries.get(id) : undefined;
    if (!e) {
      // 集成记录、重启后不认识的 PR：不抛错（否则 6 的 sync 会中断），给最小上下文
      return deps.unknownEventContext
        ? deps.unknownEventContext({ pr_id, ticket_id })
        : {
            requirement_id: `${UNATTRIBUTED_PREFIX}${pr_id}`,
            trace_id: `${UNATTRIBUTED_PREFIX}${pr_id}`,
            span_id: newId(),
            parent_span_id: null,
          };
    }
    const t = e.ticket;
    return {
      requirement_id: t.requirement_id,
      trace_id: t.trace_id,
      span_id: t.span_id,
      parent_span_id: t.parent_span_id,
    };
  };

  return {
    async start() {
      startHead = await deps.targetHead();
      pr = await deps.createPr({ eventContext });
      unsubs.push(
        deps.bus.subscribe("review_backlog", (ev) => {
          reviewBacklog = { pending: ev.payload.pending, capacity: ev.payload.capacity };
        }),
        deps.bus.subscribe("supervisor_backlog", (ev) => {
          supervisorBacklog = { pending: ev.payload.pending, capacity: ev.payload.capacity };
        }),
      );
    },
    stop() {
      stopped = true;
      for (const u of unsubs.splice(0)) u();
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const wake of [...sleepers]) wake();
    },
    async enqueue(ticket) {
      if (entries.has(ticket.ticket_id)) throw new Error(`重复登记的单：${ticket.ticket_id}`);
      const e: Entry = {
        ticket: { ...ticket },
        status: "pending",
        pr_id: null,
        worktree_path: null,
        round: 0,
        base_seq: mergeLog.length,
        base_unknown: false,
        base_commit: undefined,
        counts: { review: 0, conflict: 0 },
        rate_limit_streak: 0,
        target_dirty_streak: 0,
        own_worktree: false,
        busy: false,
        resume_token: undefined,
        pending_replace: undefined,
        resuming: false,
        conflicted: false,
        base_changed: false,
        re_reviewed: false,
      };
      entries.set(ticket.ticket_id, e);
      await setStatus(e, "pending");
    },
    async submit({ ticket_id, pr_id, worktree_path, round, review_resubmits, base_commit }) {
      const e = getEntry(ticket_id);
      if (TERMINAL.has(e.status)) throw new Error(`单 ${ticket_id} 已是终态 ${e.status}`);
      if (
        queue.includes(ticket_id) ||
        current === e ||
        e.busy ||
        e.status === "merge_queued" ||
        e.status === "conflict" ||
        e.status === "re_reviewing"
      )
        throw new Error(`单 ${ticket_id} 已在合并队列中或正在处理（${e.status}）`);
      e.pr_id = pr_id;
      e.worktree_path = worktree_path;
      if (round !== undefined) e.round = round;
      if (review_resubmits !== undefined) e.counts.review = review_resubmits;
      // 基线：submit 带的 base_commit，没带就用 6 的 diff(pr_id).base_sha
      let base = base_commit;
      if (!base) {
        try {
          base = (await requirePr().diff(pr_id)).base_sha;
        } catch (err) {
          onError(err, ticket_id);
        }
      }
      e.base_commit = base || undefined;
      const i = base ? mergeLog.map((m) => m.sha).lastIndexOf(base) : -1;
      if (i >= 0) {
        // 本会话内某次合并的结果：只有它之后的合并才算基线前进
        e.base_seq = i + 1;
        e.base_unknown = false;
      } else if (base && base === startHead) {
        // 启动时的目标分支 HEAD：本会话的合并都在它之后
        e.base_seq = 0;
        e.base_unknown = false;
      } else {
        // 记录不足以判断：合并前和目标分支 HEAD 比，不同就重审
        e.base_unknown = true;
      }
      prToTicket.set(pr_id, ticket_id);
      if (queue.includes(ticket_id)) throw new Error(`单 ${ticket_id} 已在合并队列中`);
      e.resume_token = undefined;
      await setStatus(e, "merge_queued");
      queue.push(ticket_id);
      if (e.pending_replace) {
        // 预算暂停后续跑开出了新 PR：关掉冲突复投前的旧 PR
        try {
          await supersede(e, pr_id);
        } catch (err) {
          onError(err, ticket_id);
        }
      }
      kick();
    },
    eventContext,
    mergeResult: (pr_id) => results.get(pr_id),
    async sync() {
      const changes = await requirePr().sync();
      const applied: SyncChange[] = [];
      for (const c of changes) {
        const id = prToTicket.get(c.pr_id);
        const e = id ? entries.get(id) : undefined;
        // 只处理本单当前的 PR；已被取代的旧 PR、集成记录、终态的单跳过
        if (!e || superseded.has(c.pr_id) || e.pr_id !== c.pr_id || TERMINAL.has(e.status))
          continue;
        try {
          if (c.to === "merged") {
            // 用户在 GitHub 上手动合并：同步为 merged；没有合并 sha，不发 interface_changed
            removeFromQueue(e.ticket.ticket_id);
            await setStatus(e, "merged");
            const files = await changedFiles(c.pr_id);
            mergeLog.push({
              ticket_id: e.ticket.ticket_id,
              sha: "",
              files,
              changed_interfaces: [],
            });
            applied.push(c);
          } else if (c.to === "closed") {
            // 用户手动关闭：6 已发 escalated(github_manual)，9 只改状态
            removeFromQueue(e.ticket.ticket_id);
            e.status = "escalated";
            await setStatus(e, "escalated");
            await cleanupOwnWorktree(e);
            applied.push(c);
          }
        } catch (err) {
          // 一条出错不影响其余
          onError(err, e.ticket.ticket_id);
        }
      }
      if (applied.length) kick();
      return applied;
    },
    async resumeBudgetPaused() {
      const paused = [...entries.values()].filter(
        (e) => e.resume_token !== undefined && !e.resuming && !TERMINAL.has(e.status),
      );
      if (paused.length === 0 || stopped) return [];
      if ((await deps.budgetState()).daily_exhausted) return [];
      for (const e of paused) startResume(e);
      return paused.map((e) => e.ticket.ticket_id);
    },
    budgetPaused: () =>
      [...entries.values()]
        .filter((e) => (e.resume_token !== undefined || e.resuming) && !TERMINAL.has(e.status))
        .map((e) => e.ticket.ticket_id),
    async backpressureState(): Promise<BackpressureState> {
      const budget = await deps.budgetState();
      const merge_queued = [...entries.values()].filter((e) => e.status === "merge_queued").length;
      const d = bp.decide(
        {
          review: reviewBacklog,
          supervisor: supervisorBacklog,
          merge_queued,
          daily_exhausted: budget.daily_exhausted,
        },
        clock.now(),
      );
      return {
        ...d,
        review_backlog: { ...reviewBacklog },
        supervisor_backlog: supervisorBacklog ? { ...supervisorBacklog } : null,
        pending_prs: {
          merge_queued,
          in_review: reviewBacklog.pending,
          total: merge_queued + reviewBacklog.pending,
          limit: deps.config.backpressure.pending_pr_limit,
        },
        daily_budget_exhausted: budget.daily_exhausted,
      };
    },
    dependencyState: (id) => dependencyState(id),
    status: (id) => entries.get(id)?.status,
    snapshot: () =>
      [...entries.values()].map((e) => ({
        ticket_id: e.ticket.ticket_id,
        status: e.status,
        pr_id: e.pr_id,
        round: e.round,
        resubmit_counts: { ...e.counts },
        dependency: dependencyState(e.ticket.ticket_id),
        budget_paused: e.resume_token !== undefined || e.resuming,
      })),
    async idle() {
      for (;;) {
        if (pumping) await pumping;
        else if (background.size) await Promise.all([...background]);
        else return;
      }
    },
  };
}
