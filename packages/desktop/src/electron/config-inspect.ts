// T-113：配置文件的路径解析与检查（导入、启动只读原因、准备页「生成配置」共用）。
// 从 project-import / backend 挪出来，免得两边互相 import；那两个文件照旧再导出原来的名字。
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ConfigError, loadPricing, validate } from "@bakacoding/config-budget";
import type { DesktopConfigCheck, DesktopConfigFileState } from "../shared/api.js";
import { sanitizeSyncErrorMessage } from "./sync-state.js";

/** 配置路径：`--config` > BAKACODING_CONFIG > `<repo>/config/models.json` */
export const CONFIG_ENV = "BAKACODING_CONFIG";
export const MODELS_FILE = "config/models.json";
export const PRICING_FILE = "config/pricing.json";
/** 导入错误信息上限 */
export const IMPORT_REASON_MAX = 2000;

export function resolveConfigPath(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  repoRoot: string,
): string {
  let fromArg: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--config=")) fromArg = a.slice("--config=".length);
    else if (a === "--config" && argv[i + 1] !== undefined) fromArg = argv[i + 1];
  }
  const p = fromArg || env[CONFIG_ENV] || path.join("config", "models.json");
  return path.isAbsolute(p) ? p : path.resolve(repoRoot, p);
}

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
export function readErrorCode(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "unknown";
}

/** 一个配置文件的检查结果：state 之外 errors 是已脱敏前的字段错误（调用方再 clean） */
export interface FileIssues {
  state: DesktopConfigFileState;
  errors: string[];
}

/** 读 + 解析 + 3 的 validate（T-100：读不到只报错误码，坏 JSON 只报行列号，都不拼 e.message） */
export function inspectModels(file: string, label: string): FileIssues {
  if (!existsSync(file)) return { state: "missing", errors: [] };
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    return { state: "invalid", errors: [`${label} 读取失败（${readErrorCode(e)}）`] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { state: "invalid", errors: [jsonParseErrorText(text, e, label)] };
  }
  const errors = validate(raw).map((e) => `${label}：${e}`);
  return { state: errors.length ? "invalid" : "ok", errors };
}

export function inspectPricing(file: string): FileIssues {
  if (!existsSync(file)) return { state: "missing", errors: [] };
  try {
    loadPricing(file);
    return { state: "ok", errors: [] };
  } catch (e) {
    // T-100：3 的 loadPricing（T-099）抛的 ConfigError 各条已脱敏，原样用；别的错误只说校验失败
    return {
      state: "invalid",
      errors: [
        e instanceof ConfigError
          ? `${PRICING_FILE} 校验失败：${e.errors.join("；")}`
          : `${PRICING_FILE} 校验失败`,
      ],
    };
  }
}

/** 准备页「生成配置」项最多带几条错误 */
export const MAX_CONFIG_ERRORS = 20;

/**
 * T-113：两个配置文件的状态（准备页「生成配置」项、启动只读原因、导入都用这一个）。
 * models 路径同后端 resolveConfigPath；models_external 时准备页不生成 models.json。
 * errors 先换密钥值、再 redact(light)、截断，不含配置值。
 */
export function inspectConfig(
  dir: string,
  env: Readonly<Record<string, string | undefined>> = {},
  argv: readonly string[] = [],
  /** 价格表路径（后端的 pricingPath 选项；默认 `<dir>/config/pricing.json`） */
  pricingPath: string = path.join(dir, PRICING_FILE),
): DesktopConfigCheck {
  const source = configSource(argv, env);
  const modelsPath = resolveConfigPath(argv, env, dir);
  const m = inspectModels(modelsPath, source ? `${source}（${modelsPath}）` : MODELS_FILE);
  const p = inspectPricing(pricingPath);
  const clean = (text: string) => sanitizeSyncErrorMessage(text, env, IMPORT_REASON_MAX);
  return {
    models: m.state,
    pricing: p.state,
    models_external: !!source,
    errors: [...m.errors, ...p.errors].slice(0, MAX_CONFIG_ERRORS).map(clean),
  };
}

/** 准备页「生成配置」能修的状态：pricing 有问题，或 models 有问题且不是另外指定的 */
export function configFixable(c: DesktopConfigCheck): boolean {
  return c.pricing !== "ok" || (!c.models_external && c.models !== "ok");
}
