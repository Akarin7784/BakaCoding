// T-149：sanitizeChatReason 复用模块 11 的路径脱敏（POSIX / Windows / UNC / home / ~）。
import { describe, expect, it } from "vitest";
import { sanitizeChatReason } from "./supervisor-chat.js";

const HOME = "/home/eva";
const s = (m: string) => sanitizeChatReason(m, {}, { home: HOME });

describe("sanitizeChatReason 路径脱敏（T-149）", () => {
  it.each([
    [
      "POSIX 绝对路径",
      "主管回复失败：ENOENT 打不开 /var/lib/baka/state.db 了",
      "/var/lib/baka/state.db",
    ],
    [
      "Windows 路径",
      "主管回复失败：EPERM C:\\Users\\Eva\\repo\\a.ts 被占用",
      "C:\\Users\\Eva\\repo\\a.ts",
    ],
    [
      "UNC 路径",
      "主管回复失败：读不到 \\\\nas\\share\\proj\\x.json 了",
      "\\\\nas\\share\\proj\\x.json",
    ],
    ["home 目录", `主管回复失败：缺少 ${HOME}/projects/secret/config.json`, `${HOME}/projects`],
    ["~ 路径", "主管回复失败：找不到 ~/.bakacoding/keys.json 文件", "~/.bakacoding/keys.json"],
  ])("%s 被遮掉", (_n, msg, raw) => {
    const out = s(msg);
    expect(out).not.toContain(raw);
    expect(out).toContain("[REDACTED:");
    expect(out.startsWith("主管回复失败：")).toBe(true);
  });

  it("没有路径时原样返回", () => {
    expect(s("主管回复失败：RateLimitError 429")).toBe("主管回复失败：RateLimitError 429");
  });
});
