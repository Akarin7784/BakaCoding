// UI-05c / T-154：渲染进程侧脱敏。
import { redactPathsPure } from "@bakacoding/diagnostics/dist/path-redaction-core.js";
import { describe, expect, it } from "vitest";
import { redactForView } from "./redact";

const MARK = /\[REDACTED:(?:home_dir|file_url|unc_path|windows_path|tilde_path|abs_path)\]/g;

describe("redactForView", () => {
  it("遮掉本地绝对路径、Windows 路径、~ 路径和 file URL", () => {
    const out = redactForView(
      "改了 /home/eva/proj/a.ts 和 C:\\Users\\eva\\b.ts，见 ~/x/y 与 file:///tmp/z",
    );
    expect(out).not.toMatch(/eva|\/tmp|~\//);
    expect(out.match(MARK)?.length).toBe(4);
  });
  it("中文句子里路径后紧跟全角标点时不吞后文", () => {
    expect(redactForView("日志里有 /home/eva/a/.env，第 1 次重写。")).toBe(
      "日志里有 [REDACTED:abs_path]，第 1 次重写。",
    );
    expect(redactForView("打开 C:\\x\\a.exe。然后「~/y」")).toBe(
      "打开 [REDACTED:windows_path]。然后「[REDACTED:tilde_path]」",
    );
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

// T-154：渲染进程和主进程用同一份实现（11 的 redactPathsPure），不再各写一套。
describe("redactForView 用 11 的共享实现（T-154）", () => {
  it.each([
    "共享 \\\\fileserver\\share x\\repo\\a",
    "打开 D:/Docs/my repo/a.ts",
    "读 /Volumes/Data Disk/x 失败",
    'cd "/srv/x/my Disk"',
    "file:/x/y 和 /dev/null",
  ])("%s", (s) => {
    expect(redactForView(s)).toBe(redactPathsPure(s, { home: "", fullWidthStop: true }).text);
    expect(redactForView(s)).toMatch(MARK);
  });
});
