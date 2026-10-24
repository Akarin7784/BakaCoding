import { createHmac, randomBytes } from "node:crypto";

/**
 * 诊断包里代替对话 / 提示词原文的摘要（T-159，schema v1.2）。
 * len：原文的 Unicode 码点数；hmac：HMAC-SHA256(salt, 原文 UTF-8 字节) 的十六进制。
 * salt 每个包导出时随机生成 32 字节，只在内存里用，用完即弃，绝不写进包。
 */
export interface TextDigest {
  len: number;
  hmac: string;
}

/** manifest.text_digest 的固定说明（不含 salt 值）。 */
export const TEXT_DIGEST_NOTE =
  "对话和提示词原文不进包，换成 {len: 码点数, hmac: HMAC-SHA256(每包随机 salt, UTF-8 原文) 十六进制}；salt 不写进包，同一包内同文同 hmac，不同包不可对照" as const;

/** 本次导出生成的摘要对象：FullRedactor.deep 遇到它们原样放过，不再脱敏。 */
const issued = new WeakSet<object>();

export function isIssuedDigest(v: unknown): v is TextDigest {
  return typeof v === "object" && v !== null && issued.has(v);
}

/** 一个包一个 Digester：salt 只在这个对象里。 */
export class Digester {
  readonly #salt: Buffer;

  /** salt 只为测试注入；导出时总是随机生成。 */
  constructor(salt: Buffer = randomBytes(32)) {
    this.#salt = salt;
  }

  /** 对原文（脱敏之前）取摘要。 */
  digest(text: string): TextDigest {
    const d: TextDigest = {
      len: [...text].length,
      hmac: createHmac("sha256", this.#salt).update(text, "utf8").digest("hex"),
    };
    issued.add(d);
    return d;
  }

  /** 把 obj 上列出的字符串字段换成摘要（浅拷贝，不改原对象）；不是字符串的字段原样保留。 */
  fields<T extends object>(obj: T, keys: readonly string[]): T {
    const out = { ...obj } as Record<string, unknown>;
    for (const k of keys) {
      const v = out[k];
      if (typeof v === "string") out[k] = this.digest(v);
    }
    return out as T;
  }
}

/** 各事件类型 payload 里要摘要的字段（T-159 盘点 A1-A8）。 */
export const EVENT_TEXT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  call_completed: ["prompt", "output"],
  group_message: ["content"],
  interface_changed: ["summary"],
  escalated: ["detail"],
  ticket_warning: ["detail"],
  write_scope_requested: ["reason"],
  write_scope_denied: ["reason"],
};
