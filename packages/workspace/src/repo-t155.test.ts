import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { branchStatus, BranchStatusError, type BranchStatusCode } from "./repo.js";

// T-155：branchStatus 只读查询当前分支和集成分支领先数，用真实临时仓库。
let base: string;
let dir: string;
const saved: Record<string, string | undefined> = {};
const ENV: Record<string, string> = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
const git = (...a: string[]) =>
  execFileSync("git", a, { cwd: dir, encoding: "utf8", env: { ...process.env, ...ENV } }).trim();
const commit = (m: string) => git("commit", "-q", "--allow-empty", "-m", m);
const code = async (p: Promise<unknown>): Promise<BranchStatusCode> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(BranchStatusError);
    return (e as BranchStatusError).code;
  }
  throw new Error("没有抛错");
};
const setup = () => {
  git("init", "-q");
  git("symbolic-ref", "HEAD", "refs/heads/main");
  commit("c0");
};

beforeEach(() => {
  for (const k of ["HOME", "XDG_CONFIG_HOME"]) saved[k] = process.env[k];
  base = realpathSync(mkdtempSync(join(tmpdir(), "bc-t155-")));
  dir = join(base, "proj");
  mkdirSync(dir);
  process.env.HOME = join(base, "home");
  process.env.XDG_CONFIG_HOME = join(base, "home", ".config");
  mkdirSync(process.env.HOME);
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("branchStatus（T-155）", () => {
  it("集成分支与 main 同一提交：ahead=0，给当前分支", async () => {
    setup();
    git("branch", "bakacoding/integration");
    expect(await branchStatus(dir)).toEqual({ current_branch: "main", ahead: 0 });
  });

  it("集成分支领先 main 两个提交：ahead=2；main 自己多出的提交不算", async () => {
    setup();
    git("checkout", "-q", "-b", "bakacoding/integration");
    commit("i1");
    commit("i2");
    git("checkout", "-q", "main");
    commit("m1");
    git("checkout", "-q", "-b", "feat/x");
    expect(await branchStatus(dir)).toEqual({ current_branch: "feat/x", ahead: 2 });
  });

  it("可指定基线和集成分支名", async () => {
    setup();
    git("branch", "-m", "main", "trunk");
    git("checkout", "-q", "-b", "integ");
    commit("i1");
    expect(await branchStatus(dir, { base_branch: "trunk", integration_branch: "integ" })).toEqual({
      current_branch: "integ",
      ahead: 1,
    });
  });

  it("分离 HEAD：current_branch 为 null", async () => {
    setup();
    git("branch", "bakacoding/integration");
    git("checkout", "-q", "--detach");
    expect(await branchStatus(dir)).toEqual({ current_branch: null, ahead: 0 });
  });

  it("没有集成分支：no_integration，消息不含路径", async () => {
    setup();
    const err = await branchStatus(dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BranchStatusError);
    expect((err as BranchStatusError).code).toBe("no_integration");
    expect((err as Error).message).not.toContain(base);
    expect((err as Error).message).not.toContain("bakacoding/integration");
  });

  it("没有基线分支：no_base", async () => {
    setup();
    git("branch", "-m", "main", "trunk");
    git("branch", "bakacoding/integration");
    expect(await code(branchStatus(dir))).toBe("no_base");
  });

  it("不是仓库：not_git；子目录：nested_repo", async () => {
    expect(await code(branchStatus(dir))).toBe("not_git");
    setup();
    git("branch", "bakacoding/integration");
    mkdirSync(join(dir, "sub"));
    expect(await code(branchStatus(join(dir, "sub")))).toBe("nested_repo");
  });

  it("非法分支名：invalid_branch，不跑 git", async () => {
    expect(await code(branchStatus(dir, { integration_branch: "--all" }))).toBe("invalid_branch");
    expect(await code(branchStatus(dir, { base_branch: "" }))).toBe("invalid_branch");
  });

  it("只读：不改 refs 和 HEAD", async () => {
    setup();
    git("branch", "bakacoding/integration");
    const before = git("for-each-ref") + git("symbolic-ref", "HEAD");
    await branchStatus(dir);
    expect(git("for-each-ref") + git("symbolic-ref", "HEAD")).toBe(before);
  });
});
