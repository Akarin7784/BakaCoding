// T-042：集成分支审查 / 合入 main / C3
import { describe, expect, it, vi } from "vitest";
import { MainMergeError, createSupervisor } from "./index.js";
import type { SupervisorDeps } from "./types.js";

function baseDeps(over: Partial<SupervisorDeps> = {}): SupervisorDeps {
  const tickets: Array<{
    ticket_id: string;
    status?: string;
    project_id: string;
    requirement_id: string;
    fields?: unknown;
  }> = [];
  return {
    call: async () => ({ output: '{"verdict":"ok","summary":"LGTM","items":[]}' }) as never,
    getConfig: () =>
      ({
        roles: { supervisor: { provider: "p", model: "m", effort: "max" } },
        pipeline: {
          resplit_limit: 2,
          supervisor_backlog_limit: 10,
          main_merge: "user",
        },
      }) as never,
    promptTemplate: async () => "模板",
    storage: {
      listProjects: () => [],
      listDecisions: () => [],
      saveDecision: () => {},
      registerRequirement: () => {},
      saveTicket: () => {},
      getTicket: () => undefined,
      listTickets: () => tickets as never,
    },
    enqueue: () => {},
    publish: async () => {},
    subscribe: () => () => {},
    notifyUser: () => {},
    newId: () => "id-" + Math.random().toString(16).slice(2, 10),
    ...over,
  };
}

describe("T-042 reviewIntegration / mergeMain", () => {
  it("没有注入 pr → unavailable", async () => {
    const s = createSupervisor(baseDeps());
    await expect(s.reviewIntegration()).rejects.toMatchObject({ code: "unavailable" });
  });

  it("无新提交 → nothing_to_merge", async () => {
    const s = createSupervisor(
      baseDeps({
        pr: {
          kind: "local",
          openIntegration: async () => "int-1",
          diff: async () => ({ base_sha: "a".repeat(40), head_sha: "b".repeat(40), files: [] }),
          checks: async () => [],
          merge: async () => ({ merged: true, sha: "c".repeat(40), fast_forward: true }),
        },
        integration: { idle: async () => true },
      }),
    );
    const r = await s.reviewIntegration();
    expect(r).toMatchObject({ result: "blocked", reasons: [{ code: "nothing_to_merge" }] });
  });

  it("有在途单 → tickets_in_flight", async () => {
    const tickets = [
      {
        ticket_id: "T1",
        status: "coding",
        project_id: "p",
        requirement_id: "r",
        created_at: "2026-10-17T00:00:00Z",
        permission_list: [],
        ticket_text: "x",
        fields: null,
      },
    ];
    const s = createSupervisor(
      baseDeps({
        storage: {
          listProjects: () => [],
          listDecisions: () => [],
          saveDecision: () => {},
          registerRequirement: () => {},
          saveTicket: () => {},
          getTicket: () => undefined,
          listTickets: () => tickets as never,
        },
        pr: {
          kind: "local",
          openIntegration: async () => "int-1",
          diff: async () => ({
            base_sha: "a".repeat(40),
            head_sha: "b".repeat(40),
            files: [{ path: "a.ts", status: "modified", additions: 1, deletions: 0 }],
          }),
          checks: async () => [],
          merge: async () => ({ merged: true, sha: "c".repeat(40), fast_forward: true }),
        },
        integration: { idle: async () => false },
      }),
    );
    const r = await s.reviewIntegration();
    expect(r.result).toBe("blocked");
    if (r.result === "blocked")
      expect(r.reasons[0]).toMatchObject({ code: "tickets_in_flight", ticket_ids: ["T1"] });
  });

  it("CI cancelled → ci_failed（Q-4）", async () => {
    const s = createSupervisor(
      baseDeps({
        pr: {
          kind: "local",
          openIntegration: async () => "int-1",
          diff: async () => ({
            base_sha: "a".repeat(40),
            head_sha: "b".repeat(40),
            files: [{ path: "a.ts", status: "modified", additions: 1, deletions: 0 }],
          }),
          checks: async () => [
            { name: "ci", status: "completed", conclusion: "cancelled" },
          ],
          merge: async () => ({ merged: true, sha: "c".repeat(40), fast_forward: true }),
        },
        integration: { idle: async () => true },
      }),
    );
    const r = await s.reviewIntegration();
    expect(r.result).toBe("blocked");
    if (r.result === "blocked") expect(r.reasons[0]?.code).toBe("ci_failed");
  });

  it("模型 ok → mergeMain by supervisor + main_merge=user → notified", async () => {
    const notified: string[] = [];
    const merge = vi.fn(async () => ({
      merged: true as const,
      sha: "d".repeat(40),
      fast_forward: true,
    }));
    const head = "b".repeat(40);
    const s = createSupervisor(
      baseDeps({
        notifyUser: (m) => void notified.push(m.text),
        pr: {
          kind: "github",
          openIntegration: async () => "int-1",
          diff: async () => ({
            base_sha: "a".repeat(40),
            head_sha: head,
            files: [{ path: "a.ts", status: "modified", additions: 1, deletions: 0 }],
          }),
          checks: async () => [],
          merge,
        },
        integration: { idle: async () => true },
      }),
    );
    const rev = await s.reviewIntegration();
    expect(rev.result).toBe("ok");
    const m = await s.mergeMain({ by: "supervisor", head_sha: head });
    expect(m).toMatchObject({ result: "notified", reason: "main_merge_user" });
    expect(merge).not.toHaveBeenCalled();
    expect(notified.some((t) => t.includes("可以合入 main"))).toBe(true);
  });

  it("C3：本地 + 用户 worktree 在 main + by supervisor → notified，不 merge", async () => {
    const merge = vi.fn(async () => ({
      merged: true as const,
      sha: "d".repeat(40),
      fast_forward: true,
    }));
    const head = "b".repeat(40);
    const s = createSupervisor(
      baseDeps({
        getConfig: () =>
          ({
            roles: { supervisor: { provider: "p", model: "m", effort: "max" } },
            pipeline: {
              resplit_limit: 2,
              supervisor_backlog_limit: 10,
              main_merge: "supervisor",
            },
          }) as never,
        pr: {
          kind: "local",
          openIntegration: async () => "int-1",
          diff: async () => ({
            base_sha: "a".repeat(40),
            head_sha: head,
            files: [{ path: "a.ts", status: "modified", additions: 1, deletions: 0 }],
          }),
          checks: async () => [],
          merge,
        },
        integration: {
          idle: async () => true,
          userMainWorktree: async () => "/repo",
        },
      }),
    );
    expect((await s.reviewIntegration()).result).toBe("ok");
    const m = await s.mergeMain({ by: "supervisor", head_sha: head });
    expect(m).toMatchObject({ result: "notified", reason: "user_worktree_on_main" });
    expect(merge).not.toHaveBeenCalled();
  });

  it("by user 可合；stale_head 抛错", async () => {
    const head = "b".repeat(40);
    let currentHead = head;
    const s = createSupervisor(
      baseDeps({
        getConfig: () =>
          ({
            roles: { supervisor: { provider: "p", model: "m", effort: "max" } },
            pipeline: {
              resplit_limit: 2,
              supervisor_backlog_limit: 10,
              main_merge: "user",
            },
          }) as never,
        pr: {
          kind: "local",
          openIntegration: async () => "int-1",
          diff: async () => ({
            base_sha: "a".repeat(40),
            head_sha: currentHead,
            files: [{ path: "a.ts", status: "modified", additions: 1, deletions: 0 }],
          }),
          checks: async () => [],
          merge: async () => ({ merged: true, sha: "e".repeat(40), fast_forward: true }),
        },
        integration: { idle: async () => true },
      }),
    );
    expect((await s.reviewIntegration()).result).toBe("ok");
    currentHead = "f".repeat(40);
    await expect(s.mergeMain({ by: "user", head_sha: head })).rejects.toBeInstanceOf(MainMergeError);
    await expect(s.mergeMain({ by: "user", head_sha: head })).rejects.toMatchObject({
      code: "stale_head",
    });
  });

  it("模型输出非法 → review_failed", async () => {
    const s = createSupervisor(
      baseDeps({
        call: async () => ({ output: "not-json" }) as never,
        pr: {
          kind: "local",
          openIntegration: async () => "int-1",
          diff: async () => ({
            base_sha: "a".repeat(40),
            head_sha: "b".repeat(40),
            files: [{ path: "a.ts", status: "modified", additions: 1, deletions: 0 }],
          }),
          checks: async () => [],
          merge: async () => ({ merged: true, sha: "c".repeat(40), fast_forward: true }),
        },
        integration: { idle: async () => true },
      }),
    );
    const r = await s.reviewIntegration();
    expect(r.result).toBe("blocked");
    if (r.result === "blocked") expect(r.reasons[0]?.code).toBe("review_failed");
  });
});

describe("T-042 supervisor_backlog 与自动审", () => {
  it("发 supervisor_backlog 时 requirement_id / ticket_id 为 null，trace 新开", async () => {
    const published: unknown[] = [];
    const s = createSupervisor(
      baseDeps({
        publish: async (e) => {
          published.push(e);
        },
        pr: {
          kind: "local",
          openIntegration: async () => "int-1",
          diff: async () => ({
            base_sha: "a".repeat(40),
            head_sha: "b".repeat(40),
            files: [{ path: "a.ts", status: "modified", additions: 1, deletions: 0 }],
          }),
          checks: async () => [],
          merge: async () => ({ merged: true, sha: "c".repeat(40), fast_forward: true }),
        },
        integration: { idle: async () => true },
      }),
    );
    s.start();
    const backs = published.filter(
      (e): e is { type: string; requirement_id: unknown; ticket_id: unknown; trace_id: string } =>
        !!e && typeof e === "object" && (e as { type?: string }).type === "supervisor_backlog",
    );
    expect(backs.length).toBeGreaterThanOrEqual(1);
    expect(backs[0]!.requirement_id).toBeNull();
    expect(backs[0]!.ticket_id).toBeNull();
    expect(backs[0]!.trace_id).toBeTruthy();
  });

  it("自动审：同一 head 只审一次；有在途单不审", async () => {
    let reviewCalls = 0;
    const head = "b".repeat(40);
    const call = vi.fn(async () => {
      reviewCalls++;
      return { output: '{"verdict":"ok","summary":"ok","items":[]}' } as never;
    });
    let idle = true;
    const handlers: Record<string, (e: unknown) => void> = {};
    const s = createSupervisor(
      baseDeps({
        call,
        getConfig: () =>
          ({
            roles: { supervisor: { provider: "p", model: "m", effort: "max" } },
            pipeline: {
              resplit_limit: 2,
              supervisor_backlog_limit: 10,
              main_merge: "user",
            },
          }) as never,
        subscribe: (type, handler) => {
          handlers[type] = handler as (e: unknown) => void;
          return () => {};
        },
        pr: {
          kind: "local",
          openIntegration: async () => "int-1",
          diff: async () => ({
            base_sha: "a".repeat(40),
            head_sha: head,
            files: [{ path: "a.ts", status: "modified", additions: 1, deletions: 0 }],
          }),
          checks: async () => [],
          merge: async () => ({ merged: true, sha: "c".repeat(40), fast_forward: true }),
        },
        integration: { idle: async () => idle },
      }),
    );
    s.start();
    const fakeEv = {
      type: "interface_changed",
      requirement_id: "r",
      ticket_id: "t",
      trace_id: "tr",
      span_id: "sp",
      parent_span_id: null,
      event_id: "e1",
      ts: "2026-10-17T00:00:00Z",
      seq: 1,
      payload: {
        pr_id: "p",
        base_commit: head,
        changed_interfaces: [],
        summary: "x",
        affected_ticket_ids: [],
      },
    };
    handlers["interface_changed"]!(fakeEv);
    await vi.waitFor(() => expect(reviewCalls).toBe(1));
    handlers["interface_changed"]!(fakeEv);
    await new Promise((r) => setTimeout(r, 30));
    expect(reviewCalls).toBe(1);

    idle = false;
    reviewCalls = 0;
    handlers["interface_changed"]!({
      ...fakeEv,
      payload: { ...fakeEv.payload, base_commit: "c".repeat(40) },
    });
    await new Promise((r) => setTimeout(r, 30));
    // idle=false 时 maybeAutoReview 在取 head 前就 return
    expect(reviewCalls).toBe(0);
  });
});
