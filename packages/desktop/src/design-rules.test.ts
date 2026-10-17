// UI-01：设计规范的静态检查（放在 renderer 外，因为要读文件；renderer 里不许引入 node:*）——
// 文案表禁用词、token 与 docs/ui-design.md §5.1 一致、按钮只有三种、危险按钮只在确认框里、
// 组件里不写死调色板颜色、尊重「减少动态效果」。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buttonVariants } from "./renderer/components/ui/button";

/** packages/desktop/src */
const SRC = fileURLToPath(new URL("./", import.meta.url));
const RENDERER = join(SRC, "renderer");
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
/** 禁用的叫法（§5.6）；拆开写，免得本文件自己被搜到。 */
const FORBIDDEN = ["已合" + "并"];
const css = readFileSync(join(RENDERER, "index.css"), "utf8");
const doc = readFileSync(join(REPO, "docs/ui-design.md"), "utf8");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const sources = walk(RENDERER).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));

/** 取 CSS 某个选择器块里的自定义属性。 */
function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const body = css.slice(start, css.indexOf("}", start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

/** §5.1 表格：| `token` | `浅色` | `深色` | 用途 | */
function docTokens(): [string, string, string][] {
  const sec = doc.slice(doc.indexOf("### 5.1"), doc.indexOf("### 5.2"));
  return [...sec.matchAll(/^\| `([\w-]+)` \| `([^`]+)` \| `([^`]+)` \|/gm)].map((m) => [
    m[1]!,
    m[2]!,
    m[3]!,
  ]);
}

describe("颜色 token（§5.1）", () => {
  it("浅色、深色两套值逐个与设计文档一致", () => {
    const rows = docTokens();
    expect(rows.map((r) => r[0])).toEqual([
      "background",
      "sidebar",
      "foreground",
      "muted-foreground",
      "border",
      "hover",
      "accent",
      "danger",
    ]);
    const light = block(":root");
    const dark = block(':root[data-theme="dark"]');
    for (const [name, l, d] of rows) {
      expect(light[name], `${name} 浅色`).toBe(l);
      expect(dark[name], `${name} 深色`).toBe(d);
    }
  });

  it("danger 红与 accent 蓝是两个 token，色相不同", () => {
    const light = block(":root");
    expect(light.danger).not.toBe(light.accent);
    expect(light.danger).toMatch(/ 27\)$/);
    expect(light.accent).toMatch(/ 250\)$/);
    expect(css).toContain("--color-danger: var(--danger);");
  });

  it("dark: 变体跟随 data-theme，不直接跟随系统媒体查询", () => {
    expect(css).toContain(
      '@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));',
    );
    expect(css).not.toContain("prefers-color-scheme");
  });

  it("尊重系统「减少动态效果」", () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation-duration: 0\.01ms/,
    );
  });

  it("字体：西文 Inter，中文 Segoe UI Variable / 微软雅黑 UI；代码字体栈；正文 14px", () => {
    expect(css).toMatch(
      /--font-sans:\s*"Inter Variable", "Segoe UI Variable",[^;]*"Microsoft YaHei UI"/,
    );
    expect(css).toMatch(/--font-mono: "Cascadia Code", "JetBrains Mono", Consolas/);
    expect(css).toContain("--text-sm: 14px;");
    expect(css).toContain("--text-chat: 15px;");
    expect(css).toContain("--text-chat--line-height: 1.65;");
    expect(css).toMatch(/body \{[\s\S]*font-size: var\(--text-sm\)/);
  });

  it("阴影只有弹层一层（§5.4）", () => {
    expect(css).toContain("--shadow-popover: 0 8px 24px oklch(0 0 0 / 0.08);");
    const shadowUsers = sources.filter((f) =>
      /\bshadow-(?!popover)\w/.test(readFileSync(f, "utf8")),
    );
    expect(shadowUsers.map((f) => relative(RENDERER, f))).toEqual([]);
  });
});

describe("按钮（§5.3）", () => {
  it("只有 primary / secondary / danger 三种，高度 34 / 小号 28", () => {
    expect(buttonVariants({ variant: "primary" })).toContain("bg-primary");
    expect(buttonVariants({ variant: "secondary" })).toContain("bg-secondary");
    expect(buttonVariants({ variant: "danger" })).toContain("bg-danger");
    expect(buttonVariants({})).toContain("h-[34px]");
    expect(buttonVariants({ size: "sm" })).toContain("h-7");
    expect(buttonVariants({})).toContain("font-medium");
  });

  it("页面代码不用旧的 ghost / outline / default 变体", () => {
    const bad = sources.filter((f) =>
      /variant=["'](ghost|outline|default|destructive|link)["']/.test(readFileSync(f, "utf8")),
    );
    expect(bad.map((f) => relative(RENDERER, f))).toEqual([]);
  });

  it("危险样式只在 dialog.tsx 里用（确认框里的 DialogDangerButton）", () => {
    const users = sources.filter((f) =>
      /variant:\s*"danger"|variant=["']danger["']|bg-danger\b/.test(readFileSync(f, "utf8")),
    );
    expect(users.map((f) => relative(RENDERER, f)).sort()).toEqual([
      "components/ui/button.tsx",
      "components/ui/dialog.tsx",
    ]);
  });
});

describe("颜色只用 token", () => {
  it("组件里不写死 Tailwind 调色板颜色或十六进制色值", () => {
    const palette =
      /\b(?:bg|text|border|ring|fill|stroke)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone|white|black)\b/;
    const hex = /["'`]#[0-9a-fA-F]{3,8}["'`]/;
    const bad = sources.filter((f) => {
      const t = readFileSync(f, "utf8");
      return palette.test(t) || hex.test(t);
    });
    expect(bad.map((f) => relative(RENDERER, f))).toEqual([]);
  });

  it("错误提示用 danger，不再用强调蓝（问题清单第 10 条）", () => {
    // role="alert" 或 error 色调前后 4 行内不得出现 text-accent
    const offenders: string[] = [];
    for (const f of sources) {
      const lines = readFileSync(f, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!/role=\{?["']alert["']|role=\{[^}]*"alert"|tone === "error"|^\s*error:/.test(line))
          return;
        const near = lines.slice(Math.max(0, i - 4), i + 5).join("\n");
        if (near.includes("text-accent")) offenders.push(`${relative(RENDERER, f)}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe("文案（§5.6）", () => {
  it("packages/desktop/src 里任何文件都不出现禁用的叫法", () => {
    const hits: string[] = [];
    for (const file of walk(SRC)) {
      if (!/\.(tsx?|css|html|json)$/.test(file)) continue;
      const text = readFileSync(file, "utf8");
      text.split("\n").forEach((line, i) => {
        for (const w of FORBIDDEN)
          if (line.includes(w)) hits.push(`${relative(SRC, file)}:${i + 1}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
