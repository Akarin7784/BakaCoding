import { execFile } from "node:child_process";
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
   * （保留 `GIT_SSH_COMMAND`、`GIT_ASKPASS` 等），不加超时，行为与 T-097 之前一致。
   * 默认 false：本地仓库操作，环境用模块 4 的 `gitEnv()`（剔掉继承的 `GIT_*`）。
   */
  remote?: boolean;
  /**
   * 超时毫秒数，0 表示不限。本地操作默认 `REPO_GIT_TIMEOUT_MS`（30 秒）；
   * 远程操作默认不限。会跑用户 hook 的 commit 由调用方传 0。
   */
  timeoutMs?: number;
}

/**
 * 用 execFile 调 git（不经 shell）。allowCodes 内的非零退出码不抛错。
 * 本地操作的环境用 `gitEnv()`：继承的 `GIT_DIR`、`GIT_WORK_TREE`、`GIT_INDEX_FILE`
 * 等不会把操作带到别的仓库或索引上（T-097）。
 */
export function git(
  cwd: string,
  args: readonly string[],
  opts: GitOptions = {},
): Promise<GitResult> {
  const env = opts.remote ? { ...process.env, ...opts.env } : gitEnv(opts.env);
  const timeout = opts.timeoutMs ?? (opts.remote ? 0 : REPO_GIT_TIMEOUT_MS);
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      { cwd, env, timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null;
        const timedOut = !!e && timeout > 0 && (e.killed === true || e.signal === "SIGTERM");
        const code = e ? (typeof e.code === "number" ? e.code : null) : 0;
        if (!timedOut && (code === 0 || (code !== null && opts.allowCodes?.includes(code)))) {
          resolve({ stdout, stderr, code: code ?? 0 });
          return;
        }
        reject(
          new GitError(
            timedOut
              ? `git ${args.join(" ")} 超时（${String(timeout)}ms）`
              : `git ${args.join(" ")} 失败（退出码 ${String(code)}）：${stderr.trim()}`,
            args,
            timedOut ? null : code,
            stderr,
            stdout,
          ),
        );
      },
    );
  });
}
