export type RedactLevel = "light" | "full";

/** 规则名 → 命中次数。只含规则名和次数，不含任何原文。 */
export type RedactReport = Record<string, number>;

interface Rule {
  name: string;
  level: RedactLevel;
  re: RegExp;
  /** 返回替换文本；默认 [REDACTED:name]。 */
  replace?: (m: string, ...g: string[]) => string;
}

const tag = (name: string) => `[REDACTED:${name}]`;

// 顺序重要：先匹配带结构的，再匹配宽泛的。
const RULES: Rule[] = [
  {
    name: "private_key",
    level: "light",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    name: "url_credentials",
    level: "light",
    re: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi,
    replace: (_m, scheme) => `${scheme}${tag("url_credentials")}@`,
  },
  {
    name: "github_token",
    level: "light",
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  },
  { name: "api_key", level: "light", re: /\bsk-(?:[A-Za-z0-9_-]{16,})/g },
  {
    name: "bearer",
    level: "light",
    re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g,
    replace: (_m, k) => `${k} ${tag("bearer")}`,
  },
  {
    name: "env_secret",
    level: "light",
    re: /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIALS?)[A-Z0-9_]*)\s*([=:])\s*("[^"\n]*"|'[^'\n]*'|[^\s"'\n]+)/g,
    replace: (_m, k, sep) => `${k}${sep}${tag("env_secret")}`,
  },
  { name: "email", level: "light", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  {
    name: "home_path",
    level: "full",
    re: /(?:\/(?:home|Users)\/[^/\s"'`]+|[A-Za-z]:\\Users\\[^\\\s"'`]+|~(?=\/))/g,
  },
  {
    name: "ipv4",
    level: "full",
    re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
  },
  {
    name: "ipv6",
    level: "full",
    re: /\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b|\b(?:[0-9a-f]{1,4}:){1,7}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?(?=\s|$|[),;\]])/gi,
  },
  {
    name: "hostname",
    level: "full",
    re: /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:local|lan|internal|corp|intranet|home|localdomain)\b/gi,
  },
];

/**
 * 脱敏。light：落库前用（key/token/Bearer/env 密钥/邮箱/私钥/URL 凭据）；
 * full：导出诊断包用，额外去掉 home 路径、IP、内网主机名。
 */
export function redact(text: string, level: RedactLevel): { text: string; report: RedactReport } {
  const counts: Record<string, number> = {};
  let out = text;
  for (const r of RULES) {
    // full 执行全部规则（light 规则 + full 专属规则）；light 只执行 light 规则。
    if (r.level === "full" && level !== "full") continue;
    out = out.replace(r.re, (m: string, ...rest: unknown[]) => {
      counts[r.name] = (counts[r.name] ?? 0) + 1;
      const groups = rest.filter((x): x is string => typeof x === "string");
      return r.replace ? r.replace(m, ...groups) : tag(r.name);
    });
  }
  return { text: out, report: counts };
}
