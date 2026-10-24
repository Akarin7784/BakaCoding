// UI-10：html / body / #root 定死 100% 高、overflow hidden，整页不出滚动条。
// 读源码的测试放在 electron/（渲染端测试不许 import node:*）。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("../renderer/index.css", import.meta.url)), "utf8");

describe("index.css 视口规则（UI-10）", () => {
  it("html, body, #root 高 100% 且 overflow hidden", () => {
    const m = css.match(/html,\s*body,\s*#root\s*\{([^}]*)\}/);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/height:\s*100%/);
    expect(m![1]).toMatch(/overflow:\s*hidden/);
  });
});
