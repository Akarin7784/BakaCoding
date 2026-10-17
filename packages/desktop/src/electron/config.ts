import path from "node:path";

/** 数据库路径的环境变量名。 */
export const DB_PATH_ENV = "BAKACODING_DB_PATH";
/** 默认路径（相对项目根目录），与模块 2 README 一致。 */
export const DEFAULT_DB_RELATIVE = path.join(".bakacoding", "bakacoding.db");

/**
 * 解析数据库路径，优先级：命令行 `--db=<path>` / `--db <path>` > 环境变量 BAKACODING_DB_PATH >
 * `<cwd>/.bakacoding/bakacoding.db`。相对路径按 cwd 解析。
 */
export function resolveDbPath(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): string {
  let fromArg: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--db=")) fromArg = a.slice("--db=".length);
    else if (a === "--db" && argv[i + 1] !== undefined) fromArg = argv[i + 1];
  }
  const p = fromArg || env[DB_PATH_ENV] || DEFAULT_DB_RELATIVE;
  return path.resolve(cwd, p);
}
