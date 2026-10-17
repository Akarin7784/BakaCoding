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
  eventContextInjected: unknown[];
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
          return next;
        },
        close: async (pr_id: string, reason: string) => {
          calls.push(`close:${pr_id}:${reason}`);
        },
        sync: async () => h.syncChanges!.splice(0),
        diff: async (pr_id: string): Promise<Diff> => ({
          base_sha: SHA("a"),
          head_sha: SHA("b"),
          files: (diffs.get(pr_id) ?? []).map((path) => ({
            path,
            status: "modified",
            additions: 1,
            deletions: 0,
            patch: "",
          })),
        }),
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
    budgetState: () => ({ daily_exhausted: daily.exhausted }),
    tickets: { setStatus: (t, s) => void statuses.push([t, s]) },
    worktrees: {
      create: (t, base, round) => {
        calls.push(`create:${t}:${base}:r${round}`);
        return { path: `/wt/${t}-r${round}`, branch: `bakacoding/${t}-r${round}` };
      },
      cleanup: (p) => void calls.push(`cleanup:${p}`),
    },
    subAgent: { resubmitConflict: resubmit, reReview },
    clock: {
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    },
    newId: () => `ev-${id++}`,
    target_dirty_retry_ms: 5000,
    onError: (e) => {
      throw e;
    },
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
    eventContextInjected,
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
  it("1. 启动时把 eventContext 注入 6：按 ticket_id、其次 pr_id 查 trace；未知 PR 报错", async () => {
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
    expect(() => s.eventContext({ pr_id: "nope", ticket_id: null })).toThrow(/找不到/);
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
      ["T-2", { reason: "github_manual", detail: "merge_error: Error: boom" }],
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
