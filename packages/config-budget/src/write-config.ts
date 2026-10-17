import { randomBytes } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { SECRET_NAMES, validate } from "./config.js";
import { redact } from "./redact.js";

export type WriteConfigResult = { ok: true } | { ok: false; errors: string[] };

export interface WriteConfigOptions {
  /** 用来比对“值等于当前密钥”的环境变量；默认 process.env。 */
  env?: NodeJS.ProcessEnv;
}

/** 只允许写 models.json；pricing.json 等其它文件不可写。 */
export const WRITABLE_CONFIG_FILE = "models.json" as const;

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
 * 错误信息不含文件路径和配置值。
 */
export async function writeConfig(
  path: string,
  config: unknown,
  opts: WriteConfigOptions = {},
): Promise<WriteConfigResult> {
  if (basename(path) !== WRITABLE_CONFIG_FILE) {
    return { ok: false, errors: [`(file): 只能写 ${WRITABLE_CONFIG_FILE}`] };
  }
  const errors = validate(config);
  const secretErrors = findSecretLikeValues(config, opts.env);
  if (errors.length > 0 || secretErrors.length > 0) {
    const secrets = envSecrets(opts.env ?? process.env);
    return {
      ok: false,
      errors: [...errors.map((e) => sanitizeMessage(e, secrets)), ...secretErrors],
    };
  }
  const text = `${JSON.stringify(config, null, 2)}\n`;
  const dir = dirname(path);
  const tmp = join(
    dir,
    `.${WRITABLE_CONFIG_FILE}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  );
  try {
    await mkdir(dir, { recursive: true });
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
        await rename(tmp, path);
        break;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (i >= RENAME_RETRIES || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES"))
          throw e;
        await sleep(RENAME_RETRY_MS * (i + 1));
      }
    }
    return { ok: true };
  } catch (e) {
    await unlink(tmp).catch(() => {});
    const code = (e as NodeJS.ErrnoException).code ?? "unknown";
    return { ok: false, errors: [`(file): 写入配置失败（${code}）`] };
  }
}
