/** 每次 git 调用的默认超时（T-086 定义；T-094 起挪到这里，repo.ts 原样再导出，worktree / cleanup 共用）。 */
export const REPO_GIT_TIMEOUT_MS = 30_000;

/**
 * 子进程跑 git 用的环境变量（T-086）：先剔掉继承来的所有 `GIT_` 开头的变量
 * （`GIT_DIR`、`GIT_WORK_TREE`、`GIT_INDEX_FILE`、`GIT_AUTHOR_*` / `GIT_COMMITTER_*`、
 * `GIT_CONFIG_*` 等会改变目标仓库、身份或配置），再加上固定的
 * `GIT_TERMINAL_PROMPT=0`、`LC_ALL=C` 和调用方显式给的 `extra`。
 * 只用于本地仓库操作（检查、建仓、提交、worktree、清理）：剔掉 `GIT_` 变量后也去掉了
 * `GIT_SSH_COMMAND`、`GIT_ASKPASS` 等，需要访问远程（fetch / push）的调用不要用它。
 * 模块 4 和其它直接调 git 操作本地仓库的地方都用它。
 */
export function gitEnv(
  extra: NodeJS.ProcessEnv = {},
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (!k.toUpperCase().startsWith("GIT_")) env[k] = v;
  }
  return { ...env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", ...extra };
}
