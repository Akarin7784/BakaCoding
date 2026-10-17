import { credentialUrlRanges } from "./credential.js";

export type RedactLevel = "light" | "full";

/** 规则名 → 命中次数。只含规则名和次数，不含任何原文。 */
export type RedactReport = Record<string, number>;

interface RegexRule {
  name: string;
  level: RedactLevel;
  re: RegExp;
  /** 返回替换文本；默认 [REDACTED:name]。返回 `undefined` 表示这处不算命中、保留原文。 */
  replace?: (m: string, ...g: string[]) => string | undefined;
}

interface FnRule {
  name: string;
  level: RedactLevel;
  /** 返回替换后的文本和命中次数。必须是线性的。 */
  apply: (text: string) => { text: string; count: number };
}

type Rule = RegexRule | FnRule;

const tag = (name: string) => `[REDACTED:${name}]`;

/** 把 `[start, end)` 片段换成 tag（片段已排序、不重叠）。 */
function replaceRanges(text: string, ranges: Array<[number, number]>, name: string): string {
  let out = "";
  let last = 0;
  for (const [s, e] of ranges) {
    out += text.slice(last, s) + tag(name);
    last = e;
  }
  return out + text.slice(last);
}

/**
 * 私钥块：BEGIN 之后找下一个 END（indexOf 式前进，线性）。只有 BEGIN 没有 END 时遮到文末，宁可多遮。
 */
const PEM_BEGIN = /-----BEGIN [A-Z ]{0,64}PRIVATE KEY-----/g;
const PEM_END = /-----END [A-Z ]{0,64}PRIVATE KEY-----/g;
function redactPrivateKeys(text: string): { text: string; count: number } {
  if (!text.includes("-----BEGIN ")) return { text, count: 0 };
  const ranges: Array<[number, number]> = [];
  PEM_BEGIN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PEM_BEGIN.exec(text))) {
    PEM_END.lastIndex = m.index + m[0].length;
    const e = PEM_END.exec(text);
    const end = e ? e.index + e[0].length : text.length;
    ranges.push([m.index, end]);
    PEM_BEGIN.lastIndex = end;
    if (!e) break;
  }
  return { text: replaceRanges(text, ranges, "private_key"), count: ranges.length };
}

/**
 * 内网主机名：只从一段的开头起匹配，最多 16 段、每段最长 63；匹配到后往前把同一个主机名剩下的字符
 * （`[a-z0-9.-]`）一起遮掉，超过 16 段的主机名也不漏前缀。
 */
const HOSTNAME =
  /(?<![a-z0-9-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){1,16}(?:local|lan|internal|corp|intranet|home|localdomain)\b/gi;
const HOST_CHAR = /[a-z0-9.-]/i;
function redactHostnames(text: string): { text: string; count: number } {
  const ranges: Array<[number, number]> = [];
  let floor = 0;
  for (const m of text.matchAll(HOSTNAME)) {
    let s = m.index;
    // 只往回看到上一处结尾为止，整体线性。
    while (s > floor && HOST_CHAR.test(text[s - 1]!)) s--;
    const e = m.index + m[0].length;
    ranges.push([s, e]);
    floor = e;
  }
  return { text: replaceRanges(text, ranges, "hostname"), count: ranges.length };
}

/**
 * 邮箱：不设长度上限，逐个 `@` 扫（#63 评审）。对每个 `@`：向左按 `[A-Za-z0-9._%+-]` 扩，遇到上一处匹配的末尾
 * 或上一个 `@` 就停；向右按 `[A-Za-z0-9.-]` 扩，去掉末尾的 `.` 和 `-`；右边含 `.` 且以 2 个及以上字母的顶级域结尾就遮。
 * 每个 `@` 把左右扫描和相邻的隔开，整体线性。
 */
const EMAIL_LOCAL = /[A-Za-z0-9._%+-]/;
const EMAIL_DOMAIN = /[A-Za-z0-9.-]/;
const EMAIL_TLD = /^[A-Za-z]{2,}$/;
function redactEmails(text: string): { text: string; count: number } {
  if (!text.includes("@")) return { text, count: 0 };
  const ranges: Array<[number, number]> = [];
  const n = text.length;
  let floor = 0;
  for (let at = text.indexOf("@"); at >= 0; at = text.indexOf("@", floor)) {
    let s = at;
    while (s > floor && EMAIL_LOCAL.test(text[s - 1]!)) s--;
    let e = at + 1;
    while (e < n && EMAIL_DOMAIN.test(text[e]!)) e++;
    while (e > at + 1 && (text[e - 1] === "." || text[e - 1] === "-")) e--;
    const domain = text.slice(at + 1, e);
    const dot = domain.lastIndexOf(".");
    if (s < at && dot > 0 && EMAIL_TLD.test(domain.slice(dot + 1))) {
      ranges.push([s, e]);
      floor = e;
    } else {
      floor = at + 1;
    }
  }
  return { text: replaceRanges(text, ranges, "email"), count: ranges.length };
}

// 顺序重要：先匹配带结构的，再匹配宽泛的。
// 所有规则都要线性（T-059：10 万字符的输入 light / full 都在 500ms 内）：重复次数有上限，
// 或者是匹配末尾的一段贪婪字符（后面没有别的约束，不会回溯）。
const RULES: Rule[] = [
  { name: "private_key", level: "light", apply: redactPrivateKeys },
  {
    // 与模块 2 拒写共用 `credentialUrlRanges`（见 credential.ts）。
    name: "url_credentials",
    level: "light",
    apply: (text) => {
      const ranges = credentialUrlRanges(text);
      return { text: replaceRanges(text, ranges, "url_credentials"), count: ranges.length };
    },
  },
  {
    // 不要求前面是单词边界：`_ghp_…`、`tokenghp_…` 里的 token 也要遮。
    name: "github_token",
    level: "light",
    re: /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  },
  { name: "gitlab_token", level: "light", re: /glpat-[A-Za-z0-9_-]{20,}/g },
  { name: "api_key", level: "light", re: /\bsk-(?:[A-Za-z0-9_-]{16,})/g },
  {
    name: "bearer",
    level: "light",
    re: /\b(Bearer|Basic)\s{1,16}[A-Za-z0-9._~+/=-]{8,}/g,
    replace: (_m, k) => `${k} ${tag("bearer")}`,
  },
  {
    // 名字从「前面不是名字字符」处起头，每个名字只试一次，先用前瞻确认名字里有关键字（不回溯成平方级，名字不限长）。
    // 引号里的值最长 4096；引号没闭合或更长时，至少遮掉引号后面的第一段。
    name: "env_secret",
    level: "light",
    re: /(?<![A-Za-z0-9_])(?=[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIALS?))([A-Z0-9_]+)\s{0,16}([=:])\s{0,16}("[^"\n]{0,4096}"|'[^'\n]{0,4096}'|["']?[^\s"'\n]+)/g,
    replace: (_m, k, sep) => `${k}${sep}${tag("env_secret")}`,
  },
  { name: "email", level: "light", apply: redactEmails },
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
    re: /\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b|\b(?:[0-9a-f]{1,4}:){1,7}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?(?=\s|$|[),;\]])/gi,
  },
  { name: "hostname", level: "full", apply: redactHostnames },
];

/**
 * 脱敏。light：落库前用（key/token/Bearer/env 密钥/邮箱/私钥/URL 凭据）；
 * full：导出诊断包用，额外去掉 home 路径、IP、内网主机名。
 */
export function redact(text: string, level: RedactLevel): { text: string; report: RedactReport } {
  const counts: Record<string, number> = {};
  const hit = (name: string, n = 1) => {
    if (n > 0) counts[name] = (counts[name] ?? 0) + n;
  };
  let out = text;
  for (const r of RULES) {
    // full 执行全部规则（light 规则 + full 专属规则）；light 只执行 light 规则。
    if (r.level === "full" && level !== "full") continue;
    if ("apply" in r) {
      const res = r.apply(out);
      out = res.text;
      hit(r.name, res.count);
      continue;
    }
    out = out.replace(r.re, (m: string, ...rest: unknown[]) => {
      const groups = rest.filter((x): x is string => typeof x === "string");
      const rep = r.replace ? r.replace(m, ...groups) : tag(r.name);
      if (rep === undefined) return m;
      hit(r.name);
      return rep;
    });
  }
  return { text: out, report: counts };
}
