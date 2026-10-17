// T-072：导入项目——检查目录（config/models.json、config/pricing.json 及其内容；UI-03b 起不是 git 仓库也能导入），
// 然后由 BackendSwitcher 拆掉旧后端、在新仓库上重新组装，再用新后端的总线调 3 的 importProject。
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ConfigError, loadPricing, validate } from "@bakacoding/config-budget";
import { CONFIG_ENV, DB_PATH_ENV, REPO_ENV, resolveConfigPath } from "./backend.js";
import { sanitizeSyncErrorMessage } from "./sync-state.js";

export const MODELS_FILE = "config/models.json";
export const PRICING_FILE = "config/pricing.json";
/** 「不是 git 仓库」看的目录（UI-03b 起只用来给 notGit，不再进 missing） */
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

/** notGit（UI-03b）：配置都对、只是还不是 Git 仓库——照样导入，导入后进项目准备页初始化 */
export type DirCheck =
  { ok: true; note?: string; notGit?: true } | { ok: false; missing?: string[]; reason?: string };

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
 * JSON 解析失败的说明（T-100，同 3 的 T-098 做法）：不拼 `e.message`（Node 的报错会带出原文片段），
 * 只从里面取字符位置换成行列号；取不到就只说不是合法 JSON。
 */
export function jsonParseErrorText(text: string, e: unknown, subject: string): string {
  const m = /\bposition (\d+)\b/.exec(e instanceof Error ? e.message : "");
  if (!m) return `${subject} 不是合法 JSON`;
  const pos = Math.min(Number(m[1]), text.length);
  const before = text.slice(0, pos).split("\n");
  return `${subject} 不是合法 JSON（第 ${before.length} 行第 ${before[before.length - 1]!.length + 1} 列）`;
}

/** 读文件失败只留错误码（T-100：Node 的 message 里带完整路径）。 */
function readErrorCode(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "unknown";
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
  // UI-03b：不是 Git 仓库不再拒绝导入（导入后在项目准备页初始化），只看配置
  const notGit = !existsSync(path.join(dir, GIT_DIR));
  const pricing = path.join(dir, PRICING_FILE);
  if (!source && !existsSync(models)) missing.push(MODELS_FILE);
  if (!existsSync(pricing)) missing.push(PRICING_FILE);
  const envMissing = !!source && !existsSync(models);
  if (missing.length || envMissing) {
    const names = missing.map((m) => `缺少 ${m}`);
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
  // T-100：读不到只报错误码，坏 JSON 只报行列号，都不拼 e.message
  let text: string | undefined;
  try {
    text = readFileSync(models, "utf8");
  } catch (e) {
    errors.push(`${modelsLabel} 读取失败（${readErrorCode(e)}）`);
  }
  if (text !== undefined) {
    let raw: unknown;
    let parsed = false;
    try {
      raw = JSON.parse(text);
      parsed = true;
    } catch (e) {
      errors.push(jsonParseErrorText(text, e, modelsLabel));
    }
    if (parsed) errors.push(...validate(raw).map((e) => `${modelsLabel}：${e}`));
  }
  try {
    loadPricing(pricing);
  } catch (e) {
    // T-100：3 的 loadPricing（T-099）抛的 ConfigError 各条已脱敏，原样用；别的错误只说校验失败
    errors.push(
      e instanceof ConfigError
        ? `${PRICING_FILE} 校验失败：${e.errors.join("；")}`
        : `${PRICING_FILE} 校验失败`,
    );
  }
  if (errors.length) {
    if (note) errors.push(note);
    return { ok: false, reason: clean(errors.join("\n")) };
  }
  return {
    ok: true,
    ...(note !== undefined && { note: clean(note) }),
    ...(notGit && { notGit: true as const }),
  };
}
