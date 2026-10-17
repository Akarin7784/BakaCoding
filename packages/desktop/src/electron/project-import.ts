// T-072：导入项目——检查目录（config/models.json、config/pricing.json 及其内容；UI-03b 起不是 git 仓库也能导入，
// T-113 起本仓库的配置缺了或不合法也能导入，导入后在准备页生成），
// 然后由 BackendSwitcher 拆掉旧后端、在新仓库上重新组装，再用新后端的总线调 3 的 importProject。
import { existsSync } from "node:fs";
import path from "node:path";
import { DB_PATH_ENV, REPO_ENV } from "./backend.js";
import {
  type ConfigSource,
  configFixable,
  configSource,
  IMPORT_REASON_MAX,
  inspectConfig,
  inspectModels,
  resolveConfigPath,
} from "./config-inspect.js";
import { sanitizeSyncErrorMessage } from "./sync-state.js";

export {
  type ConfigSource,
  configFixable,
  configSource,
  IMPORT_REASON_MAX,
  inspectConfig,
  jsonParseErrorText,
  MAX_CONFIG_ERRORS,
  MODELS_FILE,
  PRICING_FILE,
} from "./config-inspect.js";

/** 「不是 git 仓库」看的目录（UI-03b 起只用来给 notGit，不再进 missing） */
export const GIT_DIR = ".git";

/** `--db` 的值（与 backend.resolveRepoDbPath 同一解析：取最后一个） */
function dbArg(argv: readonly string[]): string | undefined {
  let v: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--db=")) v = a.slice("--db=".length);
    else if (a === "--db" && argv[i + 1] !== undefined) v = argv[i + 1];
  }
  return v || undefined;
}

/**
 * 不允许导入切换的情况：`--repo` / BAKACODING_REPO 指定了仓库；或 `--db` / BAKACODING_DB_PATH 是绝对路径
 * （所有仓库会共用一个库）。相对的库路径在每个仓库里解析，不锁。`--db` 优先于环境变量。
 */
export function repoLockedBy(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): "arg" | "env" | "db_arg" | "db_env" | null {
  if (argv.some((a) => a === "--repo" || a.startsWith("--repo="))) return "arg";
  if (env[REPO_ENV]) return "env";
  const db = dbArg(argv);
  if (db) return path.isAbsolute(db) ? "db_arg" : null;
  const fromEnv = env[DB_PATH_ENV];
  if (fromEnv && path.isAbsolute(fromEnv)) return "db_env";
  return null;
}

export const REPO_LOCKED_REASON =
  "仓库已被启动参数 / 环境变量锁定（--repo、BAKACODING_REPO，或绝对路径的 --db、BAKACODING_DB_PATH），不能在界面里切换项目";

/** notGit（UI-03b）：配置都对、只是还不是 Git 仓库——照样导入，导入后进项目准备页初始化 */
/** configNeedsPrep（T-113）：本仓库的配置缺了或不合法——照样导入，导入后在准备页「生成配置」 */
export type DirCheck =
  | { ok: true; note?: string; notGit?: true; configNeedsPrep?: true }
  | { ok: false; missing?: string[]; reason?: string };

/** 用了另外指定的配置时给用户的说明（导入结果 / 提示里都带上） */
export function envConfigNote(
  configPath: string,
  source: ConfigSource = "BAKACODING_CONFIG",
): string {
  return `当前使用 ${source} 指定的配置：${configPath}`;
}

/**
 * 导入前检查。配置路径用后端同一个 resolveConfigPath（`--config` > BAKACODING_CONFIG > `<dir>/config/models.json`，
 * 相对路径相对所选目录）；用了另外指定的配置时结果里写明来源。错误信息先换密钥值、再 redact(light)、截断。
 * T-113：本仓库的 config/models.json、config/pricing.json 缺了或不合法不再拦导入（configNeedsPrep，导入后在准备页
 * 「生成配置」）；只有另外指定的 models 配置缺了或不合法还拒绝（准备页不改别处的文件）。
 */
export function checkProjectDir(
  dir: string,
  env: Readonly<Record<string, string | undefined>> = {},
  argv: readonly string[] = [],
): DirCheck {
  const source = configSource(argv, env);
  const models = resolveConfigPath(argv, env, dir);
  const note = source ? envConfigNote(models, source) : undefined;
  const clean = (text: string) => sanitizeSyncErrorMessage(text, env, IMPORT_REASON_MAX);
  // UI-03b：不是 Git 仓库不再拒绝导入（导入后在项目准备页初始化）
  const notGit = !existsSync(path.join(dir, GIT_DIR));

  if (source) {
    if (!existsSync(models))
      return {
        ok: false,
        reason: clean(`当前使用 ${source} 指定的配置，但文件不存在：${models}`),
      };
    const m = inspectModels(models, `${source}（${models}）`);
    if (m.state !== "ok") return { ok: false, reason: clean([...m.errors, note].join("\n")) };
  }
  const c = inspectConfig(dir, env, argv);
  const needsPrep = configFixable(c);
  return {
    ok: true,
    ...(note !== undefined && { note: clean(note) }),
    ...(notGit && { notGit: true as const }),
    ...(needsPrep && { configNeedsPrep: true as const }),
  };
}
