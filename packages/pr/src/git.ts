import { execFile } from "node:child_process";

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

/** 用 execFile 调 git（不经 shell）。allowCodes 内的非零退出码不抛错。 */
export function git(
  cwd: string,
  args: readonly string[],
  opts: { allowCodes?: readonly number[]; env?: NodeJS.ProcessEnv } = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      { cwd, env: { ...process.env, ...opts.env }, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : null) : 0;
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
      },
    );
  });
}
