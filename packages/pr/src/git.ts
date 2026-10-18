import { AsyncLocalStorage } from "node:async_hooks";
import { spawn, type ChildProcess } from "node:child_process";
import { gitEnv, REPO_GIT_TIMEOUT_MS } from "@bakacoding/workspace";

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly code: number | null,
    readonly stderr: string,
    readonly stdout: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

/**
 * git 超时（T-110）：本地默认 `REPO_GIT_TIMEOUT_MS`，远程默认 `REMOTE_GIT_TIMEOUT_MS`。
 * `code` 为 null、信息格式与 T-110 之前的超时 GitError 相同；不带 `retryable`（与之前一致，调用方行为不变）。
 */
export class GitTimeoutError extends GitError {
  constructor(
    args: readonly string[],
    readonly timeout_ms: number,
    stderr: string,
    stdout: string,
  ) {
    super(`git ${args.join(" ")} 超时（${String(timeout_ms)}ms）`, args, null, stderr, stdout);
    this.name = "GitTimeoutError";
  }
}

/** 远程 git（fetch / push / ls-remote）默认超时（T-110）：要传对象、走 ssh / 凭据助手，比本地 30 秒长。 */
export const REMOTE_GIT_TIMEOUT_MS = 120_000;
/** 超时 / 中止时先 SIGTERM，这么久之后子进程还没退出就 SIGKILL。 */
export const GIT_KILL_GRACE_MS = 5_000;

/**
 * 结束 git 子进程及整棵进程树（T-123）。Windows 上 git 会派生 ssh / git-remote-ext 等孙进程
 * （远程 git 和 `ext::` 传输都有），`child.kill()` 只终止直接子进程，孙进程会残留：继续跑、继续
 * 占着 stdio 管道。Windows 没有优雅信号，直接用 `taskkill /PID <pid> /T /F` 结束整棵树；
 * taskkill 起不来（PATH 异常等）时退回 `child.kill()`。POSIX 行为不变：SIGTERM → SIGKILL。
 */
function endProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (process.platform === "win32" && typeof pid === "number") {
    try {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.on("error", () => {
        try {
          child.kill(signal);
        } catch {
          // 进程已经退出
        }
      });
      killer.unref();
      return;
    } catch {
      // 退回到直接 kill
    }
  }
  child.kill(signal);
}

/**
 * 写命令（T-110）：会改索引、ref 或工作区，中途被 kill 可能留下 index.lock 或改了一半的 ref。
 * 带 signal 时只在执行前检查，已开始就跑完（仍受超时限制）。其余本地命令视为只读：收到中止立刻 kill，
 * 并加 `--no-optional-locks`（status / diff 不顺手刷新索引、不拿 index.lock）。
 */
const WRITE_COMMANDS = new Set([
  "add",
  "apply",
  "commit",
  "commit-tree",
  "update-ref",
  "merge",
  "reset",
]);

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface GitOptions {
  allowCodes?: readonly number[];
  /** 额外的环境变量，叠加在基础环境之上（如提交身份 `GIT_AUTHOR_*`）。 */
  env?: NodeJS.ProcessEnv;
  /**
   * 访问远程的调用（fetch / push / ls-remote）设为 true：沿用继承的 process.env
   * （保留 `GIT_SSH_COMMAND`、`GIT_ASKPASS` 等），默认超时 `REMOTE_GIT_TIMEOUT_MS`（T-110）。
   * 默认 false：本地仓库操作，环境用模块 4 的 `gitEnv()`（剔掉继承的 `GIT_*`）。
   */
  remote?: boolean;
  /**
   * 超时毫秒数，0 表示不限。本地操作默认 `REPO_GIT_TIMEOUT_MS`（30 秒）；
   * 远程操作默认 `REMOTE_GIT_TIMEOUT_MS`（120 秒）。会跑用户 hook 的 commit 由调用方传 0。
   */
  timeoutMs?: number;
  /** 外部取消（T-110）；不传时取 `withGitSignal` 设下的当前 signal。中止时抛 `signal.reason`。 */
  signal?: AbortSignal;
  /**
   * stdout / stderr 各自的字节上限，默认 64 MiB（同 T-110 之前 execFile 的 maxBuffer）。超出时 kill 子进程，
   * 抛 GitError：`code: null`，信息 `git … 失败（退出码 null）：<stderr>`，stdout / stderr 截到上限（与 execFile 一致）。
   */
  maxBuffer?: number;
}

const currentSignal = new AsyncLocalStorage<AbortSignal | undefined>();

/**
 * 在 fn（含其中所有异步续延）里调用的 git 默认带上这个 signal（T-110）。每次调用各自一份上下文，
 * 并发的调用互不影响。signal 为 undefined 时沿用外层上下文：公开方法里再调另一个公开方法而没传 signal，
 * 内层的 git 仍受外层调用的 signal 约束（内层是外层工作的一部分）。
 */
export function withGitSignal<T>(
  signal: AbortSignal | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return signal ? currentSignal.run(signal, fn) : fn();
}

function abortError(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const e = new Error("已取消");
  e.name = "AbortError";
  return e;
}

/** 这次调用的超时：显式 timeoutMs，否则远程 REMOTE_GIT_TIMEOUT_MS、本地 REPO_GIT_TIMEOUT_MS。 */
export function gitTimeoutMs(opts: Pick<GitOptions, "remote" | "timeoutMs">): number {
  return opts.timeoutMs ?? (opts.remote ? REMOTE_GIT_TIMEOUT_MS : REPO_GIT_TIMEOUT_MS);
}

const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * 一个输出流的收集器（内部，导出仅供测试）。与 execFile 的 maxBuffer 一致（实测）：累计超过 limit 时
 * 保留到 limit 为止的部分并调 onOverflow（kill）；累计恰好等于 limit 且之后没有数据不算超出；
 * 恰好等于 limit 之后再来任何数据都算超出。超出之后的数据丢弃。
 */
export function collectInto(
  into: Buffer[],
  limit: number,
  onOverflow: () => void,
): (b: Buffer) => void {
  let size = 0;
  let over = false;
  return (b) => {
    if (over) return;
    if (size + b.length > limit) {
      into.push(b.subarray(0, limit - size));
      size = limit;
      over = true;
      onOverflow();
      return;
    }
    into.push(b);
    size += b.length;
  };
}

/**
 * 调 git（spawn，不经 shell）。allowCodes 内的非零退出码不抛错。
 * 本地操作的环境用 `gitEnv()`：继承的 `GIT_DIR`、`GIT_WORK_TREE`、`GIT_INDEX_FILE`
 * 等不会把操作带到别的仓库或索引上（T-097）。
 * 超时 / 中止（T-110）：SIGTERM，`GIT_KILL_GRACE_MS` 后仍未退出再 SIGKILL；Windows 上连同整棵进程树一起
 * 结束（T-123，`taskkill /T /F`，避免 git 派生的 ssh 等孙进程残留）；以子进程退出为准，不等 stdio 关闭。
 */
export function git(
  cwd: string,
  args: readonly string[],
  opts: GitOptions = {},
): Promise<GitResult> {
  const env = opts.remote ? { ...process.env, ...opts.env } : gitEnv(opts.env);
  const timeout = gitTimeoutMs(opts);
  const signal = opts.signal ?? currentSignal.getStore();
  const write = !opts.remote && WRITE_COMMANDS.has(args[0] ?? "");
  if (signal?.aborted) return Promise.reject(abortError(signal));
  const argv = opts.remote || write ? [...args] : ["--no-optional-locks", ...args];
  return new Promise((resolve, reject) => {
    const child = spawn("git", argv, { cwd, env, windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const limit = opts.maxBuffer ?? MAX_BUFFER;
    let killedFor: "timeout" | "abort" | "buffer" | undefined;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let grace: NodeJS.Timeout | undefined;
    const text = (b: Buffer[]) => Buffer.concat(b).toString("utf8");
    const onAbort = () => kill("abort");
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (grace) clearTimeout(grace);
      if (signal && !write) signal.removeEventListener("abort", onAbort);
    };
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const fail = () => {
      if (killedFor === "abort" && signal) return reject(abortError(signal));
      if (killedFor === "timeout")
        return reject(new GitTimeoutError(args, timeout, text(err), text(out)));
      const stderr = text(err);
      reject(
        new GitError(
          `git ${args.join(" ")} 失败（退出码 null）：${stderr.trim()}`,
          args,
          null,
          stderr,
          text(out),
        ),
      );
    };
    function kill(why: "timeout" | "abort" | "buffer") {
      if (killedFor || settled) return;
      killedFor = why;
      // T-123：Windows 上要结束整棵进程树，否则 ssh 等孙进程会残留
      endProcessTree(child, "SIGTERM");
      grace = setTimeout(() => endProcessTree(child, "SIGKILL"), GIT_KILL_GRACE_MS);
      grace.unref?.();
    }
    child.stdout.on(
      "data",
      collectInto(out, limit, () => kill("buffer")),
    );
    child.stderr.on(
      "data",
      collectInto(err, limit, () => kill("buffer")),
    );
    if (timeout > 0) timer = setTimeout(() => kill("timeout"), timeout);
    if (signal && !write) signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) =>
      settle(() =>
        reject(new GitError(`git ${args.join(" ")} 启动失败：${e.message}`, args, null, "", "")),
      ),
    );
    // 被 kill 的：子进程一退出就结束，不等孙进程关管道
    child.on("exit", () => {
      if (killedFor) settle(fail);
    });
    child.on("close", (code) => {
      if (killedFor) return settle(fail);
      settle(() => {
        const stdout = text(out);
        const stderr = text(err);
        if (code === 0 || (code !== null && opts.allowCodes?.includes(code))) {
          resolve({ stdout, stderr, code: code ?? 0 });
          return;
        }
        reject(
          new GitError(
            `git ${args.join(" ")} 失败（退出码 ${String(code)}）：${stderr.trim()}`,
            args,
            code,
            stderr,
            stdout,
          ),
        );
      });
    });
  });
}
