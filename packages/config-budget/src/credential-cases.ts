/**
 * T-059：带凭据 URL 与 token 的共用用例。模块 2（prStore 拒写）、本包的 `redact` 和 11 的导出测试都跑这一份。
 * - `expect: "reject"`：必须被拦下。`rule` 缺省为 `url_credentials`：`isCredentialUrl(text)` 为真，
 *   `redact(text, "light")` 由 `url_credentials` 规则遮掉 `secret`。`rule: "token"`：不是 URL，
 *   `redact` 由 token 类规则（`github_token` / `gitlab_token`）遮掉 `secret`。
 * - `expect: "allow"`：`isCredentialUrl(text)` 为假，`redact` 不报 `url_credentials`。
 * - 所有假 token 运行时拼出，源码里没有完整的 token 字面量。
 */
export interface CredentialCase {
  name: string;
  build(): { text: string; secret: string };
  expect: "reject" | "allow";
  rule?: "url_credentials" | "token";
}

const fill = (n: number, alphabet = "A1b2C3d4E5f6G7h8") =>
  alphabet.repeat(Math.ceil(n / alphabet.length)).slice(0, n);
const hex = (n: number) => fill(n, "a1b2c3d4e5f60718");
const gh = (p: "p" | "o" | "u" | "s" | "r", n = 36) => `gh${p}_${fill(n)}`;
const pat = () => `github_pat_11${fill(20)}_${fill(59)}`;
const glpat = () => `glpat-${fill(20)}`;

type Built = { text: string; secret: string };
const rej = (name: string, build: () => Built, rule?: CredentialCase["rule"]): CredentialCase =>
  rule ? { name, build, expect: "reject", rule } : { name, build, expect: "reject" };
const allow = (name: string, text: string): CredentialCase => ({
  name,
  build: () => ({ text, secret: "" }),
  expect: "allow",
});
/** 用 secret 拼出文本：`f(secret)`。 */
const url = (name: string, secret: string, f: (s: string) => string) =>
  rej(name, () => ({ text: f(secret), secret }));

export const CREDENTIAL_CASES: readonly CredentialCase[] = [
  // 放行
  allow("ssh://git@", "ssh://git@github.com/o/r.git"),
  allow("ssh://git@ 带端口", "ssh://git@gitlab.example.com:2222/o/r.git"),
  allow("https://user@", "https://eva@github.com/o/r.git"),
  allow("https://user@ 带点和连字符", "https://eva.m-1@github.com/o/r.git"),
  allow("SSH 简写", "git@github.com:o/r.git"),
  allow("普通 https", "https://github.com/o/r.git"),
  allow("无关查询参数", "https://github.com/o/r/pull/3?tab=files&page=2"),
  allow("token 参数为空", "https://example.com/r.git?token="),
  allow("git+ssh 用户名", "git+ssh://git@github.com/o/r.git"),
  allow("前后有空格的普通 URL", "  https://github.com/o/r.git  "),
  allow("无关的 # 片段", "https://github.com/o/r/pull/3#discussion_r1"),
  allow("文字里嵌普通 URL", "见 https://github.com/o/r/pull/3 和 ssh://git@github.com/o/r.git"),

  // userinfo 带密码
  url("user:token@", gh("p"), (s) => `https://eva:${s}@github.com/o/r.git`),
  url("x-access-token:token@", hex(40), (s) => `https://x-access-token:${s}@github.com/o/r.git`),
  url("ssh 带密码", "s3cretPassw0rd", (s) => `ssh://git:${s}@github.com/o/r.git`),
  url("用户名里 %3A 编码的冒号", "tokVALUE123", (s) => `https://x%3A${s}@h/r`),
  url("用户名里小写 %3a", "tokVALUE123", (s) => `https://x%3a${s}@h/r`),
  url("https: 不带斜杠", "tokVALUE123", (s) => `https:user:${s}@h/r`),
  url("https:/\\ 反斜杠写法", "tokVALUE123", (s) => `https:/\\user:${s}@h/r`),
  url("超过 8 个斜杠", "tokVALUE123", (s) => `https:/\\/\\/\\/\\/\\eva:${s}@h/r`),
  url("https:/\\ + 超长用户名", "u".repeat(300), (s) => `https:/\\${s}:tok@h/r`),
  url("https:eva: + 超长密码", "p".repeat(300), (s) => `https:eva:${s}@h/r`),
  url(
    "嵌在文字里的 user:pass@",
    "tokVALUE123",
    (s) => `克隆地址 https://eva:${s}@github.com/o/r.git 已配置`,
  ),
  url("前面有空格", gh("p"), (s) => `  https://eva:${s}@github.com/o/r.git`),

  // 用户名像 token
  url("用户名是 GitHub token", gh("p"), (s) => `https://${s}@github.com/o/r.git`),
  url("用户名是细粒度 PAT", pat(), (s) => `https://${s}@github.com/o/r.git`),
  url("用户名是 GitLab token", glpat(), (s) => `https://${s}@gitlab.com/o/r.git`),
  url("oauth2 用户名", "oauth2", (s) => `https://${s}@gitlab.com/o/r.git`),
  url("40 位十六进制用户名", hex(40), (s) => `https://${s}@github.com/o/r`),
  url("ssh:// 40 位十六进制用户名", hex(40), (s) => `ssh://${s}@github.com/o/r.git`),
  url("长串 base64 用户名", fill(24), (s) => `https://${s}@github.com/o/r`),
  url("git:// 用户名像 token", gh("o"), (s) => `git://${s}@github.com/o/r.git`),
  url("用户名超过 39 个字符", "a".repeat(40), (s) => `https://${s}@github.com/o/r`),
  url("嵌在文字里的 token 用户名", gh("s"), (s) => `clone https://${s}@github.com/o/r`),

  // 参数里的 token
  url("查询参数 token", "tokVALUE123", (s) => `https://example.com/r.git?token=${s}`),
  url("查询参数名大写 TOKEN", "tokVALUE123", (s) => `https://example.com/r.git?TOKEN=${s}`),
  url(
    "查询参数 access_token",
    "tokVALUE123",
    (s) => `https://api.example.com/x?a=1&access_token=${s}`,
  ),
  url(
    "查询参数 private_token",
    "tokVALUE123",
    (s) => `https://gitlab.com/api/v4/x?private_token=${s}`,
  ),
  url("预签名 URL", hex(64), (s) => `https://bucket.s3.amazonaws.com/a?X-Amz-Signature=${s}`),
  url("大小写混写的参数名", "tokVALUE123", (s) => `https://example.com/x?Access-Token=${s}`),
  url(
    "# 后面的 access_token",
    "tokVALUE123",
    (s) => `https://app.example.com/cb#access_token=${s}`,
  ),
  url("# 后面带路径再带参数", "tokVALUE123", (s) => `https://app.example.com/#/cb?token=${s}`),
  url("参数名末尾的 []", "tokVALUE123", (s) => `https://example.com/x?token[]=${s}`),
  url("参数名 token[a[b]", "tokVALUE123", (s) => `https://example.com/x?token[a[b]=${s}`),
  url(
    "嵌在文字里的查询参数 token",
    "tokVALUE123",
    (s) => `回调 https://example.com/x?token=${s} 已收到`,
  ),

  // 不在 URL 里的 token：任何位置都要遮
  rej("ghp_ 独立出现", () => ({ text: `tok ${gh("p")}`, secret: gh("p") }), "token"),
  rej("ghp_ 紧跟在下划线后", () => ({ text: `MY_${gh("p")}`, secret: gh("p") }), "token"),
  rej("ghp_ 紧跟在字母后", () => ({ text: `value${gh("p")}`, secret: gh("p") }), "token"),
  rej("github_pat_ 紧跟在字母后", () => ({ text: `x${pat()}`, secret: pat() }), "token"),
  rej("glpat- 独立出现", () => ({ text: `gitlab ${glpat()}`, secret: glpat() }), "token"),
  rej("glpat- 紧跟在字母后", () => ({ text: `k${glpat()}`, secret: glpat() }), "token"),
];
