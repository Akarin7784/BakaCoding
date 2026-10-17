// T-096（#101 评审）：T-042 C3 查「用户仓库是否检出 main」用 AppDeps.repoRoot，不再从 worktreeRoot 往上推。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { userMainWorktreeFor } from "./assemble.js";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "bc-main-wt-")));
  dirs.push(d);
  return d;
}

/** 建一个有一次提交的仓库，检出 branch */
function repoOn(branch: string): string {
  const root = tmp();
  const git = (...a: string[]) =>
    execFileSync("git", a, {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.invalid",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.invalid",
      },
    });
  git("init", "-q", "-b", branch);
  writeFileSync(join(root, "a.txt"), "a\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "init");
  return root;
}

describe("userMainWorktreeFor（T-042 C3 / T-096）", () => {
  it("给了 repoRoot 就用它：worktreeRoot 不在仓库里也能查到检出 main 的 worktree", async () => {
    const repo = repoOn("main");
    const elsewhere = join(tmp(), "wt");
    mkdirSync(elsewhere, { recursive: true });
    expect(await userMainWorktreeFor({ repoRoot: repo, worktreeRoot: elsewhere })).toBe(repo);
  });

  it("repoRoot 优先于 worktreeRoot：repoRoot 检出的是别的分支时返回 null，不看 worktreeRoot 所在的仓库", async () => {
    const onFeature = repoOn("feature");
    const onMain = repoOn("main");
    const wtRoot = join(onMain, ".bakacoding", "worktrees");
    mkdirSync(wtRoot, { recursive: true });
    expect(await userMainWorktreeFor({ repoRoot: onFeature, worktreeRoot: wtRoot })).toBeNull();
  });

  it("没给 repoRoot：退回按 <repo>/.bakacoding/worktrees 往上推两级", async () => {
    const repo = repoOn("main");
    const wtRoot = join(repo, ".bakacoding", "worktrees");
    mkdirSync(wtRoot, { recursive: true });
    expect(await userMainWorktreeFor({ worktreeRoot: wtRoot })).toBe(repo);
  });

  it("不是 git 仓库：返回 null，不抛", async () => {
    const d = tmp();
    expect(await userMainWorktreeFor({ repoRoot: d, worktreeRoot: join(d, "x") })).toBeNull();
  });
});
