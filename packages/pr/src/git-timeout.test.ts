import { execFileSync } from "node:child_process";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as pub from "./index.js";
import {
  git,
  GitError,
  gitTimeoutMs,
  GitTimeoutError,
  REMOTE_GIT_TIMEOUT_MS,
  withGitSignal,
} from "./git.js";

// T-110：远程 git 超时 + signal；本地只读 git 接 signal，写命令只在执行前检查；只读命令不拿 index.lock。

const HANG_REMOTE = ["-c", "protocol.ext.allow=always", "ls-remote", "ext::sh -c sleep% 30"];

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bc-pr-git-timeout-"));
  execFileSync("git", ["init", "-q", "-b", "main", root]);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const elapsed = async (p: Promise<unknown>) => {
  const t = Date.now();
  const e = await p.catch((x: unknown) => x);
  return { e, ms: Date.now() - t };
};

describe("远程 git 超时与取消（T-110）", () => {
  it("默认超时 120 秒，从包入口导出", () => {
    expect(REMOTE_GIT_TIMEOUT_MS).toBe(120_000);
    expect(pub.REMOTE_GIT_TIMEOUT_MS).toBe(120_000);
    expect(pub.GitTimeoutError).toBe(GitTimeoutError);
    expect(gitTimeoutMs({ remote: true })).toBe(120_000);
    expect(gitTimeoutMs({})).toBe(30_000);
    expect(gitTimeoutMs({ remote: true, timeoutMs: 0 })).toBe(0);
  });

  it("挂住的远程 git 到时抛 GitTimeoutError，以子进程退出为准，不等孙进程关管道", async () => {
    const { e, ms } = await elapsed(git(root, HANG_REMOTE, { remote: true, timeoutMs: 200 }));
    expect(e).toBeInstanceOf(GitTimeoutError);
    expect(e).toBeInstanceOf(GitError);
    expect(e).toMatchObject({ code: null, timeout_ms: 200 });
    expect(ms).toBeLessThan(5_000);
  });

  it("外部 signal 中止：立刻 kill，原样抛 signal.reason", async () => {
    const ctl = new AbortController();
    const reason = new Error("stop");
    setTimeout(() => ctl.abort(reason), 100);
    const { e, ms } = await elapsed(
      git(root, HANG_REMOTE, { remote: true, timeoutMs: 0, signal: ctl.signal }),
    );
    expect(e).toBe(reason);
    expect(ms).toBeLessThan(5_000);
  });
});

describe("本地 git 超时：行为不变（T-110）", () => {
  it("超时仍是 GitError（code null、信息格式不变），不带 retryable", async () => {
    const { e } = await elapsed(git(root, ["hash-object", "--stdin"], { timeoutMs: 200 }));
    expect(e).toBeInstanceOf(GitTimeoutError);
    expect(e).toBeInstanceOf(GitError);
    const g = e as GitTimeoutError;
    expect(g.code).toBeNull();
    expect(g.message).toBe("git hash-object --stdin 超时（200ms）");
    expect("retryable" in g).toBe(false);
  });
});

describe("本地 git 接 signal（T-110）", () => {
  it("只读命令：中止立刻 kill，抛 reason", async () => {
    const ctl = new AbortController();
    const reason = new Error("stop");
    setTimeout(() => ctl.abort(reason), 100);
    const { e, ms } = await elapsed(
      git(root, ["hash-object", "--stdin"], { timeoutMs: 0, signal: ctl.signal }),
    );
    expect(e).toBe(reason);
    expect(ms).toBeLessThan(5_000);
  });

  it("withGitSignal：其中的 git 默认带上这个 signal", async () => {
    const ctl = new AbortController();
    const reason = new Error("stop");
    setTimeout(() => ctl.abort(reason), 100);
    const p = withGitSignal(ctl.signal, () =>
      git(root, ["hash-object", "--stdin"], { timeoutMs: 0 }),
    );
    await expect(p).rejects.toBe(reason);
  });

  it("写命令：已开始的不因中止被 kill（只受超时限制）", async () => {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(new Error("stop")), 50);
    const { e } = await elapsed(git(root, ["apply"], { timeoutMs: 400, signal: ctl.signal }));
    expect(e).toBeInstanceOf(GitTimeoutError);
  });

  it("写命令：signal 已中止时不执行", async () => {
    const ctl = new AbortController();
    const reason = new Error("already");
    ctl.abort(reason);
    await writeFile(join(root, "a.txt"), "1\n");
    await expect(git(root, ["add", "a.txt"], { signal: ctl.signal })).rejects.toBe(reason);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" })).toBe(
      "?? a.txt\n",
    );
  });

  it("只读的 status 不刷新索引（--no-optional-locks）", async () => {
    await writeFile(join(root, "a.txt"), "1\n");
    execFileSync("git", ["add", "a.txt"], { cwd: root });
    // 让索引里记的 stat 过期（内容不变），普通 status 会顺手重写索引
    const future = new Date(Date.now() + 60_000);
    await utimes(join(root, "a.txt"), future, future);
    const index = join(root, ".git", "index");
    const before = (await stat(index)).mtimeMs;
    await new Promise((r) => setTimeout(r, 50));
    await git(root, ["status", "--porcelain"]);
    expect((await stat(index)).mtimeMs).toBe(before);
  });
});

describe("包入口（T-110）", () => {
  it("mergeCommitContaining 不再公开导出", () => {
    expect("mergeCommitContaining" in pub).toBe(false);
  });
});
