import { describe, expect, it } from "vitest";
import { redact } from "./redact.js";

// 测试用假 token，按格式拼出，不是真实凭据。
const rnd = (n: number) => "A1b2C3d4E5".repeat(10).slice(0, n);
const DEEPSEEK = `sk-${"0123456789abcdef".repeat(2)}`;
const GH = [
  `ghp_${rnd(36)}`,
  `gho_${rnd(36)}`,
  `ghs_${rnd(36)}`,
  `github_pat_11${rnd(20)}_${rnd(59)}`,
];

describe("redact light", () => {
  it("DeepSeek key 与 GitHub token 不漏", () => {
    for (const t of [DEEPSEEK, ...GH]) {
      const { text, report } = redact(`token is ${t}.`, "light");
      expect(text).not.toContain(t);
      expect(text).not.toMatch(/sk-[0-9a-f]{8}|gh[pos]_|github_pat_/);
      expect(Object.values(report).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    }
  });
  it("Bearer、env 风格、邮箱、私钥、URL 凭据", () => {
    const input = [
      `Authorization: Bearer ${rnd(40)}`,
      `DEEPSEEK_API_KEY=${DEEPSEEK}`,
      `export GITHUB_TOKEN="${GH[0]}"`,
      "DB_PASSWORD: hunter2hunter2",
      "contact eva@example.com",
      "https://user:pa55@example.com/x",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const { text, report } = redact(input, "light");
    for (const s of [rnd(40), DEEPSEEK, GH[0]!, "hunter2", "eva@example.com", "pa55", "MIIE"]) {
      expect(text).not.toContain(s);
    }
    expect(text).toContain("DEEPSEEK_API_KEY=[REDACTED");
    expect(report.email).toBe(1);
    expect(text).not.toContain("hunter2");
  });
  it("light 不动路径和 IP；普通代码不误伤", () => {
    const s = "read /home/eva/a.ts from 10.0.0.1; const tokenCount = 3; skip-list ok";
    expect(redact(s, "light").text).toBe(s);
  });
  it("报告不含原文", () => {
    expect(JSON.stringify(redact(DEEPSEEK, "light").report)).not.toContain("sk-");
  });
});

describe("redact full", () => {
  it("额外去掉 home 路径、IP、内网主机名", () => {
    const s =
      "at /home/eva/proj/a.ts and C:\\Users\\Eva\\x and /Users/eva/y, host 192.168.1.20, db.corp, fe80:0:0:0:0:0:0:1";
    const { text } = redact(s, "full");
    for (const x of ["/home/eva", "Users\\Eva", "/Users/eva", "192.168.1.20", "db.corp", "fe80"]) {
      expect(text).not.toContain(x);
    }
    expect(text).toContain("/proj/a.ts");
  });
  it("full 包含 light", () => {
    expect(redact(`x ${DEEPSEEK}`, "full").text).not.toContain(DEEPSEEK);
  });
});

const LIGHT_FIXTURES: Array<[string, string]> = [
  [DEEPSEEK, `key ${DEEPSEEK}`],
  ...GH.map((t): [string, string] => [t, `tok ${t}`]),
  [rnd(40), `Authorization: Bearer ${rnd(40)}`],
  ["hunter2hunter2", "DB_PASSWORD=hunter2hunter2"],
  ["eva@example.com", "mail eva@example.com"],
  ["pa55", "https://user:pa55@example.com/x"],
  ["MIIE", "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----"],
];

describe("full ⊇ light", () => {
  it.each(LIGHT_FIXTURES)("light 能脱的 %s 在 full 下同样被脱", (secret, input) => {
    expect(redact(input, "light").text).not.toContain(secret);
    const full = redact(input, "full");
    expect(full.text).not.toContain(secret);
    for (const [rule, n] of Object.entries(redact(input, "light").report)) {
      expect(full.report[rule]).toBeGreaterThanOrEqual(n);
    }
  });
});

describe("report 形状", () => {
  it("只含规则名 → 正整数次数，不含原文", () => {
    const input = LIGHT_FIXTURES.map(([, i]) => i).join("\n") + "\n/home/eva 10.1.2.3";
    for (const level of ["light", "full"] as const) {
      const { report } = redact(input, level);
      expect(typeof report).toBe("object");
      expect(Array.isArray(report)).toBe(false);
      for (const [k, v] of Object.entries(report)) {
        expect(k).toMatch(/^[a-z0-9_]+$/);
        expect(Number.isInteger(v) && v > 0).toBe(true);
      }
      const json = JSON.stringify(report);
      for (const [secret] of LIGHT_FIXTURES) expect(json).not.toContain(secret);
      expect(json).not.toContain("/home/eva");
    }
    expect(redact("nothing here", "full").report).toEqual({});
  });
});
