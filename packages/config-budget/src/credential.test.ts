// T-059：带凭据 URL 的共用检查与 redact 用同一份用例。
import { describe, expect, it } from "vitest";
import { CREDENTIAL_CASES, isCredentialUrl, redact } from "./index.js";

const rejects = CREDENTIAL_CASES.filter((c) => c.expect === "reject");
const urlRejects = rejects.filter((c) => (c.rule ?? "url_credentials") === "url_credentials");
const tokenRejects = rejects.filter((c) => c.rule === "token");
const allows = CREDENTIAL_CASES.filter((c) => c.expect === "allow");

describe("CREDENTIAL_CASES 形状", () => {
  it("名字不重复；每条 reject 都带非空 secret，且 secret 在文本里", () => {
    expect(new Set(CREDENTIAL_CASES.map((c) => c.name)).size).toBe(CREDENTIAL_CASES.length);
    for (const c of rejects) {
      const { text, secret } = c.build();
      expect(secret, c.name).not.toBe("");
      expect(text.includes(secret), c.name).toBe(true);
    }
    expect(urlRejects.length).toBeGreaterThan(0);
    expect(tokenRejects.length).toBeGreaterThan(0);
    expect(allows.length).toBeGreaterThan(0);
  });
});

describe("isCredentialUrl", () => {
  it.each(urlRejects.map((c) => [c.name, c] as const))("拒：%s", (_n, c) => {
    expect(isCredentialUrl(c.build().text)).toBe(true);
  });
  it.each(allows.map((c) => [c.name, c] as const))("放行：%s", (_n, c) => {
    expect(isCredentialUrl(c.build().text)).toBe(false);
  });
});

describe("redact 按同一份用例", () => {
  for (const level of ["light", "full"] as const) {
    it.each(urlRejects.map((c) => [c.name, c] as const))(
      `${level}：url_credentials 规则自己遮掉 %s`,
      (_n, c) => {
        const { text, secret } = c.build();
        const r = redact(text, level);
        expect(r.text).not.toContain(secret);
        expect(r.report.url_credentials ?? 0).toBeGreaterThan(0);
      },
    );
    it.each(tokenRejects.map((c) => [c.name, c] as const))(
      `${level}：token 规则遮掉 %s`,
      (_n, c) => {
        const { text, secret } = c.build();
        const r = redact(text, level);
        expect(r.text).not.toContain(secret);
        expect((r.report.github_token ?? 0) + (r.report.gitlab_token ?? 0)).toBeGreaterThan(0);
      },
    );
    it.each(allows.map((c) => [c.name, c] as const))(
      `${level}：放行 %s 不报 url_credentials`,
      (_n, c) => {
        expect(redact(c.build().text, level).report.url_credentials).toBeUndefined();
      },
    );
  }

  it("40 位十六进制用户名由 url_credentials 遮掉，不是靠邮箱规则", () => {
    const user = "a1b2c3d4e5f60718".repeat(3).slice(0, 40);
    const r = redact(`https://${user}@github.com/o/r`, "light");
    expect(r.text).not.toContain(user);
    expect(r.report.url_credentials).toBe(1);
    expect(r.report.email).toBeUndefined();
  });
  it("大写 ?TOKEN= 由 url_credentials 遮掉，不是靠 env_secret", () => {
    const r = redact("https://example.com/r.git?TOKEN=tokVALUE123", "light");
    expect(r.text).not.toContain("tokVALUE123");
    expect(r.report.url_credentials).toBe(1);
    expect(r.report.env_secret).toBeUndefined();
  });
  it("只遮凭据那一段，主机和路径保留", () => {
    expect(redact("https://eva:tokVALUE123@github.com/o/r.git", "light").text).toBe(
      "https://[REDACTED:url_credentials]@github.com/o/r.git",
    );
    expect(redact("https://example.com/x?token=tokVALUE123", "light").text).toBe(
      "https://example.com/x?[REDACTED:url_credentials]",
    );
  });
});
