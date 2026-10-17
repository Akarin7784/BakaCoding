import { describe, expect, it } from "vitest";
import type { SyncState } from "@bakacoding/scheduler";
import {
  SYNC_ERROR_MESSAGE_MAX,
  sanitizeSyncErrorMessage,
  toDesktopSyncState,
  unavailableSyncState,
} from "./sync-state.js";

const base: SyncState = {
  enabled: true,
  last_ok_at: "2026-10-17T15:00:00.000Z",
  last_error: null,
  consecutive_failures: 0,
  rate_limited_until: null,
  next_at: "2026-10-17T15:01:00.000Z",
};

describe("toDesktopSyncState（T-067）", () => {
  it("live：字段与 9 的 SyncState 一致，加 available:true；不带 disabled_reason 时不出现该键", () => {
    const st = toDesktopSyncState(base);
    expect(st).toEqual({ available: true, ...base });
    expect("disabled_reason" in st).toBe(false);
  });

  it("鉴权停：保留 disabled_reason=auth", () => {
    const st = toDesktopSyncState({
      ...base,
      enabled: false,
      disabled_reason: "auth",
      next_at: null,
      last_error: {
        at: base.last_ok_at!,
        name: "GithubAuthError",
        message: "GitHub 鉴权失败（HTTP 401，sync）",
      },
      consecutive_failures: 1,
    });
    expect(st).toMatchObject({ available: true, enabled: false, disabled_reason: "auth" });
  });

  it("错误信息里的 env 密钥值、ghp_ token、Bearer 都不下发，只剩变量名 / 规则名", () => {
    const token = "planted-github-token-VALUE-123456";
    const ghp = "ghp_" + "A".repeat(36);
    const st = toDesktopSyncState(
      {
        ...base,
        last_error: {
          at: base.last_ok_at!,
          name: "Error",
          message: `fetch failed token=${token} auth ${ghp} Authorization: Bearer abcdefghijklmnop1234`,
        },
        consecutive_failures: 2,
      },
      { GITHUB_TOKEN: token, HOME: "/home/x" },
    );
    const json = JSON.stringify(st);
    expect(json).not.toContain(token);
    expect(json).not.toContain(ghp);
    expect(json).not.toContain("abcdefghijklmnop1234");
    expect(json).toContain("[REDACTED:GITHUB_TOKEN]");
  });

  it("错误信息截到上限，错误名去掉非标识符字符", () => {
    const st = toDesktopSyncState({
      ...base,
      last_error: { at: base.last_ok_at!, name: "Bad<script>Name", message: "x".repeat(10_000) },
      consecutive_failures: 1,
    });
    if (!st.available) throw new Error("expected live");
    expect(st.last_error!.message.length).toBe(SYNC_ERROR_MESSAGE_MAX + 1);
    expect(st.last_error!.message.endsWith("…")).toBe(true);
    expect(st.last_error!.name).toBe("BadscriptName");
  });

  it("短值 / 非密钥变量名不替换", () => {
    expect(sanitizeSyncErrorMessage("path /usr/bin ok", { PATH: "/usr/bin", API_KEY: "abc" })).toBe(
      "path /usr/bin ok",
    );
  });

  it("只读：available:false，reason 带只读原因", () => {
    expect(unavailableSyncState("缺少环境变量 DEEPSEEK_API_KEY")).toEqual({
      available: false,
      reason: "只读模式：缺少环境变量 DEEPSEEK_API_KEY",
    });
    expect(unavailableSyncState(undefined)).toEqual({
      available: false,
      reason: "只读模式：后端未接线",
    });
  });
});
