import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { redactPaths, redactPathsPure } from "./index.js";

const HOME = "/home/evafake";

// T-154：纯函数版不依赖 node，渲染进程能直接打包。
describe("redactPathsPure：不依赖 node（T-154）", () => {
  it("源码里没有 node: / fs / os / path 之类的 import", () => {
    const src = readFileSync(new URL("./path-redaction-core.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/require\(|from\s+["'](node:|fs|os|path)/);
  });
});

// T-154：主进程 redactPaths 转给纯函数，输出逐字一致（不开全角截止）。
describe("redactPaths 与 redactPathsPure 输出一致（T-154）", () => {
  const inputs = [
    `读 ${HOME}/a.txt 失败`,
    "file:///etc/passwd",
    "共享 \\\\fileserver\\share\\repo x\\a",
    "打开 C:\\Program Files\\app\\a.exe 失败",
    "在 ~/code/x y/z.json",
    "读 /srv/a.ts，然后 /srv/b.ts。后文",
    "https://x.com/a 和 2026/10/24 和 a/b",
    "/dev/null",
    'cd "/srv/x/my Disk"',
  ];
  it.each(inputs)("%s", (s) => {
    expect(redactPaths(s, { home: HOME })).toEqual(redactPathsPure(s, { home: HOME }));
  });

  it("主进程输出固定（改了实现这里会红）", () => {
    // 主进程不把全角标点当截止符：吞到空白，再按 T-147 续接把后一段也并进来（偏向多遮）
    expect(redactPaths("读 /srv/a.ts，然后 /srv/b.ts。后文", { home: HOME }).text).toBe(
      "读 [REDACTED:abs_path]",
    );
  });
});

describe("redactPathsPure：fullWidthStop（UI-05c 369e7be 的修复）", () => {
  it.each([
    ["读 /srv/a.ts，然后重试", "读 [REDACTED:abs_path]，然后重试"],
    ["见 C:\\x\\a.exe。下一句", "见 [REDACTED:windows_path]。下一句"],
    ["「~/x/y」里", "「[REDACTED:tilde_path]」里"],
  ])("%s", (input, want) => {
    expect(redactPathsPure(input, { home: "", fullWidthStop: true }).text).toBe(want);
  });
  it("home 传空串时跳过 home_dir，路径仍由 abs_path 遮", () => {
    expect(redactPathsPure(`${HOME}/a`, { home: "", fullWidthStop: true }).text).toBe(
      "[REDACTED:abs_path]",
    );
  });
});

// T-147 已接受的三条限制：这些测试钉住现状（漏出的部分）。行为要改时同步改这里和 path-redaction-core.ts 文件头。
describe("T-147 已接受的限制", () => {
  it("限制 1：路径在句尾、最后一段带空格时，最后一个词漏出", () => {
    expect(redactPaths("读 /Volumes/evafake Data Disk", { home: HOME }).text).toBe(
      "读 [REDACTED:abs_path] Data Disk",
    );
  });
  it("限制 2：续接窗口是 3 个词——3 个词以内续接，4 个词不续接", () => {
    expect(redactPaths("/srv/a w1 w2 w3 x/y", { home: HOME }).text).toBe("[REDACTED:abs_path]");
    expect(redactPaths("/srv/a w1 w2 w3 w4 x/y", { home: HOME }).text).toBe(
      "[REDACTED:abs_path] w1 w2 w3 w4 x/y",
    );
  });
  it("限制 3：引号里路径前面有别的字时只按空格规则处理（同样漏最后一个词）", () => {
    expect(redactPaths('"见 /srv/my Disk"', { home: HOME }).text).toBe(
      '"见 [REDACTED:abs_path] Disk"',
    );
    // 对照：紧挨引号时整段遮
    expect(redactPaths('"/srv/my Disk"', { home: HOME }).text).toBe('"[REDACTED:abs_path]"');
  });
});
