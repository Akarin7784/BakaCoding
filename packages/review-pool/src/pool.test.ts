import { describe, expect, it, vi } from "vitest";
import { ReviewResultSchema, type CallCtx, type Diff } from "@bakacoding/types";
import {
  createReviewPool,
  InMemoryAssignmentStore,
  parseModelOutput,
  SUPERVISOR_MEMBER_ID,
  UNPARSEABLE_DETAIL,
  type ModelCall,
  type ReviewBacklogInput,
  type ReviewInput,
  type ReviewPoolConfig,
  type ReviewPoolDeps,
} from "./index.js";
import type { CheckResult } from "@bakacoding/pr";

const PASS = JSON.stringify({ verdict: "pass", reasons: [] });
const FAIL = JSON.stringify({
  verdict: "fail",
  reasons: [{ category: "out_of_scope", detail: "改了 b.ts", file: "b.ts", line: 3 }],
});

const DIFF: Diff = {
  base_sha: "a".repeat(40),
  head_sha: "b".repeat(40),
  files: [{ path: "a.ts", status: "modified", additions: 1, deletions: 0, patch: "+const x = 1;" }],
};

function cfg(memberIds = ["reviewer-1", "reviewer-2"], perMember = 2): ReviewPoolConfig {
  return {
    roles: {
      supervisor: { provider: "deepseek", model: "boss-model" },
      review_board: {
        members: memberIds.map((id) => ({
          id,
          provider: "deepseek",
          model: `${id}-model`,
          effort: "high" as const,
        })),
        review_assignment: "least_busy",
        sticky_on_resubmit: true,
        skip_rate_limited: true,
      },
    },
    backpressure: { reviews_per_member: perMember },
  };
}

function ctx(ticket_id: string, is_resubmit = false): CallCtx {
  return {
    role: "sub_agent",
    requirement_id: "R-1",
    ticket_id,
    is_resubmit,
    trace: { trace_id: "tr", span_id: `sp-${ticket_id}`, parent_span_id: null },
  };
}

function input(ticket_id: string, is_resubmit = false): ReviewInput {
  return {
    ticket: {
      ticket_id,
      ticket_text: `${ticket_id} 需求原文：加一个常量`,
      architecture_constraints: ["不得引入新依赖"],
    },
    pr_id: `pr-${ticket_id}`,
    permission_list: [{ glob: "a.ts", level: "rw" }],
    summary: `${ticket_id} 精简摘要`,
    ctx: ctx(ticket_id, is_resubmit),
  };
}

/** 可控的模型：每次调用返回一个可手动 resolve 的 promise，或按队列给固定输出。 */
function setup(over: Partial<ReviewPoolDeps> & { outputs?: string[]; manual?: boolean } = {}) {
  const events: ReviewBacklogInput[] = [];
  const outputs = [...(over.outputs ?? [])];
  const calls: { member: string; effort: string; role: string; ctx: CallCtx; prompt: string }[] =
    [];
  const gates: ((o: string) => void)[] = [];
  let config = cfg();
  let checks: CheckResult[] = [];
  const call: ModelCall = vi.fn(async (role, provider, model, effort, prompt, c) => {
    calls.push({ member: model.replace(/-model$/, ""), effort, role: c.role, ctx: c, prompt });
    void provider;
    void role;
    if (over.manual) return { output: await new Promise<string>((r) => gates.push(r)) };
    return { output: outputs.shift() ?? PASS };
  });
  const pr = {
    diff: vi.fn(async () => DIFF),
    checks: vi.fn(async () => checks),
  };
  const deps: ReviewPoolDeps = {
    getConfig: () => config,
    call,
    pr,
    promptTemplate: () => "你是评审成员。{{input}}",
    publish: (e) => {
      events.push(e);
    },
    pollIntervalMs: 5,
    ...over,
  };
  const pool = createReviewPool(deps);
  return {
    pool,
    events,
    calls,
    gates,
    pr,
    call,
    setConfig: (c: ReviewPoolConfig) => (config = c),
    setChecks: (c: CheckResult[]) => (checks = c),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(cond: () => boolean) {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 2));
  expect(cond()).toBe(true);
}

describe("review：输入与结论", () => {
  it("diff + 需求单 + 精简摘要 + 权限清单进提示词；用成员的 provider/model/effort，ctx.role 改为 reviewer", async () => {
    const t = setup({ outputs: [FAIL] });
    const r = await t.pool.review(input("T-1"));
    expect(r).toEqual({
      verdict: "fail",
      reasons: [{ category: "out_of_scope", detail: "改了 b.ts", file: "b.ts", line: 3 }],
      reviewer: "reviewer-1",
    });
    expect(t.pr.diff).toHaveBeenCalledWith("pr-T-1");
    const c = t.calls[0]!;
    expect(c.member).toBe("reviewer-1");
    expect(c.effort).toBe("high");
    expect(c.role).toBe("reviewer");
    expect(c.ctx).toMatchObject({ requirement_id: "R-1", ticket_id: "T-1", is_resubmit: false });
    expect(c.prompt.startsWith("你是评审成员。")).toBe(true);
    for (const s of [
      "T-1 需求原文",
      "T-1 精简摘要",
      "+const x = 1;",
      '"glob":"a.ts"',
      "不得引入新依赖",
    ])
      expect(c.prompt).toContain(s);
    expect(c.prompt).not.toContain("{{input}}");
    expect((t.call as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe("reviewer");
  });

  it("模板没有 {{input}} 时把输入接在后面", async () => {
    const t = setup({ promptTemplate: () => "TEMPLATE" });
    await t.pool.review(input("T-2"));
    expect(t.calls[0]!.prompt).toMatch(/^TEMPLATE\n\n## 需求单/);
  });
});

describe("7-3 CI", () => {
  it("有失败的 check：直接判 ci_failed，不读 diff、不调模型", async () => {
    const t = setup();
    t.setChecks([
      { name: "build", status: "completed", conclusion: "failure", url: "https://ci/1" },
      { name: "lint", status: "completed", conclusion: "timed_out" },
      { name: "e2e", status: "completed", conclusion: "success" },
    ]);
    const r = await t.pool.review(input("T-3"));
    expect(r).toEqual({
      verdict: "fail",
      reasons: [
        {
          category: "ci_failed",
          detail: "CI 检查 build 结果为 failure，请按日志修复后重新提交：https://ci/1",
        },
        { category: "ci_failed", detail: "CI 检查 lint 结果为 timed_out，请按日志修复后重新提交" },
      ],
      reviewer: null,
    });
    expect(t.call).not.toHaveBeenCalled();
    expect(t.pr.diff).not.toHaveBeenCalled();
  });
  it("check 还在跑、或没配 CI：不等，照常让模型评审", async () => {
    const t = setup();
    t.setChecks([{ name: "build", status: "in_progress", conclusion: null }]);
    expect((await t.pool.review(input("T-4"))).verdict).toBe("pass");
    t.setChecks([]);
    expect((await t.pool.review(input("T-5"))).verdict).toBe("pass");
    expect(t.call).toHaveBeenCalledTimes(2);
  });
});

describe("7-2 成员数为 0：主管兼任", () => {
  it("用 roles.supervisor 的 provider/model，effort 固定 max，role 记 reviewer；容量按 1 个成员算", async () => {
    const t = setup();
    t.setConfig(cfg([], 2));
    await t.pool.review(input("T-6"));
    const c = t.calls[0]!;
    expect(c.member).toBe("boss");
    expect(c.effort).toBe("max");
    expect(c.role).toBe("reviewer");
    expect(t.pool.backlog()).toEqual({ pending: 0, capacity: 2 });
    expect(SUPERVISOR_MEMBER_ID).toBe("supervisor");
  });
});

describe("分配", () => {
  it("least_busy：并发评审分给不同成员；满了排队，有成员空出来再派", async () => {
    const t = setup({ manual: true });
    t.setConfig(cfg(["reviewer-1", "reviewer-2"], 1));
    const p1 = t.pool.review(input("T-7"));
    const p2 = t.pool.review(input("T-8"));
    const p3 = t.pool.review(input("T-9"));
    await until(() => t.calls.length === 2);
    expect(t.calls.map((c) => c.member)).toEqual(["reviewer-1", "reviewer-2"]);
    expect(t.pool.backlog()).toEqual({ pending: 3, capacity: 2 });
    await tick();
    expect(t.calls).toHaveLength(2);
    t.gates[1]!(PASS);
    await until(() => t.calls.length === 3);
    expect(t.calls[2]!.member).toBe("reviewer-2");
    t.gates[0]!(PASS);
    t.gates[2]!(PASS);
    await Promise.all([p1, p2, p3]);
    expect(t.pool.backlog()).toEqual({ pending: 0, capacity: 2 });
  });

  it("7-5 复投交给上一轮的成员（即使别人更空）", async () => {
    const t = setup({ manual: true });
    const hold = t.pool.review(input("T-Z"));
    await until(() => t.calls.length === 1);
    const a = t.pool.review(input("T-A"));
    await until(() => t.calls.length === 2);
    expect(t.calls[1]!.member).toBe("reviewer-2");
    t.gates[0]!(PASS);
    t.gates[1]!(FAIL);
    await Promise.all([hold, a]);
    const again = t.pool.review(input("T-A", true));
    await until(() => t.calls.length === 3);
    expect(t.calls[2]!.member).toBe("reviewer-2");
    t.gates[2]!(PASS);
    await again;
  });

  it("上一轮成员被限流或已不在配置里：换人，并记住新成员", async () => {
    const limited = new Set<string>();
    const store = new InMemoryAssignmentStore();
    store.set("T-B", "reviewer-2");
    const t = setup({
      assignments: store,
      isRateLimited: ({ model }) => limited.has(model),
    });
    limited.add("reviewer-2-model");
    await t.pool.review(input("T-B", true));
    expect(t.calls[0]!.member).toBe("reviewer-1");
    expect(store.get("T-B")).toBe("reviewer-1");

    store.set("T-C", "reviewer-9");
    await t.pool.review(input("T-C", true));
    expect(t.calls[1]!.member).toBe("reviewer-1");
  });

  it("sticky_on_resubmit 关掉时复投按负载分配", async () => {
    const store = new InMemoryAssignmentStore();
    store.set("T-D", "reviewer-2");
    const t = setup({ assignments: store });
    const c = cfg();
    c.roles.review_board.sticky_on_resubmit = false;
    t.setConfig(c);
    await t.pool.review(input("T-D", true));
    expect(t.calls[0]!.member).toBe("reviewer-1");
  });

  it("被限流的成员跳过；全部被限流时排队，恢复后继续（不交给主管）", async () => {
    const limited = new Set(["reviewer-1-model"]);
    const t = setup({ isRateLimited: ({ model }) => limited.has(model) });
    await t.pool.review(input("T-E"));
    expect(t.calls[0]!.member).toBe("reviewer-2");

    limited.add("reviewer-2-model");
    const p = t.pool.review(input("T-F"));
    await new Promise((r) => setTimeout(r, 20));
    expect(t.calls).toHaveLength(1);
    expect(t.pool.backlog().pending).toBe(1);
    limited.delete("reviewer-1-model");
    await p;
    expect(t.calls[1]!.member).toBe("reviewer-1");
  });

  it("skip_rate_limited 关掉时不看限流", async () => {
    const t = setup({ isRateLimited: () => true });
    const c = cfg();
    c.roles.review_board.skip_rate_limited = false;
    t.setConfig(c);
    await t.pool.review(input("T-G"));
    expect(t.calls[0]!.member).toBe("reviewer-1");
  });
});

describe("7-6 输出解析不了", () => {
  it("换一个成员重试一次，成功就用它的结论", async () => {
    const t = setup({ outputs: ["我觉得挺好", FAIL] });
    const r = await t.pool.review(input("T-H"));
    expect(r.verdict).toBe("fail");
    expect(r.reviewer).toBe("reviewer-2");
    expect(t.calls.map((c) => c.member)).toEqual(["reviewer-1", "reviewer-2"]);
  });
  it("两次都解析不了：判 fail，理由 bug「评审输出无法解析」", async () => {
    const t = setup({ outputs: ["{bad", '{"verdict":"fail","reasons":[]}'] });
    const r = await t.pool.review(input("T-I"));
    expect(r).toEqual({
      verdict: "fail",
      reasons: [{ category: "bug", detail: UNPARSEABLE_DETAIL }],
      reviewer: "reviewer-2",
    });
    expect(t.pool.backlog().pending).toBe(0);
  });
  it("只有一个成员时同一个再试一次", async () => {
    const t = setup({ outputs: ["x", PASS] });
    t.setConfig(cfg(["solo"]));
    expect((await t.pool.review(input("T-J"))).verdict).toBe("pass");
    expect(t.calls.map((c) => c.member)).toEqual(["solo", "solo"]);
  });
  it("parseModelOutput：接受代码块包裹；拒绝 ci_failed 类别和多余字段", () => {
    expect(parseModelOutput("结论如下：\n```json\n" + PASS + "\n```")).toEqual({
      verdict: "pass",
      reasons: [],
    });
    expect(
      parseModelOutput(
        JSON.stringify({ verdict: "fail", reasons: [{ category: "ci_failed", detail: "x" }] }),
      ),
    ).toBeUndefined();
    expect(
      parseModelOutput(JSON.stringify({ verdict: "pass", reasons: [], extra: 1 })),
    ).toBeUndefined();
    expect(parseModelOutput("no json")).toBeUndefined();
  });
});

describe("7-7 review_backlog", () => {
  it("排队数或容量变化时发，公共字段取自 ctx，不重复发相同值", async () => {
    const t = setup({ manual: true });
    const p1 = t.pool.review(input("T-K"));
    const p2 = t.pool.review(input("T-L"));
    await until(() => t.calls.length === 2);
    expect(t.events.map((e) => e.payload)).toEqual([
      { pending: 1, capacity: 4 },
      { pending: 2, capacity: 4 },
    ]);
    expect(t.events[0]).toMatchObject({
      type: "review_backlog",
      requirement_id: "R-1",
      ticket_id: "T-K",
      trace_id: "tr",
      span_id: "sp-T-K",
      parent_span_id: null,
    });
    // 容量变化（成员减到 1 个）也会体现在下一次事件里
    t.setConfig(cfg(["reviewer-1"], 2));
    t.gates[0]!(PASS);
    await p1;
    t.gates[1]!(PASS);
    await p2;
    expect(t.events.map((e) => e.payload)).toEqual([
      { pending: 1, capacity: 4 },
      { pending: 2, capacity: 4 },
      { pending: 1, capacity: 2 },
      { pending: 0, capacity: 2 },
    ]);
  });
  it("CI 直接判不过的单也计入积压并回落", async () => {
    const t = setup();
    t.setChecks([{ name: "b", status: "completed", conclusion: "failure" }]);
    await t.pool.review(input("T-M"));
    expect(t.events.map((e) => e.payload.pending)).toEqual([1, 0]);
  });
  it("发布失败只记 warn，不影响评审结论", async () => {
    const warn = vi.fn();
    const t = setup({
      publish: () => {
        throw new Error("bus down");
      },
      logger: { warn },
    });
    expect((await t.pool.review(input("T-N"))).verdict).toBe("pass");
    expect(warn).toHaveBeenCalled();
  });
  it("模型调用抛错：错误向上抛，槽位和积压都释放", async () => {
    const t = setup({
      call: async () => {
        throw new Error("boom");
      },
    });
    await expect(t.pool.review(input("T-O"))).rejects.toThrow("boom");
    expect(t.pool.backlog().pending).toBe(0);
    t.setConfig(cfg(["reviewer-1"], 1));
    await expect(t.pool.review(input("T-P"))).rejects.toThrow("boom");
  });
});

describe("@bakacoding/types ReviewResultSchema", () => {
  it("fail 至少一条原因；category 取五类", () => {
    const base = { reviewer: "reviewer-1" };
    expect(ReviewResultSchema.safeParse({ verdict: "pass", reasons: [], ...base }).success).toBe(
      true,
    );
    expect(ReviewResultSchema.safeParse({ verdict: "fail", reasons: [], ...base }).success).toBe(
      false,
    );
    expect(ReviewResultSchema.safeParse({ verdict: "pass", reasons: [] }).success).toBe(false);
    expect(
      ReviewResultSchema.safeParse({ verdict: "pass", reasons: [], reviewer: null }).success,
    ).toBe(true);
    expect(
      ReviewResultSchema.safeParse({
        verdict: "fail",
        reasons: [{ category: "ci_failed", detail: "x" }],
        reviewer: null,
      }).success,
    ).toBe(true);
    expect(
      ReviewResultSchema.safeParse({
        verdict: "fail",
        reasons: [{ category: "style", detail: "x" }],
        reviewer: null,
      }).success,
    ).toBe(false);
  });
});
