// T-146：诊断包的绝对路径 / home 目录脱敏（单元测试）。每种路径形态一条，外加不能误伤的文本。
import { describe, expect, it } from "vitest";
import { FullRedactor, PATH_RULES, redactPaths } from "./index.js";

const HOME = "/opt/evafakehome";

describe("redactPaths：每种路径形态都遮掉", () => {
  const cases: [string, string, string][] = [
    ["abs_path", "posix 绝对路径", "读 /srv/evafake-repo/src/a.ts 失败"],
    ["abs_path", "posix 根下一段", "cwd=/workspace"],
    ["abs_path", "整串就是路径（trace_id 场景）", "/tmp/evafake/trace-1"],
    ["tilde_path", "~/ 路径", "配置在 ~/code/evafake-repo/x.json"],
    ["windows_path", "C:\\ 路径", "打开 C:\\evafake\\repo\\a.ts"],
    ["windows_path", "C:/ 路径", "打开 D:/evafake/repo/a.ts"],
    ["unc_path", "UNC 路径", "共享 \\\\fileserver\\evafake\\repo"],
    ["file_url", "file:// URL", "见 file:///srv/evafake/a.ts"],
    ["file_url", "file:// Windows URL", "见 file:///C:/evafake/a.ts"],
    ["home_dir", "运行时 home 目录", `日志 ${HOME}/logs/x.log`],
    ["home_dir", "home 目录的反斜杠写法", `日志 \\opt\\evafakehome\\logs`],
  ];
  it.each(cases)("%s：%s", (rule, _name, input) => {
    const { text, report } = redactPaths(input, { home: HOME });
    expect(text).not.toContain("evafake");
    expect(text).toContain(`[REDACTED:${rule}]`);
    expect(report[rule as keyof typeof report]).toBeGreaterThan(0);
  });

  it("单独关掉某条规则时，对应形态就漏出来（规则确实各自生效）", () => {
    for (const [rule, , input] of cases) {
      const rules = PATH_RULES.filter((r) => r !== rule);
      // home_dir 关掉后 abs_path 仍会遮 posix 形式，这里只看规则自身的标签。
      expect(redactPaths(input, { home: HOME, rules }).text).not.toContain(`[REDACTED:${rule}]`);
    }
  });
});

describe("redactPaths：不误伤普通文本", () => {
  const keep = [
    "src/a.ts 和 a/b",
    "./x/y ../z",
    "日期 2026/10/24，分数 1/2，3/4 杯",
    "and/or 输入/输出",
    "// 注释 和 a / b",
    "看 https://github.com/Akarin7784/BakaCoding/pull/215",
    "diff --git a/x b/x\n--- /dev/null\n+++ b/x",
    "[REDACTED:home_path]/logs",
    "T-146 tr-abc span_1 2026-10-24T01:00:00.000Z",
    "项目/子目录",
  ];
  it.each(keep)("原样保留：%s", (s) => {
    expect(redactPaths(s, { home: HOME })).toEqual({ text: s, report: {} });
  });

  it("home 是 / 或空时不按 home 遮", () => {
    expect(redactPaths("a/b", { home: "/" }).text).toBe("a/b");
    expect(redactPaths("a/b", { home: "" }).text).toBe("a/b");
  });
});

describe("FullRedactor：值、键名、id 字段都过路径脱敏，DROPPED_KEYS 和密钥脱敏不变", () => {
  it("trace_id、多余字段、键名里的路径都遮掉；repo_path 照旧整段去掉；密钥照旧遮", () => {
    const r = new FullRedactor({ home: HOME });
    const out = r.deep({
      trace_id: "/tmp/evafake/trace",
      extra_path: "C:\\evafake\\x",
      ["/srv/evafake/key"]: 1,
      repo_path: "/srv/evafake/repo",
      token: "ghp_" + "a".repeat(36),
    });
    const json = JSON.stringify(out);
    expect(json).not.toContain("evafake");
    expect(json).not.toContain("repo_path");
    expect(json).not.toContain("a".repeat(36));
    expect(r.report()).toMatchObject({ abs_path: 2, windows_path: 1, github_token: 1 });
  });

  it("paths: false 时（反向检查用）路径原样漏出", () => {
    const r = new FullRedactor(false);
    expect(r.text("/tmp/evafake/trace")).toBe("/tmp/evafake/trace");
  });
});
