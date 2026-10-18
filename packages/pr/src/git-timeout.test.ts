import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as pub from "./index.js";
import {
  collectInto,
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

describe("Windows：超时 / 中止结束整棵进程树（T-123）", () => {
  const isWin = process.platform === "win32";
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const killTree = (pid: number) => {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // 已经退出
    }
  };
  const until = async (cond: () => boolean, ms = 5_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (cond()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return cond();
  };
  /**
   * git 用 sh 别名派生一个 node 孙进程并挂住；孙进程把自己的 Windows PID 写进 grandchild.pid
   * （sh 的 `$!` 是 MSYS 虚拟 PID，和 Windows 原生 PID 对不上，所以让 node 自己写）。
   */
  const spawnTree = async () => {
    await writeFile(
      join(root, "tree.sh"),
      "node -e \"require('node:fs').writeFileSync('grandchild.pid', String(process.pid)); setTimeout(()=>{},300000)\" &\nwait\n",
    );
    return join(root, "grandchild.pid");
  };
  const pidFileOf = async (node: string) => Number((await readFile(node, "utf8")).trim());

  // 时间余量给足（T-123 评审 P2）：高负载机器上 sh/node 启动可能很慢，别因为等不到 pid 文件假红。
  it.skipIf(!isWin)(
    "超时：孙进程也被结束，不在后台残留",
    async () => {
      const pidFile = await spawnTree();
      const settled = git(root, ["-c", "alias.tree=!sh tree.sh", "tree"], {
        timeoutMs: 12_000,
      }).catch((e: unknown) => e);
      let gpid = 0;
      try {
        expect(await until(() => existsSync(pidFile), 8_000)).toBe(true);
        gpid = await pidFileOf(pidFile);
        expect(gpid).toBeGreaterThan(0);
        expect(alive(gpid)).toBe(true);
        const e = await settled;
        expect(e).toBeInstanceOf(GitTimeoutError);
        expect(await until(() => !alive(gpid), 8_000)).toBe(true);
      } finally {
        if (gpid > 0 && alive(gpid)) killTree(gpid);
      }
    },
    40_000,
  );

  it.skipIf(!isWin)(
    "中止：同样结束整棵进程树，原样抛 signal.reason",
    async () => {
      const pidFile = await spawnTree();
      const ctl = new AbortController();
      const reason = new Error("stop");
      const settled = git(root, ["-c", "alias.tree=!sh tree.sh", "tree"], {
        timeoutMs: 0,
        signal: ctl.signal,
      }).catch((e: unknown) => e);
      let gpid = 0;
      try {
        expect(await until(() => existsSync(pidFile), 8_000)).toBe(true);
        gpid = await pidFileOf(pidFile);
        expect(alive(gpid)).toBe(true);
        ctl.abort(reason);
        expect(await settled).toBe(reason);
        expect(await until(() => !alive(gpid), 8_000)).toBe(true);
      } finally {
        if (gpid > 0 && alive(gpid)) killTree(gpid);
      }
    },
    40_000,
  );
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

describe("输出上限（同 T-110 之前 execFile 的 maxBuffer）", () => {
  const YES = ["-c", "alias.y=!yes", "y"];
  for (const remote of [false, true]) {
    it(`${remote ? "远程" : "本地"}路径：超出上限 kill 子进程，抛 GitError（code null、退出码 null 文案），stdout 截到上限`, async () => {
      const { e, ms } = await elapsed(git(root, YES, { remote, maxBuffer: 1000, timeoutMs: 0 }));
      expect(e).toBeInstanceOf(GitError);
      expect(e).not.toBeInstanceOf(GitTimeoutError);
      const g = e as GitError;
      expect(g.code).toBeNull();
      expect(g.message).toBe(`git ${YES.join(" ")} 失败（退出码 null）：`);
      expect(g.stdout.length).toBe(1000);
      expect(ms).toBeLessThan(5_000);
    });
  }
});

describe("输出上限边界（与 execFile 一致，实测）", () => {
  const buf = (n: number) => Buffer.alloc(n, 0x61);
  const run = (chunks: number[], limit = 10) => {
    const into: Buffer[] = [];
    let overflows = 0;
    const push = collectInto(into, limit, () => overflows++);
    for (const n of chunks) push(buf(n));
    return { overflows, size: Buffer.concat(into).length };
  };
  it("累计恰好等于上限、之后没有数据：不算超出", () => {
    expect(run([10])).toEqual({ overflows: 0, size: 10 });
    expect(run([4, 6])).toEqual({ overflows: 0, size: 10 });
  });
  it("累计恰好等于上限之后还有数据：算超出（kill），保留到上限", () => {
    expect(run([10, 1])).toEqual({ overflows: 1, size: 10 });
    expect(run([4, 6, 3])).toEqual({ overflows: 1, size: 10 });
  });
  it("跨过上限的块：截到上限；超出之后的数据丢弃，只 kill 一次", () => {
    expect(run([7, 5, 9, 9])).toEqual({ overflows: 1, size: 10 });
  });
  for (const remote of [false, true]) {
    for (const n of [10, 70_000]) {
      it(`端到端（${remote ? "远程" : "本地"}路径）：cat-file 读 上限+${n} 字节的 blob，抛 GitError 而不是返回截断的 stdout`, async () => {
        const limit = 65_536;
        await writeFile(join(root, "big.bin"), buf(limit + n));
        const sha = execFileSync("git", ["hash-object", "-w", "big.bin"], {
          cwd: root,
          encoding: "utf8",
        }).trim();
        const args = ["cat-file", "blob", sha];
        const e = await git(root, args, { remote, maxBuffer: limit, timeoutMs: 0 }).catch(
          (x: unknown) => x,
        );
        expect(e).toBeInstanceOf(GitError);
        expect((e as GitError).code).toBeNull();
        expect((e as GitError).message).toBe(`git ${args.join(" ")} 失败（退出码 null）：`);
        expect((e as GitError).stdout.length).toBe(limit);
      });
    }
  }
  it("端到端：输出恰好等于上限时正常返回", async () => {
    await writeFile(join(root, "eq.bin"), buf(1000));
    const sha = execFileSync("git", ["hash-object", "-w", "eq.bin"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const r = await git(root, ["cat-file", "blob", sha], { maxBuffer: 1000 });
    expect(r.stdout.length).toBe(1000);
  });
});

describe("包入口（T-110）", () => {
  it("mergeCommitContaining 不再公开导出", () => {
    expect("mergeCommitContaining" in pub).toBe(false);
  });
});
