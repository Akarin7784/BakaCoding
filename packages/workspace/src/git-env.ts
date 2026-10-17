/**
 * 子进程跑 git 用的环境变量（T-086）：先剔掉继承来的所有 `GIT_` 开头的变量
 * （`GIT_DIR`、`GIT_WORK_TREE`、`GIT_INDEX_FILE`、`GIT_AUTHOR_*` / `GIT_COMMITTER_*`、
 * `GIT_CONFIG_*` 等会改变目标仓库、身份或配置），再加上固定的
 * `GIT_TERMINAL_PROMPT=0`、`LC_ALL=C` 和调用方显式给的 `extra`。
 * 模块 4 和其它直接调 git 的地方都用它。
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
