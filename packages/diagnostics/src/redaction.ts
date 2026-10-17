import { redact } from "@bakacoding/config-budget";
import type { RedactionReport } from "./schema.js";

/** 用模块 3 的 redact(text, "full") 做完整脱敏，并累计「规则名 → 命中次数」。 */
export class FullRedactor {
  private readonly counts: Record<string, number> = {};

  text(s: string): string {
    const { text, report } = redact(s, "full");
    for (const [rule, n] of Object.entries(report)) {
      this.counts[rule] = (this.counts[rule] ?? 0) + n;
    }
    return text;
  }

  /** 递归脱敏：所有字符串值和对象键都过一遍；数字、布尔、null 原样保留。 */
  deep<T>(value: T): T {
    return this.walk(value) as T;
  }

  private walk(v: unknown): unknown {
    if (typeof v === "string") return this.text(v);
    if (Array.isArray(v)) return v.map((x) => this.walk(x));
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (x === undefined) continue;
        out[this.text(k)] = this.walk(x);
      }
      return out;
    }
    return v;
  }

  /** 脱敏报告：只有规则名和次数，不含合计、不含原文。 */
  report(): RedactionReport {
    return Object.fromEntries(Object.entries(this.counts).sort(([a], [b]) => a.localeCompare(b)));
  }
}

/** 把（已脱敏的）路径变成安全的 zip 内相对路径。 */
export function safeZipPath(p: string): string {
  const parts = p
    .replace(/\[REDACTED:([a-z0-9_]+)\]/gi, "REDACTED-$1")
    .replace(/\\/g, "/")
    .split("/")
    // eslint-disable-next-line no-control-regex
    .map((seg) => seg.replace(/[\u0000-\u001f:*?"<>|]/g, "_"))
    .filter((seg) => seg !== "" && seg !== "." && seg !== "..");
  return parts.length > 0 ? parts.join("/") : "_";
}
