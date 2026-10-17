import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupGitEnv, cleanupMergedWorktrees, isGitLockError } from "./cleanup.js";
import { withGitWriteLock } from "./git-lock.js";
import { WorktreeManager } from "./worktree.js";

let repo: string;
const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
const INT = "bakacoding/integration";
const fast = { retry_delays_ms: [0, 0], sleep: async () => {} };

function commitIn(dir: string, file: string): string {
  writeFileSync(join(dir, file), `${file}\n`);
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", file], { cwd: dir });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
}
const hasBranch = (b: string) => git("branch", "--list", b) !== "";

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "bc-clean-")));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git("add", ".");
  git("commit", "-qm", "init");
  git("branch", INT);
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("cleanupMergedWorktrees（T-094）", () => {
  it("清掉该单所有轮次的 worktree 和已合入的分支，不碰集成分支和别的单", async () => {
    const m = await WorktreeManager.open(repo);
    const r0 = await m.createWorktree("T-1", "HEAD", 0);
    const r1 = await m.createWorktree("T-1", "HEAD", 1);
    const other = await m.createWorktree("T-10", "HEAD", 0);
    const head = commitIn(r1.path, "t1.txt");
    git("update-ref", `refs/heads/${INT}`, head); // 快进合入集成分支
    const res = await m.cleanupMerged("T-1", { merged_into: INT, ...fast });
    expect(res.errors).toEqual([]);
    expect(res.removed_worktrees.sort()).toEqual([r0.path, r1.path].sort());
    expect(res.deleted_branches.sort()).toEqual(["bakacoding/T-1-r0", "bakacoding/T-1-r1"]);
    expect(existsSync(r0.path)).toBe(false);
    expect(existsSync(r1.path)).toBe(false);
    expect(hasBranch("bakacoding/T-1-r1")).toBe(false);
    expect(hasBranch(INT)).toBe(true);
    expect(existsSync(other.path)).toBe(true);
    expect(hasBranch("bakacoding/T-10-r0")).toBe(true);
    expect(git("worktree", "list", "--porcelain")).not.toContain("T-1-r");
  });

  it("worktree 目录已不在、只剩分支 / 登记时也清", async () => {
    const m = await WorktreeManager.open(repo);
    const r0 = await m.createWorktree("T-2", "HEAD", 0);
    rmSync(r0.path, { recursive: true, force: true });
    const res = await cleanupMergedWorktrees(repo, "T-2", { merged_into: INT, ...fast });
    expect(res.errors).toEqual([]);
    expect(res.deleted_branches).toEqual(["bakacoding/T-2-r0"]);
    expect(git("worktree", "list", "--porcelain")).not.toContain("T-2-r0");
  });

  it("分支头不在目标分支里就保留分支（not_merged），worktree 照删", async () => {
    const m = await WorktreeManager.open(repo);
    const r0 = await m.createWorktree("T-3", "HEAD", 0);
    commitIn(r0.path, "unmerged.txt");
    const res = await m.cleanupMerged("T-3", { merged_into: INT, ...fast });
    expect(res.removed_worktrees).toEqual([r0.path]);
    expect(res.kept_branches).toEqual([{ branch: "bakacoding/T-3-r0", reason: "not_merged" }]);
    expect(hasBranch("bakacoding/T-3-r0")).toBe(true);
  });

  it("另认 <remote>/<merged_into>：本地集成分支没前进但远程跟踪引用已包含时也删", async () => {
    const m = await WorktreeManager.open(repo);
    const r0 = await m.createWorktree("T-4", "HEAD", 0);
    const head = commitIn(r0.path, "t4.txt");
    git("update-ref", `refs/remotes/origin/${INT}`, head);
    const noRemote = await m.cleanupMerged("T-4", { merged_into: INT, ...fast });
    expect(noRemote.kept_branches).toEqual([{ branch: "bakacoding/T-4-r0", reason: "not_merged" }]);
    const res = await m.cleanupMerged("T-4", { merged_into: INT, remote: "origin", ...fast });
    expect(res.deleted_branches).toEqual(["bakacoding/T-4-r0"]);
    expect(git("rev-parse", `refs/remotes/origin/${INT}`)).toBe(head); // 远程跟踪引用不动
  });

  it("git 删 worktree 一直失败时改用兜底删除，再 prune 后删分支", async () => {
    const m = await WorktreeManager.open(repo);
    const r0 = await m.createWorktree("T-5", "HEAD", 0);
    const calls: string[] = [];
    let removed = 0;
    const res = await cleanupMergedWorktrees(repo, "T-5", {
      merged_into: INT,
      ...fast,
      runGit: async (cwd, args) => {
        calls.push(args.join(" "));
        if (args.includes("remove"))
          throw Object.assign(new Error("x"), { stderr: "Permission denied" });
        return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
      },
      removeDir: async (p) => {
        removed++;
        rmSync(p, { recursive: true, force: true });
      },
    });
    expect(calls.filter((c) => c.includes("worktree remove"))).toHaveLength(3);
    expect(calls.find((c) => c.includes("worktree remove"))).toContain("-c core.longpaths=true");
    expect(removed).toBe(1);
    expect(res.errors).toEqual([]);
    expect(res.removed_worktrees).toEqual([r0.path]);
    expect(res.deleted_branches).toEqual(["bakacoding/T-5-r0"]);
  });

  it("目录删不掉：记 errors、保留分支、不抛错；一项失败不影响同单其他轮次", async () => {
    const m = await WorktreeManager.open(repo);
    const r0 = await m.createWorktree("T-6", "HEAD", 0);
    const r1 = await m.createWorktree("T-6", "HEAD", 1);
    const res = await cleanupMergedWorktrees(repo, "T-6", {
      merged_into: INT,
      ...fast,
      runGit: async (cwd, args) => {
        if (args.includes("remove") && args.includes(r0.path)) throw new Error("locked");
        return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
      },
      removeDir: async () => {
        throw new Error("EBUSY");
      },
    });
    expect(res.errors.map((e) => e.target)).toEqual([r0.path]);
    expect(res.removed_worktrees).toEqual([r1.path]);
    expect(res.deleted_branches).toEqual(["bakacoding/T-6-r1"]);
    expect(res.kept_branches).toEqual([{ branch: "bakacoding/T-6-r0", reason: "checked_out" }]);
    expect(existsSync(r0.path)).toBe(true);
  });

  it("锁文件冲突按间隔重试", async () => {
    const m = await WorktreeManager.open(repo);
    await m.createWorktree("T-7", "HEAD", 0);
    const sleeps: number[] = [];
    let fails = 1;
    const res = await cleanupMergedWorktrees(repo, "T-7", {
      merged_into: INT,
      retry_delays_ms: [5, 10],
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      runGit: async (cwd, args) => {
        if (args[0] === "update-ref" && fails-- > 0)
          throw Object.assign(new Error("x"), {
            stderr: "fatal: Unable to create '/r/.git/packed-refs.lock': File exists.",
          });
        return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
      },
    });
    expect(sleeps).toEqual([5]);
    expect(res.deleted_branches).toEqual(["bakacoding/T-7-r0"]);
  });

  it("非法参数、非 git 目录都不抛错，只记 errors", async () => {
    expect((await cleanupMergedWorktrees(repo, "../x", { merged_into: INT })).errors).toHaveLength(
      1,
    );
    expect((await cleanupMergedWorktrees(repo, "T-1", { merged_into: "-x" })).errors).toHaveLength(
      1,
    );
    const notRepo = realpathSync(mkdtempSync(join(tmpdir(), "bc-clean-nr-")));
    try {
      const res = await cleanupMergedWorktrees(notRepo, "T-1", { merged_into: INT });
      expect(res.errors.length).toBeGreaterThan(0);
    } finally {
      rmSync(notRepo, { recursive: true, force: true });
    }
  });

  it("设了 GIT_DIR / GIT_INDEX_FILE 也不会动到别的仓库，目标仓库照常清理", async () => {
    const other = realpathSync(mkdtempSync(join(tmpdir(), "bc-clean-other-")));
    const og = (...a: string[]) => execFileSync("git", a, { cwd: other, encoding: "utf8" }).trim();
    try {
      og("init", "-q", "-b", "main");
      og("config", "user.email", "t@example.com");
      og("config", "user.name", "t");
      writeFileSync(join(other, "o.txt"), "o\n");
      og("add", ".");
      og("commit", "-qm", "init");
      og("branch", INT);
      og("branch", "bakacoding/T-9-r0"); // 同名分支，已包含在集成分支里
      const m = await WorktreeManager.open(repo);
      const r0 = await m.createWorktree("T-9", "HEAD", 0);
      const saved = { dir: process.env.GIT_DIR, idx: process.env.GIT_INDEX_FILE };
      process.env.GIT_DIR = join(other, ".git");
      process.env.GIT_INDEX_FILE = join(other, ".git", "index");
      let res;
      try {
        res = await cleanupMergedWorktrees(repo, "T-9", { merged_into: INT, ...fast });
      } finally {
        if (saved.dir === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = saved.dir;
        if (saved.idx === undefined) delete process.env.GIT_INDEX_FILE;
        else process.env.GIT_INDEX_FILE = saved.idx;
      }
      expect(res.errors).toEqual([]);
      expect(res.removed_worktrees).toEqual([r0.path]);
      expect(res.deleted_branches).toEqual(["bakacoding/T-9-r0"]);
      expect(hasBranch("bakacoding/T-9-r0")).toBe(false);
      expect(og("branch", "--list", "bakacoding/T-9-r0")).not.toBe("");
      expect(og("status", "--porcelain")).toBe("");
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("cleanupGitEnv 剔掉所有 GIT_ 变量，只留自己加的", () => {
    const env = cleanupGitEnv({
      PATH: "/bin",
      GIT_DIR: "/x",
      git_work_tree: "/y",
      GIT_CONFIG_COUNT: "1",
    });
    expect(env).toEqual({ PATH: "/bin", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" });
  });

  it("不删受管目录以外的 worktree", async () => {
    const outside = join(repo, "..", `${repo.split("/").pop()}-T-8-r0`);
    git("worktree", "add", "-q", "-b", "bakacoding/T-8-r0", outside, "HEAD");
    try {
      const res = await cleanupMergedWorktrees(repo, "T-8", { merged_into: INT, ...fast });
      expect(existsSync(outside)).toBe(true);
      expect(res.removed_worktrees).toEqual([]);
      expect(res.kept_branches).toEqual([{ branch: "bakacoding/T-8-r0", reason: "checked_out" }]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("withGitWriteLock", () => {
  it("同一仓库串行、不同仓库并行；抛错不卡后面的人", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const a = withGitWriteLock(repo, async () => {
      order.push("a-start");
      await gate;
      order.push("a-end");
    });
    const b = withGitWriteLock(repo, async () => {
      order.push("b");
      throw new Error("boom");
    });
    const c = withGitWriteLock(repo, () => order.push("c"));
    const other = withGitWriteLock(join(repo, "elsewhere"), () => order.push("other"));
    await other;
    expect(order).toEqual(["a-start", "other"]);
    release();
    await a;
    await expect(b).rejects.toThrow("boom");
    await c;
    expect(order).toEqual(["a-start", "other", "a-end", "b", "c"]);
  });
  it("isGitLockError 认得锁文件错误", () => {
    expect(isGitLockError({ stderr: "Unable to create '/x/.git/index.lock': File exists." })).toBe(
      true,
    );
    expect(isGitLockError(new Error("Permission denied"))).toBe(false);
  });
});
