// T-072：导入项目——检查目录（git 仓库、config/models.json、config/pricing.json 及其内容），
// 然后由 BackendSwitcher 拆掉旧后端、在新仓库上重新组装，再用新后端的总线调 3 的 importProject。
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadPricing, validate } from "@bakacoding/config-budget";
import { CONFIG_ENV, DB_PATH_ENV, REPO_ENV } from "./backend.js";
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

/** 设了 BAKACODING_CONFIG 时给用户的说明（导入结果 / 提示里都带上） */
export function envConfigNote(configPath: string): string {
  return `当前使用 BAKACODING_CONFIG 指定的配置：${configPath}`;
}

/**
 * (a) git 仓库检查 + 配置文件是否存在；(b) 用 3 的 validate / loadPricing 校验内容。
 * 设了 BAKACODING_CONFIG 时不看仓库里的 config/models.json，改为校验它指向的文件（相对路径相对所选目录，
 * 与 backend.resolveConfigPath 一致），结果里写明在用它。错误信息先换密钥值、再 redact(light)、截断。
 */
export function checkProjectDir(
  dir: string,
  env: Readonly<Record<string, string | undefined>> = {},
): DirCheck {
  const fromEnv = env[CONFIG_ENV];
  const models = fromEnv
    ? path.isAbsolute(fromEnv)
      ? fromEnv
      : path.resolve(dir, fromEnv)
    : path.join(dir, MODELS_FILE);
  const modelsLabel = fromEnv ? `BAKACODING_CONFIG（${models}）` : MODELS_FILE;
  const note = fromEnv ? envConfigNote(models) : undefined;
  const clean = (text: string) => sanitizeSyncErrorMessage(text, env, IMPORT_REASON_MAX);

  const missing: string[] = [];
  if (!existsSync(path.join(dir, GIT_DIR))) missing.push(GIT_DIR);
  const pricing = path.join(dir, PRICING_FILE);
  if (!fromEnv && !existsSync(models)) missing.push(MODELS_FILE);
  if (!existsSync(pricing)) missing.push(PRICING_FILE);
  const envMissing = fromEnv !== undefined && !existsSync(models);
  if (missing.length || envMissing) {
    const names = missing.map((m) => (m === GIT_DIR ? "不是 git 仓库（没有 .git）" : `缺少 ${m}`));
    if (envMissing) names.push(`BAKACODING_CONFIG 指定的配置文件不存在：${models}`);
    if (note) names.push(note);
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
