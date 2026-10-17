// T-076：新仓库（还没有 bakacoding/integration）走本地模式，第一张单从派单到合入走通。
// 用真实的 4（WorktreeManager）、6（LocalPrProvider）、9（调度器）；8 换成替身：在 4 建的 worktree 里写文件、
// 经 6 开 PR 并提交，然后像评审通过那样调 9 的 submit。
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getConfig } from "@bakacoding/config-budget";
import { INTEGRATION_BRANCH, InMemoryPrStore, LocalPrProvider } from "@bakacoding/pr";
import type { TicketStatus } from "@bakacoding/types";
import { WorktreeManager } from "@bakacoding/workspace";
import { createScheduler, type SchedulerDeps, type SchedulerTicket } from "./index.js";

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
/** 同组合根 integrationTargetHead（T-079）：集成分支有就读它，没有退回 main；不读检出的 HEAD */
async function targetHead(cwd: string): Promise<string> {
  try {
    return await git(
      cwd,
      "rev-parse",
      "--verify",
      "-q",
      `refs/heads/${INTEGRATION_BRANCH}^{commit}`,
    );
  } catch {
    return git(cwd, "rev-parse", "--verify", "refs/heads/main^{commit}");
  }
}

const examplePath = fileURLToPath(new URL("../../../config/models.example.json", import.meta.url));

let root: string;
let repo: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bc-t076-"));
  repo = join(root, "repo");
  await run("git", ["init", "-q", "-b", "main", repo]);
  await writeFile(join(repo, "a.txt"), "a\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "init");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("T-076 本地模式新仓库：第一张单从派单到合入", () => {
  it("没有集成分支时合入前从基线分支建出，单子 merged，集成分支含该提交，main 不动", async () => {
    const cfg = getConfig(examplePath);
    const wm = await WorktreeManager.open(repo);
    const pr = new LocalPrProvider({ store: new InMemoryPrStore(), repo: wm.repoRoot });
    const statuses: Array<[string, TicketStatus]> = [];
    const published: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const errors: unknown[] = [];
    const mainBefore = await git(repo, "rev-parse", "main");
    let commitSha = "";

    const deps: SchedulerDeps = {
      bus: {
        publish: (e) => void published.push(e as (typeof published)[number]),
        subscribe: (() => () => undefined) as SchedulerDeps["bus"]["subscribe"],
      },
      createPr: () => pr,
      config: { pipeline: cfg.pipeline, backpressure: cfg.backpressure },
      // 同组合根（T-079）：集成分支有就读它，没有退回 main
      targetHead: () => targetHead(wm.repoRoot),
      budgetState: () => ({ daily_exhausted: false }),
      tickets: { setStatus: (t, s) => void statuses.push([t, s]) },
      worktrees: {
        create: (t, base, round) => wm.createWorktree(t, base, round),
        cleanup: (p) => wm.cleanup(p),
      },
      subAgent: {
        // 8 替身：建 worktree → open → 写文件提交 → 评审通过 → submit
        handle: async (t: SchedulerTicket) => {
          const base = await targetHead(wm.repoRoot);
          const wt = await wm.createWorktree(t.ticket_id, base, 0);
          const pr_id = await pr.open(t.ticket_id, wt.path, wt.branch);
          await writeFile(join(wt.path, "b.txt"), "b\n");
          commitSha = await pr.commitWorktree(t.ticket_id, wt.path);
          await scheduler.submit({
            ticket_id: t.ticket_id,
            pr_id,
            worktree_path: wt.path,
            round: 0,
            base_commit: base,
          });
          return { kind: "merge_queued", pr_id };
        },
        resubmitConflict: async () => {
          throw new Error("不应冲突复投");
        },
        reReview: async () => {
          throw new Error("不应重审");
        },
        resume: async () => ({ kind: "escalated", pr_id: null }),
      },
      dispatch_poll_ms: 0,
      onError: (e) => void errors.push(e),
    };
    const scheduler = createScheduler(deps);
    await scheduler.start();
    await expect(git(repo, "rev-parse", "--verify", "-q", INTEGRATION_BRANCH)).rejects.toThrow();

    await scheduler.enqueue({
      ticket_id: "T-1",
      requirement_id: "req-1",
      trace_id: "trace-1",
      span_id: "span-T-1",
      parent_span_id: null,
      write_scope: ["b.txt"],
    });
    await scheduler.idle();
    await scheduler.stop();

    expect(errors).toEqual([]);
    expect(published.filter((e) => e.type === "escalated")).toEqual([]);
    expect(scheduler.status("T-1")).toBe("merged");
    expect(statuses.at(-1)).toEqual(["T-1", "merged"]);
    const int = await git(repo, "rev-parse", INTEGRATION_BRANCH);
    expect(int).toBe(commitSha);
    expect(await git(repo, "rev-parse", `${INTEGRATION_BRANCH}~1`)).toBe(mainBefore);
    expect(await git(repo, "show", `${INTEGRATION_BRANCH}:b.txt`)).toBe("b");
    expect(await git(repo, "rev-parse", "main")).toBe(mainBefore);
  });
  it("T-079：检出带未合入提交的功能分支时，两张单都从集成分支起步，功能分支的提交不进集成分支", async () => {
    // 用户检出 feature，上面有一个没合进 main 的提交
    await git(repo, "checkout", "-q", "-b", "feature");
    await writeFile(join(repo, "feat.txt"), "feat\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "unmerged feature work");
    const featureHead = await git(repo, "rev-parse", "HEAD");
    const mainBefore = await git(repo, "rev-parse", "main");

    const cfg = getConfig(examplePath);
    const wm = await WorktreeManager.open(repo);
    const pr = new LocalPrProvider({ store: new InMemoryPrStore(), repo: wm.repoRoot });
    const errors: unknown[] = [];
    const bases: Record<string, string> = {};
    const commits: Record<string, string> = {};
    const files: Record<string, string> = { "T-1": "b.txt", "T-2": "c.txt" };

    const deps: SchedulerDeps = {
      bus: {
        publish: () => undefined,
        subscribe: (() => () => undefined) as SchedulerDeps["bus"]["subscribe"],
      },
      createPr: () => pr,
      config: { pipeline: cfg.pipeline, backpressure: cfg.backpressure },
      targetHead: () => targetHead(wm.repoRoot),
      budgetState: () => ({ daily_exhausted: false }),
      tickets: { setStatus: () => undefined },
      worktrees: {
        create: (t, base, round) => wm.createWorktree(t, base, round),
        cleanup: (p) => wm.cleanup(p),
      },
      subAgent: {
        // 8 替身：基线取 targetHead（同 10 给新单的 base_commit）
        handle: async (t: SchedulerTicket) => {
          const base = await targetHead(wm.repoRoot);
          bases[t.ticket_id] = base;
          const wt = await wm.createWorktree(t.ticket_id, base, 0);
          const pr_id = await pr.open(t.ticket_id, wt.path, wt.branch);
          await writeFile(join(wt.path, files[t.ticket_id]!), `${t.ticket_id}\n`);
          commits[t.ticket_id] = await pr.commitWorktree(t.ticket_id, wt.path);
          await scheduler.submit({
            ticket_id: t.ticket_id,
            pr_id,
            worktree_path: wt.path,
            round: 0,
            base_commit: base,
          });
          return { kind: "merge_queued", pr_id };
        },
        resubmitConflict: async () => {
          throw new Error("不应冲突复投");
        },
        reReview: async () => {
          throw new Error("基线和集成分支一致，不应重审");
        },
        resume: async () => ({ kind: "escalated", pr_id: null }),
      },
      dispatch_poll_ms: 0,
      onError: (e) => void errors.push(e),
    };
    const scheduler = createScheduler(deps);
    await scheduler.start();
    const ticket = (id: string) => ({
      ticket_id: id,
      requirement_id: "req-1",
      trace_id: `trace-${id}`,
      span_id: `span-${id}`,
      parent_span_id: null,
      write_scope: [files[id]!],
    });
    await scheduler.enqueue(ticket("T-1"));
    await scheduler.idle();
    const intAfter1 = await git(repo, "rev-parse", INTEGRATION_BRANCH);
    await scheduler.enqueue(ticket("T-2"));
    await scheduler.idle();
    await scheduler.stop();

    expect(errors).toEqual([]);
    expect(scheduler.status("T-1")).toBe("merged");
    expect(scheduler.status("T-2")).toBe("merged");
    // 单 1 从 main 起步（集成分支还没建），不是检出的 feature
    expect(bases["T-1"]).toBe(mainBefore);
    expect(bases["T-1"]).not.toBe(featureHead);
    // 单 2 从单 1 合入后的集成分支起步，含单 1 的改动
    expect(intAfter1).toBe(commits["T-1"]);
    expect(bases["T-2"]).toBe(intAfter1);
    const int = await git(repo, "rev-parse", INTEGRATION_BRANCH);
    expect(await git(repo, "show", `${INTEGRATION_BRANCH}:b.txt`)).toBe("T-1");
    expect(await git(repo, "show", `${INTEGRATION_BRANCH}:c.txt`)).toBe("T-2");
    // feature 上没合进 main 的提交不在集成分支里；main、feature 都不动
    await expect(
      run("git", ["merge-base", "--is-ancestor", featureHead, int], { cwd: repo }),
    ).rejects.toThrow();
    await expect(git(repo, "cat-file", "-e", `${INTEGRATION_BRANCH}:feat.txt`)).rejects.toThrow();
    expect(await git(repo, "rev-parse", "main")).toBe(mainBefore);
    expect(await git(repo, "rev-parse", "feature")).toBe(featureHead);
  });
});
