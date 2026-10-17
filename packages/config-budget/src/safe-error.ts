import type { ZodIssue } from "zod";
import { redact } from "./redact.js";

// 模块 3 内部用的错误文案工具（T-098 / T-099）：不进 index，对外只再导出 formatConfigIssue。

const list = (xs: readonly unknown[]) => xs.map((x) => JSON.stringify(x)).join(" / ");

/**
 * 把校验问题转成不含配置原值的中文（T-087；T-098 起 `validate` / `getConfig` 也用它）：只用 `issue.path`、`issue.code` 和 schema 自己的
 * 期望值（类型名、枚举选项、上下限）；zod 默认 message 里的 `received '...'` 一律不用。
 * `custom` 是 schema 里写死的固定文案（不含值），照用。
 */
export function formatConfigIssue(i: ZodIssue): string {
  const path = i.path.join(".") || "(root)";
  let what: string;
  switch (i.code) {
    case "invalid_type":
      what = i.received === "undefined" ? "缺少必填字段" : `类型不对，应为 ${i.expected}`;
      break;
    case "invalid_literal":
      what = `应为 ${JSON.stringify(i.expected)}`;
      break;
    case "invalid_enum_value":
      what = `应为 ${list(i.options)} 之一`;
      break;
    case "invalid_union_discriminator":
      what = `应为 ${list(i.options)} 之一`;
      break;
    case "unrecognized_keys":
      what = `有未知字段 ${list(i.keys)}`;
      break;
    case "too_small":
      what = `太小或太短，下限 ${String(i.minimum)}${i.inclusive ? "（含）" : ""}`;
      break;
    case "too_big":
      what = `太大或太长，上限 ${String(i.maximum)}${i.inclusive ? "（含）" : ""}`;
      break;
    case "not_multiple_of":
      what = `应为 ${String(i.multipleOf)} 的倍数`;
      break;
    case "custom":
      what = i.message;
      break;
    default:
      what = `不合法（${i.code}）`;
  }
  return `${path}: ${what}`;
}

/** 校验问题转中文，再按 redact light 脱敏一次（字段路径、未知键名本身也可能像密钥）。 */
export function schemaIssues(issues: readonly ZodIssue[]): string[] {
  return issues.map((i) => redact(formatConfigIssue(i), "light").text);
}

/**
 * JSON 解析失败的说明：不拼 `err.message`（Node 的报错会把原文带出来），
 * 只从里面取出字符位置换成行列号；取不到就只说不是合法 JSON。
 */
export function jsonErrorText(text: string, e: unknown, subject: string): string {
  const m = /\bposition (\d+)\b/.exec(e instanceof Error ? e.message : "");
  if (!m) return `${subject}不是合法 JSON`;
  const pos = Math.min(Number(m[1]), text.length);
  const before = text.slice(0, pos).split("\n");
  return `${subject}不是合法 JSON（第 ${before.length} 行第 ${before[before.length - 1]!.length + 1} 列）`;
}

/** 文件读取错误只留错误码（不带路径和 `String(e)`）。 */
export function errnoCode(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "unknown";
}
