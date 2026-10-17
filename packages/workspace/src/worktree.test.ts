import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorktreeManager } from "./worktree.js";

let repo: string;
const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "bc-wt-")));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git("add", ".");
  git("commit", "-qm", "init");
  writeFileSync(join(repo, ".env"), "SECRET=x\n"); // 未跟踪
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("WorktreeManager", () => {
  it("在约定路径创建 worktree 和分支，不带未跟踪文件，并写 exclude", async () => {
    const m = await WorktreeManager.open(repo);
    const base = git("rev-parse", "HEAD");
    const wt = await m.createWorktree("T-9", base, 1);
    expect(wt.path).toBe(join(repo, ".bakacoding/worktrees/T-9-r1"));
    expect(wt.branch).toBe("bakacoding/T-9-r1");
    expect(existsSync(join(wt.path, "a.txt"))).toBe(true);
    expect(existsSync(join(wt.path, ".env"))).toBe(false);
    expect(readFileSync(join(repo, ".git/info/exclude"), "utf8")).toContain(
      "/.bakacoding/worktrees/",
    );
    expect(git("status", "--porcelain")).toBe("?? .env");
    await m.ensureIgnored();
    expect(readFileSync(join(repo, ".git/info/exclude"), "utf8").match(/bakacoding/g)).toHaveLength(
      1,
    );
  });
  it("cleanup 按 ticket 清掉所有轮次，按路径只清一个", async () => {
    const m = await WorktreeManager.open(repo);
    const a = await m.createWorktree("T-1", "HEAD", 0);
    await m.createWorktree("T-1", "HEAD", 1);
    const c = await m.createWorktree("T-10", "HEAD", 0);
    expect(await m.cleanup(a.path)).toEqual([a.path]);
    expect((await m.cleanup("T-1")).length).toBe(1);
    expect(git("branch", "--list", "bakacoding/T-1-*")).toBe("");
    expect(existsSync(c.path)).toBe(true);
    expect(git("branch", "--list", "bakacoding/T-10-r0")).toContain("T-10-r0");
  });
  it("拒绝非法 ticket_id、重复创建和不存在的 base", async () => {
    const m = await WorktreeManager.open(repo);
    await expect(m.createWorktree("../x", "HEAD")).rejects.toThrow(/ticket_id/);
    await m.createWorktree("T-2", "HEAD");
    await expect(m.createWorktree("T-2", "HEAD")).rejects.toThrow();
    await expect(m.createWorktree("T-3", "deadbeef")).rejects.toThrow();
  });
});
