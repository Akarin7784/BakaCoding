// T-101：组合根内部 git 调用 repoGit 的 env 与缓冲上限。
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REPO_GIT_DEFAULT_MAX_BUFFER, repoGit } from "./repo-git.js";

let dirs: string[] = [];
const saved = new Map<string, string | undefined>();
function setEnv(name: string, value: string): void {
  if (!saved.has(name)) saved.set(name, process.env[name]);
  process.env[name] = value;
}
afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/** 建一个检出 branch、有一次提交的仓库（建仓本身不吃 process.env 里的 GIT_*） */
function repoOn(branch: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bc-repo-git-")));
  dirs.push(root);
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

describe("repoGit（T-101）", () => {
  it("cwd 是目标仓库，GIT_DIR 指向别的仓库也不跟过去", async () => {
    const other = repoOn("other");
    const repo = repoOn("main");
    setEnv("GIT_DIR", join(other, ".git"));
    const { stdout } = await repoGit(repo, ["symbolic-ref", "--short", "HEAD"]);
    expect(stdout.trim()).toBe("main");
  });

  it("stdout 是 utf8 字符串", async () => {
    const repo = repoOn("main");
    const { stdout } = await repoGit(repo, ["rev-parse", "--show-toplevel"]);
    expect(typeof stdout).toBe("string");
    expect(stdout.trim()).toBe(repo);
  });

  it("默认缓冲 1 MiB，超了 reject；传 maxBuffer 放大后能读完", async () => {
    const repo = repoOn("main");
    const big = REPO_GIT_DEFAULT_MAX_BUFFER + 4096;
    // 用 cat-file 读一个超过 1 MiB 的 blob
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: repo,
      input: "x".repeat(big),
      encoding: "utf8",
    }).trim();
    await expect(repoGit(repo, ["cat-file", "blob", blob])).rejects.toThrow();
    const { stdout } = await repoGit(repo, ["cat-file", "blob", blob], { maxBuffer: 2 * big });
    expect(stdout).toHaveLength(big);
  });
});
