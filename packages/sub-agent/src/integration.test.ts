// 用真实的 4（worktree + 文件工具）、5（编码池）、6（本地 PR）、7（评审池）、2（SQLite 存储）跑通 8；
// 只把模块 1（模型调用）和模块 9（submit）换成替身。
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCoderPool, type ChatRequest, type ChatResponse } from "@bakacoding/coder-pool";
import { LocalPrProvider, type PrRecord } from "@bakacoding/pr";
import {
  createReviewPool,
  createRoundAssignmentStore,
  storageRoundSource,
  type ModelCall,
} from "@bakacoding/review-pool";
import { openStorage, type Storage } from "@bakacoding/storage";
import type { BakaEvent, TicketStatus } from "@bakacoding/types";
import { randomUUID } from "node:crypto";
import { WorktreeManager } from "@bakacoding/workspace";
import {
  createSubAgent,
  eventLogResubmitHistory,
  type SubAgent,
  type SubAgentDeps,
  type SubAgentPublish,
  type SubAgentTicket,
  type StoredPrRecord,
} from "./index.js";

const run = promisify(execFile);
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const git = async (cwd: string, ...args: string[]) =>
  (await run("git", args, { cwd, env: ENV })).stdout.trim();

const FAIL = JSON.stringify({
  verdict: "fail",
  reasons: [{ category: "incomplete", detail: "b.ts 还要导出 TWO", file: "src/b.ts" }],
});
const PASS = JSON.stringify({ verdict: "pass", reasons: [] });

let root: string;
let repo: string;
let storage: Storage;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bc-subagent-"));
  repo = join(root, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await git(repo, "init", "-q", "-b", "main");
  await writeFile(join(repo, "src", "a.ts"), "export const ONE = 1;\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "init");
  storage = openStorage({ path: join(root, "db.sqlite") });
});
afterEach(async () => {
  storage.close();
  await rm(root, { recursive: true, force: true });
});

/** 总线替身：直接落 2 的事件日志（seq / event_id / ts 由这里补）。 */
function ingest(e: Parameters<SubAgentPublish>[0]): void {
  storage.ingest({
    ...e,
    seq: storage.nextSeq(),
    event_id: randomUUID(),
    ts: new Date().toISOString(),
  } as BakaEvent);
}

describe("8 接真实的 4/5/6/7/2（模型和 9 用替身）", () => {
  it("评审不过一次后通过：worktree 里真提交、轮次和 reviewer 落库、7 重启后从轮次记录找回原成员", async () => {
    const base = await git(repo, "rev-parse", "HEAD");
    const ticket: SubAgentTicket = {
      ticket_id: "T-1",
      project_id: "P-1",
      requirement_id: "R-1",
      trace_id: "tr-1",
      span_id: "sp-1",
      parent_span_id: null,
      ticket_text: "新建 src/b.ts，导出 TWO = 2",
      base_commit: base,
      permission_list: [{ glob: "src/**", level: "rw" }],
    };
    storage.saveTicket({
      ticket_id: ticket.ticket_id,
      project_id: ticket.project_id,
      requirement_id: ticket.requirement_id,
      created_at: "2026-10-17T08:00:00Z",
      ticket_text: ticket.ticket_text,
      base_commit: base,
      permission_list: ticket.permission_list,
      context_snippets: [],
    });

    // 模块 1 替身：第一次只写一个半成品，第二次写完整
    const contents = ["export const TWO = 0;\n", "export const TWO = 2;\n"];
    const chatRequests: ChatRequest[] = [];
    let step = 0;
    const chat = vi.fn(async (req: ChatRequest): Promise<ChatResponse> => {
      chatRequests.push(structuredClone(req) as ChatRequest);
      const phase = step++ % 3;
      // 先读后写（4 要求改已有文件前先 read；第一轮文件还不存在，read 报错也照样继续）
      if (phase === 0)
        return {
          content: "",
          tool_calls: [{ id: `r${step}`, name: "read", input: { file_path: "src/b.ts" } }],
        };
      if (phase === 1) {
        return {
          content: "",
          tool_calls: [
            {
              id: `w${step}`,
              name: "write",
              input: { file_path: "src/b.ts", content: contents.shift()! },
            },
          ],
        };
      }
      return {
        content: '```json\n{"status":"done","summary":"写了 src/b.ts"}\n```',
        tool_calls: [],
      };
    });
    const coder = createCoderPool({
      getConfig: () => ({
        roles: { coder: { provider: "deepseek", model: "deepseek-flash" } },
        pipeline: { max_turns: 10 },
      }),
      chat,
      promptTemplate: () => "你是 Flash 编码代理。",
      architectureConstraints: () => ["不加依赖"],
    });

    const store = storage.prStore<PrRecord>();
    const pr = new LocalPrProvider({ store, repo, author: { name: "t", email: "t@t" } });

    const reviewOutputs = [FAIL, PASS];
    const reviewCalls: { model: string; is_resubmit: boolean }[] = [];
    const call: ModelCall = vi.fn(async (_role, _provider, model, _effort, _prompt, ctx) => {
      reviewCalls.push({ model, is_resubmit: ctx.is_resubmit });
      return { output: reviewOutputs.shift()! };
    });
    const reviewCfg = {
      roles: {
        supervisor: { provider: "deepseek", model: "boss" },
        review_board: {
          members: ["reviewer-1", "reviewer-2"].map((id) => ({
            id,
            provider: "deepseek",
            model: id,
            effort: "high" as const,
          })),
          review_assignment: "least_busy" as const,
          sticky_on_resubmit: true,
          skip_rate_limited: true,
        },
      },
      backpressure: { reviews_per_member: 2 },
    };
    // 7 的复投成员从 2 的轮次记录恢复；projectOf 取 8 登记的需求单 project_id（T-011 listPrRounds 合入前）
    const holder: { agent?: SubAgent } = {};
    const projectOf = (id: string) => holder.agent?.projectOf(id);
    const pool = createReviewPool({
      getConfig: () => reviewCfg,
      call,
      pr,
      promptTemplate: () => "你是评审。",
      publish: () => undefined,
      assignments: createRoundAssignmentStore({ rounds: storageRoundSource(storage, projectOf) }),
    });

    const mgr = await WorktreeManager.open(repo);
    const statuses: TicketStatus[] = [];
    const submit = vi.fn();
    const events: unknown[] = [];
    const agent = createSubAgent({
      getConfig: () => ({
        roles: { coder: { effort: "low", resubmit_effort: ["high", "high", "max"] } },
        pipeline: { resubmit_limits: { review: 3 } },
      }),
      coder,
      review: (i) => pool.review(i),
      pr,
      budgetState: () => ({ daily_exhausted: false }),
      rounds: {
        save: (r) => storage.savePrRecord(r),
        list: (id) => storage.query({ project_id: "P-1", ticket_id: id })[0]?.rounds ?? [],
      },
      tickets: { setStatus: (_id, s) => void statuses.push(s) },
      resubmitHistory: eventLogResubmitHistory(storage),
      worktreeRoot: join(repo, ".bakacoding", "worktrees"),
      worktrees: { create: (id, b, n) => mgr.createWorktree(id, b, n) },
      submit,
      publish: (e) => {
        events.push(e);
        ingest(e);
      },
    });
    holder.agent = agent;

    const out = await agent.handle(ticket);
    expect(out).toMatchObject({
      kind: "merge_queued",
      round: 2,
      resubmit_counts: { review: 1, conflict: 0 },
    });
    if (out.kind !== "merge_queued") throw new Error();

    // 4 建的 r0 worktree 里有两次真提交，文件是第二轮的内容
    const wt = join(repo, ".bakacoding", "worktrees", "T-1-r0");
    expect(await readFile(join(wt, "src", "b.ts"), "utf8")).toBe("export const TWO = 2;\n");
    expect(await git(wt, "rev-list", "--count", `${base}..HEAD`)).toBe("2");
    expect(await git(wt, "status", "--porcelain")).toBe("");

    // 5 收到的 effort 与 feedback
    expect(chatRequests[0]!.effort).toBe("low");
    expect(chatRequests[3]!.effort).toBe("high");
    expect(JSON.stringify(chatRequests[3]!.messages)).toContain("b.ts 还要导出 TWO");

    // 同一成员评审两轮（复投粘性）
    expect(reviewCalls).toHaveLength(2);
    expect(reviewCalls[1]!.model).toBe(reviewCalls[0]!.model);
    expect(reviewCalls[1]!.is_resubmit).toBe(true);

    // 2 里的轮次记录：两轮，reviewer 原样，diff 来自 6
    const rec = storage.query({ project_id: "P-1", ticket_id: "T-1" })[0]!;
    expect(rec.rounds.map((r) => [r.round, r.verdict, r.reviewer])).toEqual([
      [1, "fail", reviewCalls[0]!.model],
      [2, "pass", reviewCalls[0]!.model],
    ]);
    expect(rec.rounds[1]!.diff.files.map((f) => f.path)).toEqual(["src/b.ts"]);

    // 6 的 PR 记录只有一条（复投复用同一 pr_id）
    const prs = (await store.list()).filter((r) => r.kind === "ticket");
    expect(prs.map((r) => r.pr_id)).toEqual([out.pr_id]);

    // 「重启」后新建的 7 记录从 2 的轮次里找回原成员
    const fresh = createRoundAssignmentStore({ rounds: storageRoundSource(storage, projectOf) });
    expect(await fresh.get("T-1")).toBe(reviewCalls[0]!.model);

    expect(statuses).toEqual(["coding", "in_review", "resubmitting", "in_review", "merge_queued"]);
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        ticket_id: "T-1",
        pr_id: out.pr_id,
        worktree_path: wt,
        base_commit: base,
      }),
    );
    expect(events.length).toBeGreaterThan(0);
  });
});

describe("评审复投计数跨重启（2 的事件日志）", () => {
  it("进程重启后新建的 8 从事件日志恢复计数，再失败一次就超限上报，不会无限复投", async () => {
    const root = join(repo, ".bakacoding", "worktrees");
    const wt = join(root, "T-2-r0");
    const ticket: SubAgentTicket = {
      ticket_id: "T-2",
      project_id: "P-1",
      requirement_id: "R-1",
      trace_id: "tr-2",
      span_id: "sp-2",
      parent_span_id: null,
      ticket_text: "随便改点什么",
      base_commit: "c".repeat(40),
      permission_list: [{ glob: "src/**", level: "rw" }],
    };
    const gaveUp = { status: "gave_up" as const, summary: "做不完", changed_files: [] };
    const make = (runTicket: SubAgentDeps["coder"]["runTicket"]) => {
      const statuses: TicketStatus[] = [];
      const agent = createSubAgent({
        getConfig: () => ({
          roles: { coder: { effort: "low", resubmit_effort: ["low", "high", "high"] } },
          pipeline: { resubmit_limits: { review: 2 } },
        }),
        coder: { runTicket },
        review: async () => ({ verdict: "pass", reasons: [], reviewer: "reviewer-1" }),
        pr: {
          open: async () => "pr-T-2",
          commitWorktree: async () => "d".repeat(40),
          diff: async () => ({ base_sha: "a".repeat(40), head_sha: "b".repeat(40), files: [] }),
        },
        budgetState: () => ({ daily_exhausted: false }),
        rounds: { save: (r) => storage.savePrRecord(r) },
        tickets: { setStatus: (_id, s) => void statuses.push(s) },
        resubmitHistory: eventLogResubmitHistory(storage),
        worktreeRoot: root,
        submit: vi.fn(),
        publish: ingest,
      });
      return { agent, statuses };
    };

    // 第一次进程：gave_up 两次（计 2 次复投），第三次编码时进程「挂掉」（runTicket 永不返回）
    let calls = 0;
    const first = make(() =>
      ++calls <= 2 ? Promise.resolve(gaveUp) : new Promise(() => undefined),
    );
    void first.agent.handle(ticket, { worktree: { path: wt, branch: "bakacoding/T-2-r0" } });
    await vi.waitFor(() => expect(calls).toBe(3));
    expect(eventLogResubmitHistory(storage)("T-2")).toEqual({ review: 2 });

    // 重启：新的 8，同一个存储
    const runs: string[] = [];
    const second = make(async (input) => {
      runs.push(input.effort);
      return gaveUp;
    });
    const out = await second.agent.handle(ticket, {
      worktree: { path: wt, branch: "bakacoding/T-2-r0" },
    });
    expect(out).toMatchObject({
      kind: "escalated",
      reason: "coder_failed",
      detail: "gave_up",
      resubmit_counts: { review: 2, conflict: 0 },
    });
    expect(runs).toEqual(["high"]); // 重启后只再跑一次，档位按第 2 次复投
    expect(second.statuses).toEqual(["resubmitting", "escalated"]);
    const escalated = storage.queryEvents({ ticket_id: "T-2", types: ["escalated"] });
    expect(escalated).toHaveLength(1);
    expect(escalated[0]!.type === "escalated" && escalated[0]!.payload.resubmit_counts).toEqual({
      review: 2,
      conflict: 0,
    });
  });
});

describe("T-039：worktree 根目录的软链接逃逸、重启后从 2 读当前 PR 重审", () => {
  const ticket: SubAgentTicket = {
    ticket_id: "T-3",
    project_id: "P-1",
    requirement_id: "R-1",
    trace_id: "tr-3",
    span_id: "sp-3",
    parent_span_id: null,
    ticket_text: "改点什么",
    base_commit: "c".repeat(40),
    permission_list: [{ glob: "src/**", level: "rw" }],
  };
  const make = (wtRoot: string, over: Partial<SubAgentDeps> = {}) => {
    const statuses: TicketStatus[] = [];
    const runTicket = vi.fn(async () => ({
      status: "done" as const,
      summary: "",
      changed_files: [],
    }));
    const review = vi.fn(async () => ({ verdict: "pass" as const, reasons: [], reviewer: "r-1" }));
    const agent = createSubAgent({
      getConfig: () => ({
        roles: { coder: { effort: "low", resubmit_effort: ["low", "high", "high"] } },
        pipeline: { resubmit_limits: { review: 2 } },
      }),
      coder: { runTicket },
      review,
      pr: {
        open: async () => "pr-x",
        commitWorktree: async () => "d".repeat(40),
        diff: async () => ({ base_sha: "a".repeat(40), head_sha: "b".repeat(40), files: [] }),
      },
      budgetState: () => ({ daily_exhausted: false }),
      rounds: { save: (r) => storage.savePrRecord(r) },
      tickets: { setStatus: (_id, s) => void statuses.push(s) },
      resubmitHistory: eventLogResubmitHistory(storage),
      worktreeRoot: wtRoot,
      submit: vi.fn(),
      publish: ingest,
      loadTicket: (id) => (id === ticket.ticket_id ? ticket : undefined),
      ...over,
    });
    return { agent, statuses, runTicket, review };
  };

  it("根目录里指向根目录外的软链接：handle / resume / resubmitConflict / reReview 都拒绝，不调编码池、不写状态", async () => {
    const wtRoot = join(repo, ".bakacoding", "worktrees");
    const outside = join(root, "outside");
    await mkdir(wtRoot, { recursive: true });
    await mkdir(outside, { recursive: true });
    const link = join(wtRoot, "T-3-r0");
    await symlink(outside, link);
    // 根目录内指向根目录内的软链接是允许的（对照）
    await mkdir(join(wtRoot, "real-T-3-r1"));
    await symlink(join(wtRoot, "real-T-3-r1"), join(wtRoot, "T-3-r1"));

    await storage.prStore<StoredPrRecord>().put({
      pr_id: "pr-link",
      kind: "ticket",
      ticket_id: "T-3",
      worktree_path: link,
      branch: "bakacoding/T-3-r0",
      base_sha: "a".repeat(40),
      status: "open",
    });
    const t = make(wtRoot, { prRecords: storage.prStore<StoredPrRecord>() });
    await expect(t.agent.handle(ticket, { worktree: { path: link, branch: "b" } })).rejects.toThrow(
      /worktree 根目录/,
    );
    await expect(
      t.agent.handle(ticket, { worktree: { path: join(link, "sub"), branch: "b" } }),
    ).rejects.toThrow(/worktree 根目录/);
    await expect(
      t.agent.resume(ticket, {
        ticket_id: "T-3",
        worktree_path: link,
        branch: "b",
        base_commit: ticket.base_commit,
        worktree_round: 0,
        pr_id: null,
        resubmit_counts: { review: 0, conflict: 0 },
        phase: "coding",
        is_resubmit: false,
      }),
    ).rejects.toThrow(/worktree 根目录/);
    await expect(
      t.agent.resubmitConflict({
        ticket,
        round: 1,
        worktree_path: link,
        branch: "b",
        base_commit: "a".repeat(40),
        conflicted_files: [],
        previous_pr_id: "pr-old",
        resubmit_counts: { review: 0, conflict: 1 },
      }),
    ).rejects.toThrow(/worktree 根目录/);
    await expect(t.agent.reReview({ ticket, pr_id: "pr-link", merged_since: [] })).rejects.toThrow(
      /worktree 根目录/,
    );
    expect(t.runTicket).not.toHaveBeenCalled();
    expect(t.review).not.toHaveBeenCalled();
    expect(t.statuses).toEqual([]);

    // 对照：根目录内的软链接照常可用
    const ok = await t.agent.handle(ticket, {
      worktree: { path: join(wtRoot, "T-3-r1"), branch: "b" },
    });
    expect(ok.kind).toBe("merge_queued");
  });

  it("重启后新的 8 只凭 2 的 PR 记录重审（真 SQLite）", async () => {
    const wtRoot = join(repo, ".bakacoding", "worktrees");
    await storage.prStore<StoredPrRecord>().put({
      pr_id: "pr-7",
      kind: "ticket",
      ticket_id: "T-3",
      worktree_path: join(wtRoot, "T-3-r1"),
      branch: "bakacoding/T-3-r1",
      base_sha: "a".repeat(40),
      status: "open",
    });
    const t = make(wtRoot, { prRecords: storage.prStore<StoredPrRecord>() });
    const out = await t.agent.reReview({ ticket, pr_id: "pr-7", merged_since: [] });
    expect(out).toEqual({ pr_id: "pr-7", review_resubmits: 0 });
    expect(t.review).toHaveBeenCalledTimes(1);
    expect(t.runTicket).not.toHaveBeenCalled();
    expect(t.statuses).toEqual([]);
  });
});
