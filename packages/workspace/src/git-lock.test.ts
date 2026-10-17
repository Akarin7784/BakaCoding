// T-094：T-086 的 initRepo / initialCommit / createMainBranch 与合入后清理共用进程内 git 写锁。
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupMergedWorktrees } from "./cleanup.js";
import { withGitWriteLock } from "./git-lock.js";
import { createMainBranch, initialCommit, initRepo } from "./repo.js";

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "bc-lock-")));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", a, { cwd, encoding: "utf8" }).trim();

/** 先占住写锁，返回放锁函数和「占锁期间完成了什么」的记录。 */
function hold(repo: string) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const held = withGitWriteLock(repo, () => gate);
  return { release, held };
}

describe("T-086 三个写操作接 git 写锁", () => {
  it("initRepo 等写锁：锁被占住时不建仓库，放锁后才执行", async () => {
    const dir = join(root, "new");
    const { release, held } = hold(dir);
    let done = false;
    const p = initRepo(dir).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 100));
    expect(done).toBe(false);
    expect(existsSync(join(dir, ".git"))).toBe(false);
    release();
    await held;
    await p;
    expect(existsSync(join(dir, ".git"))).toBe(true);
  });

  it("initialCommit、createMainBranch 与 cleanupMerged 串行，不交错", async () => {
    const repo = join(root, "r");
    await initRepo(repo, { identity: { name: "t", email: "t@example.com" } });
    writeFileSync(join(repo, "a.txt"), "a\n");
    const order: string[] = [];
    const { release, held } = hold(repo);
    const c = initialCommit(repo, { files: ["a.txt"] }).then(() => order.push("commit"));
    await new Promise((r) => setTimeout(r, 100));
    expect(order).toEqual([]);
    expect(existsSync(join(repo, ".git/refs/heads/main"))).toBe(false);
    release();
    await held;
    await c;
    expect(order).toEqual(["commit"]);

    // 改名成 master 再测 createMainBranch：与 cleanupMerged 同时发起，按先后串行完成
    git(repo, "branch", "-m", "main", "master");
    git(repo, "branch", "bakacoding/integration");
    const h2 = hold(repo);
    const a = cleanupMergedWorktrees(repo, "T-1", {
      merged_into: "bakacoding/integration",
    }).then(() => order.push("cleanup"));
    const b = createMainBranch(repo).then(() => order.push("main"));
    await new Promise((r) => setTimeout(r, 100));
    expect(order).toEqual(["commit"]);
    h2.release();
    await h2.held;
    await Promise.all([a, b]);
    expect(order).toEqual(["commit", "cleanup", "main"]);
    expect(git(repo, "rev-parse", "main")).toBe(git(repo, "rev-parse", "master"));
  });
});
