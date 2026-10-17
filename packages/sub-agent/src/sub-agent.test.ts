import { describe, expect, it, vi } from "vitest";
import { CommitPatchError, GitError, NoChangesError } from "@bakacoding/pr";
import type { RunTicketInput, RunTicketResult } from "@bakacoding/coder-pool";
import type { ReviewInput } from "@bakacoding/review-pool";
import type { Diff, ReviewResult, RoundRecord, TicketStatus } from "@bakacoding/types";
import {
  BUDGET_RESUME_NOTE,
  type ConflictResubmitRequest,
  type ResumeToken,
  createSubAgent,
  effortFor,
  reasonsToFeedback,
  type SubAgentConfig,
  type SubAgentDeps,
  type SubAgentPublishInput,
  type SubAgentTicket,
} from "./index.js";

const DIFF: Diff = {
  base_sha: "a".repeat(40),
  head_sha: "b".repeat(40),
  files: [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 0, patch: "+x" }],
};

const TICKET: SubAgentTicket = {
  ticket_id: "T-1",
  project_id: "P-1",
  requirement_id: "R-1",
  trace_id: "tr-1",
  span_id: "sp-1",
  parent_span_id: "sp-0",
  ticket_text: "把 foo 改名 bar",
  base_commit: "c".repeat(40),
  permission_list: [{ glob: "src/**", level: "rw" }],
  architecture_constraints: ["不加依赖"],
};

const CFG: SubAgentConfig = {
  roles: { coder: { effort: "low", resubmit_effort: ["low", "high", "high"] } },
  pipeline: { resubmit_limits: { review: 3 } },
};

const done = (summary = "改好了", changed_files = ["src/a.ts"]): RunTicketResult => ({
  status: "done",
  summary,
  changed_files,
});
const PASS = (reviewer: string | null = "reviewer-1"): ReviewResult => ({
  verdict: "pass",
  reasons: [],
  reviewer,
});
const FAIL = (detail = "bar 没导出", reviewer: string | null = "reviewer-1"): ReviewResult => ({
  verdict: "fail",
  reasons: [{ category: "incomplete", detail, file: "src/a.ts", line: 3 }],
  reviewer,
});
const budgetErr = () => Object.assign(new Error("budget"), { code: "BUDGET_EXCEEDED" });

type CommitStep = "ok" | "no_changes" | "hook";

function setup(
  opts: {
    runs?: RunTicketResult[];
    reviews?: Array<ReviewResult | Error>;
    commits?: CommitStep[];
    budget?: Array<{ daily_exhausted: boolean; ticket_exhausted?: boolean }>;
    config?: SubAgentConfig;
    over?: Partial<SubAgentDeps>;
  } = {},
) {
  const runs = [...(opts.runs ?? [])];
  const reviews = [...(opts.reviews ?? [])];
  const commits = [...(opts.commits ?? [])];
  const budgets = [...(opts.budget ?? [])];
  const runInputs: RunTicketInput[] = [];
  const reviewInputs: ReviewInput[] = [];
  const rounds: (RoundRecord & { ticket_id: string })[] = [];
  const statuses: TicketStatus[] = [];
  const events: (SubAgentPublishInput<"escalated"> | SubAgentPublishInput<"group_message">)[] = [];
  const order: string[] = [];
  let prSeq = 0;
  const pr = {
    open: vi.fn(async (ticket_id: string) => {
      order.push("open");
      return `pr-${ticket_id}-${++prSeq}`;
    }),
    commitWorktree: vi.fn(async (ticket_id: string, wt: string) => {
      order.push("commit");
      const step = commits.shift() ?? "ok";
      if (step === "no_changes") throw new NoChangesError(ticket_id, wt);
      if (step === "hook")
        throw new CommitPatchError(
          `${ticket_id} 提交失败：HOOK_NO`,
          new GitError("git commit 失败", ["commit"], 1, "HOOK_NO", ""),
        );
      return "d".repeat(40);
    }),
    diff: vi.fn(async () => DIFF),
  };
  const submit = vi.fn(() => void order.push("submit"));
  const deps: SubAgentDeps = {
    getConfig: () => opts.config ?? CFG,
    coder: {
      runTicket: vi.fn(async (input: RunTicketInput) => {
        runInputs.push(structuredClone(input));
        const r = runs.shift();
        if (!r) throw new Error("编码脚本用完");
        return r;
      }),
    },
    review: vi.fn(async (input: ReviewInput) => {
      reviewInputs.push(structuredClone(input));
      const r = reviews.shift();
      if (!r) throw new Error("评审脚本用完");
      if (r instanceof Error) throw r;
      return r;
    }),
    pr,
    budgetState: vi.fn(async (ticket_id: string) => {
      const b = budgets.shift() ?? { daily_exhausted: false, ticket_exhausted: true };
      return {
        daily_exhausted: b.daily_exhausted,
        ticket: {
          ticket_id,
          spent_micro_usd: 50,
          resubmit_micro_usd: 0,
          remaining_micro_usd: b.ticket_exhausted ? 0 : 10,
          exhausted: b.ticket_exhausted ?? false,
          by_role: { supervisor: 0, reviewer: 0, sub_agent: 0, coder: 50 },
        },
      };
    }),
    rounds: { save: (r) => void rounds.push(structuredClone(r)) },
    tickets: {
      setStatus: (_id, s) => {
        statuses.push(s);
        order.push(`status:${s}`);
      },
    },
    resubmitHistory: () => ({ review: 0 }),
    worktreeRoot: "/wt",
    worktrees: {
      create: (id, _base, n) => ({ path: `/wt/${id}-r${n}`, branch: `bakacoding/${id}-r${n}` }),
    },
    submit,
    publish: (e) => void events.push(e),
    ...opts.over,
  };
  const agent = createSubAgent(deps);
  const kinds = () =>
    events.map((e) =>
      e.type === "group_message" ? e.payload.kind : `escalated:${e.payload.reason}`,
    );
  return {
    agent,
    deps,
    pr,
    submit,
    runInputs,
    reviewInputs,
    rounds,
    statuses,
    events,
    order,
    kinds,
  };
}

describe("handle 主流程", () => {
  it("一次通过：编码 → 开 PR → 提交 → 评审 → 写轮次 → 交 9 的 submit，状态 coding → in_review → merge_queued", async () => {
    const t = setup({ runs: [done("foo 改成 bar")], reviews: [PASS()] });
    const out = await t.agent.handle(TICKET);

    expect(out).toEqual({
      kind: "merge_queued",
      pr_id: "pr-T-1-1",
      round: 1,
      resubmit_counts: { review: 0, conflict: 0 },
      reviewer: "reviewer-1",
    });
    // 6 要求提交前先有 PR 记录；merge_queued 在 submit 之前写，之后 8 不再写状态
    expect(t.order.filter((x) => !x.startsWith("status:") || x === "status:merge_queued")).toEqual([
      "open",
      "commit",
      "status:merge_queued",
      "submit",
    ]);
    expect(t.pr.open).toHaveBeenCalledWith("T-1", "/wt/T-1-r0", "bakacoding/T-1-r0");
    expect(t.statuses).toEqual(["coding", "in_review", "merge_queued"]);

    const run = t.runInputs[0]!;
    expect(run).toMatchObject({
      ticket: { ticket_id: "T-1", project_id: "P-1" },
      worktree_path: "/wt/T-1-r0",
      permission_list: TICKET.permission_list,
      effort: "low",
      ctx: {
        role: "sub_agent",
        requirement_id: "R-1",
        ticket_id: "T-1",
        is_resubmit: false,
        trace: { trace_id: "tr-1", span_id: "sp-1", parent_span_id: "sp-0" },
      },
    });
    expect(run.feedback).toBeUndefined();
    expect(run.prompt).toContain("把 foo 改名 bar");

    const rv = t.reviewInputs[0]!;
    expect(rv.pr_id).toBe("pr-T-1-1");
    expect(rv.ticket).toEqual({
      ticket_id: "T-1",
      ticket_text: "把 foo 改名 bar",
      architecture_constraints: ["不加依赖"],
    });
    expect(rv.summary).toContain("foo 改成 bar");
    expect(rv.summary).toContain("src/a.ts");
    expect(rv.ctx.is_resubmit).toBe(false);

    expect(t.rounds).toEqual([
      {
        ticket_id: "T-1",
        round: 1,
        diff: DIFF,
        verdict: "pass",
        fail_reasons: [],
        reviewer: "reviewer-1",
      },
    ]);
    expect(t.submit).toHaveBeenCalledWith({
      ticket_id: "T-1",
      pr_id: "pr-T-1-1",
      worktree_path: "/wt/T-1-r0",
      round: 0, // worktree 轮次 r0
      review_resubmits: 0,
      base_commit: TICKET.base_commit,
    });
    expect(t.kinds()).toEqual(["dispatch", "report", "review_verdict"]);
    const gm = t.events[0]!;
    expect(gm).toMatchObject({
      type: "group_message",
      requirement_id: "R-1",
      ticket_id: "T-1",
      trace_id: "tr-1",
      span_id: "sp-1",
      parent_span_id: "sp-0",
      payload: { project_id: "P-1", sender: "sub_agent", flash_calls: [] },
    });
  });

  it("用 9 给的 worktree，不再自己建", async () => {
    const create = vi.fn();
    const t = setup({ runs: [done()], reviews: [PASS()], over: { worktrees: { create } } });
    await t.agent.handle(TICKET, { worktree: { path: "/wt/x/T-1-r2", branch: "b/T-1" } });
    expect(create).not.toHaveBeenCalled();
    expect(t.runInputs[0]!.worktree_path).toBe("/wt/x/T-1-r2");
    expect(t.pr.open).toHaveBeenCalledWith("T-1", "/wt/x/T-1-r2", "b/T-1");
    expect(t.submit).toHaveBeenCalledWith(expect.objectContaining({ round: 2 })); // 从路径 -r<n> 解析
  });

  it("需求单缺 ticket_id 或 project_id 直接报错", async () => {
    const t = setup();
    await expect(t.agent.handle({ ...TICKET, project_id: "" })).rejects.toThrow(/project_id/);
  });

  it("架构约束没写在单上时按 project_id 取", async () => {
    const architectureConstraints = vi.fn(() => ["只经 types 共享类型"]);
    const t = setup({ runs: [done()], reviews: [PASS()], over: { architectureConstraints } });
    const { architecture_constraints: _drop, ...bare } = TICKET;
    void _drop;
    await t.agent.handle(bare);
    expect(architectureConstraints).toHaveBeenCalledWith("P-1");
    expect(t.reviewInputs[0]!.ticket.architecture_constraints).toEqual(["只经 types 共享类型"]);
  });
});

describe("评审不过与复投", () => {
  it("评审不过一次再通过：reasons 原样作 feedback，同一 worktree 同一 pr_id，复投升档，计 1 次", async () => {
    const fail = FAIL("bar 没导出");
    const t = setup({ runs: [done(), done("补了导出")], reviews: [fail, PASS()] });
    const out = await t.agent.handle(TICKET);

    expect(out).toMatchObject({
      kind: "merge_queued",
      pr_id: "pr-T-1-1",
      round: 2,
      resubmit_counts: { review: 1, conflict: 0 },
    });
    expect(t.pr.open).toHaveBeenCalledTimes(1);
    expect(t.order.filter((x) => !x.startsWith("status:"))).toEqual([
      "open",
      "commit",
      "commit",
      "submit",
    ]);
    const second = t.runInputs[1]!;
    expect(second.feedback).toBe(reasonsToFeedback(fail.reasons));
    expect(JSON.parse(second.feedback!)).toEqual(fail.reasons);
    expect(second.worktree_path).toBe("/wt/T-1-r0");
    expect(second.effort).toBe("low"); // 第 1 次复投 = resubmit_effort[0]
    expect(second.ctx.is_resubmit).toBe(true);
    expect(t.reviewInputs[1]!.ctx.is_resubmit).toBe(true);
    expect(t.reviewInputs[1]!.pr_id).toBe("pr-T-1-1");
    expect(t.statuses).toEqual([
      "coding",
      "in_review",
      "resubmitting",
      "in_review",
      "merge_queued",
    ]);
    expect(t.rounds.map((r) => [r.round, r.verdict])).toEqual([
      [1, "fail"],
      [2, "pass"],
    ]);
    expect(t.rounds[0]!.fail_reasons).toEqual(["incomplete (src/a.ts:3): bar 没导出"]);
    expect(t.rounds[1]!.review_comments).toBe(second.feedback);
    expect(t.submit).toHaveBeenCalledWith(
      expect.objectContaining({ round: 0, review_resubmits: 1 }),
    );
    expect(t.kinds()).toEqual([
      "dispatch",
      "report",
      "review_verdict",
      "resubmit",
      "report",
      "review_verdict",
    ]);
  });

  it("评审连续不过超过上限（3 次）：发 escalated(review_limit) 带 resubmit_counts，不进合并队列", async () => {
    const t = setup({
      runs: [done(), done(), done(), done()],
      reviews: [FAIL("1"), FAIL("2"), FAIL("3"), FAIL("4")],
    });
    const out = await t.agent.handle(TICKET);
    expect(out).toEqual({
      kind: "escalated",
      reason: "review_limit",
      detail: undefined,
      pr_id: "pr-T-1-1",
      resubmit_counts: { review: 3, conflict: 0 },
    });
    expect(t.runInputs.map((r) => r.effort)).toEqual(["low", "low", "high", "high"]);
    expect(t.submit).not.toHaveBeenCalled();
    expect(t.statuses.at(-1)).toBe("escalated");
    const esc = t.events.find((e) => e.type === "escalated")!;
    expect(esc).toMatchObject({
      type: "escalated",
      requirement_id: "R-1",
      ticket_id: "T-1",
      payload: { reason: "review_limit", resubmit_counts: { review: 3, conflict: 0 } },
    });
    expect(t.kinds().slice(-2)).toEqual(["escalated:review_limit", "escalation"]);
    expect(t.rounds).toHaveLength(4);
  });
});

describe("编码池没交出改动", () => {
  it("gave_up、turn_limit 原地复投：summary 作 feedback，计入评审复投计数，之后通过", async () => {
    const t = setup({
      runs: [
        { status: "gave_up", summary: "找不到 foo", changed_files: [] },
        { status: "turn_limit", summary: "轮数用完", changed_files: ["src/a.ts"] },
        done(),
      ],
      reviews: [PASS()],
    });
    const out = await t.agent.handle(TICKET);
    expect(out).toMatchObject({
      kind: "merge_queued",
      round: 1,
      resubmit_counts: { review: 2, conflict: 0 },
    });
    expect(t.runInputs.map((r) => r.feedback)).toEqual([undefined, "找不到 foo", "轮数用完"]);
    expect(t.runInputs.map((r) => r.worktree_path)).toEqual(Array(3).fill("/wt/T-1-r0"));
    expect(t.runInputs.map((r) => r.effort)).toEqual(["low", "low", "high"]);
    expect(t.pr.open).toHaveBeenCalledTimes(1); // 第一次 done 才开 PR
    expect(t.rounds).toHaveLength(1); // 只有走到评审的轮次写记录
  });

  it("超过上限发 escalated(coder_failed)，detail 是最后一次状态", async () => {
    const t = setup({
      config: { ...CFG, pipeline: { resubmit_limits: { review: 1 } } },
      runs: [
        { status: "gave_up", summary: "a", changed_files: [] },
        { status: "turn_limit", summary: "b", changed_files: [] },
      ],
    });
    const out = await t.agent.handle(TICKET);
    expect(out).toEqual({
      kind: "escalated",
      reason: "coder_failed",
      detail: "turn_limit",
      pr_id: null,
      resubmit_counts: { review: 1, conflict: 0 },
    });
    expect(t.events.find((e) => e.type === "escalated")!.payload).toEqual({
      reason: "coder_failed",
      detail: "turn_limit",
      resubmit_counts: { review: 1, conflict: 0 },
    });
    expect(t.deps.review).not.toHaveBeenCalled();
  });

  it("done 但 NoChangesError：当 gave_up 处理（复投、计数），超限时 detail 为 done_no_changes", async () => {
    const t = setup({
      config: { ...CFG, pipeline: { resubmit_limits: { review: 1 } } },
      runs: [done("做完了"), done("真做完了")],
      commits: ["no_changes", "no_changes"],
    });
    const out = await t.agent.handle(TICKET);
    expect(out).toMatchObject({
      kind: "escalated",
      reason: "coder_failed",
      detail: "done_no_changes",
      pr_id: "pr-T-1-1",
    });
    expect(t.runInputs[1]!.feedback).toContain("没有任何改动");
    expect(t.runInputs[1]!.feedback).toContain("做完了");
    expect(t.pr.open).toHaveBeenCalledTimes(1); // 第二轮复用同一 PR
    expect(t.deps.review).not.toHaveBeenCalled();
  });

  it("NoChangesError 后复投再交出改动：照常评审通过", async () => {
    const t = setup({ runs: [done(), done()], commits: ["no_changes", "ok"], reviews: [PASS()] });
    const out = await t.agent.handle(TICKET);
    expect(out).toMatchObject({
      kind: "merge_queued",
      resubmit_counts: { review: 1, conflict: 0 },
    });
  });

  it("CommitPatchError（如 hook 拒绝）：当 gave_up，错误信息作 feedback", async () => {
    const t = setup({ runs: [done(), done()], commits: ["hook", "ok"], reviews: [PASS()] });
    const out = await t.agent.handle(TICKET);
    expect(out).toMatchObject({
      kind: "merge_queued",
      resubmit_counts: { review: 1, conflict: 0 },
    });
    expect(t.runInputs[1]!.feedback).toBe("T-1 提交失败：HOOK_NO");
  });

  it("其他提交错误（如 WorktreeMismatchError）：handle 里上报 github_manual，detail 带错误，状态不停在 coding", async () => {
    const t = setup({
      runs: [done()],
      over: {
        pr: {
          open: async () => "pr-x",
          commitWorktree: async () => {
            throw new Error("WorktreeMismatch");
          },
          diff: async () => DIFF,
        },
      },
    });
    const out = await t.agent.handle(TICKET);
    expect(out).toMatchObject({ kind: "escalated", reason: "github_manual", pr_id: "pr-x" });
    if (out.kind !== "escalated") throw new Error();
    expect(out.detail).toBe("commit_error: Error: WorktreeMismatch");
    expect(t.statuses.at(-1)).toBe("escalated");
  });
});

describe("预算", () => {
  it("本单预算用完：escalated(budget_exceeded)，不复投、不计数", async () => {
    const t = setup({
      runs: [{ status: "budget_exceeded", summary: "", changed_files: [] }],
      budget: [{ daily_exhausted: false, ticket_exhausted: true }],
    });
    const out = await t.agent.handle(TICKET);
    expect(out).toMatchObject({
      kind: "escalated",
      reason: "budget_exceeded",
      resubmit_counts: { review: 0, conflict: 0 },
    });
    expect(t.deps.coder.runTicket).toHaveBeenCalledTimes(1);
    expect(t.deps.budgetState).toHaveBeenCalledWith("T-1");
    expect(t.events.find((e) => e.type === "escalated")!.payload).toMatchObject({
      reason: "budget_exceeded",
    });
    expect(t.statuses.at(-1)).toBe("escalated");
  });

  it("当日预算用完：不上报、不计数，返回 requeue_budget；第二天 resume 同一 worktree 续跑，feedback 注明预算暂停", async () => {
    const fail = FAIL();
    const t = setup({
      runs: [done(), { status: "budget_exceeded", summary: "", changed_files: [] }, done()],
      reviews: [fail, PASS()],
      budget: [{ daily_exhausted: true, ticket_exhausted: false }],
    });
    const out = await t.agent.handle(TICKET);
    expect(out.kind).toBe("requeue_budget");
    if (out.kind !== "requeue_budget") throw new Error();
    expect(out.resume).toMatchObject({
      ticket_id: "T-1",
      worktree_path: "/wt/T-1-r0",
      branch: "bakacoding/T-1-r0",
      pr_id: "pr-T-1-1",
      resubmit_counts: { review: 1, conflict: 0 },
      phase: "coding",
      is_resubmit: true,
      feedback: reasonsToFeedback(fail.reasons),
    });
    expect(t.events.some((e) => e.type === "escalated")).toBe(false);
    expect(t.statuses.at(-1)).toBe("pending");
    expect(t.submit).not.toHaveBeenCalled();

    const again = await t.agent.resume(TICKET, out.resume);
    expect(again).toMatchObject({
      kind: "merge_queued",
      pr_id: "pr-T-1-1",
      resubmit_counts: { review: 1, conflict: 0 },
    });
    const resumed = t.runInputs[2]!;
    expect(resumed.worktree_path).toBe("/wt/T-1-r0");
    expect(resumed.feedback!.startsWith(BUDGET_RESUME_NOTE)).toBe(true);
    expect(resumed.feedback).toContain("预算暂停后续跑");
    expect(resumed.feedback).toContain(fail.reasons[0]!.detail);
    expect(resumed.effort).toBe(t.runInputs[1]!.effort); // 不因暂停升档
    expect(t.pr.open).toHaveBeenCalledTimes(1);
    expect(t.submit).toHaveBeenCalledTimes(1);
  });

  it("首跑就碰到当日预算：续跑 feedback 只有预算说明，is_resubmit 仍为 false", async () => {
    const t = setup({
      runs: [{ status: "budget_exceeded", summary: "", changed_files: [] }, done()],
      reviews: [PASS()],
      budget: [{ daily_exhausted: true }],
    });
    const out = await t.agent.handle(TICKET);
    if (out.kind !== "requeue_budget") throw new Error("应暂停");
    expect(out.resume.pr_id).toBeNull();
    await t.agent.resume(TICKET, out.resume);
    expect(t.runInputs[1]!.feedback).toBe(BUDGET_RESUME_NOTE);
    expect(t.runInputs[1]!.ctx.is_resubmit).toBe(false);
    expect(t.statuses).toEqual(["coding", "pending", "coding", "in_review", "merge_queued"]);
  });

  it("评审时当日预算用完：暂停在 review 阶段，续跑不重新编码，直接重评审", async () => {
    const t = setup({
      runs: [done("改好了")],
      reviews: [budgetErr(), PASS()],
      budget: [{ daily_exhausted: true }],
    });
    const out = await t.agent.handle(TICKET);
    if (out.kind !== "requeue_budget") throw new Error("应暂停");
    expect(out.resume.phase).toBe("review");
    const again = await t.agent.resume(TICKET, out.resume);
    expect(again.kind).toBe("merge_queued");
    expect(t.deps.coder.runTicket).toHaveBeenCalledTimes(1);
    expect(t.reviewInputs[1]!.summary).toContain("改好了");
    expect(t.rounds).toHaveLength(1);
  });

  it("评审抛非预算错误：handle 里上报 review_limit，detail 带错误", async () => {
    const t = setup({ runs: [done()], reviews: [new Error("boom")] });
    const out = await t.agent.handle(TICKET);
    expect(out).toMatchObject({
      kind: "escalated",
      reason: "review_limit",
      detail: "review_error: Error: boom",
    });
    expect(t.statuses.at(-1)).toBe("escalated");
  });

  it("续跑凭据单号不符：报错", async () => {
    const t = setup();
    await expect(
      t.agent.resume(TICKET, {
        ticket_id: "T-9",
        worktree_path: "/wt/T-9-r0",
        branch: "b",
        base_commit: "c".repeat(40),
        worktree_round: 0,
        pr_id: null,
        resubmit_counts: { review: 0, conflict: 0 },
        phase: "coding",
        is_resubmit: false,
      }),
    ).rejects.toThrow(/T-9/);
  });
});

describe("轮次记录的 reviewer", () => {
  it.each([["reviewer-2"], ["supervisor"], [null]])(
    "reviewer = %s 原样写进轮次记录",
    async (reviewer) => {
      const t = setup({ runs: [done(), done()], reviews: [FAIL("x", reviewer), PASS(reviewer)] });
      await t.agent.handle(TICKET);
      expect(t.rounds.map((r) => r.reviewer)).toEqual([reviewer, reviewer]);
    },
  );

  it("轮次号从已保存的记录续编", async () => {
    const t = setup({
      runs: [done()],
      reviews: [PASS()],
      over: {
        rounds: {
          save: vi.fn(),
          list: () => [{ round: 4 }, { round: 2 }],
        },
      },
    });
    const out = await t.agent.handle(TICKET);
    expect(out).toMatchObject({ round: 5 });
  });
});

describe("effortFor", () => {
  it("首跑用 roles.coder.effort，第 k 次复投用 resubmit_effort[k-1]，两类复投合计，超出取最后一项", () => {
    const cfg: SubAgentConfig = {
      roles: { coder: { effort: "off", resubmit_effort: ["low", "high", "max"] } },
      pipeline: { resubmit_limits: { review: 3 } },
    };
    expect(effortFor(cfg, { review: 0, conflict: 0 })).toBe("off");
    expect(effortFor(cfg, { review: 1, conflict: 0 })).toBe("low");
    expect(effortFor(cfg, { review: 0, conflict: 2 })).toBe("high");
    expect(effortFor(cfg, { review: 2, conflict: 1 })).toBe("max");
    expect(effortFor(cfg, { review: 3, conflict: 2 })).toBe("max");
  });
});

describe("9 的入口（与 T-035 对齐）", () => {
  it("resubmitConflict：新 worktree 开新 PR，冲突文件作 feedback，计数用 9 给的，通过后不调 submit", async () => {
    const t = setup({ runs: [done(), done()], reviews: [PASS(), PASS()] });
    await t.agent.handle(TICKET);
    const out = await t.agent.resubmitConflict({
      ticket: {
        ticket_id: "T-1",
        requirement_id: "R-1",
        trace_id: "tr-1",
        span_id: "sp-1",
        parent_span_id: "sp-0",
      },
      round: 1,
      worktree_path: "/wt/T-1-r1",
      branch: "bakacoding/T-1-r1",
      base_commit: "bakacoding/integration",
      conflicted_files: ["src/a.ts"],
      previous_pr_id: "pr-T-1-1",
      resubmit_counts: { review: 0, conflict: 1 },
    });
    expect(out).toEqual({ pr_id: "pr-T-1-2", review_resubmits: 0 });
    expect(t.pr.open).toHaveBeenLastCalledWith("T-1", "/wt/T-1-r1", "bakacoding/T-1-r1");
    const run = t.runInputs[1]!;
    expect(run.feedback).toContain("src/a.ts");
    expect(run.feedback).toContain("bakacoding/integration");
    expect(run.effort).toBe("low"); // 第 1 次复投
    expect(run.ctx.is_resubmit).toBe(true);
    expect(t.submit).toHaveBeenCalledTimes(1); // 只有 handle 那次
  });

  it("resubmitConflict 不认识的单：报错（可注入 loadTicket 补全）", async () => {
    const t = setup();
    const req = {
      ticket: {
        ticket_id: "T-7",
        requirement_id: "R-1",
        trace_id: "t",
        span_id: "s",
        parent_span_id: null,
      },
      round: 1,
      worktree_path: "/wt/T-7-r1",
      branch: "b",
      base_commit: "main",
      conflicted_files: [],
      previous_pr_id: "p",
      resubmit_counts: { review: 0, conflict: 1 },
    };
    await expect(t.agent.resubmitConflict(req)).rejects.toThrow(/T-7/);
    const t2 = setup({
      runs: [done()],
      reviews: [FAIL()],
      config: { ...CFG, pipeline: { resubmit_limits: { review: 0 } } },
      over: { loadTicket: (id) => ({ ...TICKET, ticket_id: id }) },
    });
    expect(await t2.agent.resubmitConflict(req)).toEqual({ escalated: true, pr_id: "pr-T-7-1" });
  });

  it("reReview：同一 PR 再评一次，不计复投、不调 submit；不过则按评审复投走", async () => {
    const t = setup({ runs: [done(), done()], reviews: [PASS(), FAIL(), PASS()] });
    await t.agent.handle(TICKET);
    const out = await t.agent.reReview({
      ticket: {
        ticket_id: "T-1",
        requirement_id: "R-1",
        trace_id: "tr-1",
        span_id: "sp-1",
        parent_span_id: "sp-0",
      },
      pr_id: "pr-T-1-1",
      merged_since: [],
    });
    expect(out).toEqual({ pr_id: "pr-T-1-1", review_resubmits: 1 });
    expect(t.reviewInputs[1]!.ctx.is_resubmit).toBe(true);
    expect(t.deps.coder.runTicket).toHaveBeenCalledTimes(2);
    expect(t.submit).toHaveBeenCalledTimes(1);
    await expect(
      t.agent.reReview({
        ticket: {
          ticket_id: "T-1",
          requirement_id: "R-1",
          trace_id: "t",
          span_id: "s",
          parent_span_id: null,
        },
        pr_id: "pr-other",
        merged_since: [],
      }),
    ).rejects.toThrow(/pr-other/);
  });

  it("projectOf：登记过的单返回 project_id（给 7 的 storageRoundSource）", async () => {
    const t = setup({ runs: [done()], reviews: [PASS()] });
    expect(t.agent.projectOf("T-1")).toBeUndefined();
    await t.agent.handle(TICKET);
    expect(t.agent.projectOf("T-1")).toBe("P-1");
  });
});

describe("#40 评审跟进", () => {
  const conflictReq = (over: Partial<ConflictResubmitRequest> = {}): ConflictResubmitRequest => ({
    ticket: {
      ticket_id: "T-1",
      requirement_id: "R-1",
      trace_id: "tr-1",
      span_id: "sp-1",
      parent_span_id: "sp-0",
    },
    round: 1,
    worktree_path: "/wt/T-1-r1",
    branch: "bakacoding/T-1-r1",
    base_commit: "e".repeat(40),
    conflicted_files: ["src/a.ts"],
    previous_pr_id: "pr-T-1-1",
    resubmit_counts: { review: 0, conflict: 1 },
    ...over,
  });

  it("状态归属：冲突复投与重审期间 8 不写任何状态（含上报），只在 handle 里写到 merge_queued", async () => {
    const t = setup({
      config: { ...CFG, pipeline: { resubmit_limits: { review: 1 } } },
      runs: [done(), done(), done()],
      reviews: [PASS(), FAIL(), FAIL(), PASS(), FAIL()],
    });
    await t.agent.handle(TICKET);
    const afterHandle = t.statuses.length;
    expect(t.statuses.at(-1)).toBe("merge_queued");
    // 冲突复投：评审不过 → 复投 → 再不过超限上报，全程不写状态
    expect(await t.agent.resubmitConflict(conflictReq())).toEqual({
      escalated: true,
      pr_id: "pr-T-1-2",
    });
    expect(t.events.some((e) => e.type === "escalated")).toBe(true);
    expect(t.statuses.length).toBe(afterHandle);
  });

  it("重审期间不写状态", async () => {
    const t = setup({ runs: [done()], reviews: [PASS(), PASS()] });
    await t.agent.handle(TICKET);
    const n = t.statuses.length;
    await t.agent.reReview({ ticket: conflictReq().ticket, pr_id: "pr-T-1-1", merged_since: [] });
    expect(t.statuses.length).toBe(n);
  });

  it("改动文件以 6 的 diff 为准：群消息和评审摘要都不用编码池自报的 changed_files", async () => {
    const t = setup({ runs: [done("改好了", ["src/fake.ts"])], reviews: [PASS()] });
    await t.agent.handle(TICKET);
    expect(t.reviewInputs[0]!.summary).toContain("src/a.ts");
    expect(t.reviewInputs[0]!.summary).not.toContain("src/fake.ts");
    const report = t.events.find((e) => e.type === "group_message" && e.payload.kind === "report");
    expect(JSON.stringify(report)).toContain("src/a.ts");
    expect(JSON.stringify(report)).not.toContain("src/fake.ts");
  });

  it.each([
    ["open", "github_manual", /^open_error: GithubError \[422\]: No commits between/],
    ["submit", "github_manual", /^submit_error: Error: 队列满/],
    ["diff", "github_manual", /^diff_error: Error: diff 坏了/],
    ["round_save", "review_limit", /^round_save_error: Error: 写库失败/],
  ] as const)(
    "handle 里 %s 抛未知异常：上报 %s，detail 带错误，不停在 coding",
    async (where, reason, re) => {
      const err = (m: string) =>
        Object.assign(new Error(m), where === "open" ? { name: "GithubError", status: 422 } : {});
      const over: Partial<SubAgentDeps> = {};
      const base = {
        open: async () => "pr-1",
        commitWorktree: async () => "d".repeat(40),
        diff: async () => DIFF,
      };
      if (where === "open")
        over.pr = {
          ...base,
          open: async () => {
            throw err("No commits between bakacoding/integration and b");
          },
        };
      if (where === "diff")
        over.pr = {
          ...base,
          diff: async () => {
            throw err("diff 坏了");
          },
        };
      if (where === "submit")
        over.submit = () => {
          throw err("队列满");
        };
      if (where === "round_save")
        over.rounds = {
          save: () => {
            throw err("写库失败");
          },
        };
      const t = setup({ runs: [done()], reviews: [PASS()], over });
      const out = await t.agent.handle(TICKET);
      expect(out).toMatchObject({ kind: "escalated", reason });
      if (out.kind !== "escalated") throw new Error();
      expect(out.detail).toMatch(re);
      expect(t.statuses.at(-1)).toBe("escalated");
      expect(t.events.find((e) => e.type === "escalated")!.payload).toMatchObject({
        reason,
        detail: out.detail,
      });
    },
  );

  it("编码池抛异常：上报 coder_failed；冲突复投里的异常照常抛给 9", async () => {
    const t = setup({ runs: [] });
    const out = await t.agent.handle(TICKET);
    expect(out).toMatchObject({
      kind: "escalated",
      reason: "coder_failed",
      detail: "coding_error: Error: 编码脚本用完",
    });
    await expect(t.agent.resubmitConflict(conflictReq())).rejects.toThrow("编码脚本用完");
  });

  it("worktree 路径必须在 worktreeRoot 下：handle / resume / resubmitConflict 都拒绝越界路径", async () => {
    const t = setup({ runs: [done()], reviews: [PASS()] });
    await expect(
      t.agent.handle(TICKET, { worktree: { path: "/etc/T-1-r0", branch: "b" } }),
    ).rejects.toThrow(/worktree 根目录/);
    await expect(
      t.agent.handle(TICKET, { worktree: { path: "/wt/../etc/x", branch: "b" } }),
    ).rejects.toThrow(/worktree 根目录/);
    await expect(
      t.agent.handle(TICKET, { worktree: { path: "/wt", branch: "b" } }),
    ).rejects.toThrow(/worktree 根目录/);
    await expect(
      t.agent.resubmitConflict(conflictReq({ worktree_path: "/tmp/T-1-r1" })),
    ).rejects.toThrow(/worktree 根目录/);
    const token: ResumeToken = {
      ticket_id: "T-1",
      worktree_path: "/home/x/T-1-r0",
      branch: "b",
      base_commit: TICKET.base_commit,
      worktree_round: 0,
      pr_id: null,
      resubmit_counts: { review: 0, conflict: 0 },
      phase: "coding",
      is_resubmit: false,
    };
    await expect(t.agent.resume(TICKET, token)).rejects.toThrow(/worktree 根目录/);
    expect(t.deps.coder.runTicket).not.toHaveBeenCalled();
    expect(t.statuses).toEqual([]);
  });

  it("resume 只收 ticket_id：从 loadTicket 补全；补不全就报清楚的错", async () => {
    const token: ResumeToken = {
      ticket_id: "T-1",
      worktree_path: "/wt/T-1-r0",
      branch: "bakacoding/T-1-r0",
      base_commit: TICKET.base_commit,
      worktree_round: 0,
      pr_id: null,
      resubmit_counts: { review: 0, conflict: 0 },
      phase: "coding",
      is_resubmit: false,
    };
    const bare = setup();
    await expect(bare.agent.resume({ ticket_id: "T-1" }, token)).rejects.toThrow(
      /找不到需求单 T-1.*loadTicket/,
    );
    const loadTicket = vi.fn(() => TICKET);
    const t = setup({ runs: [done()], reviews: [PASS()], over: { loadTicket } });
    const out = await t.agent.resume(conflictReq().ticket, token);
    expect(loadTicket).toHaveBeenCalledWith("T-1");
    expect(out.kind).toBe("merge_queued");
    expect(t.runInputs[0]!.prompt).toContain(TICKET.ticket_text);
    expect(t.agent.projectOf("T-1")).toBe("P-1");
  });

  it("冲突复投途中当日预算暂停后续跑：submit 报的是 r1 的基线和轮次，不是 r0；全程不写状态", async () => {
    const resolveBase = vi.fn(() => "f".repeat(40));
    const t = setup({
      runs: [done(), { status: "budget_exceeded", summary: "", changed_files: [] }, done()],
      reviews: [PASS(), PASS()],
      budget: [{ daily_exhausted: true }],
      over: { resolveBase },
    });
    await t.agent.handle(TICKET);
    expect(t.submit).toHaveBeenLastCalledWith(
      expect.objectContaining({ round: 0, base_commit: TICKET.base_commit }),
    );
    const n = t.statuses.length;
    const paused = await t.agent.resubmitConflict(
      conflictReq({ base_commit: "bakacoding/integration" }),
    );
    if (!("requeue_budget" in paused)) throw new Error("应暂停");
    expect(resolveBase).toHaveBeenCalledWith("/wt/T-1-r1");
    expect(paused.resume).toMatchObject({
      mode: "conflict",
      worktree_round: 1,
      base_commit: "f".repeat(40),
    });
    const out = await t.agent.resume({ ticket_id: "T-1" }, paused.resume);
    expect(out.kind).toBe("merge_queued");
    expect(t.submit).toHaveBeenCalledTimes(2);
    expect(t.submit).toHaveBeenLastCalledWith({
      ticket_id: "T-1",
      pr_id: "pr-T-1-2",
      worktree_path: "/wt/T-1-r1",
      round: 1,
      review_resubmits: 0,
      base_commit: "f".repeat(40),
    });
    expect(t.statuses.length).toBe(n); // 冲突复投、续跑都不写状态（9 写 pending / merge_queued）
  });

  it("没注入 resolveBase 时冲突复投用 9 传来的 base_commit", async () => {
    const t = setup({
      runs: [done(), { status: "budget_exceeded", summary: "", changed_files: [] }, done()],
      reviews: [PASS(), PASS()],
      budget: [{ daily_exhausted: true }],
    });
    await t.agent.handle(TICKET);
    const paused = await t.agent.resubmitConflict(conflictReq());
    if (!("requeue_budget" in paused)) throw new Error("应暂停");
    await t.agent.resume(TICKET, paused.resume);
    expect(t.submit).toHaveBeenLastCalledWith(
      expect.objectContaining({ base_commit: "e".repeat(40), round: 1 }),
    );
  });

  it("handle 模式的续跑：submit 报原 worktree 的基线与轮次", async () => {
    const t = setup({
      runs: [{ status: "budget_exceeded", summary: "", changed_files: [] }, done()],
      reviews: [PASS()],
      budget: [{ daily_exhausted: true }],
    });
    const out = await t.agent.handle(TICKET, { worktree: { path: "/wt/T-1-r3", branch: "b3" } });
    if (out.kind !== "requeue_budget") throw new Error();
    await t.agent.resume({ ticket_id: "T-1" }, out.resume);
    expect(t.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        round: 3,
        base_commit: TICKET.base_commit,
        worktree_path: "/wt/T-1-r3",
      }),
    );
  });

  it("评审复投计数跨重启：新 createSubAgent 从 resubmitHistory 恢复，超限照样上报", async () => {
    const t = setup({
      runs: [done()],
      reviews: [FAIL()],
      over: { resubmitHistory: () => ({ review: 3 }) },
    });
    const out = await t.agent.handle(TICKET, {
      worktree: { path: "/wt/T-1-r0", branch: "b" },
      pr_id: "pr-old",
    });
    expect(out).toMatchObject({
      kind: "escalated",
      reason: "review_limit",
      pr_id: "pr-old",
      resubmit_counts: { review: 3, conflict: 0 },
    });
    expect(t.pr.open).not.toHaveBeenCalled();
    expect(t.runInputs[0]!.effort).toBe("high"); // 第 3 次复投的档位
    expect(t.runInputs[0]!.ctx.is_resubmit).toBe(true);
    expect(t.statuses[0]).toBe("resubmitting");
  });

  it("每计一次评审复投恰好发一条 kind=resubmit 的群消息（计数靠它跨重启）", async () => {
    const t = setup({
      runs: [{ status: "gave_up", summary: "a", changed_files: [] }, done(), done()],
      reviews: [FAIL(), PASS()],
      commits: ["ok", "ok"],
    });
    const out = await t.agent.handle(TICKET);
    expect(out).toMatchObject({ resubmit_counts: { review: 2 } });
    expect(t.kinds().filter((k) => k === "resubmit")).toHaveLength(2);
  });
});
