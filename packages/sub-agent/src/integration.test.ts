// 用真实的 4（worktree + 文件工具）、5（编码池）、6（本地 PR）、7（评审池）、2（SQLite 存储）跑通 8；
// 只把模块 1（模型调用）和模块 9（submit）换成替身。
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
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
import type { TicketStatus } from "@bakacoding/types";
import { WorktreeManager } from "@bakacoding/workspace";
import { createSubAgent, type SubAgent, type SubAgentTicket } from "./index.js";

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
      worktrees: { create: (id, b, n) => mgr.createWorktree(id, b, n) },
      submit,
      publish: (e) => void events.push(e),
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
