import { describe, expect, it } from "vitest";
import type { DesktopSyncState } from "../../shared/api.js";
import { GIT_SYNC_ERROR_TEXT, gitSyncView } from "./gitStatus";

const ok: DesktopSyncState = {
  available: true,
  enabled: true,
  last_ok_at: "2026-10-24T07:40:00.000Z",
  last_error: null,
  consecutive_failures: 0,
  rate_limited_until: null,
  next_at: "2026-10-24T07:41:00.000Z",
};
const SECRET = "boom /home/secret-user/repo ghp_xxx";

describe("gitSyncView（UI-06c）", () => {
  it("正常：只有上次同步时间，无错误", () => {
    const v = gitSyncView(ok);
    expect(v.lastSync).toMatch(/^上次同步：2026/);
    expect(v.error).toBeNull();
  });
  it("从没成功过", () => {
    expect(gitSyncView({ ...ok, last_ok_at: null }).lastSync).toBe("上次同步：还没有成功过");
  });
  it("不可用 / 没有：都不显示", () => {
    expect(gitSyncView(null)).toEqual({ lastSync: null, error: null });
    expect(gitSyncView({ available: false, reason: "只读" })).toEqual({
      lastSync: null,
      error: null,
    });
  });
  it("鉴权停 → 固定文案", () => {
    const v = gitSyncView({
      ...ok,
      enabled: false,
      disabled_reason: "auth",
      consecutive_failures: 1,
      last_error: { name: "GithubAuthError", message: SECRET },
    });
    expect(v.error).toBe(GIT_SYNC_ERROR_TEXT.auth);
  });
  it("限流 → 固定文案", () => {
    const v = gitSyncView({
      ...ok,
      consecutive_failures: 1,
      last_error: { name: "GithubRateLimitError", message: SECRET },
    });
    expect(v.error).toBe(GIT_SYNC_ERROR_TEXT.rateLimited);
  });
  it("普通失败 → 固定文案，不透出原始错误", () => {
    const v = gitSyncView({
      ...ok,
      consecutive_failures: 3,
      last_error: { name: "Error", message: SECRET },
    });
    expect(v.error).toBe(GIT_SYNC_ERROR_TEXT.failed);
    expect(JSON.stringify(v)).not.toContain("secret-user");
    expect(JSON.stringify(v)).not.toContain("ghp_");
  });
});
