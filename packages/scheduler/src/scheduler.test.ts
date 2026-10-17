import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { getConfig } from "@bakacoding/config-budget";
import {
  GithubRateLimitError,
  SyncPartialError,
  type MergeResult,
  type SyncChange,
} from "@bakacoding/pr";
import {
  DEPENDENCY_MANIFEST_GLOBS,
  EventSchema,
  type Diff,
  type EventOf,
  type TicketStatus,
} from "@bakacoding/types";
import { isUnsafeGlob as workspaceIsUnsafeGlob } from "@bakacoding/workspace";
import {
  BackpressureController,
  createScheduler,
  type ConflictResubmitRequest,
  type DispatchOutcome,
  HighRiskDecisionError,
  type HighRiskHeldInfo,
  isStalePrError,
  type ReReviewRequest,
  type Scheduler,
  type SubAgentCallOptions,
  DEFAULT_EXCLUSIVE_ZONES,
  expandBraces,
  globToRegExp,
  globsOverlap,
  inExclusiveZone,
  isUnsafeScope,
  MAX_BRACE_EXPANSIONS,
  matchesAny,
  sampleOf,
  samplesOf,
  type ResumeOutcome,
  type SchedulerDeps,
  type SchedulerTicket,
  type SubAgentOutcome,
} from "./index.js";

const examplePath = fileURLToPath(new URL("../../../config/models.example.json", import.meta.url));
const SHA = (c: string) => c.repeat(40);

type Step = MergeResult | Error;

function ticket(id: string, extra: Partial<SchedulerTicket> = {}): SchedulerTicket {
  return {
    ticket_id: id,
    requirement_id: "req-1",
    trace_id: "trace-1",
    span_id: `span-${id}`,
    parent_span_id: "span-root",
    ...extra,
  };
}

const merged = (c: string): MergeResult => ({ merged: true, sha: SHA(c), fast_forward: false });
const conflict = (files = ["a.ts"]): MergeResult => ({
  merged: false,
  conflict: true,
  conflicted_files: files,
});
const rateLimit = (ms = 1000) => new GithubRateLimitError(429, "merge", ms);

interface Harness {
  deps: SchedulerDeps;
  published: Array<{ type: string; payload: Record<string, unknown>; ticket_id: string | null }>;
  statuses: Array<[string, TicketStatus]>;
  sleeps: number[];
  calls: string[];
  merges: Map<string, Step[]>;
  diffs: Map<string, string[]>;
  syncChanges: SyncChange[];
  daily: { exhausted: boolean };
  emit<K extends "review_backlog" | "supervisor_backlog">(
    type: K,
    payload: { pending: number; capacity: number },
  ): void;
  resubmit: ReturnType<
    typeof vi.fn<(r: ConflictResubmitRequest, o?: SubAgentCallOptions) => Promise<SubAgentOutcome>>
  >;
  reReview: ReturnType<
    typeof vi.fn<(r: ReReviewRequest, o?: SubAgentCallOptions) => Promise<SubAgentOutcome>>
  >;
  resume: ReturnType<typeof vi.fn<(t: SchedulerTicket, token: unknown) => Promise<ResumeOutcome>>>;
  eventContextInjected: unknown[];
  errors: unknown[];
  head: { sha: string };
  diffFails: Set<string>;
  /** 直接触发某个订阅（T-039：write_scope_requested 等），返回 handler 的结果 */
  fire(type: string, event: unknown): unknown;
}

function harness(over: { pending_pr_limit?: number; conflict_limit?: number } = {}): Harness {
  const cfg = getConfig(examplePath);
  const published: Harness["published"] = [];
  const statuses: Harness["statuses"] = [];
  const sleeps: number[] = [];
  const calls: string[] = [];
  const merges = new Map<string, Step[]>();
  const diffs = new Map<string, string[]>();
  const daily = { exhausted: false };
  const handlers = new Map<string, (e: unknown) => void>();
  const eventContextInjected: unknown[] = [];
  const errors: unknown[] = [];
  const head = { sha: SHA("a") };
  const diffFails = new Set<string>();
  let now = Date.parse("2026-10-17T08:00:00.000Z");
  let id = 0;
  let seq = 0;
  let newPr = 100;
  const h: Partial<Harness> = {};
  const resubmit = vi.fn<
    (r: ConflictResubmitRequest, o?: SubAgentCallOptions) => Promise<SubAgentOutcome>
  >(async (r) => {
    calls.push(`resubmit:${r.ticket.ticket_id}:r${r.round}`);
    return { pr_id: `pr-${newPr++}` };
  });
  const reReview = vi.fn<(r: ReReviewRequest, o?: SubAgentCallOptions) => Promise<SubAgentOutcome>>(
    async (r) => {
      calls.push(`reReview:${r.ticket.ticket_id}`);
      return { pr_id: r.pr_id };
    },
  );
  const resume = vi.fn(async (t: SchedulerTicket, token: unknown): Promise<ResumeOutcome> => {
    calls.push(`resume:${t.ticket_id}:${JSON.stringify(token)}`);
    return { kind: "escalated", pr_id: null };
  });
  const deps: SchedulerDeps = {
    bus: {
      publish: (e) => {
        const full = { ...e, seq: seq++ };
        const r = EventSchema.safeParse(full);
        if (!r.success) throw new Error(`事件不合法：${r.error.message}`);
        published.push(full as Harness["published"][number]);
      },
      subscribe: ((type: string, handler: (e: unknown) => void) => {
        handlers.set(type, handler);
        return () => handlers.delete(type);
      }) as SchedulerDeps["bus"]["subscribe"],
    },
    createPr: ({ eventContext }) => {
      eventContextInjected.push(eventContext);
      return {
        merge: async (pr_id: string, target: string) => {
          calls.push(`merge:${pr_id}:${target}`);
          const q = merges.get(pr_id) ?? [];
          const next = q.shift() ?? merged("f");
          if (next instanceof Error) throw next;
          if (next.merged) head.sha = next.sha;
          return next;
        },
        close: async (pr_id: string, reason: string) => {
          calls.push(`close:${pr_id}:${reason}`);
        },
        sync: async () => h.syncChanges!.splice(0),
        diff: async (pr_id: string): Promise<Diff> => {
          if (diffFails.has(pr_id)) throw new Error(`diff 失败：${pr_id}`);
          return {
            base_sha: SHA("a"),
            head_sha: SHA("b"),
            files: (diffs.get(pr_id) ?? []).map((path) => ({
              path,
              status: "modified",
              additions: 1,
              deletions: 0,
              patch: "",
            })),
          };
        },
      };
    },
    config: {
      pipeline: {
        ...cfg.pipeline,
        resubmit_limits: {
          ...cfg.pipeline.resubmit_limits,
          ...(over.conflict_limit !== undefined ? { conflict: over.conflict_limit } : {}),
        },
      },
      backpressure: {
        ...cfg.backpressure,
        ...(over.pending_pr_limit !== undefined ? { pending_pr_limit: over.pending_pr_limit } : {}),
      },
    },
    targetHead: () => head.sha,
    budgetState: () => ({ daily_exhausted: daily.exhausted }),
    tickets: { setStatus: (t, s) => void statuses.push([t, s]) },
    worktrees: {
      create: (t, base, round) => {
        calls.push(`create:${t}:${base}:r${round}`);
        return { path: `/wt/${t}-r${round}`, branch: `bakacoding/${t}-r${round}` };
      },
      cleanup: (p) => void calls.push(`cleanup:${p}`),
    },
    subAgent: { resubmitConflict: resubmit, reReview, resume },
    clock: {
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    },
    newId: () => `ev-${id++}`,
    target_dirty_retry_ms: 5000,
    onError: (e) => void errors.push(e),
  };
  Object.assign(h, {
    deps,
    published,
    statuses,
    sleeps,
    calls,
    merges,
    diffs,
    syncChanges: [],
    daily,
    emit: (type: string, payload: { pending: number; capacity: number }) =>
      handlers.get(type)?.({ type, payload }),
    fire: (type: string, event: unknown) => handlers.get(type)?.(event),
    resubmit,
    reReview,
    resume,
    eventContextInjected,
    errors,
    head,
    diffFails,
  });
  return h as Harness;
}

async function started(h: Harness) {
  const s = createScheduler(h.deps);
  await s.start();
  return s;
}

const escalations = (h: Harness) =>
  h.published.filter((e) => e.type === "escalated") as unknown as EventOf<"escalated">[];

describe("模块 9 合并队列（T-035）", () => {
  it("1. 启动时把 eventContext 注入 6：按 ticket_id、其次 pr_id 查 trace；未知 PR 给最小上下文", async () => {
    const h = harness();
    const s = await started(h);
    expect(h.eventContextInjected).toEqual([s.eventContext]);
    await s.enqueue(ticket("T-1"));
    h.merges.set("pr-1", [
      { merged: false, conflict: false, reason: "merge_blocked", detail: "x" },
    ]);
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/wt/T-1-r0" });
    await s.idle();
    const want = {
      requirement_id: "req-1",
      trace_id: "trace-1",
      span_id: "span-T-1",
      parent_span_id: "span-root",
    };
    expect(s.eventContext({ pr_id: "x", ticket_id: "T-1" })).toEqual(want);
    expect(s.eventContext({ pr_id: "pr-1", ticket_id: null })).toEqual(want);
    // 不认识的 PR（集成记录、重启后）：不抛错，给最小上下文
    expect(s.eventContext({ pr_id: "local-integration-1", ticket_id: null })).toMatchObject({
      requirement_id: "unattributed:local-integration-1",
      trace_id: "unattributed:local-integration-1",
      parent_span_id: null,
    });
  });

  it("2. merge_blocked：发 escalated(github_manual) 带 6 的 detail，不复投", async () => {
    const h = harness();
    const s = await started(h);
    await s.enqueue(ticket("T-1"));
    h.merges.set("pr-1", [
      { merged: false, conflict: false, reason: "merge_blocked", detail: "required check missing" },
    ]);
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/wt/T-1-r0" });
    await s.idle();
    expect(escalations(h).map((e) => e.payload)).toEqual([
      { reason: "github_manual", detail: "required check missing" },
    ]);
    expect(s.status("T-1")).toBe("escalated");
    expect(h.resubmit).not.toHaveBeenCalled();
    expect(s.mergeResult("pr-1")).toMatchObject({ merged: false, reason: "merge_blocked" });
  });

  it("3a. 限流：按 retry_after_ms 等待后重试，连续 3 次后成功不上报", async () => {
    const h = harness();
    const s = await started(h);
    await s.enqueue(ticket("T-1"));
    h.merges.set("pr-1", [rateLimit(1000), rateLimit(2000), rateLimit(3000), merged("c")]);
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/wt" });
    await s.idle();
    expect(h.sleeps).toEqual([1000, 2000, 3000]);
    expect(s.status("T-1")).toBe("merged");
    expect(escalations(h)).toEqual([]);
  });

  it("3b. 限流：连续超过 3 次发 escalated(github_manual, detail rate_limit)", async () => {
    const h = harness();
    const s = await started(h);
    await s.enqueue(ticket("T-1"));
    h.merges.set("pr-1", [rateLimit(), rateLimit(), rateLimit(), rateLimit()]);
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/wt" });
    await s.idle();
    expect(h.sleeps).toEqual([1000, 1000, 1000]);
    expect(escalations(h).map((e) => e.payload)).toEqual([
      { reason: "github_manual", detail: "rate_limit" },
    ]);
    expect(s.status("T-1")).toBe("escalated");
  });

  it("3c. 限流计数只算连续：中间一次 target_dirty 会清零", async () => {
    const h = harness();
    const s = await started(h);
    await s.enqueue(ticket("T-1"));
    h.merges.set("pr-1", [
      rateLimit(),
      rateLimit(),
      rateLimit(),
      { merged: false, conflict: false, reason: "target_dirty", worktree_path: "/x" },
      rateLimit(),
      rateLimit(),
      merged("c"),
    ]);
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/wt" });
    await s.idle();
    expect(s.status("T-1")).toBe("merged");
    expect(h.sleeps).toEqual([1000, 1000, 1000, 5000, 1000, 1000]);
  });

  it("4. 冲突：新建 r<n+1> worktree 交给 8，新 PR 开出后关旧 PR、再清旧 worktree；第 3 次冲突上报 conflict_limit", async () => {
    const h = harness();
    const s = await started(h);
    await s.enqueue(ticket("T-1"));
    h.merges.set("pr-1", [conflict(["a.ts"])]);
    h.merges.set("pr-100", [conflict(["b.ts"])]);
    h.merges.set("pr-101", [conflict(["c.ts"])]);
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/wt/T-1-r0", round: 0 });
    await s.idle();
    expect(h.calls).toEqual([
      "merge:pr-1:bakacoding/integration",
      `create:T-1:${SHA("a")}:r1`, // T-039：从目标分支 HEAD 的 sha 建，不再传分支名
      "resubmit:T-1:r1",
      "close:pr-1:冲突复投，由 pr-100 取代",
      "cleanup:/wt/T-1-r0",
      "merge:pr-100:bakacoding/integration",
      `create:T-1:${SHA("a")}:r2`, // T-039：从目标分支 HEAD 的 sha 建，不再传分支名
      "resubmit:T-1:r2",
      "close:pr-100:冲突复投，由 pr-101 取代",
      "cleanup:/wt/T-1-r1",
      "merge:pr-101:bakacoding/integration",
      // 最终上报：清掉 9 建的 r2 worktree
      "cleanup:/wt/T-1-r2",
    ]);
    expect(h.resubmit.mock.calls[0]![0]).toMatchObject({
      conflicted_files: ["a.ts"],
      previous_pr_id: "pr-1",
      worktree_path: "/wt/T-1-r1",
      base_commit: SHA("a"),
      resubmit_counts: { review: 0, conflict: 1 },
    });
    expect(escalations(h).map((e) => e.payload)).toEqual([
      {
        reason: "conflict_limit",
        resubmit_counts: { review: 0, conflict: 2 },
        detail: "conflicted_files: c.ts",
      },
    ]);
    expect(s.status("T-1")).toBe("escalated");
    const seen = h.statuses.filter(([t]) => t === "T-1").map(([, st]) => st);
    expect(seen).toEqual([
      "pending",
      "merge_queued",
      "conflict",
      "resubmitting",
      "merge_queued",
      "conflict",
      "resubmitting",
      "merge_queued",
      "escalated",
    ]);
  });

  it("4b. 冲突复投时 8 上报了：状态 escalated，9 不重复上报", async () => {
    const h = harness();
    h.resubmit.mockImplementationOnce(async () => ({ escalated: true, pr_id: "pr-9" }));
    const s = await started(h);
    await s.enqueue(ticket("T-1"));
    h.merges.set("pr-1", [conflict()]);
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/wt/T-1-r0" });
    await s.idle();
    expect(s.status("T-1")).toBe("escalated");
    expect(escalations(h)).toEqual([]);
    expect(h.calls).toContain("close:pr-1:冲突复投，由 pr-9 取代");
    expect(h.calls).toContain("cleanup:/wt/T-1-r1");
  });

  it("5. sync：手动合并 → merged；手动关闭 → escalated 且不重复上报（6 已发）；旧 PR 忽略", async () => {
    // T-1、T-2 依赖一张还没合的 T-0，留在队列里不自动合并
    const h = harness();
    const s = await started(h);
    await s.enqueue(ticket("T-0"));
    await s.enqueue(ticket("T-1", { depends_on: ["T-0"] }));
    await s.enqueue(ticket("T-2", { depends_on: ["T-0"] }));
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/1" });
    await s.submit({ ticket_id: "T-2", pr_id: "pr-2", worktree_path: "/2" });
    await s.idle();
    h.syncChanges.push(
      { pr_id: "pr-1", from: "open", to: "merged" },
      { pr_id: "pr-2", from: "open", to: "closed" },
      { pr_id: "pr-unknown", from: "open", to: "closed" },
      { pr_id: "local-integration-1", from: "open", to: "merged" },
    );
    const applied = await s.sync();
    expect(applied.map((c) => c.pr_id)).toEqual(["pr-1", "pr-2"]);
    expect(s.status("T-1")).toBe("merged");
    expect(s.status("T-2")).toBe("escalated");
    expect(escalations(h)).toEqual([]);
    expect(h.published.filter((e) => e.type === "interface_changed")).toEqual([]);
    expect(h.calls.filter((c) => c.startsWith("merge:"))).toEqual([]);
  });

  it("5b. sync：冲突复投后被 9 自己关掉的旧 PR（closed_by: bakacoding）跳过，不改状态、不当用户关闭", async () => {
    const h = harness();
    const s = await started(h);
    await s.enqueue(ticket("T-1"));
    h.merges.set("pr-1", [conflict()]);
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/wt/T-1-r0" });
    await s.idle();
    expect(h.calls).toContain("close:pr-1:冲突复投，由 pr-100 取代");
    expect(s.status("T-1")).toBe("merged");
    const before = h.statuses.length;
    h.syncChanges.push({ pr_id: "pr-1", from: "open", to: "closed" });
    expect(await s.sync()).toEqual([]);
    expect(s.status("T-1")).toBe("merged");
    expect(h.statuses.length).toBe(before);
    expect(escalations(h)).toEqual([]);
  });

  it("5c. sync：9 正在关旧 PR 时同步报上来它已关闭，跳过，不当用户手动关闭", async () => {
    const h = harness();
    const ref: { s?: Awaited<ReturnType<typeof started>> } = {};
    const inner = h.deps.createPr;
    let syncDuringClose: SyncChange[] | undefined;
    h.deps.createPr = async (opts) => {
      const pr = await inner(opts);
      return {
        ...pr,
        close: async (pr_id: string, reason: string) => {
          await pr.close(pr_id, reason);
          // 远端已关、本单记录还指着旧 PR 的这一刻来一次 sync
          h.syncChanges.push({ pr_id, from: "open", to: "closed" });
          syncDuringClose = await ref.s!.sync();
        },
      };
    };
    const s = (ref.s = await started(h));
    await s.enqueue(ticket("T-1"));
    h.merges.set("pr-1", [conflict()]);
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/wt/T-1-r0" });
    await s.idle();
    expect(syncDuringClose).toEqual([]);
    expect(s.status("T-1")).toBe("merged");
    expect(escalations(h)).toEqual([]);
    expect(h.statuses.filter(([, st]) => st === "escalated")).toEqual([]);
  });

  it("Q3a. 冲突复投后台抛错：调 onError，直接上报 github_manual（resubmit_error），状态 escalated", async () => {
    const h = harness();
    h.resubmit.mockImplementationOnce(async () => {
      throw new Error("coder crashed");
    });
    const s = await started(h);
    await s.enqueue(ticket("T-1"));
    h.merges.set("pr-1", [conflict()]);
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/wt/T-1-r0" });
    await s.idle();
    expect(h.errors.map((e) => (e as Error).message)).toEqual(["coder crashed"]);
    expect(escalations(h).map((e) => [e.ticket_id, e.payload])).toEqual([
      ["T-1", { reason: "github_manual", detail: "resubmit_error: coder crashed" }],
    ]);
    expect(s.status("T-1")).toBe("escalated");
    expect(h.statuses.filter(([t]) => t === "T-1").at(-1)).toEqual(["T-1", "escalated"]);
    expect(h.calls.some((c) => c.startsWith("close:"))).toBe(false);
    // 9 建的 r1 worktree 在上报时清掉
    expect(h.calls).toContain("cleanup:/wt/T-1-r1");
  });

  it("Q3b. 建 worktree 抛错也走同一条：resubmit_error 上报，不停在 resubmitting", async () => {
    const h = harness();
    h.deps.worktrees.create = () => {
      throw new Error("worktree 已存在");
    };
    const s = await started(h);
    await s.enqueue(ticket("T-1"));
    h.merges.set("pr-1", [conflict()]);
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/wt/T-1-r0" });
    await s.idle();
    expect(escalations(h).map((e) => e.payload)).toEqual([
      { reason: "github_manual", detail: "resubmit_error: worktree 已存在" },
    ]);
    expect(s.status("T-1")).toBe("escalated");
  });

  it("Q3c. 重审后台抛错：调 onError，上报 github_manual（re_review_error），状态 escalated", async () => {
    const h = harness();
    h.reReview.mockImplementationOnce(async () => {
      throw new Error("review pool down");
    });
    const s = await started(h);
    await s.enqueue(ticket("A"));
    await s.enqueue(ticket("B", { depends_on: ["A"] }));
    await s.submit({ ticket_id: "A", pr_id: "pr-a", worktree_path: "/a" });
    await s.idle();
    await s.submit({ ticket_id: "B", pr_id: "pr-b", worktree_path: "/b", base_commit: SHA("a") });
    await s.idle();
    expect(h.reReview).toHaveBeenCalledTimes(1);
    expect(h.errors.map((e) => (e as Error).message)).toEqual(["review pool down"]);
    expect(escalations(h).map((e) => [e.ticket_id, e.payload])).toEqual([
      ["B", { reason: "github_manual", detail: "re_review_error: review pool down" }],
    ]);
    expect(s.status("B")).toBe("escalated");
  });

  it("Q4a. 基线不在合并日志里（如重启后）且与目标分支 HEAD 不同：保守重审，再合并", async () => {
    const h = harness();
    const s = await started(h);
    await s.enqueue(ticket("T-1"));
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/1", base_commit: SHA("9") });
    await s.idle();
    expect(h.reReview).toHaveBeenCalledTimes(1);
    expect(h.reReview.mock.calls[0]![0]).toMatchObject({
      pr_id: "pr-1",
      merged_since: [],
      base_unknown: true,
      target_head: SHA("a"),
    });
    expect(s.status("T-1")).toBe("merged");
    expect(s.mergeResult("pr-1")).toMatchObject({ base_changed: true, re_reviewed: true });
    expect(s.snapshot()[0]!.resubmit_counts).toEqual({ review: 0, conflict: 0 });
  });

  it("Q4b. 基线不在合并日志里但等于目标分支当前 HEAD：没前进，直接合", async () => {
    const h = harness();
    const s = await started(h);
    h.head.sha = SHA("9"); // 启动后目标分支被别处推进到 9，本单正好基于 9
    await s.enqueue(ticket("T-1"));
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/1", base_commit: SHA("9") });
    await s.idle();
    expect(h.reReview).not.toHaveBeenCalled();
    expect(s.mergeResult("pr-1")).toMatchObject({ merged: true, base_changed: false });
  });

  it("Q4c. 没带 base_commit 时用 6 的 diff base_sha；连它也拿不到就保守重审，不跳过", async () => {
    const h = harness();
    const s = await started(h);
    await s.enqueue(ticket("T-1"));
    await s.enqueue(ticket("T-2"));
    // T-1：diff 的 base_sha（a）就是启动时的 HEAD，不重审
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/1" });
    await s.idle();
    expect(h.reReview).not.toHaveBeenCalled();
    // T-2：diff 失败，基线未知 → 重审
    h.diffFails.add("pr-2");
    await s.submit({ ticket_id: "T-2", pr_id: "pr-2", worktree_path: "/2" });
    await s.idle();
    expect(h.reReview).toHaveBeenCalledTimes(1);
    expect(h.reReview.mock.calls[0]![0]).toMatchObject({ pr_id: "pr-2", base_unknown: true });
    expect(s.status("T-2")).toBe("merged");
  });

  it("Q4d. 启动时读一次目标分支 HEAD 作为合并日志起点", async () => {
    const h = harness();
    const spy = vi.fn(() => SHA("a"));
    h.deps.targetHead = spy;
    await started(h);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("R1a. 合并成功后的收尾（发 interface_changed）抛错：状态保持 merged，发 escalated(merged_but)，依赖方照常放行，无未处理 rejection（T-038）", async () => {
    const h = harness();
    const pub = h.deps.bus.publish;
    let failed = false;
    h.deps.bus.publish = (e) => {
      if (e.type === "interface_changed" && !failed) {
        failed = true;
        throw new Error("bus down");
      }
      return pub(e);
    };
    const s = await started(h);
    await s.enqueue(ticket("T-1"));
    await s.enqueue(ticket("T-2"));
    await s.enqueue(ticket("T-3", { depends_on: ["T-1"] }));
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/1" });
    await s.submit({ ticket_id: "T-2", pr_id: "pr-2", worktree_path: "/2" });
    await s.idle();
    expect(escalations(h).map((e) => [e.ticket_id, e.payload])).toEqual([
      [
        "T-1",
        {
          reason: "merged_but",
          resubmit_counts: { review: 0, conflict: 0 },
          detail: "merged_but: interface_changed_unsent: bus down",
        },
      ],
    ]);
    for (const e of escalations(h)) expect(EventSchema.safeParse(e).success).toBe(true);
    expect(s.status("T-1")).toBe("merged");
    expect(h.statuses.filter(([id]) => id === "T-1").map(([, st]) => st)).not.toContain(
      "escalated",
    );
    expect(s.status("T-2")).toBe("merged");
    expect(s.dependencyState("T-3")).toBe("ready");
    // T-046：下一轮合并循环前补发 T-1，再合 T-2
    expect(
      h.published.filter((e) => e.type === "interface_changed").map((e) => e.ticket_id),
    ).toEqual(["T-1", "T-2"]);
  });

  it("T46a. sync 手动合并带 merge_sha：经同一总线发 interface_changed，base_commit 为合并 sha，记进合并日志", async () => {
    const h = harness();
    const s = await started(h);
    await s.enqueue(ticket("T-0"));
    await s.enqueue(
      ticket("T-1", { depends_on: ["T-0"], interfaces: [{ file: "src/a.ts", symbol: "A" }] }),
    );
    await s.enqueue(
      ticket("T-2", { depends_on: ["T-0"], interfaces: [{ file: "src/a.ts", symbol: "A" }] }),
    );
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/1" });
    await s.idle();
    h.diffs.set("pr-1", ["src/a.ts"]);
    h.syncChanges.push({ pr_id: "pr-1", from: "open", to: "merged", merge_sha: SHA("c") });
    expect((await s.sync()).map((c) => c.pr_id)).toEqual(["pr-1"]);
    expect(s.status("T-1")).toBe("merged");
    const ic = h.published.filter((e) => e.type === "interface_changed");
    expect(ic).toHaveLength(1);
    expect(ic[0]).toMatchObject({
      ticket_id: "T-1",
      payload: {
        pr_id: "pr-1",
        base_commit: SHA("c"),
        changed_interfaces: [{ file: "src/a.ts", symbol: "A" }],
        affected_ticket_ids: ["T-2"],
      },
    });
    expect(escalations(h)).toEqual([]);
    // 手动合并的 sha 不进合并日志（记空串）：以它为基线的单按基线未知走保守路径，和目标分支 HEAD 比后重审
    await s.enqueue(ticket("T-3"));
    await s.submit({ ticket_id: "T-3", pr_id: "pr-3", worktree_path: "/3", base_commit: SHA("c") });
    await s.idle();
    expect(h.reReview).toHaveBeenCalledTimes(1);
    expect(h.reReview.mock.calls[0]![0]).toMatchObject({ pr_id: "pr-3", base_unknown: true });
    expect(s.status("T-3")).toBe("merged");
  });

  it("T46b. sync 手动合并没有 merge_sha：不发 interface_changed，不用 targetHead 兜底，调 onError，状态 merged", async () => {
    const h = harness();
    const s = await started(h);
    await s.enqueue(ticket("T-0"));
    await s.enqueue(ticket("T-1", { depends_on: ["T-0"] }));
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/1" });
    await s.idle();
    h.syncChanges.push({ pr_id: "pr-1", from: "open", to: "merged" });
    await s.sync();
    expect(s.status("T-1")).toBe("merged");
    expect(h.published.filter((e) => e.type === "interface_changed")).toEqual([]);
    expect(escalations(h)).toEqual([]);
    expect(h.errors.some((e) => (e as Error).message.includes("merge_sha"))).toBe(true);
  });

  it("T46c. 写状态抛错：照旧报 merged_but（detail 不变），interface_changed 照发，状态 merged", async () => {
    const h = harness();
    const s = await started(h);
    await s.enqueue(ticket("T-1"));
    const set = h.deps.tickets.setStatus;
    h.deps.tickets.setStatus = (t, st) => {
      if (t === "T-1" && st === "merged") throw new Error("db locked");
      return set(t, st);
    };
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/1" });
    await s.idle();
    expect(escalations(h).map((e) => e.payload)).toEqual([
      {
        reason: "merged_but",
        resubmit_counts: { review: 0, conflict: 0 },
        detail: "merged_but: db locked",
      },
    ]);
    expect(
      h.published.filter((e) => e.type === "interface_changed").map((e) => e.ticket_id),
    ).toEqual(["T-1"]);
    expect(s.status("T-1")).toBe("merged");
  });

  it("T46d. saveMergeResult 抛错：照旧报 merged_but，interface_changed 照发", async () => {
    const h = harness();
    h.deps.saveMergeResult = () => {
      throw new Error("disk full");
    };
    const s = await started(h);
    await s.enqueue(ticket("T-1"));
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/1" });
    await s.idle();
    expect(escalations(h).map((e) => e.payload.detail)).toEqual(["merged_but: disk full"]);
    expect(
      h.published.filter((e) => e.type === "interface_changed").map((e) => e.ticket_id),
    ).toEqual(["T-1"]);
    expect(s.status("T-1")).toBe("merged");
  });

  it("T46e. 发 interface_changed 一直失败：只报一次 merged_but；sync 时补发、去重不重发、affected 按补发时重算排除终态", async () => {
    const h = harness();
    const pub = h.deps.bus.publish;
    let down = true;
    h.deps.bus.publish = (e) => {
      if (e.type === "interface_changed" && down) throw new Error("bus down");
      return pub(e);
    };
    const s = await started(h);
    await s.enqueue(ticket("T-0"));
    await s.enqueue(ticket("T-1", { write_scope: ["src/**"] }));
    await s.enqueue(ticket("T-2", { write_scope: ["src/**"], depends_on: ["T-0"] }));
    await s.enqueue(ticket("T-3", { write_scope: ["src/**"], depends_on: ["T-0"] }));
    await s.submit({ ticket_id: "T-2", pr_id: "pr-2", worktree_path: "/2" });
    await s.submit({ ticket_id: "T-3", pr_id: "pr-3", worktree_path: "/3" });
    h.diffs.set("pr-1", ["src/a.ts"]);
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/1" });
    await s.idle();
    // 再触发几次重试（sync、合并循环），总线仍坏：不再上报
    await s.sync();
    await s.enqueue(ticket("T-4", { write_scope: ["x/**"] }));
    await s.submit({ ticket_id: "T-4", pr_id: "pr-4", worktree_path: "/4" });
    await s.idle();
    expect(escalations(h).map((e) => [e.ticket_id, e.payload.detail])).toEqual([
      ["T-1", "merged_but: interface_changed_unsent: bus down"],
      ["T-4", "merged_but: interface_changed_unsent: bus down"],
    ]);
    expect(s.status("T-1")).toBe("merged");
    // T-3 被用户手动关掉（终态），补发时不再算受影响
    h.syncChanges.push({ pr_id: "pr-3", from: "open", to: "closed" });
    down = false;
    await s.sync();
    const ic = h.published.filter((e) => e.type === "interface_changed");
    expect(ic.map((e) => e.ticket_id)).toEqual(["T-1", "T-4"]);
    expect(ic[0]!.payload).toMatchObject({
      base_commit: SHA("f"),
      affected_ticket_ids: ["T-2"],
    });
    // 补发成功不另发事件，也不再重发
    const before = h.published.length;
    await s.sync();
    await s.idle();
    expect(h.published.length).toBe(before);
    expect(escalations(h)).toHaveLength(2);
  });

  it("T46f. 冲突复投后第一次 submit 打的 high_risk 保留", async () => {
    const h = harness();
    const s = await started(h);
    await s.enqueue(ticket("T-1"));
    h.merges.set("pr-1", [conflict(["a.ts"])]);
    await s.submit({
      ticket_id: "T-1",
      pr_id: "pr-1",
      worktree_path: "/wt/T-1-r0",
      high_risk: true,
    });
    await s.idle();
    expect(h.resubmit).toHaveBeenCalledTimes(1);
    expect(s.status("T-1")).toBe("merged");
    expect(s.snapshot().find((v) => v.ticket_id === "T-1")).toMatchObject({
      pr_id: "pr-100",
      high_risk: true,
    });
  });

  it("T46g. 阻塞项顺序：A 手动合并（M）→ 9 合 B（改 C 用的接口）→ sync 才发现 A → C 以 M 为基线提交：保守重审，不跳过", async () => {
    const h = harness();
    const s = await started(h);
    const I = { file: "src/i.ts", symbol: "I" };
    await s.enqueue(ticket("T-0"));
    await s.enqueue(ticket("T-A", { depends_on: ["T-0"] }));
    await s.enqueue(ticket("T-B", { interfaces: [I] }));
    await s.enqueue(ticket("T-C", { interfaces: [I] }));
    await s.submit({ ticket_id: "T-A", pr_id: "pr-a", worktree_path: "/a" });
    await s.idle();
    // A 已在 GitHub 上被手动合并为 M（9 还不知道），C 从 M 开工；9 接着合入 B（X）
    h.diffs.set("pr-b", ["src/i.ts"]);
    h.merges.set("pr-b", [merged("b")]);
    await s.submit({ ticket_id: "T-B", pr_id: "pr-b", worktree_path: "/b" });
    await s.idle();
    expect(s.status("T-B")).toBe("merged");
    // 这时 sync 才发现 A
    h.syncChanges.push({ pr_id: "pr-a", from: "open", to: "merged", merge_sha: SHA("c") });
    await s.sync();
    expect(s.status("T-A")).toBe("merged");
    h.reReview.mockClear();
    await s.submit({ ticket_id: "T-C", pr_id: "pr-c", worktree_path: "/c", base_commit: SHA("c") });
    await s.idle();
    expect(h.reReview).toHaveBeenCalledTimes(1);
    expect(h.reReview.mock.calls[0]![0]).toMatchObject({ pr_id: "pr-c", base_unknown: true });
    expect(s.status("T-C")).toBe("merged");
  });

  it("T46h. merge_sha 不合法（非 40 位小写十六进制）按缺省处理：不发 interface_changed，调 onError", async () => {
    const h = harness();
    const s = await started(h);
    await s.enqueue(ticket("T-0"));
    await s.enqueue(ticket("T-1", { depends_on: ["T-0"] }));
    await s.enqueue(ticket("T-2", { depends_on: ["T-0"] }));
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/1" });
    await s.submit({ ticket_id: "T-2", pr_id: "pr-2", worktree_path: "/2" });
    await s.idle();
    h.syncChanges.push(
      { pr_id: "pr-1", from: "open", to: "merged", merge_sha: "abc1234" },
      { pr_id: "pr-2", from: "open", to: "merged", merge_sha: SHA("C") },
    );
    expect((await s.sync()).map((c) => c.pr_id)).toEqual(["pr-1", "pr-2"]);
    expect(s.status("T-1")).toBe("merged");
    expect(s.status("T-2")).toBe("merged");
    expect(h.published.filter((e) => e.type === "interface_changed")).toEqual([]);
    expect(h.errors.filter((e) => (e as Error).message.includes("merge_sha"))).toHaveLength(2);
  });

  it("T46i. 手动合并写状态抛错：和 onMerged 一样报 merged_but（detail 不变），interface_changed 照发，状态 merged", async () => {
    const h = harness();
    const s = await started(h);
    await s.enqueue(ticket("T-0"));
    await s.enqueue(ticket("T-1", { depends_on: ["T-0"] }));
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/1" });
    await s.idle();
    const set = h.deps.tickets.setStatus;
    h.deps.tickets.setStatus = (t, st) => {
      if (t === "T-1" && st === "merged") throw new Error("db locked");
      return set(t, st);
    };
    h.syncChanges.push({ pr_id: "pr-1", from: "open", to: "merged", merge_sha: SHA("c") });
    expect((await s.sync()).map((c) => c.pr_id)).toEqual(["pr-1"]);
    expect(escalations(h).map((e) => [e.ticket_id, e.payload])).toEqual([
      [
        "T-1",
        {
          reason: "merged_but",
          resubmit_counts: { review: 0, conflict: 0 },
          detail: "merged_but: db locked",
        },
      ],
    ]);
    expect(
      h.published.filter((e) => e.type === "interface_changed").map((e) => e.ticket_id),
    ).toEqual(["T-1"]);
    expect(s.status("T-1")).toBe("merged");
  });

  it("T46j. 补发不重入：两次 sync 并发时同一条 interface_changed 只发一次", async () => {
    const h = harness();
    const pub = h.deps.bus.publish;
    let down = true;
    const gate = deferred<void>();
    let attempts = 0;
    h.deps.bus.publish = async (e) => {
      if (e.type === "interface_changed") {
        if (down) throw new Error("bus down");
        attempts++;
        await gate.promise;
      }
      return pub(e);
    };
    const s = await started(h);
    await s.enqueue(ticket("T-1"));
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/1" });
    await s.idle();
    expect(escalations(h)).toHaveLength(1);
    down = false;
    const a = s.sync();
    const b = s.sync();
    await vi.waitFor(() => expect(attempts).toBe(1));
    gate.resolve();
    await Promise.all([a, b]);
    await s.idle();
    expect(attempts).toBe(1);
    expect(
      h.published.filter((e) => e.type === "interface_changed").map((e) => e.ticket_id),
    ).toEqual(["T-1"]);
    // 已补发成功，再 sync 不重发
    await s.sync();
    expect(h.published.filter((e) => e.type === "interface_changed")).toHaveLength(1);
  });

  it("T61a. sync() 返回后隔 0～5 个微任务再 submit（不等 idle）：触发不丢，单子照常合并", async () => {
    for (let gap = 0; gap <= 5; gap++) {
      const h = harness();
      const s = await started(h);
      await s.enqueue(ticket("T-0"));
      await s.enqueue(ticket("T-1", { depends_on: ["T-0"] }));
      await s.enqueue(ticket("T-2"));
      await s.enqueue(ticket("T-3"));
      await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/1" });
      await s.idle();
      await s.submit({ ticket_id: "T-3", pr_id: "pr-3", worktree_path: "/3" });
      await s.idle();
      h.syncChanges.push({ pr_id: "pr-1", from: "open", to: "merged", merge_sha: SHA("c") });
      await s.sync();
      for (let k = 0; k < gap; k++) await Promise.resolve();
      // 带 base_commit：submit 不 await diff，落在 sync 触发的那轮循环收尾前后的不同位置
      await s.submit({
        ticket_id: "T-2",
        pr_id: "pr-2",
        worktree_path: "/2",
        base_commit: SHA("a"),
      });
      await s.idle();
      expect(s.status("T-2"), `gap=${gap}`).toBe("merged");
      expect(h.calls, `gap=${gap}`).toContain("merge:pr-2:bakacoding/integration");
    }
  });

  it("T61b. 重审中（busy）的单排回队里时来触发：补跑的一轮跳过它、不从队里拿掉，重审结束后照常合并", async () => {
    const h = harness();
    const s = await started(h);
    const I = { file: "src/a.ts", symbol: "a" };
    await s.enqueue(ticket("A", { interfaces: [I] }));
    await s.enqueue(ticket("B", { interfaces: [I] }));
    await s.enqueue(ticket("C"));
    h.diffs.set("pr-a", ["src/a.ts"]);
    await s.submit({ ticket_id: "A", pr_id: "pr-a", worktree_path: "/a" });
    await s.idle();
    // B 基线在 A 之前且涉及 A 改的接口 → 重审（后台、busy）；C 同时提交，合并循环在跑
    await s.submit({ ticket_id: "B", pr_id: "pr-b", worktree_path: "/b" });
    await s.submit({ ticket_id: "C", pr_id: "pr-c", worktree_path: "/c" });
    await s.idle();
    expect(h.reReview).toHaveBeenCalledTimes(1);
    expect(s.status("B")).toBe("merged");
    expect(s.status("C")).toBe("merged");
    expect(h.calls).toContain("merge:pr-b:bakacoding/integration");
  });

  it("R1b. step 里 targetHead 抛错：该单上报，后面的单照常合", async () => {
    const h = harness();
    const s = await started(h);
    h.deps.targetHead = () => {
      throw new Error("rev-parse failed");
    };
    await s.enqueue(ticket("T-1"));
    await s.enqueue(ticket("T-2"));
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/1", base_commit: SHA("9") });
    await s.submit({ ticket_id: "T-2", pr_id: "pr-2", worktree_path: "/2" });
    await s.idle();
    expect(escalations(h).map((e) => e.payload)).toEqual([
      { reason: "github_manual", detail: "merge_error: rev-parse failed" },
    ]);
    expect(s.status("T-2")).toBe("merged");
  });

  it("R2. 关旧 PR 抛错：先已记下新 PR，再上报 resubmit_error，清掉 9 建的新 worktree", async () => {
    const h = harness();
    const inner = h.deps.createPr;
    h.deps.createPr = async (opts) => {
      const pr = await inner(opts);
      return {
        ...pr,
        close: async () => {
          throw new Error("close 403");
        },
      };
    };
    const s = await started(h);
    await s.enqueue(ticket("T-1"));
    h.merges.set("pr-1", [conflict()]);
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/wt/T-1-r0" });
    await s.idle();
    expect(s.snapshot()[0]).toMatchObject({ pr_id: "pr-100", status: "escalated", round: 1 });
    expect(s.eventContext({ pr_id: "pr-100", ticket_id: null }).span_id).toBe("span-T-1");
    expect(escalations(h).map((e) => e.payload)).toEqual([
      { reason: "github_manual", detail: "resubmit_error: close 403" },
    ]);
    expect(h.calls).toContain("cleanup:/wt/T-1-r1");
    expect(h.calls).not.toContain("cleanup:/wt/T-1-r0");
  });

  it("R3. sync：一条变化处理出错不影响其余", async () => {
    const h = harness();
    const s = await started(h);
    await s.enqueue(ticket("T-0"));
    await s.enqueue(ticket("T-1", { depends_on: ["T-0"] }));
    await s.enqueue(ticket("T-2", { depends_on: ["T-0"] }));
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/1" });
    await s.submit({ ticket_id: "T-2", pr_id: "pr-2", worktree_path: "/2" });
    await s.idle();
    const set = h.deps.tickets.setStatus;
    h.deps.tickets.setStatus = (t, st) => {
      if (t === "T-1") throw new Error("db locked");
      return set(t, st);
    };
    h.syncChanges.push(
      { pr_id: "pr-1", from: "open", to: "closed" },
      { pr_id: "pr-2", from: "open", to: "closed" },
    );
    expect((await s.sync()).map((c) => c.pr_id)).toEqual(["pr-2"]);
    expect(h.errors.map((e) => (e as Error).message)).toEqual(["db locked"]);
    expect(s.status("T-2")).toBe("escalated");
  });

  it("R5a. submit 状态检查：已在队里 / 正在复投的单再交报错", async () => {
    const h = harness();
    let release!: () => void;
    h.resubmit.mockImplementationOnce(
      () =>
        new Promise<SubAgentOutcome>((r) => {
          release = () => r({ pr_id: "pr-100" });
        }),
    );
    const s = await started(h);
    await s.enqueue(ticket("T-0"));
    await s.enqueue(ticket("W", { depends_on: ["T-0"] }));
    await s.submit({ ticket_id: "W", pr_id: "pr-w", worktree_path: "/w" });
    await expect(s.submit({ ticket_id: "W", pr_id: "pr-w2", worktree_path: "/w" })).rejects.toThrow(
      /已在合并队列中/,
    );
    await s.enqueue(ticket("T-1"));
    h.merges.set("pr-1", [conflict()]);
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/1" });
    await vi.waitFor(() => expect(h.resubmit).toHaveBeenCalled());
    await expect(
      s.submit({ ticket_id: "T-1", pr_id: "pr-x", worktree_path: "/x" }),
    ).rejects.toThrow(/正在处理/);
    release();
    await s.idle();
    expect(h.calls.filter((c) => c.startsWith("merge:pr-100"))).toHaveLength(1);
  });

  it("R5b. 等 8 期间单子已被用户手动关闭（escalated）：8 返回后不覆盖终态，不再排队，清掉新 worktree", async () => {
    const h = harness();
    const ref: { s?: Awaited<ReturnType<typeof started>> } = {};
    h.resubmit.mockImplementationOnce(async () => {
      h.syncChanges.push({ pr_id: "pr-1", from: "open", to: "closed" });
      expect((await ref.s!.sync()).map((c) => c.pr_id)).toEqual(["pr-1"]);
      return { pr_id: "pr-100" };
    });
    const s = (ref.s = await started(h));
    await s.enqueue(ticket("T-1"));
    h.merges.set("pr-1", [conflict()]);
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/wt/T-1-r0" });
    await s.idle();
    expect(s.status("T-1")).toBe("escalated");
    expect(h.calls.filter((c) => c.startsWith("merge:pr-100"))).toEqual([]);
    expect(h.calls).toContain("cleanup:/wt/T-1-r1");
    expect(h.statuses.filter(([t]) => t === "T-1").at(-1)).toEqual(["T-1", "escalated"]);
  });

  it("R5c. stop()：停掉合并循环并取消等待中的定时器", async () => {
    const h = harness();
    delete h.deps.clock; // 用真定时器
    h.deps.target_dirty_retry_ms = 60_000;
    const s = await started(h);
    await s.enqueue(ticket("T-1"));
    h.merges.set("pr-1", [
      { merged: false, conflict: false, reason: "target_dirty", worktree_path: "/x" },
    ]);
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/1" });
    await vi.waitFor(() => expect(h.calls).toContain("merge:pr-1:bakacoding/integration"));
    const t0 = Date.now();
    s.stop();
    await s.idle();
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(h.calls.filter((c) => c.startsWith("merge:"))).toHaveLength(1);
    expect(s.status("T-1")).toBe("merge_queued");
  });

  it("R5d. target_dirty 连续重试 10 次后上报 github_manual", async () => {
    const h = harness();
    const s = await started(h);
    await s.enqueue(ticket("T-1"));
    const dirty = {
      merged: false,
      conflict: false,
      reason: "target_dirty",
      worktree_path: "/repo",
    } as const;
    h.merges.set(
      "pr-1",
      Array.from({ length: 11 }, () => dirty),
    );
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/1" });
    await s.idle();
    expect(h.sleeps).toEqual(Array.from({ length: 10 }, () => 5000));
    expect(escalations(h).map((e) => e.payload)).toEqual([
      { reason: "github_manual", detail: "target_dirty: /repo" },
    ]);
  });

  it("B1. 冲突复投途中当日预算用完：放回 pending、不上报、不加计数；预算重置后带凭据续跑，新 PR 开出才关旧 PR", async () => {
    const h = harness();
    const ref: { s?: Awaited<ReturnType<typeof started>> } = {};
    h.resubmit.mockImplementationOnce(async () => ({
      requeue_budget: true,
      resume: { phase: "coding", n: 1 },
    }));
    h.resume.mockImplementationOnce(async (t, token) => {
      h.calls.push(`resume:${t.ticket_id}:${JSON.stringify(token)}`);
      // 8 的 resume 走主流程：评审通过时自己调 9 的 submit
      await ref.s!.submit({ ticket_id: t.ticket_id, pr_id: "pr-200", worktree_path: "/wt/T-1-r1" });
      return { kind: "merge_queued", pr_id: "pr-200" };
    });
    const s = (ref.s = await started(h));
    await s.enqueue(ticket("T-1"));
    h.merges.set("pr-1", [conflict()]);
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/wt/T-1-r0" });
    await s.idle();
    expect(s.status("T-1")).toBe("pending");
    expect(escalations(h)).toEqual([]);
    expect(s.budgetPaused()).toEqual(["T-1"]);
    // finishSubAgent 收到 requeue_budget：不清 pr_id、不标 merge_queued、不入队
    expect(s.snapshot()[0]).toMatchObject({
      pr_id: "pr-1",
      status: "pending",
      budget_paused: true,
      round: 1,
      resubmit_counts: { review: 0, conflict: 1 },
    });
    expect(h.calls.some((c) => c.startsWith("close:"))).toBe(false);

    h.daily.exhausted = true;
    expect(await s.resumeBudgetPaused()).toEqual([]);
    expect(h.resume).not.toHaveBeenCalled();

    h.daily.exhausted = false;
    expect(await s.resumeBudgetPaused()).toEqual(["T-1"]);
    await s.idle();
    expect(h.resume.mock.calls[0]![1]).toEqual({ phase: "coding", n: 1 });
    expect(h.calls).toContain("close:pr-1:冲突复投，由 pr-200 取代");
    expect(h.calls).toContain("cleanup:/wt/T-1-r0");
    expect(s.status("T-1")).toBe("merged");
    expect(s.snapshot()[0]!.resubmit_counts).toEqual({ review: 0, conflict: 1 });
    expect(s.budgetPaused()).toEqual([]);
    expect(escalations(h)).toEqual([]);
    // 入队之后的状态都由 9 写：pending（预算暂停）、merge_queued、merged
    expect(h.statuses.filter(([t]) => t === "T-1").map(([, st]) => st)).toEqual([
      "pending",
      "merge_queued",
      "conflict",
      "resubmitting",
      "pending",
      "merge_queued",
      "merged",
    ]);
  });

  it("B2. 重审途中预算用完：pending 等续跑；续跑又碰上就继续等；8 上报后 9 写 escalated、不重复发事件", async () => {
    const h = harness();
    h.reReview.mockImplementationOnce(async () => ({ requeue_budget: true, resume: "tok-1" }));
    h.resume.mockImplementationOnce(async () => ({ kind: "requeue_budget", resume: "tok-2" }));
    h.resume.mockImplementationOnce(async () => ({ kind: "escalated", pr_id: "pr-1" }));
    const s = await started(h);
    await s.enqueue(ticket("T-1"));
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/1", base_commit: SHA("9") });
    await s.idle();
    expect(h.reReview).toHaveBeenCalledTimes(1);
    expect(s.status("T-1")).toBe("pending");
    expect(await s.resumeBudgetPaused()).toEqual(["T-1"]);
    await s.idle();
    expect(h.resume.mock.calls[0]![1]).toBe("tok-1");
    expect(s.budgetPaused()).toEqual(["T-1"]);
    expect(await s.resumeBudgetPaused()).toEqual(["T-1"]);
    await s.idle();
    expect(h.resume.mock.calls[1]![1]).toBe("tok-2");
    expect(s.status("T-1")).toBe("escalated");
    expect(escalations(h)).toEqual([]);
    expect(s.budgetPaused()).toEqual([]);
  });

  it("B3. 续跑抛错：上报 github_manual（resume_error），状态 escalated", async () => {
    const h = harness();
    h.reReview.mockImplementationOnce(async () => ({ requeue_budget: true, resume: "tok" }));
    h.resume.mockImplementationOnce(async () => {
      throw new Error("worktree gone");
    });
    const s = await started(h);
    await s.enqueue(ticket("T-1"));
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/1", base_commit: SHA("9") });
    await s.idle();
    await s.resumeBudgetPaused();
    await s.idle();
    expect(escalations(h).map((e) => e.payload)).toEqual([
      { reason: "github_manual", detail: "resume_error: worktree gone" },
    ]);
    expect(s.status("T-1")).toBe("escalated");
  });

  it("6. 当日预算用完：暂停派新单，在途的单照常合并；重置后恢复", async () => {
    const h = harness();
    const s = await started(h);
    h.daily.exhausted = true;
    await s.enqueue(ticket("T-1"));
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/1" });
    await s.idle();
    const st = await s.backpressureState();
    expect(st.paused).toBe(true);
    expect(st.concurrency).toBe(0);
    expect(st.reasons).toEqual(["daily_budget"]);
    expect(st.daily_budget_exhausted).toBe(true);
    expect(s.status("T-1")).toBe("merged");
    h.daily.exhausted = false;
    expect(await s.backpressureState()).toMatchObject({
      paused: false,
      concurrency: 8,
      reasons: [],
    });
  });

  it("7a. 按依赖顺序合并：依赖未合入的 PR 不出队，后面不相干的照常合", async () => {
    const h = harness();
    const s = await started(h);
    await s.enqueue(ticket("A"));
    await s.enqueue(ticket("B", { depends_on: ["A"] }));
    await s.enqueue(ticket("C"));
    await s.submit({ ticket_id: "B", pr_id: "pr-b", worktree_path: "/b" });
    await s.submit({ ticket_id: "C", pr_id: "pr-c", worktree_path: "/c" });
    await s.idle();
    expect(s.status("B")).toBe("merge_queued");
    expect(s.dependencyState("B")).toBe("waiting");
    expect(s.status("C")).toBe("merged");
    await s.submit({ ticket_id: "A", pr_id: "pr-a", worktree_path: "/a" });
    await s.idle();
    expect(h.calls.filter((c) => c.startsWith("merge:"))).toEqual([
      "merge:pr-c:bakacoding/integration",
      "merge:pr-a:bakacoding/integration",
      "merge:pr-b:bakacoding/integration",
    ]);
    expect(s.status("B")).toBe("merged");
  });

  it("7b. 依赖被上报：依赖它的单（含间接）一起挂起，不出队", async () => {
    const h = harness();
    const s = await started(h);
    await s.enqueue(ticket("A"));
    await s.enqueue(ticket("B", { depends_on: ["A"] }));
    await s.enqueue(ticket("C", { depends_on: ["B"] }));
    await s.submit({ ticket_id: "B", pr_id: "pr-b", worktree_path: "/b" });
    await s.submit({ ticket_id: "C", pr_id: "pr-c", worktree_path: "/c" });
    h.merges.set("pr-a", [
      { merged: false, conflict: false, reason: "merge_blocked", detail: "d" },
    ]);
    await s.submit({ ticket_id: "A", pr_id: "pr-a", worktree_path: "/a" });
    await s.idle();
    expect(s.status("A")).toBe("escalated");
    expect(s.dependencyState("B")).toBe("held");
    expect(s.dependencyState("C")).toBe("held");
    expect(s.status("B")).toBe("merge_queued");
    expect(h.calls.filter((c) => c.startsWith("merge:"))).toEqual([
      "merge:pr-a:bakacoding/integration",
    ]);
    expect(s.snapshot().find((v) => v.ticket_id === "C")?.dependency).toBe("held");
  });

  it("7c. 依赖成环或依赖未登记：按 waiting 处理，不死循环", async () => {
    const h = harness();
    const s = await started(h);
    await s.enqueue(ticket("X", { depends_on: ["Y"] }));
    await s.enqueue(ticket("Y", { depends_on: ["X"] }));
    await s.enqueue(ticket("Z", { depends_on: ["ghost"] }));
    expect(s.dependencyState("X")).toBe("waiting");
    expect(s.dependencyState("Z")).toBe("waiting");
  });

  it("8. 反压：排队中 + 评审中的 PR 超过 pending_pr_limit 暂停派新单（上限读配置）", async () => {
    const h = harness({ pending_pr_limit: 2 });
    const s = await started(h);
    await s.enqueue(ticket("A"));
    await s.enqueue(ticket("B", { depends_on: ["A"] }));
    await s.enqueue(ticket("C", { depends_on: ["A"] }));
    await s.submit({ ticket_id: "B", pr_id: "pr-b", worktree_path: "/b" });
    await s.submit({ ticket_id: "C", pr_id: "pr-c", worktree_path: "/c" });
    await s.idle();
    expect((await s.backpressureState()).paused).toBe(false);
    h.emit("review_backlog", { pending: 1, capacity: 4 });
    const st = await s.backpressureState();
    expect(st.pending_prs).toEqual({
      merge_queued: 2,
      in_review: 1,
      total: 3,
      limit: 2,
      high_risk_held: 0,
    });
    expect(st.paused).toBe(true);
    expect(st.reasons).toEqual(["pending_pr_limit"]);
  });

  it("8b. 反压：主管待办超过 supervisor_backlog_limit 暂停派新单", async () => {
    const h = harness();
    const s = await started(h);
    h.emit("supervisor_backlog", { pending: 11, capacity: 10 });
    expect(await s.backpressureState()).toMatchObject({
      paused: true,
      reasons: ["supervisor_backlog"],
      supervisor_backlog: { pending: 11, capacity: 10 },
    });
  });

  it("8c. pending_pr_limit 默认值在配置里（16）", () => {
    expect(getConfig(examplePath).backpressure.pending_pr_limit).toBe(16);
  });

  it("9. 冲突复投与评审复投分开计数", async () => {
    const h = harness({ conflict_limit: 1 });
    h.resubmit.mockImplementationOnce(async () => ({ pr_id: "pr-2", review_resubmits: 3 }));
    const s = await started(h);
    await s.enqueue(ticket("T-1"));
    h.merges.set("pr-1", [conflict()]);
    h.merges.set("pr-2", [conflict()]);
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/1", review_resubmits: 2 });
    await s.idle();
    expect(h.resubmit.mock.calls[0]![0].resubmit_counts).toEqual({ review: 2, conflict: 1 });
    expect(escalations(h)[0]!.payload).toMatchObject({
      reason: "conflict_limit",
      resubmit_counts: { review: 3, conflict: 1 },
    });
  });

  it("10. 合并成功后发 interface_changed：新基线、与改动文件相交的接口、受影响的在途单", async () => {
    const h = harness();
    const s = await started(h);
    await s.enqueue(
      ticket("P", {
        interfaces: [
          { file: "src/api.ts", symbol: "createThing" },
          { file: "src/other.ts", symbol: "unused" },
        ],
      }),
    );
    await s.enqueue(ticket("Q", { write_scope: ["src/**"] }));
    await s.enqueue(ticket("R", { interfaces: [{ file: "src/api.ts", symbol: "createThing" }] }));
    await s.enqueue(ticket("S", { write_scope: ["docs/*.md"] }));
    h.diffs.set("pr-p", ["src/api.ts", "README.md"]);
    h.merges.set("pr-p", [merged("d")]);
    await s.submit({ ticket_id: "P", pr_id: "pr-p", worktree_path: "/p" });
    await s.idle();
    const ev = h.published.find((e) => e.type === "interface_changed") as unknown as
      EventOf<"interface_changed"> | undefined;
    expect(ev).toBeDefined();
    expect(ev!.ticket_id).toBe("P");
    expect(ev!.payload).toMatchObject({
      pr_id: "pr-p",
      base_commit: SHA("d"),
      changed_interfaces: [{ file: "src/api.ts", symbol: "createThing" }],
      affected_ticket_ids: ["Q", "R"],
    });
    expect(ev!.payload.summary).toContain("P 已合入 bakacoding/integration");
    expect(s.mergeResult("pr-p")).toEqual({
      conflict: false,
      base_changed: false,
      re_reviewed: false,
      merged: true,
    });
  });

  it("基线前进且涉及本单依赖或接口：重新评审，不计复投；不涉及就直接合", async () => {
    const h = harness();
    const saved: unknown[] = [];
    h.deps.saveMergeResult = (t, r) => void saved.push([t, r]);
    const s = await started(h);
    await s.enqueue(ticket("A", { interfaces: [{ file: "src/a.ts", symbol: "a" }] }));
    await s.enqueue(ticket("B", { interfaces: [{ file: "src/a.ts", symbol: "a" }] }));
    await s.enqueue(ticket("C", { interfaces: [{ file: "src/c.ts", symbol: "c" }] }));
    await s.enqueue(ticket("D", { interfaces: [{ file: "src/a.ts", symbol: "a" }] }));
    h.diffs.set("pr-a", ["src/a.ts"]);
    h.merges.set("pr-a", [merged("1")]);
    await s.submit({ ticket_id: "A", pr_id: "pr-a", worktree_path: "/a" });
    await s.idle();
    // B、C 不带 base_commit：基线按 enqueue 时（A 合入前）算，基线已前进
    await s.submit({ ticket_id: "B", pr_id: "pr-b", worktree_path: "/b" });
    await s.submit({ ticket_id: "C", pr_id: "pr-c", worktree_path: "/c" });
    await s.idle();
    // D 的基线是 A 的合并提交：之后只合了 B、C（没改 D 的接口文件），基线前进但不重审
    await s.submit({ ticket_id: "D", pr_id: "pr-d", worktree_path: "/d", base_commit: SHA("1") });
    await s.idle();
    expect(s.mergeResult("pr-d")).toMatchObject({ merged: true, base_changed: true });
    expect(h.reReview).toHaveBeenCalledTimes(1);
    expect(h.reReview.mock.calls[0]![0]).toMatchObject({
      pr_id: "pr-b",
      merged_since: [{ ticket_id: "A", files: ["src/a.ts"] }],
    });
    expect(s.status("B")).toBe("merged");
    expect(s.status("C")).toBe("merged");
    expect(s.mergeResult("pr-b")).toMatchObject({ base_changed: true, re_reviewed: true });
    expect(s.mergeResult("pr-c")).toMatchObject({ base_changed: true, re_reviewed: false });
    expect(s.snapshot().find((v) => v.ticket_id === "B")?.resubmit_counts).toEqual({
      review: 0,
      conflict: 0,
    });
    const bStatuses = h.statuses.filter(([t]) => t === "B").map(([, st]) => st);
    expect(bStatuses).toEqual([
      "pending",
      "merge_queued",
      "re_reviewing",
      "merge_queued",
      "merged",
    ]);
    expect(saved).toContainEqual([
      "B",
      { conflicted: false, base_changed: true, re_reviewed: true, merged: true },
    ]);
  });

  it("6 已上报的错误（鉴权失败、分支分叉）只改状态不重复上报；其他错误上报 github_manual", async () => {
    const h = harness();
    const s = await started(h);
    const auth = Object.assign(new Error("auth"), { name: "GithubAuthError" });
    const weird = new Error("boom");
    await s.enqueue(ticket("T-1"));
    await s.enqueue(ticket("T-2"));
    h.merges.set("pr-1", [auth]);
    h.merges.set("pr-2", [weird]);
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/1" });
    await s.submit({ ticket_id: "T-2", pr_id: "pr-2", worktree_path: "/2" });
    await s.idle();
    expect(s.status("T-1")).toBe("escalated");
    expect(s.status("T-2")).toBe("escalated");
    expect(escalations(h).map((e) => [e.ticket_id, e.payload])).toEqual([
      ["T-2", { reason: "github_manual", detail: "merge_error: boom" }],
    ]);
  });

  it("队列：先来先合；重复登记、未登记、终态再提交都报错；未 start 合并报错", async () => {
    const h = harness();
    const s = createScheduler(h.deps);
    await s.enqueue(ticket("T-1"));
    await expect(s.enqueue(ticket("T-1"))).rejects.toThrow(/重复/);
    await expect(s.submit({ ticket_id: "nope", pr_id: "p", worktree_path: "/" })).rejects.toThrow(
      /未登记/,
    );
    await expect(s.sync()).rejects.toThrow(/start/);
    await s.start();
    await s.enqueue(ticket("T-2"));
    await s.enqueue(ticket("T-3"));
    await s.submit({ ticket_id: "T-2", pr_id: "pr-2", worktree_path: "/2" });
    await s.submit({ ticket_id: "T-3", pr_id: "pr-3", worktree_path: "/3" });
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/1" });
    await s.idle();
    expect(h.calls.filter((c) => c.startsWith("merge:")).map((c) => c.split(":")[1])).toEqual([
      "pr-2",
      "pr-3",
      "pr-1",
    ]);
    await expect(
      s.submit({ ticket_id: "T-1", pr_id: "pr-1b", worktree_path: "/1" }),
    ).rejects.toThrow(/终态/);
    s.stop();
  });
});

describe("BackpressureController", () => {
  const cfg = getConfig(examplePath);
  const MIN = 60_000;
  const make = () =>
    new BackpressureController({ pipeline: cfg.pipeline, backpressure: cfg.backpressure });
  const input = (pending: number, capacity = 4) => ({
    review: { pending, capacity },
    supervisor: null,
    merge_queued: 0,
    daily_exhausted: false,
  });

  it("评审积压 > 容量×2 减半，> 容量×4 暂停；回落到容量以下后每 5 分钟加 1", () => {
    const c = make();
    expect(c.decide(input(8), 0)).toEqual({ paused: false, concurrency: 8, reasons: [] });
    expect(c.decide(input(9), 0)).toEqual({
      paused: false,
      concurrency: 4,
      reasons: ["review_backlog_halve"],
    });
    expect(c.decide(input(10, 2), 0)).toEqual({
      paused: true,
      concurrency: 0,
      reasons: ["review_backlog_pause"],
    });
    // 积压在容量以上（未回落）：不恢复
    expect(c.decide(input(5), 10 * MIN).concurrency).toBe(0);
    // 回落到容量以下：开始计时
    expect(c.decide(input(3), 10 * MIN)).toMatchObject({
      paused: true,
      concurrency: 0,
      reasons: ["review_backlog_recovering"],
    });
    expect(c.decide(input(3), 15 * MIN)).toMatchObject({ paused: false, concurrency: 1 });
    expect(c.decide(input(3), 25 * MIN).concurrency).toBe(3);
    expect(c.decide(input(0), 60 * MIN)).toEqual({ paused: false, concurrency: 8, reasons: [] });
  });

  it("每日预算、主管待办、待合并 PR 都只暂停，不改恢复中的并发", () => {
    const c = make();
    expect(
      c.decide(
        {
          review: { pending: 0, capacity: 4 },
          supervisor: { pending: 11, capacity: 10 },
          merge_queued: 17,
          daily_exhausted: true,
        },
        0,
      ),
    ).toEqual({
      paused: true,
      concurrency: 0,
      reasons: ["supervisor_backlog", "pending_pr_limit", "daily_budget"],
    });
    expect(c.decide(input(0), 0)).toEqual({ paused: false, concurrency: 8, reasons: [] });
  });
});

// ---------------- T-039：派单、写入范围锁、编码槽位、终态保护 ----------------

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 注入 8 的 handle：每张单一个可控的 deferred，模拟 8 编码 / 评审中。 */
function withHandle(h: Harness, opts: { max?: number; hard?: number } = {}) {
  const pending = new Map<string, ReturnType<typeof deferred<DispatchOutcome>>>();
  const handled: string[] = [];
  const handle = vi.fn((t: SchedulerTicket) => {
    handled.push(t.ticket_id);
    const d = deferred<DispatchOutcome>();
    pending.set(t.ticket_id, d);
    return d.promise;
  });
  h.deps.subAgent.handle = handle;
  h.deps.dispatch_poll_ms = 0;
  if (opts.max !== undefined) h.deps.config.pipeline.concurrency_max = opts.max;
  if (opts.hard !== undefined) h.deps.config.pipeline.concurrency_hard_max = opts.hard;
  return { pending, handled, handle };
}

/** 等自动派单、合并循环、后台收尾都跑完（handle 还挂着时 idle() 会一直等，所以不用它）。 */
async function settle(s: Scheduler): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await s.dispatch();
  }
}

/** 模拟 8 评审通过：先调 9 的 submit，再让 handle 返回 merge_queued。 */
async function pass(
  s: Scheduler,
  d: ReturnType<typeof withHandle>,
  id: string,
  pr_id = `pr-${id}`,
): Promise<void> {
  await s.submit({ ticket_id: id, pr_id, worktree_path: `/wt/${id}-r0`, round: 0 });
  d.pending.get(id)!.resolve({ kind: "merge_queued", pr_id });
  await settle(s);
}

describe("T-039 派单与编码槽位", () => {
  it("D1. 入队即派给 8 的 handle；槽位按 concurrency_max 限，submit 后让出槽位，下一张接着派；9 不写进队前的状态", async () => {
    const h = harness();
    const d = withHandle(h, { max: 2 });
    const s = await started(h);
    for (const id of ["T-1", "T-2", "T-3"])
      await s.enqueue(ticket(id, { write_scope: [`src/${id}/**`] }));
    await settle(s);
    expect(d.handled).toEqual(["T-1", "T-2"]);
    expect(
      s
        .snapshot()
        .filter((v) => v.coding)
        .map((v) => v.ticket_id),
    ).toEqual(["T-1", "T-2"]);

    await pass(s, d, "T-1");
    expect(d.handled).toEqual(["T-1", "T-2", "T-3"]);
    expect(s.status("T-1")).toBe("merged");
    // 9 只写 pending（登记）和交队之后的状态；coding / in_review 由 8 写
    expect(h.statuses.filter(([, st]) => st === "coding" || st === "in_review")).toEqual([]);
    // 同一张单只派一次
    await settle(s);
    expect(d.handle).toHaveBeenCalledTimes(3);
  });

  it("D2. concurrency_hard_max 封顶", async () => {
    const h = harness();
    const d = withHandle(h, { max: 4, hard: 1 });
    const s = await started(h);
    await s.enqueue(ticket("T-1", { write_scope: ["a/**"] }));
    await s.enqueue(ticket("T-2", { write_scope: ["b/**"] }));
    await settle(s);
    expect(d.handled).toEqual(["T-1"]);
  });

  it("D3. 写入范围锁：重叠的单不同时派，前一张合入释放锁后再派；不重叠的照常并行；没写范围按整个仓库", async () => {
    const h = harness();
    const d = withHandle(h);
    const s = await started(h);
    await s.enqueue(ticket("T-1", { write_scope: ["src/a/**"] }));
    await s.enqueue(ticket("T-2", { write_scope: ["src/a/x.ts"] })); // 与 T-1 重叠
    await s.enqueue(ticket("T-3", { write_scope: ["src/b/**"] }));
    await s.enqueue(ticket("T-4")); // 没写范围：与所有单互斥
    await settle(s);
    expect(d.handled).toEqual(["T-1", "T-3"]);
    expect(s.snapshot().find((v) => v.ticket_id === "T-1")!.locked_scope).toEqual(["src/a/**"]);

    await pass(s, d, "T-1");
    expect(d.handled).toEqual(["T-1", "T-3", "T-2"]);
    expect(s.snapshot().find((v) => v.ticket_id === "T-1")!.locked_scope).toBeNull();

    await pass(s, d, "T-3");
    await pass(s, d, "T-2");
    expect(d.handled).toEqual(["T-1", "T-3", "T-2", "T-4"]);
  });

  it("D4. 独占区域单独排队：两张碰独占区域的单即使文件不同也不同时持锁，普通单不受影响", async () => {
    const h = harness();
    const d = withHandle(h);
    const s = await started(h);
    await s.enqueue(ticket("T-1", { write_scope: ["pnpm-lock.yaml"] }));
    await s.enqueue(ticket("T-2", { write_scope: ["packages/x/package.json"] }));
    await s.enqueue(ticket("T-3", { write_scope: ["src/a.ts"] }));
    await settle(s);
    expect(d.handled).toEqual(["T-1", "T-3"]);
    // 8 上报（进队前）：9 只改内存状态、释放锁，不写 TicketStatus
    d.pending.get("T-1")!.resolve({ kind: "escalated", pr_id: null });
    await settle(s);
    expect(s.status("T-1")).toBe("escalated");
    expect(h.statuses.filter(([id]) => id === "T-1")).toEqual([["T-1", "pending"]]);
    expect(d.handled).toEqual(["T-1", "T-3", "T-2"]);
  });

  it("D5. lock()：不重叠 ok 并入本单锁；与在途单重叠 fail 且不改锁；终态 fail；未登记报错", async () => {
    const h = harness();
    const s = await started(h);
    await s.enqueue(ticket("T-1"));
    await s.enqueue(ticket("T-2"));
    expect(s.lock("T-1", ["src/a/**"])).toBe("ok");
    expect(s.lock("T-1", ["src/c.ts"])).toBe("ok");
    expect(s.lock("T-2", ["src/a/b.ts"])).toBe("fail");
    expect(s.lock("T-2", ["src/b/**"])).toBe("ok");
    expect(s.snapshot().map((v) => v.locked_scope)).toEqual([
      ["src/a/**", "src/c.ts"],
      ["src/b/**"],
    ]);
    h.merges.set("pr-1", [
      { merged: false, conflict: false, reason: "merge_blocked", detail: "x" },
    ]);
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/1" });
    await s.idle();
    expect(s.status("T-1")).toBe("escalated");
    expect(s.lock("T-1", ["z/**"])).toBe("fail");
    // T-1 终态后锁释放：T-2 可以拿 src/a
    expect(s.lock("T-2", ["src/a/b.ts"])).toBe("ok");
    expect(() => s.lock("T-x", ["a"])).toThrow(/未登记/);
  });

  it("D6. extendScope（T-038）：能加锁并扩大写入范围；重叠返回失败并上报 scope_lock_failed（不改状态）；未登记的单失败；9 不再订阅 write_scope_requested、不发 granted/denied", async () => {
    const h = harness();
    const d = withHandle(h);
    const s = await started(h);
    await s.enqueue(ticket("T-1", { write_scope: ["src/a/**"] }));
    await s.enqueue(ticket("T-2", { write_scope: ["src/b/**"] }));
    await settle(s);
    expect(h.fire("write_scope_requested", {})).toBeUndefined(); // 没有订阅
    expect(await s.extendScope("T-1", ["src/c.ts"])).toEqual({ ok: true });
    expect(await s.extendScope("T-2", ["src/a/x.ts"])).toEqual({
      ok: false,
      reason: "申请的范围与在途单 T-1 的写入范围重叠",
    });
    expect(await s.extendScope("T-9", ["x"])).toEqual({
      ok: false,
      reason: "调度器没有登记这张单：T-9",
    });
    const replies = h.published
      .filter((e) => e.type.startsWith("write_scope_") || e.type === "escalated")
      .map((e) => [e.type, e.ticket_id, e.payload]);
    expect(replies).toEqual([
      [
        "escalated",
        "T-2",
        {
          reason: "scope_lock_failed",
          resubmit_counts: { review: 0, conflict: 0 },
          detail: "申请的范围与在途单 T-1 的写入范围重叠：src/a/x.ts",
        },
      ],
    ]);
    expect(s.snapshot().find((v) => v.ticket_id === "T-1")!.locked_scope).toEqual([
      "src/a/**",
      "src/c.ts",
    ]);
    expect(s.status("T-2")).toBe("pending"); // 进队前状态归 8，9 不改
    expect(d.handled).toEqual(["T-1", "T-2"]);
  });

  it("D6b. extendScope：不安全范围按与所有范围重叠处理，有在途单时失败；已终态的单失败", async () => {
    const h = harness();
    const d = withHandle(h);
    const s = await started(h);
    await s.enqueue(ticket("T-1", { write_scope: ["src/a/**"] }));
    await s.enqueue(ticket("T-2", { write_scope: ["lib/**"] }));
    await settle(s);
    const r = await s.extendScope("T-2", ["lib/../src/a/x.ts"]);
    expect(r.ok).toBe(false);
    expect(s.snapshot().find((v) => v.ticket_id === "T-2")!.locked_scope).toEqual(["lib/**"]);
    await pass(s, d, "T-1");
    expect(s.status("T-1")).toBe("merged");
    expect(await s.extendScope("T-1", ["src/z.ts"])).toEqual({
      ok: false,
      reason: "单子已是终态 merged",
    });
  });

  it("D6c. high_risk：submit 带的标记出现在 snapshot()，只打标、照常合并", async () => {
    const h = harness();
    const s = await started(h);
    await s.enqueue(ticket("T-1"));
    await s.enqueue(ticket("T-2"));
    expect(s.snapshot().every((v) => v.high_risk === false)).toBe(true);
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/1", high_risk: true });
    expect(s.snapshot().find((v) => v.ticket_id === "T-1")!.high_risk).toBe(true);
    await s.submit({ ticket_id: "T-2", pr_id: "pr-2", worktree_path: "/2" });
    await s.idle();
    expect(s.status("T-1")).toBe("merged");
    expect(s.status("T-2")).toBe("merged");
    expect(s.snapshot().find((v) => v.ticket_id === "T-2")!.high_risk).toBe(false);
    // 默认独占区域以 8 判定依赖类单用的同一份清单开头
    expect(DEFAULT_EXCLUSIVE_ZONES.slice(0, DEPENDENCY_MANIFEST_GLOBS.length)).toEqual([
      ...DEPENDENCY_MANIFEST_GLOBS,
    ]);
  });

  it("D7. 依赖没合入不派，合入后派", async () => {
    const h = harness();
    const d = withHandle(h);
    const s = await started(h);
    await s.enqueue(ticket("T-1", { write_scope: ["a/**"] }));
    await s.enqueue(ticket("T-2", { write_scope: ["b/**"], depends_on: ["T-1"] }));
    await settle(s);
    expect(d.handled).toEqual(["T-1"]);
    await pass(s, d, "T-1");
    expect(d.handled).toEqual(["T-1", "T-2"]);
  });

  it("D8. 反压闸门：评审积压暂停、待合并 PR 超限都不派；回落后按恢复节奏派", async () => {
    const h = harness({ pending_pr_limit: 1 });
    const d = withHandle(h);
    const s = await started(h);
    h.emit("review_backlog", { pending: 100, capacity: 2 });
    await s.enqueue(ticket("T-1", { write_scope: ["a/**"] }));
    await settle(s);
    expect(d.handled).toEqual([]);
    h.emit("review_backlog", { pending: 2, capacity: 2 }); // 2 > pending_pr_limit 1：仍暂停
    await settle(s);
    expect(d.handled).toEqual([]);
    h.emit("review_backlog", { pending: 0, capacity: 2 });
    await settle(s);
    // 积压回落后按 recover_interval_min 逐步恢复槽位（并发从 0 回到 1 要等一个间隔）
    expect(d.handled).toEqual([]);
    await h.deps.clock!.sleep(h.deps.config.backpressure.recover_interval_min * 60_000);
    await settle(s);
    expect(d.handled).toEqual(["T-1"]);
  });

  it("D9. 当日预算：用完停派；8 返回 requeue_budget 的单不当新单再派；预算重置后先交回 8 的 resume 续跑，再派新单", async () => {
    const h = harness();
    const d = withHandle(h);
    h.resume.mockImplementation(async (t, token) => {
      h.calls.push(`resume:${t.ticket_id}:${JSON.stringify(token)}`);
      return { kind: "requeue_budget", resume: token };
    });
    const s = await started(h);
    await s.enqueue(ticket("T-1", { write_scope: ["a/**"] }));
    await settle(s);
    expect(d.handled).toEqual(["T-1"]);
    h.daily.exhausted = true;
    d.pending.get("T-1")!.resolve({ kind: "requeue_budget", resume: { tok: 1 } });
    await s.enqueue(ticket("T-2", { write_scope: ["b/**"] }));
    await settle(s);
    expect(d.handled).toEqual(["T-1"]);
    expect(s.budgetPaused()).toEqual(["T-1"]);
    expect(h.resume).not.toHaveBeenCalled();

    h.daily.exhausted = false;
    expect(await s.dispatch()).toEqual(["T-2"]);
    expect(h.calls.filter((c) => c.startsWith("resume:"))).toEqual(['resume:T-1:{"tok":1}']);
    expect(d.handled).toEqual(["T-1", "T-2"]); // T-1 没被当新单重派
    await settle(s);
    expect(s.budgetPaused()).toEqual(["T-1"]); // 续跑又碰上预算用完：继续等
    // 自动派单不会马上又续跑（budgetState 还没反映出来时不空转），等一个轮询间隔后再试
    expect(h.resume).toHaveBeenCalledTimes(1);
    await h.deps.clock!.sleep(60_000);
    await settle(s);
    expect(h.resume).toHaveBeenCalledTimes(2);
  });

  it("D10. priority=deferred：闲时开关打开且不是闲时不派，normal 照常；进入闲时后派", async () => {
    const h = harness();
    const d = withHandle(h);
    const budget = { daily_exhausted: false, offpeak_preference: true, offpeak_now: false };
    h.deps.budgetState = () => budget;
    const s = await started(h);
    await s.enqueue(ticket("T-1", { write_scope: ["a/**"], priority: "deferred" }));
    await s.enqueue(ticket("T-2", { write_scope: ["b/**"] }));
    await settle(s);
    expect(d.handled).toEqual(["T-2"]);
    budget.offpeak_now = true;
    await settle(s);
    expect(d.handled).toEqual(["T-2", "T-1"]);
  });

  it("D11. 闲时开关关着时 deferred 照常派", async () => {
    const h = harness();
    const d = withHandle(h);
    h.deps.budgetState = () => ({
      daily_exhausted: false,
      offpeak_preference: false,
      offpeak_now: false,
    });
    const s = await started(h);
    await s.enqueue(ticket("T-1", { priority: "deferred" }));
    await settle(s);
    expect(d.handled).toEqual(["T-1"]);
  });

  it("D12. handle 抛错（8 没接住）：9 上报 internal_error（dispatch_error），状态 escalated，释放锁", async () => {
    const h = harness();
    const d = withHandle(h);
    const s = await started(h);
    await s.enqueue(ticket("T-1", { write_scope: ["a/**"] }));
    await s.enqueue(ticket("T-2", { write_scope: ["a/b.ts"] }));
    await settle(s);
    d.pending.get("T-1")!.reject(new Error("找不到需求单"));
    await settle(s);
    expect(escalations(h).map((e) => [e.ticket_id, e.payload])).toEqual([
      [
        "T-1",
        {
          reason: "internal_error",
          resubmit_counts: { review: 0, conflict: 0 },
          detail: "dispatch_error: 找不到需求单",
        },
      ],
    ]);
    expect(s.status("T-1")).toBe("escalated");
    expect(d.handled).toEqual(["T-1", "T-2"]);
  });

  it("D13. 不注入 handle：不自动派单（T-035 行为）；dispatch() 只续跑预算暂停的单", async () => {
    const h = harness();
    const s = await started(h);
    await s.enqueue(ticket("T-1"));
    expect(await s.dispatch()).toEqual([]);
    expect(s.snapshot()[0]).toMatchObject({ coding: false, locked_scope: null });
  });
});

describe("T-039 冲突复投传 sha 基线", () => {
  it("S1. 冲突复投先读目标分支 HEAD，从这个 sha 建 r<n+1>，同一个 sha 交给 8；新 PR 的基线认得出，不多余重审", async () => {
    const h = harness();
    const s = await started(h);
    await s.enqueue(ticket("T-1"));
    await s.enqueue(ticket("T-2", { interfaces: [{ file: "x.ts", symbol: "x" }] }));
    h.merges.set("pr-1", [merged("c")]);
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/1", base_commit: SHA("a") });
    await s.idle();
    h.merges.set("pr-2", [conflict(["y.ts"])]);
    h.merges.set("pr-100", [merged("d")]);
    await s.submit({ ticket_id: "T-2", pr_id: "pr-2", worktree_path: "/2", base_commit: SHA("c") });
    await s.idle();
    expect(h.calls).toContain(`create:T-2:${SHA("c")}:r1`);
    expect(h.resubmit.mock.calls[0]![0].base_commit).toBe(SHA("c"));
    expect(h.reReview).not.toHaveBeenCalled();
    expect(s.status("T-2")).toBe("merged");
    expect(s.mergeResult("pr-100")).toMatchObject({ merged: true, base_changed: false });
  });
});

describe("T-039 终态保护", () => {
  it("G1. 重审进行中 sync 已标 merged，重审再抛错：状态保持 merged，不发 escalated，只调 onError", async () => {
    const h = harness();
    const gate = deferred<SubAgentOutcome>();
    h.reReview.mockImplementationOnce(() => gate.promise);
    const s = await started(h);
    await s.enqueue(ticket("T-1"));
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/1", base_commit: SHA("9") });
    await vi.waitFor(() => expect(h.reReview).toHaveBeenCalledTimes(1));
    h.syncChanges.push({ pr_id: "pr-1", from: "open", to: "merged", merge_sha: SHA("d") });
    await s.sync();
    expect(s.status("T-1")).toBe("merged");
    gate.reject(new Error("review pool down"));
    await s.idle();
    expect(s.status("T-1")).toBe("merged");
    expect(escalations(h)).toEqual([]);
    expect(h.statuses.filter(([, st]) => st === "escalated")).toEqual([]);
    expect(h.errors.map((e) => (e as Error).message)).toEqual(["review pool down"]);
  });

  it("G2. 冲突复投进行中 sync 已标 merged，8 再抛错：不改成 escalated", async () => {
    const h = harness();
    const gate = deferred<SubAgentOutcome>();
    h.resubmit.mockImplementationOnce(() => gate.promise);
    const s = await started(h);
    await s.enqueue(ticket("T-1"));
    h.merges.set("pr-1", [conflict()]);
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/1", base_commit: SHA("a") });
    await vi.waitFor(() => expect(h.resubmit).toHaveBeenCalledTimes(1));
    h.syncChanges.push({ pr_id: "pr-1", from: "conflict", to: "merged", merge_sha: SHA("d") });
    await s.sync();
    gate.reject(new Error("coder crashed"));
    await s.idle();
    expect(s.status("T-1")).toBe("merged");
    expect(escalations(h)).toEqual([]);
    expect(h.errors.map((e) => (e as Error).message)).toEqual(["coder crashed"]);
  });

  it("G3. 派单的 handle 返回前单子已被 sync 标 merged，handle 再抛错：不覆盖", async () => {
    const h = harness();
    const d = withHandle(h);
    const s = await started(h);
    await s.enqueue(ticket("T-1"));
    await settle(s);
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/wt/T-1-r0" });
    // 合并循环先合掉
    await settle(s);
    expect(s.status("T-1")).toBe("merged");
    d.pending.get("T-1")!.reject(new Error("late failure"));
    await settle(s);
    expect(s.status("T-1")).toBe("merged");
    expect(escalations(h)).toEqual([]);
  });
});

describe("T-039 写入范围 glob", () => {
  it("globsOverlap：按段比较，** 匹配零段或多段，字面量不同不重叠", () => {
    const yes: Array<[string, string]> = [
      ["src/a/**", "src/a/x.ts"],
      ["src/**", "src/a/b/c.ts"],
      ["**", "anything/at/all"],
      ["**/package.json", "packages/x/package.json"],
      ["src/*.ts", "src/a.ts"],
      ["src/*.ts", "src/*.js"], // 同段两边都带通配：保守算重叠
      ["./src/a.ts", "src/a.ts"],
      ["src/a/**", "src/a"],
    ];
    const no: Array<[string, string]> = [
      ["src/a/**", "src/b/**"],
      ["src/a.ts", "src/b.ts"],
      ["src/*.ts", "src/a.js"],
      ["src/a/x.ts", "src/a"],
      ["**/package.json", "src/a.ts"],
      ["lib/**", "src/**"],
    ];
    for (const [a, b] of yes) {
      expect(globsOverlap(a, b), `${a} vs ${b}`).toBe(true);
      expect(globsOverlap(b, a), `${b} vs ${a}`).toBe(true);
    }
    for (const [a, b] of no) {
      expect(globsOverlap(a, b), `${a} vs ${b}`).toBe(false);
      expect(globsOverlap(b, a), `${b} vs ${a}`).toBe(false);
    }
  });

  it("独占区域按代表路径判断：config/** 和 package.json 算，src/** 不算", () => {
    expect(sampleOf("config/**")).toBe("config/x");
    expect(sampleOf("src/*.ts")).toBe("src/x.ts");
    expect(matchesAny(sampleOf("config/**"), DEFAULT_EXCLUSIVE_ZONES)).toBe(true);
    expect(matchesAny(sampleOf("packages/a/package.json"), DEFAULT_EXCLUSIVE_ZONES)).toBe(true);
    expect(matchesAny(sampleOf("db/migrations/001.sql"), DEFAULT_EXCLUSIVE_ZONES)).toBe(true);
    expect(matchesAny(sampleOf("src/**"), DEFAULT_EXCLUSIVE_ZONES)).toBe(false);
    expect(matchesAny(sampleOf("src/a.ts"), DEFAULT_EXCLUSIVE_ZONES)).toBe(false);
  });
});

describe("T-048 写入范围 glob：花括号与独占区域", () => {
  it("expandBraces：逗号、嵌套、序列；{a}、{} 和没配对的 { 按字面量；超上限保守按 **", () => {
    expect(expandBraces("src/{a,b}.ts")).toEqual(["src/a.ts", "src/b.ts"]);
    expect(expandBraces("{src,lib}/{x,{y,z}}.ts")).toEqual([
      "src/x.ts",
      "src/y.ts",
      "src/z.ts",
      "lib/x.ts",
      "lib/y.ts",
      "lib/z.ts",
    ]);
    expect(expandBraces("m/{1..3}.sql")).toEqual(["m/1.sql", "m/2.sql", "m/3.sql"]);
    expect(expandBraces("m/{08..10}.sql")).toEqual(["m/08.sql", "m/09.sql", "m/10.sql"]);
    expect(expandBraces("{a..c}")).toEqual(["a", "b", "c"]);
    expect(expandBraces("src/{a}.ts")).toEqual(["src/{a}.ts"]);
    expect(expandBraces("src/{}.ts")).toEqual(["src/{}.ts"]);
    expect(expandBraces("src/{a,b.ts")).toEqual(["src/{a,b.ts"]);
    expect(expandBraces("src/{a}/{b,c}")).toEqual(["src/{a}/b", "src/{a}/c"]);
    expect(expandBraces("{a,a}/x")).toEqual(["a/x"]);
    const huge = Array.from({ length: 5 }, () => "{a,b,c,d}").join("/");
    expect(4 ** 5).toBeGreaterThan(MAX_BRACE_EXPANSIONS);
    expect(expandBraces(huge)).toEqual(["**"]);
  });

  it("globsOverlap 先展开花括号：src/{a,b}.ts 与 src/a.ts 重叠，与 src/c.ts 不重叠", () => {
    const yes: Array<[string, string]> = [
      ["src/{a,b}.ts", "src/a.ts"],
      ["src/{a,b}.ts", "src/*.ts"],
      ["{src,lib}/**", "lib/x/y.ts"],
      ["src/{a,b}/**", "src/b/c.ts"],
      ["src/{a,b}.ts", "src/{b,c}.ts"],
    ];
    const no: Array<[string, string]> = [
      ["src/{a,b}.ts", "src/c.ts"],
      ["{src,lib}/**", "test/**"],
      ["src/{a,b}.ts", "src/{c,d}.ts"],
    ];
    for (const [a, b] of yes) {
      expect(globsOverlap(a, b), `${a} vs ${b}`).toBe(true);
      expect(globsOverlap(b, a), `${b} vs ${a}`).toBe(true);
    }
    for (const [a, b] of no) {
      expect(globsOverlap(a, b), `${a} vs ${b}`).toBe(false);
      expect(globsOverlap(b, a), `${b} vs ${a}`).toBe(false);
    }
    expect(globToRegExp("src/{a,b}.ts").test("src/b.ts")).toBe(true);
    expect(globToRegExp("src/{a,b}.ts").test("src/c.ts")).toBe(false);
    expect(matchesAny("db/v2.sql", ["db/{v1,v2}.sql"])).toBe(true);
  });

  it("独占区域：花括号逐个取代表路径；末段模式能写到区域里的具体文件名也算；目录范围和 *.ts 仍不算", () => {
    const Z = DEFAULT_EXCLUSIVE_ZONES;
    expect(samplesOf("{src,config}/**")).toEqual(["src/x", "config/x"]);
    expect(sampleOf("{src,config}/**")).toBe("src/x");
    // 花括号
    expect(inExclusiveZone("{src,config}/**", Z)).toBe(true);
    expect(inExclusiveZone("src/{a,package}.json", Z)).toBe(true);
    expect(inExclusiveZone("src/{a,b}.ts", Z)).toBe(false);
    // 原缺口：只取一条代表路径时 src/**/*.json → src/x/x.json，漏掉 **/package.json
    expect(matchesAny(sampleOf("src/**/*.json"), Z)).toBe(false);
    expect(inExclusiveZone("src/**/*.json", Z)).toBe(true);
    expect(inExclusiveZone("packages/*/package.json", Z)).toBe(true);
    expect(inExclusiveZone("services/**/go.*", Z)).toBe(true);
    expect(inExclusiveZone("*.json", Z)).toBe(true);
    // 不该变独占的
    for (const g of ["src/**", "src/*", "src/*.ts", "src/a.ts", "docs/**/*.md", "src/**/*.test.ts"])
      expect(inExclusiveZone(g, Z), g).toBe(false);
    // 原有规则不变
    expect(inExclusiveZone("config/**", Z)).toBe(true);
    expect(inExclusiveZone("db/migrations/001.sql", Z)).toBe(true);
    // 末段是字面量但目录不重叠：不算
    expect(inExclusiveZone("src/*.json", ["lib/package.json"])).toBe(false);
  });

  it("D14. 调度：src/{a,b}.ts 与 src/a.ts 不同时派；src/**/*.json 与 pnpm-lock.yaml 走独占队列", async () => {
    const h = harness();
    const d = withHandle(h);
    const s = await started(h);
    await s.enqueue(ticket("T-1", { write_scope: ["src/{a,b}.ts"] }));
    await s.enqueue(ticket("T-2", { write_scope: ["src/a.ts"] }));
    await s.enqueue(ticket("T-3", { write_scope: ["pnpm-lock.yaml"] }));
    await s.enqueue(ticket("T-4", { write_scope: ["pkgs/**/*.json"] }));
    await settle(s);
    expect(d.handled).toEqual(["T-1", "T-3"]);
    d.pending.get("T-1")!.resolve({ kind: "escalated", pr_id: null });
    d.pending.get("T-3")!.resolve({ kind: "escalated", pr_id: null });
    await settle(s);
    expect(d.handled).toEqual(["T-1", "T-3", "T-2", "T-4"]);
  });
});

describe("#47 安全修复：写入范围里的 .. / . / 绝对路径", () => {
  it("不安全的写入范围与任何范围都算重叠，也算落在独占区域", () => {
    const unsafe = [
      "src/../**",
      "src/*/../../a",
      "src/{a,../x}",
      "src/./a.ts",
      "./src/**",
      "src//a.ts",
      "/etc/**",
      "C:/x",
      "~/x",
      "src\\..\\x",
      "src/{.,a}/x",
    ];
    for (const g of unsafe) {
      expect(isUnsafeScope(g), g).toBe(true);
      expect(globsOverlap(g, "lib/a.ts"), g).toBe(true);
      expect(globsOverlap("lib/a.ts", g), g).toBe(true);
      expect(inExclusiveZone(g, DEFAULT_EXCLUSIVE_ZONES), g).toBe(true);
    }
    expect(globsOverlap("src/../**", "lib/a.ts")).toBe(true);
    // T-051 起与模块 4 同一份规则：结尾的 `/`（空段）也算不安全
    expect(isUnsafeScope("lib/")).toBe(true);
    for (const g of ["src/**", "src/{a,b}.ts", ".github/**"])
      expect(isUnsafeScope(g), g).toBe(false);
    expect(globsOverlap("src/**", "lib/a.ts")).toBe(false);
  });

  it("isUnsafeScope 与模块 4 的 isUnsafeGlob 结果一致（转调，@deprecated）", () => {
    const patterns = [
      "src/../**",
      "/etc/**",
      "src/../src/secret/**",
      "C:/x",
      "src//a",
      "!src/a",
      "src/**",
      "src/*.ts",
      "src/{a,b}.ts",
      ".github/**",
      "packages/*/package.json",
    ];
    for (const g of patterns) expect(isUnsafeScope(g), g).toBe(workspaceIsUnsafeGlob(g));
    expect(patterns.filter(isUnsafeScope)).toEqual(patterns.slice(0, 6));
  });

  it("D15. 调度：写入范围 src/../** 的单与 lib/a.ts 的单不同时派", async () => {
    const h = harness();
    const d = withHandle(h);
    const s = await started(h);
    await s.enqueue(ticket("T-1", { write_scope: ["lib/a.ts"] }));
    await s.enqueue(ticket("T-2", { write_scope: ["src/../**"] }));
    await settle(s);
    expect(d.handled).toEqual(["T-1"]);
    d.pending.get("T-1")!.resolve({ kind: "escalated", pr_id: null });
    await settle(s);
    expect(d.handled).toEqual(["T-1", "T-2"]);
  });
});

describe("T-039 取消信号", () => {
  it("C1. handle / resume 收到 9 的 signal；stop() 中止它，8 抛出的 reason 不上报、不改状态", async () => {
    const h = harness();
    const d = withHandle(h);
    const s = await started(h);
    await s.enqueue(ticket("T-1", { write_scope: ["a/**"] }));
    await settle(s);
    const opts = d.handle.mock.calls[0]![1] as { signal: AbortSignal };
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(opts.signal.aborted).toBe(false);
    opts.signal.addEventListener("abort", () => d.pending.get("T-1")!.reject(opts.signal.reason));
    s.stop();
    expect(opts.signal.aborted).toBe(true);
    expect((opts.signal.reason as Error).name).toBe("AbortError");
    await s.idle();
    expect(escalations(h)).toEqual([]);
    expect(s.status("T-1")).toBe("pending");
    expect(h.statuses).toEqual([["T-1", "pending"]]);
    expect((h.errors[0] as Error).name).toBe("AbortError");
  });

  it("C2. 续跑被 stop() 取消：凭据放回，单子仍在等续跑，不上报", async () => {
    const h = harness();
    const d = withHandle(h);
    let resumeSignal: AbortSignal | undefined;
    h.resume.mockImplementation(
      (_t, _token, o?: { signal?: AbortSignal }) =>
        new Promise((_, reject) => {
          resumeSignal = o?.signal;
          o?.signal?.addEventListener("abort", () => reject(o.signal!.reason));
        }),
    );
    const s = await started(h);
    await s.enqueue(ticket("T-1", { write_scope: ["a/**"] }));
    await settle(s);
    h.daily.exhausted = true;
    d.pending.get("T-1")!.resolve({ kind: "requeue_budget", resume: { tok: 1 } });
    await settle(s);
    h.daily.exhausted = false;
    await s.dispatch();
    expect(resumeSignal).toBeInstanceOf(AbortSignal);
    s.stop();
    await s.idle();
    expect(escalations(h)).toEqual([]);
    expect(s.budgetPaused()).toEqual(["T-1"]);
    expect(s.snapshot()[0]).toMatchObject({ status: "pending", budget_paused: true });
  });
});

describe("T-102b 冲突复投 / 重审的取消信号", () => {
  /** 8 的调用挂着，直到收到的 signal 被中止才以 signal.reason 失败（模拟 8 把 signal 传给 5 / 7） */
  const untilAborted = (_r: unknown, o?: SubAgentCallOptions) =>
    new Promise<SubAgentOutcome>((_, reject) => {
      o?.signal?.addEventListener("abort", () => reject(o.signal!.reason));
    });

  it("C3. 重审收到的就是 9 交给 handle 的那个 signal；stop() 中止它，不上报、不改状态", async () => {
    const h = harness();
    const d = withHandle(h);
    h.reReview.mockImplementationOnce(untilAborted);
    const s = await started(h);
    await s.enqueue(ticket("T-1", { write_scope: ["a/**"] }));
    await s.enqueue(ticket("T-2", { write_scope: ["b/**"] }));
    await settle(s);
    const handleSignal = (d.handle.mock.calls[1]![1] as { signal: AbortSignal }).signal;
    handleSignal.addEventListener("abort", () => d.pending.get("T-2")!.reject(handleSignal.reason));
    // 基线不明 → 重审
    await s.submit({
      ticket_id: "T-1",
      pr_id: "pr-1",
      worktree_path: "/wt/T-1-r0",
      base_commit: SHA("9"),
    });
    d.pending.get("T-1")!.resolve({ kind: "merge_queued", pr_id: "pr-1" });
    await vi.waitFor(() => expect(h.reReview).toHaveBeenCalledTimes(1));
    const opts = h.reReview.mock.calls[0]![1];
    expect(opts?.signal).toBe(handleSignal);
    expect(opts!.signal!.aborted).toBe(false);
    const before = [...h.statuses];
    expect(s.status("T-1")).toBe("re_reviewing");
    await s.stop();
    expect(opts!.signal!.aborted).toBe(true);
    expect(escalations(h)).toEqual([]);
    expect(s.status("T-1")).toBe("re_reviewing");
    expect(h.statuses).toEqual(before);
    expect(h.calls.filter((c) => c.startsWith("close:") || c.startsWith("cleanup:"))).toEqual([]);
    expect(h.errors.map((e) => (e as Error).name)).toContain("AbortError");
  });

  it("C4. 冲突复投收到 9 的 signal；stop() 中止它，不上报、不改状态，新 worktree 留给下次启动的 takeOver", async () => {
    const h = harness();
    h.resubmit.mockImplementationOnce(untilAborted);
    const s = await started(h);
    await s.enqueue(ticket("T-1"));
    h.merges.set("pr-1", [conflict()]);
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/1", base_commit: SHA("a") });
    await vi.waitFor(() => expect(h.resubmit).toHaveBeenCalledTimes(1));
    const opts = h.resubmit.mock.calls[0]![1];
    expect(opts?.signal).toBeInstanceOf(AbortSignal);
    expect(opts!.signal!.aborted).toBe(false);
    const before = [...h.statuses];
    expect(s.status("T-1")).toBe("resubmitting");
    await s.stop();
    expect(opts!.signal!.aborted).toBe(true);
    expect((opts!.signal!.reason as Error).name).toBe("AbortError");
    expect(escalations(h)).toEqual([]);
    expect(s.status("T-1")).toBe("resubmitting");
    expect(h.statuses).toEqual(before);
    // 旧 PR 不关、新旧 worktree 都不清：下次启动由 takeOver 接手
    expect(h.calls.filter((c) => c.startsWith("close:") || c.startsWith("cleanup:"))).toEqual([]);
    expect(h.calls).toContain(`create:T-1:${SHA("a")}:r1`);
    expect(h.errors.map((e) => (e as Error).name)).toContain("AbortError");
  });
});

describe("T-041a 重启接管 adopt", () => {
  const wt = (id: string, r = 0) => `/wt/${id}-r${r}`;

  it("没有 PR id、head 或 worktree 就拒绝，不登记", async () => {
    const h = harness();
    const s = await started(h);
    await expect(
      s.adopt(ticket("A"), { pr_id: "", head_sha: SHA("b"), worktree_path: wt("A") }),
    ).rejects.toThrow(/没有 PR id/);
    await expect(
      s.adopt(ticket("A"), { pr_id: "pr-A", head_sha: "", worktree_path: wt("A") }),
    ).rejects.toThrow(/没有 head/);
    await expect(
      s.adopt(ticket("A"), {
        pr_id: "pr-A",
        head_sha: undefined as unknown as string,
        worktree_path: wt("A"),
      }),
    ).rejects.toThrow(/没有 head/);
    await expect(
      s.adopt(ticket("A"), { pr_id: "pr-A", head_sha: SHA("b"), worktree_path: "" }),
    ).rejects.toThrow(/worktree/);
    expect(s.status("A")).toBeUndefined();
    expect(h.statuses).toEqual([]);
  });

  it("直接进合并队列并合入，不派单（注入了 handle 也不调）", async () => {
    const h = harness();
    const handle = vi.fn(async () => ({ kind: "escalated" as const, pr_id: null }));
    h.deps.subAgent.handle = handle;
    h.deps.dispatch_poll_ms = 0;
    const s = await started(h);
    // 基线就是目标分支当前 HEAD：直接合
    expect(
      await s.adopt(ticket("A", { write_scope: ["src/a/**"] }), {
        pr_id: "pr-A",
        head_sha: SHA("b"),
        worktree_path: wt("A"),
        base_commit: h.head.sha,
      }),
    ).toBe("adopted");
    await s.idle();
    expect(handle).not.toHaveBeenCalled();
    expect(h.reReview).not.toHaveBeenCalled();
    expect(h.calls).toContain("merge:pr-A:bakacoding/integration");
    expect(h.statuses.filter(([t]) => t === "A").map(([, st]) => st)).toEqual([
      "merge_queued",
      "merged",
    ]);
    expect(h.published.some((e) => e.type === "interface_changed" && e.ticket_id === "A")).toBe(
      true,
    );
  });

  it("重复调用幂等：同一 PR 再调返回 already、队里只有一条；换 PR 或再 enqueue 报错", async () => {
    const h = harness();
    const s = await started(h);
    // 依赖没登记：留在队里不出队
    const t = ticket("A", { depends_on: ["X"] });
    const input = { pr_id: "pr-A", head_sha: SHA("b"), worktree_path: wt("A") };
    expect(await s.adopt(t, input)).toBe("adopted");
    expect(await s.adopt(t, input)).toBe("already");
    await s.idle();
    expect(s.snapshot().filter((v) => v.ticket_id === "A")).toHaveLength(1);
    expect(h.statuses.filter(([id]) => id === "A")).toEqual([["A", "merge_queued"]]);
    await expect(s.adopt(t, { ...input, pr_id: "pr-B" })).rejects.toThrow(/已登记/);
    await expect(s.enqueue(t)).rejects.toThrow(/重复登记/);
    expect(h.calls.filter((c) => c.startsWith("merge:"))).toEqual([]);
  });

  it("enqueue 过的 pending 单不能 adopt", async () => {
    const h = harness();
    const s = await started(h);
    await s.enqueue(ticket("A"));
    await expect(
      s.adopt(ticket("A"), { pr_id: "pr-A", head_sha: SHA("b"), worktree_path: wt("A") }),
    ).rejects.toThrow(/已登记/);
  });

  it("基线定不了且与目标分支 HEAD 不同：保守重审后再合（re_reviewing 重启后的路径）", async () => {
    const h = harness();
    const s = await started(h);
    await s.adopt(ticket("A"), {
      pr_id: "pr-A",
      head_sha: SHA("b"),
      worktree_path: wt("A"),
      base_commit: SHA("e"),
    });
    await s.idle();
    expect(h.reReview).toHaveBeenCalledTimes(1);
    expect(h.reReview.mock.calls[0]![0]).toMatchObject({ pr_id: "pr-A", base_unknown: true });
    expect(s.status("A")).toBe("merged");
  });

  it("已有持锁单时，写入范围重叠的 adopt 抛错（写明冲突单号），不登记、不写状态、不入队", async () => {
    const h = harness();
    const d = withHandle(h);
    const s = await started(h);
    await s.enqueue(ticket("X", { write_scope: ["src/**"] }));
    await settle(s);
    expect(d.handled).toEqual(["X"]);
    const before = h.statuses.length;
    await expect(
      s.adopt(ticket("Y", { write_scope: ["src/a.ts"] }), {
        pr_id: "pr-Y",
        head_sha: SHA("b"),
        worktree_path: wt("Y"),
        base_commit: h.head.sha,
      }),
    ).rejects.toThrow(/在途单 X 重叠/);
    expect(s.status("Y")).toBeUndefined();
    expect(s.snapshot().map((v) => v.ticket_id)).toEqual(["X"]);
    expect(h.statuses.slice(before)).toEqual([]);
    await settle(s);
    expect(h.calls.filter((c) => c.startsWith("merge:"))).toEqual([]);
    // 失败不留痕：之后不重叠时可以正常接回
    await pass(s, d, "X");
    expect(
      await s.adopt(ticket("Y", { write_scope: ["src/a.ts"] }), {
        pr_id: "pr-Y",
        head_sha: SHA("b"),
        worktree_path: wt("Y"),
        base_commit: h.head.sha,
      }),
    ).toBe("adopted");
  });

  it("两张写入范围重叠的单先后 adopt：第二张抛错，只有第一张持锁", async () => {
    const h = harness();
    const s = await started(h);
    // 依赖没登记：A 留在队里持锁不出队
    expect(
      await s.adopt(ticket("A", { write_scope: ["src/**"], depends_on: ["Z"] }), {
        pr_id: "pr-A",
        head_sha: SHA("b"),
        worktree_path: wt("A"),
      }),
    ).toBe("adopted");
    await expect(
      s.adopt(ticket("B", { write_scope: ["src/a.ts"] }), {
        pr_id: "pr-B",
        head_sha: SHA("b"),
        worktree_path: wt("B"),
      }),
    ).rejects.toThrow(/在途单 A 重叠/);
    expect(s.status("B")).toBeUndefined();
    expect(h.statuses).toEqual([["A", "merge_queued"]]);
    expect(
      s
        .snapshot()
        .filter((v) => v.locked_scope !== null)
        .map((v) => v.ticket_id),
    ).toEqual(["A"]);
  });

  it("独占区域正被另一张单占着：碰独占区域的 adopt 抛错并说明是独占区域", async () => {
    const h = harness();
    const s = await started(h);
    await s.adopt(ticket("A", { write_scope: ["pnpm-lock.yaml"], depends_on: ["Z"] }), {
      pr_id: "pr-A",
      head_sha: SHA("b"),
      worktree_path: wt("A"),
    });
    // 文件不同、不重叠，但都在独占区域
    await expect(
      s.adopt(ticket("B", { write_scope: ["packages/x/package.json"] }), {
        pr_id: "pr-B",
        head_sha: SHA("b"),
        worktree_path: wt("B"),
      }),
    ).rejects.toThrow(/独占区域.*A/);
    expect(s.status("B")).toBeUndefined();
    expect(h.statuses).toEqual([["A", "merge_queued"]]);
    // 普通单不受影响
    expect(
      await s.adopt(ticket("C", { write_scope: ["src/c/**"], depends_on: ["Z"] }), {
        pr_id: "pr-C",
        head_sha: SHA("b"),
        worktree_path: wt("C"),
      }),
    ).toBe("adopted");
  });

  it("冲突（conflict 重启后的路径）：照常冲突复投，冲突计数取 round", async () => {
    const h = harness();
    h.merges.set("pr-A", [conflict(["a.ts"])]);
    const s = await started(h);
    await s.adopt(ticket("A"), {
      pr_id: "pr-A",
      head_sha: SHA("b"),
      worktree_path: wt("A", 1),
      round: 1,
      base_commit: h.head.sha,
    });
    await s.idle();
    expect(h.resubmit).toHaveBeenCalledTimes(1);
    expect(h.resubmit.mock.calls[0]![0]).toMatchObject({
      round: 2,
      previous_pr_id: "pr-A",
      resubmit_counts: { conflict: 2 },
    });
  });
});

describe("T-041b adopt 写状态失败回滚", () => {
  const wt = (id: string) => `/wt/${id}-r0`;
  it("写 merge_queued 抛错：adopt 原样抛错，不留登记、PR 映射和锁，不入队；之后同一 PR 能重新接回", async () => {
    const h = harness();
    const s = await started(h);
    const set = h.deps.tickets.setStatus;
    let fail = true;
    h.deps.tickets.setStatus = (t, st) => {
      if (fail && t === "A") throw new Error("写库失败");
      return set(t, st);
    };
    const input = { pr_id: "pr-A", head_sha: SHA("b"), worktree_path: wt("A") };
    await expect(
      s.adopt(ticket("A", { write_scope: ["src/**"], depends_on: ["Z"] }), input),
    ).rejects.toThrow(/写库失败/);
    expect(s.status("A")).toBeUndefined();
    expect(s.snapshot()).toEqual([]);
    // PR 映射撤掉：按 pr_id 查回到不认识的最小上下文
    expect(s.eventContext({ pr_id: "pr-A", ticket_id: null }).requirement_id).toBe(
      "unattributed:pr-A",
    );
    // 锁已放掉：写入范围重叠的另一张单能接回
    expect(
      await s.adopt(ticket("B", { write_scope: ["src/b.ts"], depends_on: ["Z"] }), {
        pr_id: "pr-B",
        head_sha: SHA("b"),
        worktree_path: wt("B"),
      }),
    ).toBe("adopted");
    expect(s.lock("B", ["src/**"])).toBe("ok");
    await s.idle();
    expect(h.calls.filter((c) => c === "merge:pr-A:bakacoding/integration")).toEqual([]);
    // 修好后同一 PR 重试（B 合不了：依赖 Z 没登记、一直持锁，所以换一张不重叠的范围）
    fail = false;
    expect(await s.adopt(ticket("A", { write_scope: ["lib/**"], depends_on: ["Z"] }), input)).toBe(
      "adopted",
    );
    expect(s.status("A")).toBe("merge_queued");
  });

  it("#65 评审：回滚撤掉 PR 映射——同一张单之后换新 PR 接回，旧 pr_id 不再映射到这张单", async () => {
    const h = harness();
    const s = await started(h);
    const set = h.deps.tickets.setStatus;
    let fail = true;
    h.deps.tickets.setStatus = (t, st) => {
      if (fail && t === "A") throw new Error("写库失败");
      return set(t, st);
    };
    await expect(
      s.adopt(ticket("A", { write_scope: ["src/**"], depends_on: ["Z"] }), {
        pr_id: "pr-A-old",
        head_sha: SHA("b"),
        worktree_path: wt("A"),
      }),
    ).rejects.toThrow(/写库失败/);
    fail = false;
    expect(
      await s.adopt(ticket("A", { write_scope: ["src/**"], depends_on: ["Z"] }), {
        pr_id: "pr-A-new",
        head_sha: SHA("c"),
        worktree_path: wt("A"),
      }),
    ).toBe("adopted");
    // 新 PR 照常映射到 A
    expect(s.eventContext({ pr_id: "pr-A-new", ticket_id: null })).toMatchObject({
      requirement_id: "req-1",
      span_id: "span-A",
    });
    // 旧 PR 的映射已撤掉：A 重新登记后也查不回 A（映射残留的话这里会拿到 A 的上下文）
    expect(s.eventContext({ pr_id: "pr-A-old", ticket_id: null })).toMatchObject({
      requirement_id: "unattributed:pr-A-old",
      trace_id: "unattributed:pr-A-old",
    });
  });
});

describe("T-041b replaceDependency", () => {
  it("依赖已上报单的下游单 held → 换成新单后 waiting，新单合入后 ready 并合入；终态单不改；返回被改的单号", async () => {
    const h = harness();
    const d = withHandle(h, { max: 4 });
    const s = await started(h);
    await s.enqueue(ticket("X", { write_scope: ["x/**"] }));
    await s.enqueue(ticket("D", { write_scope: ["d/**"], depends_on: ["X", "Y"] }));
    await s.enqueue(ticket("Y", { write_scope: ["y/**"] }));
    await settle(s);
    expect(d.handled.sort()).toEqual(["X", "Y"]);
    await pass(s, d, "Y");
    // X 上报：D 挂起
    d.pending.get("X")!.resolve({ kind: "escalated", pr_id: null });
    await settle(s);
    expect(s.status("X")).toBe("escalated");
    expect(s.dependencyState("D")).toBe("held");

    await s.enqueue(ticket("X2", { write_scope: ["x/**"] }));
    expect(s.replaceDependency("X", ["X2", "X2", "D"])).toEqual(["D"]);
    expect(s.dependencyState("D")).toBe("waiting");
    // 对同一个旧单号再换一次：没有单再依赖它
    expect(s.replaceDependency("X", ["X2"])).toEqual([]);
    await settle(s);
    expect(d.handled).toContain("X2");
    await pass(s, d, "X2");
    expect(d.handled).toContain("D");
    await pass(s, d, "D");
    expect(s.status("D")).toBe("merged");
    // 终态的单不改依赖
    expect(s.replaceDependency("Y", ["Q"])).toEqual([]);
  });
});

describe("T-041c 高风险闸门", () => {
  /** 打开闸门、记录 onHighRiskHeld；close 可按 PR 注入错误 */
  function gated(over: Parameters<typeof harness>[0] = {}) {
    const h = harness(over);
    const held: HighRiskHeldInfo[] = [];
    const closeFails = new Map<string, Error>();
    h.deps.holdHighRisk = true;
    h.deps.onHighRiskHeld = (i) => void held.push(i);
    const orig = h.deps.createPr;
    h.deps.createPr = async (o) => {
      const p = await orig(o);
      return {
        ...p,
        close: async (pr_id: string, reason: string) => {
          h.calls.push(`close:${pr_id}:${reason}`);
          const err = closeFails.get(pr_id);
          if (err) throw err;
        },
      };
    };
    return { h, held, closeFails };
  }
  const view = (s: Scheduler, id: string) => s.snapshot().find((v) => v.ticket_id === id)!;
  const mergesOf = (h: Harness) => h.calls.filter((c) => c.startsWith("merge:"));
  /** 抛的 HighRiskDecisionError 的码（没抛返回 "none"） */
  const codeOf = (fn: () => unknown): string => {
    try {
      fn();
    } catch (e) {
      expect(e).toBeInstanceOf(HighRiskDecisionError);
      return (e as HighRiskDecisionError).code;
    }
    return "none";
  };
  const codeOfAsync = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
    } catch (e) {
      expect(e).toBeInstanceOf(HighRiskDecisionError);
      return (e as HighRiskDecisionError).code;
    }
    return "none";
  };

  it("闸门关（默认）：高风险单照常合并，held_high_risk 恒为 false，不调 onHighRiskHeld，high_risk_held 为 0", async () => {
    const h = harness();
    const held: HighRiskHeldInfo[] = [];
    h.deps.onHighRiskHeld = (i) => void held.push(i);
    const s = await started(h);
    await s.enqueue(ticket("T-1"));
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/1", high_risk: true });
    expect(view(s, "T-1").held_high_risk).toBe(false);
    await s.idle();
    expect(s.status("T-1")).toBe("merged");
    expect(held).toEqual([]);
    expect((await s.backpressureState()).pending_prs.high_risk_held).toBe(0);
    expect(codeOf(() => s.releaseHighRisk("T-1", "pr-1"))).toBe("terminal");
  });

  it("闸门开：高风险单扣在队里不合并，后面不相干的单照常合并；同一 PR 只通知一次", async () => {
    const { h, held } = gated();
    const s = await started(h);
    await s.enqueue(ticket("T-1", { write_scope: ["package.json"] }));
    await s.enqueue(ticket("T-2", { write_scope: ["src/**"] }));
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/1", high_risk: true });
    await s.submit({ ticket_id: "T-2", pr_id: "pr-2", worktree_path: "/2" });
    await s.idle();
    expect(s.status("T-1")).toBe("merge_queued");
    expect(s.status("T-2")).toBe("merged");
    expect(mergesOf(h)).toEqual(["merge:pr-2:bakacoding/integration"]);
    expect(view(s, "T-1")).toMatchObject({ held_high_risk: true, high_risk: true });
    expect(view(s, "T-2").held_high_risk).toBe(false);
    expect(held).toEqual([
      { ticket_id: "T-1", pr_id: "pr-1", requirement_id: "req-1", cause: "submit" },
    ]);
    // 再触发几轮合并循环也不重复通知
    await s.sync();
    await s.idle();
    expect(held).toHaveLength(1);
    expect((await s.backpressureState()).pending_prs).toMatchObject({
      merge_queued: 1,
      high_risk_held: 1,
    });
  });

  it("放行：合入；同一 PR 再放行返回 already；没登记 / 不是高风险 / 闸门没开 / 终态都抛错", async () => {
    const { h } = gated();
    const s = await started(h);
    await s.enqueue(ticket("T-1"));
    await s.enqueue(ticket("T-2"));
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/1", high_risk: true });
    await s.submit({ ticket_id: "T-2", pr_id: "pr-2", worktree_path: "/2" });
    await s.idle();
    expect(codeOf(() => s.releaseHighRisk("X", "pr-1"))).toBe("not_found");
    expect(codeOf(() => s.releaseHighRisk("T-2", "pr-2"))).toBe("terminal");
    // 按 pr_id 绑定：不是当前被扣的 PR 抛 stale_pr，不放行
    const stale = (() => {
      try {
        return s.releaseHighRisk("T-1", "pr-old");
      } catch (e) {
        return e;
      }
    })();
    expect(isStalePrError(stale)).toBe(true);
    expect(view(s, "T-1").held_high_risk).toBe(true);
    expect(s.releaseHighRisk("T-1", "pr-1")).toBe("released");
    expect(s.releaseHighRisk("T-1", "pr-1")).toBe("already");
    await s.idle();
    expect(s.status("T-1")).toBe("merged");
    expect(codeOf(() => s.releaseHighRisk("T-1", "pr-1"))).toBe("terminal");

    const h2 = harness();
    const s2 = await started(h2);
    await s2.enqueue(ticket("T-1"));
    expect(codeOf(() => s2.releaseHighRisk("T-1", "pr-1"))).toBe("gate_off");
    const { h: h3 } = gated();
    const s3 = await started(h3);
    await s3.enqueue(ticket("T-1"));
    expect(codeOf(() => s3.releaseHighRisk("T-1", "pr-1"))).toBe("not_high_risk");
  });

  it("放行后冲突复投换了新 PR：重新扣（cause: resubmit），再放行才合入", async () => {
    const { h, held } = gated();
    const s = await started(h);
    await s.enqueue(ticket("T-1"));
    h.merges.set("pr-1", [conflict(["a.ts"])]);
    await s.submit({
      ticket_id: "T-1",
      pr_id: "pr-1",
      worktree_path: "/wt/T-1-r0",
      high_risk: true,
    });
    await s.idle();
    expect(s.releaseHighRisk("T-1", "pr-1")).toBe("released");
    await s.idle();
    expect(h.resubmit).toHaveBeenCalledTimes(1);
    expect(s.status("T-1")).toBe("merge_queued");
    expect(view(s, "T-1")).toMatchObject({ pr_id: "pr-100", held_high_risk: true });
    expect(held.map((i) => [i.pr_id, i.cause])).toEqual([
      ["pr-1", "submit"],
      ["pr-100", "resubmit"],
    ]);
    expect(mergesOf(h)).toEqual(["merge:pr-1:bakacoding/integration"]);
    // 旧 PR 的放行不算数：按旧 pr_id 再放行抛 stale_pr
    expect(codeOf(() => s.releaseHighRisk("T-1", "pr-1"))).toBe("stale_pr");
    expect(s.releaseHighRisk("T-1", "pr-100")).toBe("released");
    await s.idle();
    expect(s.status("T-1")).toBe("merged");
  });

  it("拒绝：9 不关 PR（10 关），发 escalated(high_risk_rejected)；状态 escalated、放锁、下游 held", async () => {
    const { h } = gated();
    const s = await started(h);
    await s.enqueue(ticket("T-1", { write_scope: ["package.json"] }));
    await s.enqueue(ticket("T-2", { depends_on: ["T-1"], write_scope: ["src/**"] }));
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/1", high_risk: true });
    await s.idle();
    await s.rejectHighRisk("T-1", "pr-1", "不需要这个依赖");
    expect(h.calls.filter((c) => c.startsWith("close:"))).toEqual([]);
    expect(escalations(h)).toEqual([
      expect.objectContaining({
        ticket_id: "T-1",
        payload: expect.objectContaining({
          reason: "high_risk_rejected",
          detail: "不需要这个依赖",
        }),
      }),
    ]);
    expect(s.status("T-1")).toBe("escalated");
    expect(h.statuses).toContainEqual(["T-1", "escalated"]);
    expect(view(s, "T-1")).toMatchObject({ locked_scope: null, held_high_risk: false });
    expect(s.dependencyState("T-2")).toBe("held");
    expect(await codeOfAsync(s.rejectHighRisk("T-1", "pr-1", "x"))).toBe("terminal");
    expect(await codeOfAsync(s.rejectHighRisk("T-2", "pr-2", "x"))).toBe("not_high_risk");

    const h2 = harness();
    const s2 = await started(h2);
    await s2.enqueue(ticket("T-1"));
    h2.merges.set("pr-1", [new Error("先别合")]);
    await s2.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/1", high_risk: true });
    await s2.idle();
    // 闸门关时单子会照常合并（这里合并出错已上报），拒绝已终态的单抛错
    expect(await codeOfAsync(s2.rejectHighRisk("T-1", "pr-1", "x"))).toBe("terminal");
  });

  it("拒绝的错误都带码：stale_pr / not_held（已放行）/ merge_in_progress；checkHighRisk 只校验不改状态", async () => {
    const { h } = gated();
    let unblock!: () => void;
    const gate = new Promise<void>((r) => (unblock = r));
    let entered = false;
    const inner = h.deps.createPr;
    h.deps.createPr = async (o) => {
      const p = await inner(o);
      return {
        ...p,
        merge: async (pr_id: string, target: string) => {
          if (pr_id === "pr-2") {
            entered = true;
            await gate;
          }
          return p.merge(pr_id, target);
        },
      };
    };
    const s = await started(h);
    await s.enqueue(ticket("T-1"));
    await s.enqueue(ticket("T-2"));
    await s.enqueue(ticket("T-3"));
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/1", high_risk: true });
    await s.submit({ ticket_id: "T-2", pr_id: "pr-2", worktree_path: "/2", high_risk: true });
    await s.idle();
    expect(await codeOfAsync(s.rejectHighRisk("T-1", "pr-old", "不要"))).toBe("stale_pr");
    expect(codeOf(() => s.checkHighRisk("T-1", "pr-old"))).toBe("stale_pr");
    expect(codeOf(() => s.checkHighRisk("T-1", "pr-1"))).toBe("none");
    expect(codeOf(() => s.checkHighRisk("T-3", "pr-3"))).toBe("not_high_risk");
    expect(codeOf(() => s.checkHighRisk("T-9", "pr-9"))).toBe("not_found");
    expect(s.status("T-1")).toBe("merge_queued");
    expect(view(s, "T-1").held_high_risk).toBe(true);
    expect(escalations(h)).toEqual([]);

    // 放行后正在合并：合并卡住期间拒绝抛 merge_in_progress（合并中的那张也不能再拒绝）
    expect(s.releaseHighRisk("T-2", "pr-2")).toBe("released");
    await vi.waitFor(() => expect(entered).toBe(true));
    expect(await codeOfAsync(s.rejectHighRisk("T-2", "pr-2", "不要"))).toBe("merge_in_progress");
    unblock();
    await s.idle();
    expect(s.status("T-2")).toBe("merged");
    expect(await codeOfAsync(s.rejectHighRisk("T-2", "pr-2", "不要"))).toBe("terminal");
    expect(escalations(h)).toEqual([]);
  });

  it("adopt 带 high_risk、闸门开：接回后照样扣着，cause 为 adopt", async () => {
    const { h, held } = gated();
    const s = await started(h);
    expect(
      await s.adopt(ticket("A", { write_scope: ["package.json"] }), {
        pr_id: "pr-A",
        head_sha: SHA("b"),
        worktree_path: "/wt/A-r0",
        base_commit: SHA("a"),
        high_risk: true,
      }),
    ).toBe("adopted");
    await s.idle();
    expect(s.status("A")).toBe("merge_queued");
    expect(mergesOf(h)).toEqual([]);
    // 扣着期间写入范围锁仍占着（v1 已知缺口：独占区域会挡住别的依赖类单）
    expect(view(s, "A").locked_scope).toEqual(["package.json"]);
    await expect(
      s.adopt(ticket("B", { write_scope: ["package.json"] }), {
        pr_id: "pr-B",
        head_sha: SHA("b"),
        worktree_path: "/wt/B-r0",
      }),
    ).rejects.toThrow(/独占区域|重叠/);
    expect(held).toEqual([
      { ticket_id: "A", pr_id: "pr-A", requirement_id: "req-1", cause: "adopt" },
    ]);
    expect(s.releaseHighRisk("A", "pr-A")).toBe("released");
    await s.idle();
    expect(s.status("A")).toBe("merged");
  });

  it("反压暂停时 onBackpressurePaused 调一次，pending_prs.high_risk_held 是被扣着等裁决的 PR 数", async () => {
    const { h } = gated({ pending_pr_limit: 1 });
    const paused: number[] = [];
    h.deps.onBackpressurePaused = (st) => void paused.push(st.pending_prs.high_risk_held);
    const d = withHandle(h, { max: 4 });
    const s = await started(h);
    for (const id of ["T-1", "T-2", "T-3"])
      await s.enqueue(ticket(id, { write_scope: [`src/${id}/**`] }));
    await settle(s);
    expect(d.handled).toEqual(["T-1", "T-2", "T-3"]);
    for (const id of ["T-1", "T-2"]) {
      await s.submit({
        ticket_id: id,
        pr_id: `pr-${id}`,
        worktree_path: `/wt/${id}-r0`,
        high_risk: true,
      });
      d.pending.get(id)!.resolve({ kind: "merge_queued", pr_id: `pr-${id}` });
    }
    await s.enqueue(ticket("T-4", { write_scope: ["src/T-4/**"] }));
    await settle(s);
    const st = await s.backpressureState();
    expect(st.paused).toBe(true);
    expect(st.reasons).toContain("pending_pr_limit");
    expect(st.pending_prs).toMatchObject({ merge_queued: 2, high_risk_held: 2 });
    expect(d.handled).not.toContain("T-4");
    expect(paused).toEqual([2]);
    // 一直暂停着不重复调：多轮派单 / 合并循环 / 再查反压都不再调
    for (let i = 0; i < 5; i++) {
      await s.sync();
      await settle(s);
      await s.backpressureState();
    }
    await s.enqueue(ticket("T-5", { write_scope: ["src/T-5/**"] }));
    await settle(s);
    expect(paused).toEqual([2]);
    // 放行两张、合入后恢复；恢复时不调（只在「未暂停 → 暂停」时调）
    s.releaseHighRisk("T-1", "pr-T-1");
    s.releaseHighRisk("T-2", "pr-T-2");
    await settle(s);
    expect((await s.backpressureState()).paused).toBe(false);
    expect(paused).toEqual([2]);
  });
});

describe("T-064 定时 sync + 独占区域大小写 + adopt 已合入", () => {
  function fakeTimers(getNow: () => number) {
    type Job = { at: number; fn: () => void };
    const jobs: Job[] = [];
    return {
      timers: {
        setTimeout: (fn: () => void, ms: number) => {
          const job: Job = { at: getNow() + ms, fn };
          jobs.push(job);
          return job;
        },
        clearTimeout: (h: unknown) => {
          const i = jobs.indexOf(h as Job);
          if (i >= 0) jobs.splice(i, 1);
        },
      },
      async flush(to: number) {
        for (;;) {
          const due = jobs.filter((j) => j.at <= to).sort((a, b) => a.at - b.at);
          if (!due.length) break;
          const j = due[0]!;
          const i = jobs.indexOf(j);
          if (i >= 0) jobs.splice(i, 1);
          j.fn();
          // runTimedSync 是 async：多轮 microtask 把它跑完
          for (let k = 0; k < 20; k++) await Promise.resolve();
        }
      },
      jobs,
    };
  }

  it("N6：Package.json / 子目录 PACKAGE.JSON 的代表路径经 isDependencyFile 判独占（T-065 合入后不区分大小写）", async () => {
    const { isDependencyFile } = await import("@bakacoding/sub-agent");
    // T-065 已合入：isDependencyFile 不区分大小写；N6 直接复用，两边一致
    expect(isDependencyFile("Package.json")).toBe(true);
    expect(isDependencyFile("apps/web/PACKAGE.JSON")).toBe(true);
    expect(inExclusiveZone("package.json", DEFAULT_EXCLUSIVE_ZONES)).toBe(true);
    expect(inExclusiveZone("Package.json", DEFAULT_EXCLUSIVE_ZONES)).toBe(true);
    expect(inExclusiveZone("apps/web/PACKAGE.JSON", DEFAULT_EXCLUSIVE_ZONES)).toBe(true);
    expect(inExclusiveZone("apps/web/package.json", DEFAULT_EXCLUSIVE_ZONES)).toBe(true);
    expect(inExclusiveZone("docs/package.json.md", DEFAULT_EXCLUSIVE_ZONES)).toBe(false);
    expect(inExclusiveZone("src/**", DEFAULT_EXCLUSIVE_ZONES)).toBe(false);
  });

  it("N6：两张写入范围分别是 package.json 与 **/package.json 的单不能同时持锁", async () => {
    const h = harness();
    const d = withHandle(h);
    const s = await started(h);
    await s.enqueue(ticket("T-1", { write_scope: ["package.json"] }));
    await s.enqueue(ticket("T-2", { write_scope: ["**/package.json"] }));
    await settle(s);
    expect(d.handled).toEqual(["T-1"]);
    d.pending.get("T-1")!.resolve({ kind: "escalated", pr_id: null });
    await settle(s);
    expect(d.handled).toEqual(["T-1", "T-2"]);
  });

  it("N1/N2：startSyncLoop 后按 sync_poll_ms 调 sync；stop 后不再调；0 关闭", async () => {
    let now = 1_000_000;
    const ft = fakeTimers(() => now);
    const h = harness();
    h.deps.sync_poll_ms = 1000;
    h.deps.timers = ft.timers;
    h.deps.clock = { now: () => now, sleep: async (ms) => void (now += ms) };
    let syncCount = 0;
    const inner = h.deps.createPr;
    h.deps.createPr = async (opts) => {
      const pr = await inner(opts);
      const orig = pr.sync.bind(pr);
      pr.sync = async () => {
        syncCount++;
        return orig();
      };
      return pr;
    };
    const s = createScheduler(h.deps);
    await s.start();
    expect(syncCount).toBe(0);
    s.startSyncLoop();
    s.startSyncLoop(); // 幂等
    now = 1_001_000;
    await ft.flush(now);
    expect(syncCount).toBe(1);
    now = 1_002_000;
    await ft.flush(now);
    expect(syncCount).toBe(2);
    s.stop();
    now = 1_010_000;
    await ft.flush(now);
    expect(syncCount).toBe(2);

    const h2 = harness();
    h2.deps.sync_poll_ms = 0;
    h2.deps.timers = fakeTimers(() => 0).timers;
    const s2 = createScheduler(h2.deps);
    await s2.start();
    s2.startSyncLoop();
    expect(s2.syncState().enabled).toBe(false);
    s2.stop();
  });

  it("N1：限流时下一轮不早于 retry_after_ms；鉴权失败停掉定时同步", async () => {
    let now = 0;
    const ft = fakeTimers(() => now);
    const h = harness();
    h.deps.sync_poll_ms = 1000;
    h.deps.timers = ft.timers;
    h.deps.clock = { now: () => now, sleep: async (ms) => void (now += ms) };
    const { GithubAuthError } = await import("@bakacoding/pr");
    let n = 0;
    const inner = h.deps.createPr;
    h.deps.createPr = async (opts) => {
      const pr = await inner(opts);
      pr.sync = async () => {
        n++;
        if (n === 1) throw rateLimit(5000);
        if (n === 2) throw new GithubAuthError(401, "sync");
        return [];
      };
      return pr;
    };
    const s = createScheduler(h.deps);
    await s.start();
    s.startSyncLoop();
    now = 1000;
    await ft.flush(now);
    expect(n).toBe(1);
    // 下一轮应在 max(5000, 1000)=5000 之后
    now = 1000 + 4999;
    await ft.flush(now);
    expect(n).toBe(1);
    now = 1000 + 5000;
    await ft.flush(now);
    expect(n).toBe(2);
    expect(s.syncState().disabled_reason).toBe("auth");
    expect(s.syncState().enabled).toBe(false);
    now += 60_000;
    await ft.flush(now);
    expect(n).toBe(2); // 停了
    s.stop();
  });

  it("T-042 SyncPartialError：先应用 changes 再抛 cause；显式 sync 不丢变化", async () => {
    // T-1 依赖未合的 T-0，留在队列里不自动合并
    const h = harness();
    const { GithubAuthError } = await import("@bakacoding/pr");
    const sha = "ab".repeat(20);
    const inner = h.deps.createPr;
    h.deps.createPr = async (opts) => {
      const pr = await inner(opts);
      pr.sync = async () => {
        throw new SyncPartialError(
          [{ pr_id: "pr-1", from: "open", to: "merged", merge_sha: sha }],
          new GithubAuthError(401, "sync"),
        );
      };
      return pr;
    };
    const s = await started(h);
    await s.enqueue(ticket("T-0"));
    await s.enqueue(ticket("T-1", { depends_on: ["T-0"] }));
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/wt/T-1-r0" });
    await s.idle();
    expect(s.status("T-1")).toBe("merge_queued");
    await expect(s.sync()).rejects.toMatchObject({ name: "GithubAuthError" });
    expect(s.status("T-1")).toBe("merged"); // 反向：若不先 apply changes，这里仍是 merge_queued
  });

  it("T-042 SyncPartialError：限流 / 鉴权看 cause（不看包装名）", async () => {
    let now = 0;
    const ft = fakeTimers(() => now);
    const h = harness();
    h.deps.sync_poll_ms = 1000;
    h.deps.timers = ft.timers;
    h.deps.clock = { now: () => now, sleep: async (ms) => void (now += ms) };
    const { GithubAuthError } = await import("@bakacoding/pr");
    let n = 0;
    const inner = h.deps.createPr;
    h.deps.createPr = async (opts) => {
      const pr = await inner(opts);
      pr.sync = async () => {
        n++;
        if (n === 1) {
          // 包装限流：若不 unwrap，rateLimitWait 看不到 retry_after_ms → 只按普通失败退避 1s
          throw new SyncPartialError([], rateLimit(5000));
        }
        if (n === 2) {
          // 包装鉴权：若不 unwrap，errorName 是 SyncPartialError → 不会停定时同步
          throw new SyncPartialError([], new GithubAuthError(401, "sync"));
        }
        return [];
      };
      return pr;
    };
    const s = createScheduler(h.deps);
    await s.start();
    s.startSyncLoop();
    now = 1000;
    await ft.flush(now);
    expect(n).toBe(1);
    expect(s.syncState().last_error?.name).toBe("GithubRateLimitError");
    now = 1000 + 4999;
    await ft.flush(now);
    expect(n).toBe(1); // 仍在 retry_after 窗口
    now = 1000 + 5000;
    await ft.flush(now);
    expect(n).toBe(2);
    expect(s.syncState().disabled_reason).toBe("auth");
    expect(s.syncState().enabled).toBe(false);
    expect(s.syncState().last_error?.name).toBe("GithubAuthError");
    now += 60_000;
    await ft.flush(now);
    expect(n).toBe(2);
    s.stop();
  });

  it("N3：6 的 sync 返回 [] 但 prRecord 已 merged → 记成 merged 并放锁", async () => {
    const h = harness();
    h.deps.holdHighRisk = true;
    h.deps.prRecord = async (pr_id) =>
      pr_id === "pr-1" ? { status: "merged", merge_sha: "ab".repeat(20) } : undefined;
    const s = await started(h);
    await s.enqueue(ticket("T-1", { write_scope: ["a.ts"] }));
    await s.submit({
      ticket_id: "T-1",
      pr_id: "pr-1",
      worktree_path: "/wt/T-1-r0",
      high_risk: true,
    });
    await settle(s);
    expect(s.status("T-1")).toBe("merge_queued"); // 仍被闸门扣着
    h.syncChanges = [];
    const applied = await s.sync();
    expect(applied.map((c) => c.to)).toEqual(["merged"]);
    expect(s.status("T-1")).toBe("merged");
    expect(h.statuses.filter(([t, st]) => t === "T-1" && st === "merged").length).toBeGreaterThan(
      0,
    );
    const ic = h.published.filter((e) => e.type === "interface_changed");
    expect(ic.length).toBe(1);
    s.stop();
  });

  it("B2：adopt already_merged → merged，合法 sha 发 interface_changed；无 sha 不发", async () => {
    const h = harness();
    const s = await started(h);
    const r1 = await s.adopt(
      ticket("T-1", { write_scope: ["a.ts"], interfaces: [{ file: "a.ts", symbol: "x" }] }),
      {
        pr_id: "pr-m",
        head_sha: SHA("b"),
        worktree_path: "/wt/T-1-r0",
        base_commit: SHA("a"),
        already_merged: true,
        merge_sha: "cd".repeat(20),
      },
    );
    expect(r1).toBe("merged");
    expect(s.status("T-1")).toBe("merged");
    expect(h.published.filter((e) => e.type === "interface_changed").length).toBe(1);

    const r2 = await s.adopt(ticket("T-2", { write_scope: ["b.ts"] }), {
      pr_id: "pr-m2",
      head_sha: SHA("c"),
      worktree_path: "/wt/T-2-r0",
      already_merged: true,
      // 非法 sha
      merge_sha: "short",
    });
    expect(r2).toBe("merged");
    expect(s.status("T-2")).toBe("merged");
    // 仍只有 T-1 那一条 interface_changed
    expect(h.published.filter((e) => e.type === "interface_changed").length).toBe(1);
    s.stop();
  });

  it("B2 反向：去掉 already_merged 时 adopt 会进合并队列而不是直接 merged", async () => {
    const h = harness();
    h.merges.set("pr-x", [rateLimit(60_000)]); // 卡住别合掉
    const s = await started(h);
    const r = await s.adopt(ticket("T-1", { write_scope: ["a.ts"] }), {
      pr_id: "pr-x",
      head_sha: SHA("b"),
      worktree_path: "/wt/T-1-r0",
      base_commit: SHA("a"),
    });
    expect(r).toBe("adopted");
    expect(s.status("T-1")).toBe("merge_queued");
    s.stop();
  });
});

// ---------------- T-096：stop() 返回 Promise，等在途工作收尾 ----------------

/** 把 harness 的 6 包一层：merge / sync 可以换成可控的实现。 */
function controllablePr(
  h: Harness,
  over: {
    merge?: (pr_id: string, target: string) => Promise<MergeResult>;
    sync?: () => Promise<SyncChange[]>;
  },
) {
  const orig = h.deps.createPr;
  h.deps.createPr = async (args) => {
    const base = await orig(args);
    return { ...base, ...over };
  };
}

const flush = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

describe("T-096 stop() 等在途工作收尾", () => {
  it("S1. 在途的 handle（不理 signal）收尾前 stop() 不 resolve；收尾后 resolve；重复调用返回同一个 Promise", async () => {
    const h = harness();
    const d = withHandle(h);
    const s = await started(h);
    await s.enqueue(ticket("T-1", { write_scope: ["a/**"] }));
    await settle(s);
    expect(d.handled).toEqual(["T-1"]);
    let done = false;
    const p = s.stop();
    void p.then(() => (done = true));
    expect(s.stop()).toBe(p);
    await flush();
    expect(done).toBe(false);
    d.pending.get("T-1")!.reject(new Error("8 收尾时抛错"));
    await p;
    expect(done).toBe(true);
    // 被取消的 handle：不上报、不改状态
    expect(escalations(h)).toEqual([]);
    expect(h.statuses).toEqual([["T-1", "pending"]]);
  });

  it("S2. 合并在途时 stop：merge 回来是冲突也不复投、不上报、不改状态；resolve 之后不再写库", async () => {
    const h = harness();
    const m = deferred<MergeResult>();
    controllablePr(h, {
      merge: (pr_id, target) => {
        h.calls.push(`merge:${pr_id}:${target}`);
        return m.promise;
      },
    });
    const s = await started(h);
    await s.enqueue(ticket("T-1"));
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/1" });
    await vi.waitFor(() => expect(h.calls).toContain("merge:pr-1:bakacoding/integration"));
    const before = [...h.statuses];
    let done = false;
    const p = s.stop().then(() => (done = true));
    await flush();
    expect(done).toBe(false);
    m.resolve(conflict());
    await p;
    expect(h.statuses).toEqual(before);
    expect(h.statuses.at(-1)).toEqual(["T-1", "merge_queued"]);
    expect(s.status("T-1")).toBe("merge_queued");
    expect(h.resubmit).not.toHaveBeenCalled();
    expect(h.calls.filter((c) => c.startsWith("create:"))).toEqual([]);
    expect(escalations(h)).toEqual([]);
    const after = h.statuses.length;
    const events = h.published.length;
    await flush(10);
    expect(h.statuses).toHaveLength(after);
    expect(h.published).toHaveLength(events);
  });

  it("S3. 合并在途时 stop、merge 抛错：不上报 merge_error、不改状态，错误交 onError", async () => {
    const h = harness();
    const m = deferred<MergeResult>();
    controllablePr(h, { merge: () => m.promise });
    const s = await started(h);
    await s.enqueue(ticket("T-1"));
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/1" });
    await flush();
    const before = [...h.statuses];
    const p = s.stop();
    m.reject(new Error("网络断了"));
    await p;
    expect(h.statuses).toEqual(before);
    expect(s.status("T-1")).toBe("merge_queued");
    expect(escalations(h)).toEqual([]);
    expect(h.errors.map((e) => (e as Error).message)).toContain("网络断了");
  });

  it("S4. 冲突复投在途时 stop：等 8 返回才 resolve；8 在 stop 后抛错不上报、不改状态", async () => {
    const h = harness();
    const r = deferred<SubAgentOutcome>();
    h.resubmit.mockImplementation(() => r.promise);
    h.merges.set("pr-1", [conflict()]);
    const s = await started(h);
    await s.enqueue(ticket("T-1"));
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/1" });
    await vi.waitFor(() => expect(h.resubmit).toHaveBeenCalledTimes(1));
    const before = [...h.statuses];
    expect(before.at(-1)).toEqual(["T-1", "resubmitting"]);
    let done = false;
    const p = s.stop().then(() => (done = true));
    await flush();
    expect(done).toBe(false);
    r.reject(new Error("8 被打断"));
    await p;
    expect(h.statuses).toEqual(before);
    expect(s.status("T-1")).toBe("resubmitting");
    expect(escalations(h)).toEqual([]);
  });

  it("S5. 在途的 sync：stop() 等它收尾", async () => {
    const h = harness();
    const sy = deferred<SyncChange[]>();
    controllablePr(h, { sync: () => sy.promise });
    const s = await started(h);
    const syncing = s.sync();
    let done = false;
    const p = s.stop().then(() => (done = true));
    await flush();
    expect(done).toBe(false);
    sy.resolve([]);
    await p;
    await expect(syncing).resolves.toEqual([]);
  });

  it("S6. onError 自己抛错：stop() 照常 resolve，不产生未处理的 rejection", async () => {
    const h = harness();
    const d = withHandle(h);
    h.deps.onError = () => {
      throw new Error("onError 坏了");
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => void unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const s = await started(h);
      await s.enqueue(ticket("T-1", { write_scope: ["a/**"] }));
      await settle(s);
      const p = s.stop();
      d.pending.get("T-1")!.reject(new Error("aborted"));
      await expect(p).resolves.toBeUndefined();
      await flush(10);
      expect(unhandled).toEqual([]);
      expect(escalations(h)).toEqual([]);

      // 合并在途、stop 之后 merge 抛错：错误交给（会抛错的）onError，照样 resolve、不留未处理的 rejection
      const h2 = harness();
      h2.deps.onError = () => {
        throw new Error("onError 坏了");
      };
      const m = deferred<MergeResult>();
      controllablePr(h2, { merge: () => m.promise });
      const s2 = await started(h2);
      await s2.enqueue(ticket("T-1"));
      await s2.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/1" });
      await flush();
      const p2 = s2.stop();
      m.reject(new Error("网络断了"));
      await expect(p2).resolves.toBeUndefined();
      await flush(10);
      expect(unhandled).toEqual([]);
      expect(s2.status("T-1")).toBe("merge_queued");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("S8. 合入后清理（T-094 cleanupMerged）挂着不返回：stop() 不等它", async () => {
    const h = harness();
    let called = 0;
    h.deps.worktrees.cleanupMerged = () => {
      called++;
      return new Promise(() => {}); // 永不返回
    };
    const s = await started(h);
    await s.enqueue(ticket("T-1"));
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/wt/T-1-r0" });
    await vi.waitFor(() => expect(called).toBe(1));
    expect(s.status("T-1")).toBe("merged");
    await expect(s.stop()).resolves.toBeUndefined();
  });

  it("S7. 没有在途工作 / 没 start 过：stop() 直接 resolve", async () => {
    const h = harness();
    await expect(createScheduler(h.deps).stop()).resolves.toBeUndefined();
    const s = await started(h);
    await expect(s.stop()).resolves.toBeUndefined();
  });
});

describe("T-094：合入后清理 worktree / 分支", () => {
  it("合入后在发完 interface_changed 之后调 cleanupMerged(ticket_id, 目标分支)", async () => {
    const h = harness();
    const order: string[] = [];
    const pub = h.deps.bus.publish;
    h.deps.bus.publish = (e) => {
      if (e.type === "interface_changed") order.push("interface_changed");
      return pub(e);
    };
    h.deps.worktrees.cleanupMerged = (t, into) => {
      order.push(`cleanupMerged:${t}:${into}`);
      return { errors: [] };
    };
    const s = await started(h);
    await s.enqueue(ticket("T-1"));
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/wt/T-1-r0" });
    await s.idle();
    await new Promise((r) => setTimeout(r, 0));
    expect(s.status("T-1")).toBe("merged");
    expect(order).toEqual(["interface_changed", "cleanupMerged:T-1:bakacoding/integration"]);
    expect(h.errors).toEqual([]);
  });

  it("清理挂起不卡合并循环：下一张单照常合入；stop() 不等它", async () => {
    const h = harness();
    const started_: string[] = [];
    h.deps.worktrees.cleanupMerged = (t) => {
      started_.push(t);
      return new Promise(() => {}); // 永远不结束
    };
    const s = await started(h);
    await s.enqueue(ticket("T-1"));
    await s.enqueue(ticket("T-2"));
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/wt/T-1-r0" });
    await s.submit({ ticket_id: "T-2", pr_id: "pr-2", worktree_path: "/wt/T-2-r0" });
    await s.idle();
    expect(s.status("T-1")).toBe("merged");
    expect(s.status("T-2")).toBe("merged");
    expect(started_).toEqual(["T-1", "T-2"]);
    s.stop(); // 同步返回，不等挂起的清理
  });

  it("清理抛错或结果带 errors：状态仍是 merged，不上报、不发 merged_but，只调 onError", async () => {
    const h = harness();
    h.deps.worktrees.cleanupMerged = (t) => {
      if (t === "T-1") throw new Error("EBUSY: 文件被占用");
      return Promise.resolve({ errors: [{ target: "/wt/T-2-r0", message: "locked" }] });
    };
    const s = await started(h);
    await s.enqueue(ticket("T-1"));
    await s.enqueue(ticket("T-2"));
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/wt/T-1-r0" });
    await s.submit({ ticket_id: "T-2", pr_id: "pr-2", worktree_path: "/wt/T-2-r0" });
    await s.idle();
    await new Promise((r) => setTimeout(r, 0));
    expect(s.status("T-1")).toBe("merged");
    expect(s.status("T-2")).toBe("merged");
    expect(escalations(h)).toEqual([]);
    expect(h.statuses.filter(([, st]) => st === "escalated")).toEqual([]);
    const msgs = h.errors.map((e) => (e as Error).message);
    expect(msgs.some((m) => m.includes("EBUSY"))).toBe(true);
    expect(msgs.some((m) => m.includes("/wt/T-2-r0") && m.includes("locked"))).toBe(true);
  });

  it("sync 发现手动合入也清理；没注入 cleanupMerged 时行为不变", async () => {
    const h = harness();
    const cleaned: string[] = [];
    h.deps.worktrees.cleanupMerged = (t) => void cleaned.push(t);
    const s = await started(h);
    await s.enqueue(ticket("T-0"));
    await s.enqueue(ticket("T-1", { depends_on: ["T-0"] }));
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/wt/T-1-r0" });
    await s.idle();
    h.syncChanges.push({ pr_id: "pr-1", from: "open", to: "merged", merge_sha: SHA("c") });
    await s.sync();
    await new Promise((r) => setTimeout(r, 0));
    expect(s.status("T-1")).toBe("merged");
    expect(cleaned).toEqual(["T-1"]);

    const h2 = harness();
    const s2 = await started(h2);
    await s2.enqueue(ticket("T-1"));
    await s2.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/wt/T-1-r0" });
    await s2.idle();
    expect(s2.status("T-1")).toBe("merged");
    expect(h2.errors).toEqual([]);
  });

  it("stop() 之后才失败的清理不再回调 onError（停机后静默，不碰数据库）", async () => {
    const h = harness();
    let fail!: (e: Error) => void;
    h.deps.worktrees.cleanupMerged = () => new Promise((_, rej) => (fail = rej));
    const s = await started(h);
    await s.enqueue(ticket("T-1"));
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/wt/T-1-r0" });
    await s.idle();
    const statusesBefore = h.statuses.length;
    s.stop();
    fail(new Error("停机后才失败"));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.errors).toEqual([]);
    expect(h.statuses.length).toBe(statusesBefore);
  });
});

describe("T-094：清理的错误回调", () => {
  it("onError 自己抛错时不产生未处理的 rejection；实例暴露只读 target", async () => {
    const h = harness();
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown) => void unhandled.push(r);
    process.on("unhandledRejection", onUnhandled);
    try {
      h.deps.onError = () => {
        throw new Error("onError 自己坏了");
      };
      h.deps.worktrees.cleanupMerged = () => Promise.reject(new Error("清理失败"));
      const s = await started(h);
      expect(s.target).toBe("bakacoding/integration");
      await s.enqueue(ticket("T-1"));
      await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/wt/T-1-r0" });
      await s.idle();
      await new Promise((r) => setTimeout(r, 20));
      expect(s.status("T-1")).toBe("merged");
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
