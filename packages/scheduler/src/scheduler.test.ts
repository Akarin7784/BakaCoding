import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { getConfig } from "@bakacoding/config-budget";
import { GithubRateLimitError, type MergeResult, type SyncChange } from "@bakacoding/pr";
import { EventSchema, type Diff, type EventOf, type TicketStatus } from "@bakacoding/types";
import {
  BackpressureController,
  createScheduler,
  type ConflictResubmitRequest,
  type ReReviewRequest,
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
  resubmit: ReturnType<typeof vi.fn<(r: ConflictResubmitRequest) => Promise<SubAgentOutcome>>>;
  reReview: ReturnType<typeof vi.fn<(r: ReReviewRequest) => Promise<SubAgentOutcome>>>;
  resume: ReturnType<typeof vi.fn<(t: SchedulerTicket, token: unknown) => Promise<ResumeOutcome>>>;
  eventContextInjected: unknown[];
  errors: unknown[];
  head: { sha: string };
  diffFails: Set<string>;
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
  const resubmit = vi.fn(async (r: ConflictResubmitRequest): Promise<SubAgentOutcome> => {
    calls.push(`resubmit:${r.ticket.ticket_id}:r${r.round}`);
    return { pr_id: `pr-${newPr++}` };
  });
  const reReview = vi.fn(async (r: ReReviewRequest): Promise<SubAgentOutcome> => {
    calls.push(`reReview:${r.ticket.ticket_id}`);
    return { pr_id: r.pr_id };
  });
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
      "create:T-1:bakacoding/integration:r1",
      "resubmit:T-1:r1",
      "close:pr-1:冲突复投，由 pr-100 取代",
      "cleanup:/wt/T-1-r0",
      "merge:pr-100:bakacoding/integration",
      "create:T-1:bakacoding/integration:r2",
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

  it("R1a. 合并成功后的收尾（发 interface_changed）抛错：该单上报 github_manual（merged_but），队列继续，无未处理 rejection", async () => {
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
    await s.submit({ ticket_id: "T-1", pr_id: "pr-1", worktree_path: "/1" });
    await s.submit({ ticket_id: "T-2", pr_id: "pr-2", worktree_path: "/2" });
    await s.idle();
    expect(escalations(h).map((e) => [e.ticket_id, e.payload])).toEqual([
      ["T-1", { reason: "github_manual", detail: "merged_but: bus down" }],
    ]);
    expect(s.status("T-1")).toBe("escalated");
    expect(s.status("T-2")).toBe("merged");
    expect(
      h.published.filter((e) => e.type === "interface_changed").map((e) => e.ticket_id),
    ).toEqual(["T-2"]);
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
    expect(st.pending_prs).toEqual({ merge_queued: 2, in_review: 1, total: 3, limit: 2 });
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
