import { randomBytes } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { ConfigSchema, SECRET_NAMES } from "./config.js";
import { PricingSchema } from "./pricing.js";
import { formatConfigIssue, schemaIssues } from "./safe-error.js";
import { redact } from "./redact.js";

export type WriteConfigResult = { ok: true } | { ok: false; errors: string[] };

export interface WriteConfigOptions {
  /** 用来比对“值等于当前密钥”的环境变量；默认 process.env。 */
  env?: NodeJS.ProcessEnv;
  /** 测试注入：替换 rename（默认 fs/promises 的 rename）。 */
  rename?: (from: string, to: string) => Promise<void>;
  /** 测试注入：重试等待（默认 setTimeout）。 */
  sleep?: (ms: number) => Promise<void>;
}

/** writeConfig 只允许写 models.json；pricing.json 走 writePricing，其它文件都不可写。 */
export const WRITABLE_CONFIG_FILE = "models.json" as const;
/** writePricing 只允许写 pricing.json（T-114）。 */
export const WRITABLE_PRICING_FILE = "pricing.json" as const;

const RENAME_RETRIES = 5;
const RENAME_RETRY_MS = 50;

/**
 * 找出配置里像密钥的字符串（键和值都查）。错误只含字段路径和规则名，不含原文。
 * 标准是 redact 的 light 规则（key/token/Bearer/env 密钥/邮箱/私钥/URL 凭据），
 * 外加“等于当前环境变量里的密钥值”。full 专属的 home 路径/IP/主机名不是密钥，
 * 而 base_url 填内网地址是正常用法，所以不拦。
 */
function envSecrets(env: NodeJS.ProcessEnv): string[] {
  return SECRET_NAMES.map((n) => env[n]?.trim()).filter((v): v is string => !!v && v.length >= 8);
}

/** 错误信息里可能带键名（字段路径、未知键提示），键名本身也可能是密钥：统一脱敏。 */
function sanitizeMessage(msg: string, secrets: string[]): string {
  let out = redact(msg, "light").text;
  for (const v of secrets) out = out.split(v).join("[REDACTED:env_secret_value]");
  return out;
}

export function findSecretLikeValues(raw: unknown, env: NodeJS.ProcessEnv = process.env): string[] {
  const secrets = envSecrets(env);
  const errors: string[] = [];
  const check = (s: string, path: string) => {
    const rules = Object.keys(redact(s, "light").report);
    if (secrets.some((v) => s.includes(v))) rules.push("env_secret_value");
    if (rules.length > 0) {
      errors.push(
        `${path || "(root)"}: 看起来像密钥（${rules.sort().join(", ")}），密钥只能放环境变量`,
      );
    }
  };
  const walk = (v: unknown, path: string) => {
    if (typeof v === "string") check(v, path);
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, path ? `${path}.${i}` : String(i)));
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        const p = path ? `${path}.${k}` : k;
        check(k, `${p}（键名）`);
        walk(x, p);
      }
    }
  };
  walk(raw, "");
  return errors.map((e) => sanitizeMessage(e, secrets));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 校验后原子写入模型配置：同目录临时文件 → fsync → rename。2 空格缩进、末尾换行。
 * 写入的是调用方给的原始对象（不展开默认值）。失败时原文件不变，临时文件会删掉。
 * 错误信息不含文件路径和配置值（校验错误见 formatConfigIssue，最后再脱敏一次）。
 */
export async function writeConfig(
  path: string,
  config: unknown,
  opts: WriteConfigOptions = {},
): Promise<WriteConfigResult> {
  if (basename(path) !== WRITABLE_CONFIG_FILE) {
    return { ok: false, errors: [`(file): 只能写 ${WRITABLE_CONFIG_FILE}`] };
  }
  const parsed = ConfigSchema.safeParse(config);
  const errors = parsed.success ? [] : parsed.error.issues.map(formatConfigIssue);
  return validatedWrite(path, WRITABLE_CONFIG_FILE, config, errors, opts);
}

/**
 * T-114：校验后原子写入价格表 pricing.json，写法与 writeConfig 相同（同目录临时文件 → fsync → rename，
 * 2 空格缩进、末尾换行，写调用方给的原始对象）。先过 PricingSchema，再查像密钥的值；
 * 失败时原文件不变，错误信息不含文件路径和配置值。
 */
export async function writePricing(
  path: string,
  pricing: unknown,
  opts: WriteConfigOptions = {},
): Promise<WriteConfigResult> {
  if (basename(path) !== WRITABLE_PRICING_FILE) {
    return { ok: false, errors: [`(file): 只能写 ${WRITABLE_PRICING_FILE}`] };
  }
  const parsed = PricingSchema.safeParse(pricing);
  const errors = parsed.success ? [] : schemaIssues(parsed.error.issues);
  return validatedWrite(path, WRITABLE_PRICING_FILE, pricing, errors, opts);
}

/** schema 错误和像密钥的值都没有时才写；错误统一再脱敏一次。 */
async function validatedWrite(
  path: string,
  file: string,
  value: unknown,
  schemaErrors: string[],
  opts: WriteConfigOptions,
): Promise<WriteConfigResult> {
  const secretErrors = findSecretLikeValues(value, opts.env);
  if (schemaErrors.length > 0 || secretErrors.length > 0) {
    const secrets = envSecrets(opts.env ?? process.env);
    return {
      ok: false,
      errors: [...schemaErrors.map((e) => sanitizeMessage(e, secrets)), ...secretErrors],
    };
  }
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const dir = dirname(path);
  const tmp = join(dir, `.${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    await mkdir(dir, { recursive: true });
    // 新文件按 0600 建，rename 后原文件的权限会被它覆盖（不保留原权限）。
    const fh = await open(tmp, "wx", 0o600);
    try {
      await fh.writeFile(text, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    // Windows 上目标文件正被别的进程读时 rename 会短暂 EPERM/EBUSY，重试几次。
    for (let i = 0; ; i++) {
      try {
        await (opts.rename ?? rename)(tmp, path);
        break;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (i >= RENAME_RETRIES || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES"))
          throw e;
        await (opts.sleep ?? sleep)(RENAME_RETRY_MS * (i + 1));
      }
    }
    return { ok: true };
  } catch (e) {
    await unlink(tmp).catch(() => {});
    const code = (e as NodeJS.ErrnoException).code ?? "unknown";
    return { ok: false, errors: [`(file): 写入配置失败（${code}）`] };
  }
}
