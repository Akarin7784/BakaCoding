// UI-05c：渲染进程侧脱敏。
import { describe, expect, it } from "vitest";
import { REDACTED_PATH, redactForView } from "./redact";

describe("redactForView", () => {
  it("遮掉本地绝对路径、Windows 路径、~ 路径和 file URL", () => {
    const out = redactForView(
      "改了 /home/eva/proj/a.ts 和 C:\\Users\\eva\\b.ts，见 ~/x/y 与 file:///tmp/z",
    );
    expect(out).not.toMatch(/eva|\/tmp|~\//);
    expect(out.split(REDACTED_PATH).length - 1).toBe(4);
  });
  it("遮掉密钥类文本", () => {
    expect(redactForView("Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456")).not.toContain(
      "abcdefghijklmnopqrstuvwxyz123456",
    );
  });
  it("不误伤网址、相对路径和日期", () => {
    const s = "见 https://github.com/a/b ，改 src/app.ts，日期 2026/10/24";
    expect(redactForView(s)).toBe(s);
  });
});
