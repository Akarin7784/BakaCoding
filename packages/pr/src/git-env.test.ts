import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryPrStore, INTEGRATION_BRANCH, LocalPrProvider } from "./index.js";
import { git, GitError } from "./git.js";

// T-097：模块 6 的本地 git 调用用 gitEnv()，继承的 GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE
// 不能把操作带到别的仓库或索引上。校验结果用独立的 raw()（自己剔 GIT_ 变量），不依赖被测的 git()。

const ID = ["-c", "user.name=t", "-c", "user.email=t@t"];
const LEAK = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"] as const;

function raw(cwd: string, args: string[]): string {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v;
  return execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
}

let root: string;
let repo: string;
let other: string;
let foreignIndex: string;
let saved: Partial<Record<(typeof LEAK)[number], string>>;
let pr: LocalPrProvider;

function leakEnv() {
  process.env.GIT_DIR = join(other, ".git");
  process.env.GIT_WORK_TREE = other;
  process.env.GIT_INDEX_FILE = foreignIndex;
}

function otherSnapshot() {
  return {
    refs: raw(other, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    head: raw(other, ["symbolic-ref", "HEAD"]),
    status: raw(other, ["status", "--porcelain", "--untracked-files=all"]),
  };
}

/** 目标仓库里拉一个单张分支的 worktree 并提交一个文件（在泄漏环境变量之前做）。 */
async function ticketWorktree(ticket: string) {
  const branch = `feat/${ticket}`;
  const wt = join(root, `wt-${ticket}`);
  raw(repo, ["worktree", "add", "-q", "-b", branch, wt, "main"]);
  await writeFile(join(wt, `${ticket}.txt`), `${ticket}\n`);
  raw(wt, ["add", "-A"]);
  raw(wt, [...ID, "commit", "-q", "-m", ticket]);
  return { wt, branch };
}

beforeEach(async () => {
  saved = {};
  for (const k of LEAK) if (process.env[k] !== undefined) saved[k] = process.env[k];
  root = await mkdtemp(join(tmpdir(), "bc-pr-gitenv-test-"));
  repo = join(root, "repo");
  other = join(root, "other");
  foreignIndex = join(root, "foreign.index");
  for (const r of [repo, other]) {
    raw(root, ["init", "-q", "-b", "main", r]);
    await writeFile(join(r, "a.txt"), `${r === repo ? "target" : "other"}\n`);
    raw(r, ["add", "-A"]);
    raw(r, [...ID, "commit", "-q", "-m", "init"]);
  }
  pr = new LocalPrProvider({
    store: new InMemoryPrStore(),
    repo,
    author: { name: "t", email: "t@t" },
  });
});

afterEach(async () => {
  for (const k of LEAK) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(root, { recursive: true, force: true });
});

describe("模块 6 的本地 git 调用不受继承的 GIT_ 变量影响（T-097）", () => {
  it("open / commitWorktree / diff / merge 只作用于目标仓库，另一个仓库和索引文件不动", async () => {
    const { wt, branch } = await ticketWorktree("T-1");
    const before = otherSnapshot();
    leakEnv();

    const id = await pr.open("T-1", wt, branch);
    await writeFile(join(wt, "more.txt"), "more\n");
    const head = await pr.commitWorktree("T-1", wt);
    expect(raw(wt, ["rev-parse", "HEAD"])).toBe(head);
    expect(raw(wt, ["log", "-1", "--format=%s"])).toBe("T-1: apply worktree changes");

    const diff = await pr.diff(id);
    expect(diff.files.map((f) => f.path).sort()).toEqual(["T-1.txt", "more.txt"]);

    const res = await pr.merge(id, "main");
    expect(res).toMatchObject({ merged: true });
    expect(raw(repo, ["rev-parse", "main"])).toBe(head);
    expect(raw(repo, ["status", "--porcelain"])).toBe("");

    expect(otherSnapshot()).toEqual(before);
    expect(existsSync(foreignIndex)).toBe(false);
  });

  it("commitPatch 只提交到目标 worktree", async () => {
    const { wt } = await ticketWorktree("T-2");
    const before = otherSnapshot();
    leakEnv();

    const patch = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-target",
      "+patched",
      "",
    ].join("\n");
    const head = await pr.commitPatch("T-2", wt, patch);
    expect(raw(wt, ["rev-parse", "HEAD"])).toBe(head);
    expect(raw(wt, ["show", "HEAD:a.txt"])).toBe("patched");

    expect(otherSnapshot()).toEqual(before);
    expect(existsSync(foreignIndex)).toBe(false);
  });

  it("openIntegration（建分支）只在目标仓库建出集成分支", async () => {
    const before = otherSnapshot();
    leakEnv();

    await pr.openIntegration();
    expect(raw(repo, ["rev-parse", INTEGRATION_BRANCH])).toBe(raw(repo, ["rev-parse", "main"]));

    expect(otherSnapshot()).toEqual(before);
    expect(await readdir(root)).not.toContain("foreign.index");
  });
});

describe("git() 的环境与超时（T-097）", () => {
  it("本地调用剔掉继承的 GIT_DIR；remote: true 的调用保持继承的环境", async () => {
    leakEnv();
    const local = (await git(repo, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
    expect(local).toBe(raw(repo, ["rev-parse", "--absolute-git-dir"]));
    const inherited = (await git(repo, ["rev-parse", "--absolute-git-dir"], { remote: true }))
      .stdout;
    expect(inherited.trim()).toBe(raw(other, ["rev-parse", "--absolute-git-dir"]));
  });

  it("超时抛 GitError，code 为 null，信息里写明超时", async () => {
    // hash-object --stdin 等 stdin 关闭，execFile 不关 stdin，会一直挂着
    const err = await git(repo, ["hash-object", "--stdin"], { timeoutMs: 200 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).code).toBeNull();
    expect((err as GitError).message).toContain("超时");
  });
});
