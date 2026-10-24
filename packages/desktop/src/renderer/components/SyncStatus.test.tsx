// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { BakaDesktopApi, DesktopSnapshot, DesktopSyncState } from "../../shared/api.js";
import { App } from "../App";
import { SyncStatus } from "./SyncStatus";

afterEach(cleanup);

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

describe("SyncStatus（T-067）", () => {
  it("运行中：显示状态、上次成功、下次尝试", () => {
    render(<SyncStatus state={live} now={now} />);
    expect(screen.getByTestId("sync-status-label").textContent).toBe("同步运行中");
    expect(screen.getByTestId("sync-last-ok").textContent).toContain("上次成功");
    expect(screen.getByTestId("sync-next").textContent).toContain("1 分钟后");
    expect(screen.queryByTestId("sync-hint")).toBeNull();
  });

  it("鉴权停：提示检查 GITHUB_TOKEN（role=alert）", () => {
    render(
      <SyncStatus
        now={now}
        state={{
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
        }}
      />,
    );
    expect(screen.getByTestId("sync-status-label").textContent).toBe("同步已停止");
    expect(screen.getByRole("alert").textContent).toBe("鉴权失败，同步已停止，请检查 GITHUB_TOKEN");
    expect(screen.queryByTestId("sync-next")).toBeNull();
  });

  it("限流：触发限流，将在 … 后重试", () => {
    render(
      <SyncStatus
        now={now}
        state={{
          ...live,
          rate_limited_until: "2026-10-17T15:02:00.000Z",
          next_at: "2026-10-17T15:02:00.000Z",
          consecutive_failures: 1,
          last_error: { at: live.last_ok_at!, name: "GithubRateLimitError", message: "限流" },
        }}
      />,
    );
    expect(screen.getByTestId("sync-status-label").textContent).toBe("限流退避中");
    expect(screen.getByTestId("sync-hint").textContent).toBe("触发限流，将在 2 分钟后重试");
    // UI-01：告警用 danger 红，不用强调蓝
    expect(screen.getByTestId("sync-hint").className).toContain("text-danger");
    expect(screen.getByTestId("sync-status-label").className).toContain("text-danger");
  });

  it("只读：同步状态不可用 + 原因", () => {
    render(
      <SyncStatus
        now={now}
        state={{ available: false, reason: "只读模式：缺少环境变量 DEEPSEEK_API_KEY" }}
      />,
    );
    expect(screen.getByTestId("sync-status-label").textContent).toBe("同步状态不可用");
    expect(screen.getByTestId("sync-hint").textContent).toBe(
      "只读模式：缺少环境变量 DEEPSEEK_API_KEY",
    );
  });

  it("错误详情约 500 字截断，悬停有更长原文", () => {
    render(
      <SyncStatus
        now={now}
        state={{
          ...live,
          consecutive_failures: 1,
          last_error: { at: live.last_ok_at!, name: "Error", message: "y".repeat(2000) },
        }}
      />,
    );
    const el = screen.getByTestId("sync-error-detail");
    expect(el.textContent!.length).toBe(501);
    expect(el.textContent!.endsWith("…")).toBe(true);
    expect(el.getAttribute("title")!.length).toBeGreaterThan(1000);
  });
});

describe("App 接 syncState（T-067）", () => {
  const snap: DesktopSnapshot = {
    db: { path: "/x.db", state: "ok" },
    events: [],
    tickets: [],
    last_seq: -1,
  };

  it("UI-06c：左下状态卡不再显示同步状态", async () => {
    const listeners = new Set<(s: DesktopSyncState) => void>();
    const api = {
      platform: "linux",
      getSnapshot: async () => snap,
      onUpdate: () => () => {},
      getSyncState: async () => live,
      getGitStatus: async () => ({ ok: false, reason: "Git 状态暂不可用" }),
      onSyncState: (l: (s: DesktopSyncState) => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    } as unknown as BakaDesktopApi;
    render(<App api={api} />);
    // UI-06c：同步状态挪到右面板 Git 区（App.live.test 覆盖）；左下状态卡里不再有
    fireEvent.click(await screen.findByTestId("status-dot"));
    await screen.findByTestId("status-card");
    act(() => listeners.forEach((l) => l({ ...live, enabled: false })));
    expect(within(screen.getByTestId("status-card")).queryByTestId("sync-status")).toBeNull();
  });

  it("没有 api 也没注入时不显示同步行", () => {
    render(<App api={null} />);
    expect(screen.queryByTestId("sync-status")).toBeNull();
  });
});
