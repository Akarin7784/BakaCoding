import { describe, expect, it } from "vitest";
import type { DesktopSyncState } from "../../shared/api.js";
import { describeSyncState, formatDuration, SYNC_AUTH_STOPPED_HINT } from "./sync-labels";

const now = Date.parse("2026-10-17T15:00:00.000Z");
const live: DesktopSyncState = {
  available: true,
  enabled: true,
  last_ok_at: "2026-10-17T14:59:00.000Z",
  last_error: null,
  consecutive_failures: 0,
  rate_limited_until: null,
  next_at: "2026-10-17T15:01:00.000Z",
};

describe("formatDuration（T-067）", () => {
  it("秒 / 分 / 小时", () => {
    expect(formatDuration(-5)).toBe("0 秒");
    expect(formatDuration(42_000)).toBe("42 秒");
    expect(formatDuration(150_000)).toBe("2 分 30 秒");
    expect(formatDuration(600_000)).toBe("10 分钟");
    expect(formatDuration(3_900_000)).toBe("1 小时 5 分");
  });
});

describe("describeSyncState（T-067）", () => {
  it("运行中：有上次成功和下次尝试，没有提示", () => {
    const v = describeSyncState(live, now);
    expect(v.label).toBe("同步运行中");
    expect(v.tone).toBe("ok");
    expect(v.hint).toBeNull();
    expect(v.lastOk).not.toBeNull();
    expect(v.next).toContain("1 分钟后");
  });

  it("鉴权停：同步已停止 + 检查 GITHUB_TOKEN", () => {
    const v = describeSyncState(
      {
        ...live,
        enabled: false,
        disabled_reason: "auth",
        next_at: null,
        consecutive_failures: 1,
        last_error: {
          at: live.last_ok_at!,
          name: "GithubAuthError",
          message: "GitHub 鉴权失败（HTTP 401，sync）",
        },
      },
      now,
    );
    expect(v.label).toBe("同步已停止");
    expect(v.hint).toBe(SYNC_AUTH_STOPPED_HINT);
    expect(v.hint).toBe("鉴权失败，同步已停止，请检查 GITHUB_TOKEN");
    expect(v.next).toBeNull();
  });

  it("限流窗口：触发限流，取窗口结束和下一轮里较晚的", () => {
    const v = describeSyncState(
      {
        ...live,
        rate_limited_until: "2026-10-17T15:02:30.000Z",
        next_at: "2026-10-17T15:02:00.000Z",
        consecutive_failures: 1,
        last_error: { at: live.last_ok_at!, name: "GithubRateLimitError", message: "限流" },
      },
      now,
    );
    expect(v.label).toBe("限流退避中");
    expect(v.hint).toBe("触发限流，将在 2 分 30 秒后重试");
  });

  it("限流窗口已过但仍在退避：按下一轮时刻", () => {
    const v = describeSyncState(
      {
        ...live,
        rate_limited_until: null,
        next_at: "2026-10-17T15:00:45.000Z",
        consecutive_failures: 2,
        last_error: { at: live.last_ok_at!, name: "GithubRateLimitError", message: "限流" },
      },
      now,
    );
    expect(v.hint).toBe("触发限流，将在 45 秒后重试");
  });

  it("其他失败：连续 N 次 + 重试时间", () => {
    const v = describeSyncState(
      {
        ...live,
        consecutive_failures: 3,
        next_at: "2026-10-17T15:04:00.000Z",
        last_error: { at: live.last_ok_at!, name: "Error", message: "ECONNRESET" },
      },
      now,
    );
    expect(v.label).toBe("同步失败");
    expect(v.hint).toBe("同步失败（连续 3 次），将在 4 分钟后重试");
    expect(v.errorDetail).toBe("Error：ECONNRESET");
  });

  it("没开定时同步：同步未运行", () => {
    expect(describeSyncState({ ...live, enabled: false, next_at: null }, now).label).toBe(
      "同步未运行",
    );
  });

  it("只读：同步状态不可用 + 原因", () => {
    const v = describeSyncState(
      { available: false, reason: "只读模式：写入锁被占用（pid 1）" },
      now,
    );
    expect(v.label).toBe("同步状态不可用");
    expect(v.hint).toBe("只读模式：写入锁被占用（pid 1）");
  });
});
