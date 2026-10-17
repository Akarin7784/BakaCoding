// T-072：导入项目——检查目录（git 仓库、config/models.json、config/pricing.json 及其内容），
// 然后由 BackendSwitcher 拆掉旧后端、在新仓库上重新组装，再用新后端的总线调 3 的 importProject。
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadPricing, validate } from "@bakacoding/config-budget";
import { CONFIG_ENV, DB_PATH_ENV, REPO_ENV, resolveConfigPath } from "./backend.js";
import { sanitizeSyncErrorMessage } from "./sync-state.js";

export const MODELS_FILE = "config/models.json";
export const PRICING_FILE = "config/pricing.json";
/** missing 里表示「不是 git 仓库」的项 */
export const GIT_DIR = ".git";
/** 导入错误信息上限 */
export const IMPORT_REASON_MAX = 2000;

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

export type DirCheck =
  { ok: true; note?: string } | { ok: false; missing?: string[]; reason?: string };

export type ConfigSource = "--config" | "BAKACODING_CONFIG";

/** 配置是不是用户另外指定的：`--config`（非空）优先于 BAKACODING_CONFIG（非空）；都没有为 null。 */
export function configSource(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): ConfigSource | null {
  let fromArg: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--config=")) fromArg = a.slice("--config=".length);
    else if (a === "--config" && argv[i + 1] !== undefined) fromArg = argv[i + 1];
  }
  if (fromArg) return "--config";
  if (env[CONFIG_ENV]) return "BAKACODING_CONFIG";
  return null;
}

/** 用了另外指定的配置时给用户的说明（导入结果 / 提示里都带上） */
export function envConfigNote(
  configPath: string,
  source: ConfigSource = "BAKACODING_CONFIG",
): string {
  return `当前使用 ${source} 指定的配置：${configPath}`;
}

/**
 * (a) git 仓库检查 + 配置文件是否存在；(b) 用 3 的 validate / loadPricing 校验内容。
 * 配置路径用后端同一个 resolveConfigPath（`--config` > BAKACODING_CONFIG > `<dir>/config/models.json`，
 * 相对路径相对所选目录）；用了另外指定的配置时结果里写明来源。错误信息先换密钥值、再 redact(light)、截断。
 */
export function checkProjectDir(
  dir: string,
  env: Readonly<Record<string, string | undefined>> = {},
  argv: readonly string[] = [],
): DirCheck {
  const source = configSource(argv, env);
  const models = resolveConfigPath(argv, env, dir);
  const modelsLabel = source ? `${source}（${models}）` : MODELS_FILE;
  const note = source ? envConfigNote(models, source) : undefined;
  const clean = (text: string) => sanitizeSyncErrorMessage(text, env, IMPORT_REASON_MAX);

  const missing: string[] = [];
  if (!existsSync(path.join(dir, GIT_DIR))) missing.push(GIT_DIR);
  const pricing = path.join(dir, PRICING_FILE);
  if (!source && !existsSync(models)) missing.push(MODELS_FILE);
  if (!existsSync(pricing)) missing.push(PRICING_FILE);
  const envMissing = !!source && !existsSync(models);
  if (missing.length || envMissing) {
    const names = missing.map((m) => (m === GIT_DIR ? "不是 git 仓库（没有 .git）" : `缺少 ${m}`));
    // 路径只写一次
    if (envMissing) names.push(`当前使用 ${source} 指定的配置，但文件不存在：${models}`);
    else if (note) names.push(note);
    return {
      ok: false,
      ...(missing.length && { missing }),
      reason: clean(names.join("；")),
    };
  }
  const errors: string[] = [];
  try {
    const errs = validate(JSON.parse(readFileSync(models, "utf8")));
    errors.push(...errs.map((e) => `${modelsLabel}：${e}`));
  } catch (e) {
    errors.push(`${modelsLabel} 读取失败：${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    loadPricing(pricing);
  } catch (e) {
    errors.push(`${PRICING_FILE} 校验失败：${e instanceof Error ? e.message : String(e)}`);
  }
  if (errors.length) {
    if (note) errors.push(note);
    return { ok: false, reason: clean(errors.join("\n")) };
  }
  return note ? { ok: true, note: clean(note) } : { ok: true };
}
