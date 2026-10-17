/**
 * T-059：带凭据的 URL 共用检查。模块 2（prStore 拒写）和 `redact` 的 `url_credentials` 规则都调这里，
 * 两边用同一份用例 `CREDENTIAL_CASES`。规则与 T-058 相同，宁可误拒，不能漏放；所有全文扫描都是线性的。
 */

/** 带 scheme 的 URL（`https://`、`ssh://` 等）；SSH 简写 `git@host:o/r.git` 和路径不算。 */
const SCHEME_URL = /^[a-z][a-z0-9+.-]*:\/\//i;
/** 嵌在文字里的带 scheme 的 URL，逐个检查（scheme 限长，保证线性）。 */
const EMBEDDED_URL = /[a-z][a-z0-9+.-]{0,31}:\/\/[^\s"'<>]+/gi;
/** 解析失败时的保守兜底（T-058 之前的规则）：`scheme://` 后面紧跟 `xxx@` 就当带凭据。 */
const LEGACY_CREDENTIAL_URL = /^[a-z][a-z0-9+.-]*:\/\/[^/\s@]+@/i;
/** 找 `scheme:` 的起点：前面不能紧挨着 scheme 字符，每段只匹配一次。 */
const EMBEDDED_SCHEME = /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:/gi;
const USERINFO_STOP = /[\s/\\@]/;

/**
 * 整个字符串里任何位置出现 `scheme:` 后接 `user:pass@`（斜杠、反斜杠可有可无、个数不限），
 * 返回每处 `user:pass` 的 `[start, end)`。线性扫描，不设长度上限（#58 评审：限长的正则会漏掉超长用户名或密码）。
 */
function embeddedUserinfoRanges(v: string, firstOnly: boolean): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (!v.includes("@")) return out;
  const n = v.length;
  // stop[i]：从 i 起第一个空白、斜杠、反斜杠或 @ 的位置。
  const stop = new Int32Array(n + 1);
  stop[n] = n;
  for (let i = n - 1; i >= 0; i--) stop[i] = USERINFO_STOP.test(v[i]!) ? i : stop[i + 1]!;
  for (const m of v.matchAll(EMBEDDED_SCHEME)) {
    let q = m.index + m[0].length;
    while (q < n && (v[q] === "/" || v[q] === "\\")) q++;
    const e = stop[q]!;
    if (v[e] !== "@") continue;
    const c = v.indexOf(":", q);
    if (c > q && c < e) {
      out.push([q, e]);
      if (firstOnly) return out;
    }
  }
  return out;
}

/** 用户名本身像 token（任何 scheme 都查，如 `https://ghp_xxx@`、`ssh://ghp_xxx@`）。 */
const TOKEN_LIKE_USER =
  /^(gh[pousr]_|github_pat_|glpat-|xox[abposr]-|sk-|x-access-token$|oauth2$)/i;
/** http(s) 只放行这种普通用户名（GitHub 用户名规则的宽松版）。 */
const PLAIN_WEB_USER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,38}$/;
/** 20 个字符及以上、全是十六进制或全是 base64 字符的用户名，当作没有前缀的 token。 */
const HEX_ONLY = /^[0-9a-f]+$/i;
const BASE64_ONLY = /^[A-Za-z0-9+/=_-]+$/;
/** 查询参数名像凭据（值非空时算带凭据）。 */
const CREDENTIAL_QUERY_KEY =
  /^(access[_-]?token|token|private[_-]?token|auth[_-]?token|id[_-]?token|refresh[_-]?token|api[_-]?key|apikey|key|secret|client[_-]?secret|password|passwd|pwd|auth|sig|signature|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential)$/i;

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 一组 `k=v` 参数里有没有像凭据的键且值非空；键末尾的 `[]` / `[0]` 先去掉。 */
function hasCredentialParam(params: URLSearchParams): boolean {
  for (const [k, val] of params) {
    if (val !== "" && CREDENTIAL_QUERY_KEY.test(stripIndexSuffix(k))) return true;
  }
  return false;
}

/**
 * 去掉键末尾的 `[]` / `[0]` / `[a][b]`，与 T-058 的 `/(\[[^\]]*\])+$/` 等价（`token[a[b]` 也去成 `token`）；
 * 逐段从后往前找，线性，不用正则（避免回溯）。
 */
function stripIndexSuffix(k: string): string {
  let key = k;
  while (key.endsWith("]")) {
    const prev = key.lastIndexOf("]", key.length - 2);
    const open = key.indexOf("[", prev + 1);
    if (open < 0 || open >= key.length - 1) break;
    key = key.slice(0, open);
  }
  return key;
}

/** 单个带 scheme 的 URL 哪里带凭据：userinfo、参数（查询或 `#` 片段）、解析不了按旧规则判；都没有为空。 */
interface UrlFinding {
  userinfo: boolean;
  params: boolean;
  unparsable: boolean;
}

function inspectSingleUrl(v: string): UrlFinding | undefined {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return LEGACY_CREDENTIAL_URL.test(v)
      ? { userinfo: false, params: false, unparsable: true }
      : undefined;
  }
  let userinfo = false;
  if (u.password !== "") userinfo = true;
  else if (u.username !== "") {
    const raw = u.username;
    const user = safeDecode(raw);
    const web = u.protocol === "http:" || u.protocol === "https:";
    userinfo =
      user.includes(":") ||
      TOKEN_LIKE_USER.test(user) ||
      (user.length >= 20 && (HEX_ONLY.test(user) || BASE64_ONLY.test(user))) ||
      (web && !PLAIN_WEB_USER.test(raw));
  }
  let params = hasCredentialParam(u.searchParams);
  if (!params && u.hash.length > 1) {
    const frag = u.hash.slice(1);
    const q = frag.indexOf("?");
    params =
      hasCredentialParam(new URLSearchParams(frag)) ||
      (q >= 0 && hasCredentialParam(new URLSearchParams(frag.slice(q + 1))));
  }
  return userinfo || params ? { userinfo, params, unparsable: false } : undefined;
}

/**
 * 判断一个字符串是不是（或里面有没有）「带凭据的 URL」。宁可误拒，不能漏放。
 * - 先 trim；整个字符串里任何位置出现 `scheme:` 后接 `user:pass@` 都算（含 `https:/\user:tok@h`、`https:user:tok@h`）。
 * - 字符串本身和嵌在里面的每个 `scheme://…` 逐个检查：
 *   - userinfo 里有密码，或解码后的用户名里有 `:`（`%3A`）算；
 *   - 用户名像 token（`ghp_…`、`github_pat_…`、`glpat-…`、`x-access-token`、`oauth2` 等，任何 scheme）算；
 *   - 用户名 20 个字符及以上且全是十六进制或全是 base64 字符算；
 *   - http(s) 的用户名不符合 `^[A-Za-z0-9][A-Za-z0-9._-]{0,38}$` 算；`https://eva@`、`ssh://git@` 放行；
 *   - 查询参数或 `#` 后面的参数里有 `token` / `access_token` / `api_key` / `sig` 等且值非空算（键名不分大小写，末尾的 `[]` 先去掉）。
 * - SSH 简写（`git@github.com:o/r.git`）和本地路径不算；URL 解析不了的按旧规则保守判断。
 */
export function isCredentialUrl(input: string): boolean {
  const v = input.trim();
  if (embeddedUserinfoRanges(v, true).length > 0) return true;
  if (SCHEME_URL.test(v) && inspectSingleUrl(v)) return true;
  if (v.includes("://")) {
    for (const m of v.matchAll(EMBEDDED_URL)) {
      if (inspectSingleUrl(m[0])) return true;
    }
  }
  return false;
}

/**
 * 文本里所有要遮掉的凭据片段 `[start, end)`（已排序、已合并），给 `redact` 的 `url_credentials` 规则用。
 * 判定与 `isCredentialUrl` 相同：userinfo 带凭据遮 `://` 到最后一个 `@` 之间；参数带凭据遮 `?` / `#` 之后全部；
 * 解析不了的遮 `://` 之后全部；`scheme:` 后接 `user:pass@` 遮 `user:pass`。
 */
export function credentialUrlRanges(text: string): Array<[number, number]> {
  const ranges = embeddedUserinfoRanges(text, false);
  if (text.includes("://")) {
    for (const m of text.matchAll(EMBEDDED_URL)) {
      const s = m[0];
      const f = inspectSingleUrl(s);
      if (!f) continue;
      const base = m.index;
      const a = s.indexOf("://") + 3;
      if (f.unparsable) {
        ranges.push([base + a, base + s.length]);
        continue;
      }
      // authority 到第一个 / \ ? # 为止；userinfo 是其中最后一个 @ 之前。
      let authEnd = s.length;
      for (let i = a; i < s.length; i++) {
        const ch = s[i];
        if (ch === "/" || ch === "\\" || ch === "?" || ch === "#") {
          authEnd = i;
          break;
        }
      }
      if (f.userinfo) {
        const at = s.lastIndexOf("@", authEnd - 1);
        ranges.push(at >= a ? [base + a, base + at] : [base + a, base + s.length]);
      }
      if (f.params) {
        let p = -1;
        for (let i = authEnd; i < s.length; i++) {
          if (s[i] === "?" || s[i] === "#") {
            p = i;
            break;
          }
        }
        ranges.push(p >= 0 ? [base + p + 1, base + s.length] : [base + a, base + s.length]);
      }
    }
  }
  ranges.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged.filter(([s, e]) => e > s);
}
