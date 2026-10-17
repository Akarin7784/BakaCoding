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

const defaultClock: SchedulerClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** 6 已经自己发过 escalated(github_manual) 的错误，9 不重复上报。 */
const ESCALATED_BY_PR = new Set(["GithubAuthError", "GithubBranchDivergedError"]);

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
  counts: { review: number; conflict: number };
  rate_limit_streak: number;
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
    await setStatus(e, "escalated");
    const payload: PublishInput<"escalated">["payload"] =
      reason === "github_manual"
        ? { reason, detail: detail ?? "" }
        : { reason, resubmit_counts: { ...e.counts }, ...(detail ? { detail } : {}) };
    await deps.bus.publish({ ...common(e.ticket), type: "escalated", payload });
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

  function track(ticket_id: string, task: () => Promise<void>): void {
    const p = task()
      .catch((err) => onError(err, ticket_id))
      .finally(() => {
        background.delete(p);
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
      new_worktree: string;
      round: number;
    },
  ): Promise<void> {
    if (replace && "pr_id" in res && res.pr_id && res.pr_id !== replace.old_pr_id) {
      // 新 PR 已开出：关旧 PR（closed_by: bakacoding），再清旧 worktree
      await requirePr().close(replace.old_pr_id, `冲突复投，由 ${res.pr_id} 取代`);
      if (replace.old_worktree) await deps.worktrees.cleanup(replace.old_worktree);
    }
    if ("escalated" in res) {
      // 8 已自己上报，9 只更新状态
      removeFromQueue(e.ticket.ticket_id);
      if (res.pr_id) {
        e.pr_id = res.pr_id;
        prToTicket.set(res.pr_id, e.ticket.ticket_id);
      }
      await setStatus(e, "escalated");
      return;
    }
    e.pr_id = res.pr_id;
    prToTicket.set(res.pr_id, e.ticket.ticket_id);
    if (replace) {
      e.worktree_path = replace.new_worktree;
      e.round = replace.round;
    }
    if (res.review_resubmits !== undefined) e.counts.review = res.review_resubmits;
    e.base_seq = base_seq;
    await setStatus(e, "merge_queued");
  }

  function startConflictResubmit(e: Entry, conflicted_files: string[]): void {
    const old_pr_id = e.pr_id!;
    const old_worktree = e.worktree_path;
    const round = e.round + 1;
    track(e.ticket.ticket_id, async () => {
      await setStatus(e, "resubmitting");
      const base_seq = mergeLog.length;
      const wt = await deps.worktrees.create(e.ticket.ticket_id, target, round);
      const res = await deps.subAgent.resubmitConflict({
        ticket: e.ticket,
        round,
        worktree_path: wt.path,
        branch: wt.branch,
        base_commit: target,
        conflicted_files,
        previous_pr_id: old_pr_id,
        resubmit_counts: { ...e.counts },
      });
      await finishSubAgent(e, res, base_seq, {
        old_pr_id,
        old_worktree,
        new_worktree: wt.path,
        round,
      });
      if (e.status === "merge_queued") queue.push(e.ticket.ticket_id);
      void pump();
    });
  }

  function startReReview(e: Entry, since: MergeLogItem[]): void {
    const pr_id = e.pr_id!;
    removeFromQueue(e.ticket.ticket_id);
    e.re_reviewed = true;
    track(e.ticket.ticket_id, async () => {
      await setStatus(e, "re_reviewing");
      const base_seq = mergeLog.length;
      const res = await deps.subAgent.reReview({
        ticket: e.ticket,
        pr_id,
        merged_since: since.map((m) => ({ ticket_id: m.ticket_id, sha: m.sha, files: m.files })),
      });
      await finishSubAgent(e, res, base_seq);
      // 重审不改变排队位置：回到队首
      if (e.status === "merge_queued") queue.unshift(e.ticket.ticket_id);
      void pump();
    });
  }

  /** 尝试合并一张；返回 false 表示队列里没有可出队的单。 */
  async function step(): Promise<boolean> {
    const id = queue.find((t) => dependencyState(t) === "ready");
    if (!id) return false;
    const e = getEntry(id);
    const pr_id = e.pr_id!;

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
          await clock.sleep(wait);
        }
        return true;
      }
      e.rate_limit_streak = 0;
      const name = (err as Error)?.name ?? "Error";
      if (ESCALATED_BY_PR.has(name)) {
        // 6 已发 escalated(github_manual)，这里只改状态，不重复上报
        removeFromQueue(id);
        await setStatus(e, "escalated");
      } else {
        await escalate(
          e,
          "github_manual",
          `merge_error: ${name}: ${(err as Error)?.message ?? ""}`.slice(0, 500),
        );
      }
      return true;
    }
    e.rate_limit_streak = 0;

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
      await clock.sleep(dirtyRetryMs);
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
        while (await step()) {
          /* 继续出队 */
        }
      } while (pumpAgain);
    })().finally(() => {
      pumping = undefined;
    });
    return pumping;
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
    if (!e)
      throw new Error(`eventContext：找不到 PR ${pr_id}（ticket ${ticket_id ?? "null"}）对应的单`);
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
      for (const u of unsubs.splice(0)) u();
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
        counts: { review: 0, conflict: 0 },
        rate_limit_streak: 0,
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
      if (queue.includes(ticket_id)) throw new Error(`单 ${ticket_id} 已在合并队列中`);
      e.pr_id = pr_id;
      e.worktree_path = worktree_path;
      if (round !== undefined) e.round = round;
      if (review_resubmits !== undefined) e.counts.review = review_resubmits;
      if (base_commit) {
        // 基线是本会话内某次合并的结果：只有它之后的合并才算基线前进
        const i = mergeLog.map((m) => m.sha).lastIndexOf(base_commit);
        if (i >= 0) e.base_seq = i + 1;
      }
      prToTicket.set(pr_id, ticket_id);
      await setStatus(e, "merge_queued");
      queue.push(ticket_id);
      void pump();
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
        if (!e || e.pr_id !== c.pr_id || TERMINAL.has(e.status)) continue;
        if (c.to === "merged") {
          // 用户在 GitHub 上手动合并：同步为 merged；没有合并 sha，不发 interface_changed
          removeFromQueue(e.ticket.ticket_id);
          await setStatus(e, "merged");
          const files = await changedFiles(c.pr_id);
          mergeLog.push({ ticket_id: e.ticket.ticket_id, sha: "", files, changed_interfaces: [] });
          applied.push(c);
        } else if (c.to === "closed") {
          // 用户手动关闭：6 已发 escalated(github_manual)，9 只改状态
          removeFromQueue(e.ticket.ticket_id);
          await setStatus(e, "escalated");
          applied.push(c);
        }
      }
      if (applied.length) void pump();
      return applied;
    },
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
