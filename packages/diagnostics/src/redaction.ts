import { redact } from "@bakacoding/config-budget";
import { isIssuedDigest } from "./digest.js";
import { PATH_RULES, redactPaths, type PathRule } from "./path-redaction.js";
import type { RedactionReport } from "./schema.js";

/**
 * 导出时按字段名整段去掉的键（T-143）：任意嵌套深度，不看事件类型、不看值。
 * `repo_path` 是仓库在本机的绝对路径（模块 2 的 projects 表和「项目已创建」事件数据，T-142），
 * 只给桌面端主进程用，不进诊断包。
 */
export const DROPPED_KEYS: ReadonlySet<string> = new Set(["repo_path"]);

/**
 * 用模块 3 的 redact(text, "full") 做完整脱敏，再做绝对路径 / home 目录脱敏（T-146，path-redaction.ts），
 * 并累计「规则名 → 命中次数」。所有字符串（值、键名、原始文件内容和 zip 条目名）都经过 text()。
 */
export class FullRedactor {
  private readonly counts: Record<string, number> = {};

  /** `paths` 只给测试和反向检查用：注入 home、或只开部分路径规则；`paths: false` 关掉路径脱敏。 */
  constructor(
    private readonly paths: { home?: string; rules?: readonly PathRule[] } | false = {},
  ) {}

  text(s: string): string {
    // `~/…` 要在模块 3 之前整条遮掉：模块 3 的 home_path 只换掉 `~`，会留下后面的整段路径。
    const pre = this.paths === false ? s : this.paths_(s, ["tilde_path"]);
    const { text, report } = redact(pre, "full");
    this.add(report);
    if (this.paths === false) return text;
    return this.paths_(
      text,
      PATH_RULES.filter((r) => r !== "tilde_path"),
    );
  }

  private paths_(s: string, only: readonly PathRule[]): string {
    if (this.paths === false) return s;
    const allowed = this.paths.rules ?? PATH_RULES;
    const p = redactPaths(s, {
      home: this.paths.home,
      rules: only.filter((r) => allowed.includes(r)),
    });
    this.add(p.report);
    return p.text;
  }

  private add(report: Record<string, number | undefined>): void {
    for (const [rule, n] of Object.entries(report)) {
      this.counts[rule] = (this.counts[rule] ?? 0) + (n ?? 0);
    }
  }

  /**
   * 递归脱敏：所有字符串值和对象键都过一遍；数字、布尔、null 原样保留。
   * DROPPED_KEYS 里的键（如 `repo_path`）连同值整段去掉，值是 null 也一样。
   */
  deep<T>(value: T): T {
    return this.walk(value) as T;
  }

  private walk(v: unknown): unknown {
    // T-159：本次导出生成的原文摘要只含码点数和 hmac，原样保留，避免被规则误改。
    if (isIssuedDigest(v)) return { len: v.len, hmac: v.hmac };
    if (typeof v === "string") return this.text(v);
    if (Array.isArray(v)) return v.map((x) => this.walk(x));
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (x === undefined || DROPPED_KEYS.has(k)) continue;
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
