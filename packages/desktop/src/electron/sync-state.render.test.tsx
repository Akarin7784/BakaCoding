// T-067：主进程脱敏 → 渲染进程组件的端到端检查（node 环境 SSR，避免 jsdom 加载 3 的 Node 依赖）。
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SyncStatus } from "../renderer/components/SyncStatus.js";
import { toDesktopSyncState } from "./sync-state.js";

describe("同步状态不泄露密钥（T-067）", () => {
  it("错误信息里带 GITHUB_TOKEN 值时，界面只出现变量名", () => {
    const token = "planted-gh-token-SHOULD-NOT-SHOW-9876";
    const ghp = "ghp_" + "B".repeat(36);
    const state = toDesktopSyncState(
      {
        enabled: false,
        disabled_reason: "auth",
        last_ok_at: null,
        last_error: {
          at: "2026-10-17T15:00:00.000Z",
          name: "GithubAuthError",
          message: `bad credentials ${token} ${ghp}`,
        },
        consecutive_failures: 1,
        rate_limited_until: null,
        next_at: null,
      },
      { GITHUB_TOKEN: token },
    );
    const html = renderToStaticMarkup(
      <SyncStatus state={state} now={Date.parse("2026-10-17T15:00:00.000Z")} />,
    );
    expect(html).not.toContain(token);
    expect(html).not.toContain(ghp);
    expect(html).toContain("GITHUB_TOKEN");
    expect(html).toContain("鉴权失败，同步已停止，请检查 GITHUB_TOKEN");
  });
});
