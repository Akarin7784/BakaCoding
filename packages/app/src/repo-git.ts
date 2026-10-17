// T-101：组合根内部的 git 调用（原在 create-default-deps.ts，T-084）。不从 index 导出。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gitEnv, REPO_GIT_TIMEOUT_MS } from "@bakacoding/workspace";

const run = promisify(execFile);

/** 默认输出缓冲上限，同 Node `execFile` 的默认值（1 MiB）。 */
export const REPO_GIT_DEFAULT_MAX_BUFFER = 1024 * 1024;

export interface RepoGitOptions {
  /** stdout / stderr 缓冲上限（字节），默认 `REPO_GIT_DEFAULT_MAX_BUFFER`；超了 git 被杀、调用 reject */
  maxBuffer?: number;
}

/**
 * 组合根对用户仓库的 git 调用：cwd 为仓库，env 用模块 4 的 `gitEnv()`
 * （剔掉继承来的所有 `GIT_*`，再加 `GIT_TERMINAL_PROMPT=0`、`LC_ALL=C`），
 * 外部的 `GIT_DIR` / `GIT_WORK_TREE` 等不会把调用带到别的仓库；超时同模块 4 的 `REPO_GIT_TIMEOUT_MS`。
 * 不经 shell；stdout 按 utf8 解码。出错（含超时、超缓冲）照 execFile 的规则 reject。
 */
export async function repoGit(
  repoRoot: string,
  args: string[],
  options: RepoGitOptions = {},
): Promise<{ stdout: string }> {
  const { stdout } = await run("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: gitEnv(),
    timeout: REPO_GIT_TIMEOUT_MS,
    maxBuffer: options.maxBuffer ?? REPO_GIT_DEFAULT_MAX_BUFFER,
  });
  return { stdout };
}
