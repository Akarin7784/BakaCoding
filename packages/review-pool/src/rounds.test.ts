// T-034：复投成员记录持久化——从模块 2 的 PR 轮次 reviewer 字段恢复分配。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openStorage, type Storage } from "@bakacoding/storage";
import type { CallCtx, Diff, ReviewResult } from "@bakacoding/types";
import {
  createReviewPool,
  createRoundAssignmentStore,
  storageRoundSource,
  SUPERVISOR_MEMBER_ID,
  type AssignmentStore,
  type ModelCall,
  type ReviewInput,
  type ReviewPoolConfig,
} from "./index.js";

const PASS = JSON.stringify({ verdict: "pass", reasons: [] });
const FAIL = JSON.stringify({
  verdict: "fail",
  reasons: [{ category: "bug", detail: "补上空值判断" }],
});
const DIFF: Diff = { base_sha: "a".repeat(40), head_sha: "b".repeat(40), files: [] };

function cfg(memberIds: string[] = ["reviewer-1", "reviewer-2"]): ReviewPoolConfig {
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
    backpressure: { reviews_per_member: 2 },
  };
}

function input(ticket_id: string, is_resubmit: boolean): ReviewInput {
  const ctx: CallCtx = {
    role: "sub_agent",
    requirement_id: "R-1",
    ticket_id,
    is_resubmit,
    trace: { trace_id: "tr", span_id: `sp-${ticket_id}`, parent_span_id: null },
  };
  return {
    ticket: { ticket_id, ticket_text: "加一个常量" },
    pr_id: `pr-${ticket_id}`,
    permission_list: [{ glob: "src/**", level: "rw" }],
    summary: "摘要",
    ctx,
  };
}

function pool(opts: {
  assignments: AssignmentStore;
  config?: ReviewPoolConfig;
  limited?: Set<string>;
  outputs?: string[];
  failedCi?: boolean;
}) {
  const used: string[] = [];
  const outputs = [...(opts.outputs ?? [])];
  const call: ModelCall = vi.fn(async (_role, _provider, model) => {
    used.push(model.replace(/-model$/, ""));
    return { output: outputs.shift() ?? PASS };
  });
  const p = createReviewPool({
    getConfig: () => opts.config ?? cfg(),
    call,
    pr: {
      diff: async () => DIFF,
      checks: async () =>
        opts.failedCi
          ? [{ name: "ci", status: "completed", conclusion: "failure", url: null }]
          : [],
    } as never,
    promptTemplate: () => "评审 {{input}}",
    publish: () => {},
    isRateLimited: ({ model }) => opts.limited?.has(model) ?? false,
    assignments: opts.assignments,
    pollIntervalMs: 5,
  });
  return { pool: p, used };
}

let dirs: string[] = [];
let opened: Storage[] = [];
afterEach(() => {
  for (const s of opened) s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  opened = [];
});
function dbPath(): string {
  const d = mkdtempSync(join(tmpdir(), "bc-review-t034-"));
  dirs.push(d);
  return join(d, "bakacoding.db");
}
function open(path: string): Storage {
  const s = openStorage({ path });
  opened.push(s);
  return s;
}
function closeAll() {
  for (const s of opened) s.close();
  opened = [];
}
const ticketRow = (ticket_id: string) => ({
  ticket_id,
  project_id: "P-1",
  requirement_id: "R-1",
  created_at: "2026-10-17T08:00:00.000Z",
  ticket_text: "加一个常量",
  base_commit: "abc1234",
  permission_list: [{ glob: "src/**", level: "rw" as const }],
  context_snippets: [],
});
/** 模拟 8：把评审结果写成一轮 PR 记录（reviewer 原样带上）。 */
function saveRound(s: Storage, ticket_id: string, round: number, r: ReviewResult) {
  s.savePrRecord({
    ticket_id,
    round,
    diff: DIFF,
    verdict: r.verdict,
    fail_reasons: r.reasons.map((x) => x.detail),
    reviewer: r.reviewer,
  });
}
const storeOn = (s: Storage) =>
  createRoundAssignmentStore({ rounds: storageRoundSource(s, () => "P-1") });

describe("复投成员记录持久化（T-034）", () => {
  it("重启后复投的单仍交给原成员（读 2 的 PR 轮次 reviewer）", async () => {
    const path = dbPath();
    let s = open(path);
    s.saveTicket(ticketRow("T-1"));
    // 第 1 轮：reviewer-1 被限流，分给 reviewer-2
    const a = pool({
      assignments: storeOn(s),
      limited: new Set(["reviewer-1-model"]),
      outputs: [FAIL],
    });
    const r1 = await a.pool.review(input("T-1", false));
    expect(r1.reviewer).toBe("reviewer-2");
    saveRound(s, "T-1", 1, r1);

    // 重启：新进程、新池、重新打开库；按负载本该给 reviewer-1，粘性要求交回 reviewer-2
    closeAll();
    s = open(path);
    const b = pool({ assignments: storeOn(s) });
    const r2 = await b.pool.review(input("T-1", true));
    expect(b.used).toEqual(["reviewer-2"]);
    expect(r2.reviewer).toBe("reviewer-2");
  });

  it("CI 失败那轮 reviewer 为 null：跳过，沿用更早一轮的成员", async () => {
    const s = open(dbPath());
    s.saveTicket(ticketRow("T-2"));
    saveRound(s, "T-2", 1, {
      verdict: "fail",
      reasons: [{ category: "bug", detail: "x" }],
      reviewer: "reviewer-2",
    });
    // 第 2 轮 CI 失败：7 不调模型，reviewer 为 null
    const ci = pool({ assignments: storeOn(s), failedCi: true });
    const r2 = await ci.pool.review(input("T-2", true));
    expect(r2.reviewer).toBeNull();
    expect(ci.used).toEqual([]);
    saveRound(s, "T-2", 2, r2);

    const b = pool({ assignments: storeOn(s) });
    await b.pool.review(input("T-2", true));
    expect(b.used).toEqual(["reviewer-2"]);
  });

  it('"supervisor"：仍没有成员就交回主管；后来配了成员就按负载换人', async () => {
    const s = open(dbPath());
    s.saveTicket(ticketRow("T-3"));
    const solo = pool({ assignments: storeOn(s), config: cfg([]) });
    const r1 = await solo.pool.review(input("T-3", false));
    expect(r1.reviewer).toBe(SUPERVISOR_MEMBER_ID);
    saveRound(s, "T-3", 1, r1);

    const again = pool({ assignments: storeOn(s), config: cfg([]) });
    expect((await again.pool.review(input("T-3", true))).reviewer).toBe(SUPERVISOR_MEMBER_ID);
    expect(again.used).toEqual(["boss"]);

    const withBoard = pool({ assignments: storeOn(s) });
    expect((await withBoard.pool.review(input("T-3", true))).reviewer).toBe("reviewer-1");
  });

  it("原成员已不在配置里或被限流：换人（同内存实现）", async () => {
    const s = open(dbPath());
    s.saveTicket(ticketRow("T-4"));
    saveRound(s, "T-4", 1, {
      verdict: "fail",
      reasons: [{ category: "bug", detail: "x" }],
      reviewer: "reviewer-9",
    });
    const b = pool({ assignments: storeOn(s) });
    await b.pool.review(input("T-4", true));
    expect(b.used).toEqual(["reviewer-1"]);
  });

  it("本进程刚评审完、8 还没写轮次：用内存里的值；没有轮次记录、查不到项目都退回按负载分配", async () => {
    const rounds = vi.fn(async () => [] as { round: number; reviewer?: string | null }[]);
    const store = createRoundAssignmentStore({ rounds });
    await store.set("T-5", "reviewer-2");
    expect(await store.get("T-5")).toBe("reviewer-2");
    expect(await store.get("T-6")).toBeUndefined();
    expect(rounds).toHaveBeenCalledTimes(1);

    const s = open(dbPath());
    const noProject = createRoundAssignmentStore({
      rounds: storageRoundSource(s, () => undefined),
    });
    expect(await noProject.get("T-7")).toBeUndefined();
  });

  it("按轮次取最新：顺序乱也取轮次最大的非空 reviewer", async () => {
    const store = createRoundAssignmentStore({
      rounds: () => [
        { round: 3, reviewer: null },
        { round: 1, reviewer: "reviewer-1" },
        { round: 2, reviewer: "reviewer-2" },
        { round: 4 },
      ],
    });
    expect(await store.get("T-8")).toBe("reviewer-2");
  });

  it("读轮次出错：记 warn，退回按负载分配，不让评审失败", async () => {
    const warn = vi.fn();
    const store = createRoundAssignmentStore({
      rounds: () => {
        throw new Error("库被锁");
      },
      logger: { warn },
    });
    const b = pool({ assignments: store });
    const r = await b.pool.review(input("T-9", true));
    expect(r.reviewer).toBe("reviewer-1");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("库被锁"));
  });
});
