// T-059：redact 不出现平方级耗时；收紧上限后长输入照样遮干净。
import { describe, expect, it } from "vitest";
import { redact } from "./redact.js";

const INPUTS: Array<[string, () => string]> = [
  ["a.a.…", () => "a.".repeat(50_000)],
  ["a.a.… 末尾带 @", () => `${"a.".repeat(50_000)}@`],
  ["@ 后接 a.a.…", () => `x@${"a.".repeat(50_000)}`],
  ["纯字母", () => "a".repeat(100_000)],
  ["a@a@…", () => "a@".repeat(50_000)],
  ["a:a:…", () => "a:".repeat(50_000)],
  ["https://u:u:…", () => `https://${"u:".repeat(50_000)}`],
  ["https://u:u:… 末尾带 @", () => `https://${"u:".repeat(50_000)}@`],
  ["反复的 https://", () => "https://".repeat(12_500)],
  ["长单词无等号（KEY 反复）", () => "KEY".repeat(34_000)],
  ["A_KEY=' 反复（引号不闭合）", () => "A_KEY='".repeat(15_000)],
  ["反复的 BEGIN 私钥头", () => "-----BEGIN PRIVATE KEY-----".repeat(4_000)],
  ["长主机名不带内网后缀", () => `${"ab-".repeat(20)}a.`.repeat(1_700)],
  ["1::1:1:… 不以分隔符结尾", () => `1::${"1:".repeat(50_000)}x`],
  ["Bearer 后接空白", () => `Bearer${" ".repeat(100_000)}`],
  ["ghp_ 反复", () => "ghp_".repeat(25_000)],
  ["a@b. 反复", () => "a@b.".repeat(25_000)],
];

describe("redact 10 万字符输入（T-059）", () => {
  for (const level of ["light", "full"] as const) {
    it.each(INPUTS)(`${level}：%s 在 500ms 内`, (_n, build) => {
      const s = build();
      expect(s.length).toBeGreaterThanOrEqual(100_000);
      const t0 = performance.now();
      redact(s, level);
      expect(performance.now() - t0).toBeLessThan(500);
    });
  }
});

describe("收紧上限后不漏", () => {
  it("超过 16 段的内网主机名整条遮掉", () => {
    const host = `${Array.from({ length: 30 }, (_, i) => `n${i}`).join(".")}.corp`;
    const r = redact(`connect ${host}:5432`, "full");
    expect(r.text).toBe("connect [REDACTED:hostname]:5432");
    expect(r.report.hostname).toBe(1);
  });
  it("段长 63 的主机名照样遮", () => {
    const host = `${"a".repeat(63)}.${"b".repeat(63)}.internal`;
    expect(redact(host, "full").text).toBe("[REDACTED:hostname]");
  });
  it("邮箱：本地部分 64、域名 16 段内都遮", () => {
    const mail = `${"x".repeat(64)}@${Array.from({ length: 15 }, () => "d").join(".")}.com`;
    const r = redact(`to ${mail}`, "light");
    expect(r.text).not.toContain("@");
    expect(r.report.email).toBe(1);
  });
  it("变量名超长也遮", () => {
    const name = `${"A".repeat(300)}_TOKEN`;
    const r = redact(`${name}=s3cretVALUE`, "light");
    expect(r.text).toBe(`${name}=[REDACTED:env_secret]`);
  });
  it("前一个名字不含关键字时不吞掉后一个", () => {
    const r = redact("FOO=BAR_TOKEN=s3cretVALUE", "light");
    expect(r.text).not.toContain("s3cretVALUE");
  });
  it("引号没闭合也至少遮掉第一段", () => {
    expect(redact("API_KEY='s3cretVALUE", "light").text).not.toContain("s3cretVALUE");
  });
  it("私钥只有 BEGIN 没有 END 时遮到文末", () => {
    const r = redact("x\n-----BEGIN RSA PRIVATE KEY-----\nMIIEabc", "light");
    expect(r.text).toBe("x\n[REDACTED:private_key]");
  });
  it("两段私钥各算一次", () => {
    const k = "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----";
    const r = redact(`${k}\nmid\n${k}`, "light");
    expect(r.text).toBe("[REDACTED:private_key]\nmid\n[REDACTED:private_key]");
    expect(r.report.private_key).toBe(2);
  });
});

describe("邮箱不设长度上限（#63 评审）", () => {
  const labels = (n: number) => Array.from({ length: n }, (_, i) => `d${i}`).join(".");
  it.each([
    ["17 段及以上的域名", `eva@${labels(17)}.com`],
    ["40 段的域名", `eva@${labels(40)}.com`],
    ["一段超过 63 字符的域名", `eva@${"x".repeat(70)}.com`],
    ["65 字符的本地部分", `${"a".repeat(65)}@example.com`],
    ["200 字符的本地部分", `${"b".repeat(200)}@example.com`],
  ])("%s 整条遮掉", (_n, mail) => {
    for (const level of ["light", "full"] as const) {
      const r = redact(`to ${mail}, ok`, level);
      expect(r.text).toBe("to [REDACTED:email], ok");
      expect(r.report.email).toBe(1);
    }
  });
  it("末尾的 . 和 - 不算进域名；没有字母顶级域不遮", () => {
    expect(redact("mail eva@example.com.", "light").text).toBe("mail [REDACTED:email].");
    expect(redact("v1@2.0 and a@b", "light").text).toBe("v1@2.0 and a@b");
  });
  it("相邻的 @ 各自判断", () => {
    const r = redact("a@b.com@c.org x@y.io", "light");
    expect(r.text).not.toMatch(/a@b\.com|x@y\.io/);
    expect(r.report.email).toBeGreaterThanOrEqual(2);
  });
  it("full：超过 16 段的内网域名邮箱不留 .internal 后缀", () => {
    const r = redact(`eva@${labels(17)}.internal:80`, "full");
    expect(r.text).toBe("[REDACTED:email]:80");
  });
});
