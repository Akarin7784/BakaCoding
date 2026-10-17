// UI-03：只读原因显示 RepoNotReadyError 的 message；按错误码路由一键修复。
import { describe, expect, it } from "vitest";
import type { DesktopBackendStatus } from "../../shared/api";
import { readonlyReason, repoFixRoute } from "./readonly";

const ro = (error?: DesktopBackendStatus["error"], reason = "x"): DesktopBackendStatus => ({
  mode: "readonly",
  reason,
  repoSource: "last_import",
  ...(error && { error }),
});

describe("repoFixRoute（UI-03）", () => {
  it("RepoNotReadyError 按 code 路由；不是 Git 仓库走初始化", () => {
    expect(repoFixRoute(ro({ name: "RepoNotReadyError", message: "m", code: "no_commits" }))).toBe(
      "initial_commit",
    );
    expect(repoFixRoute(ro({ name: "RepoNotReadyError", message: "m", code: "no_main" }))).toBe(
      "create_main",
    );
    expect(repoFixRoute(ro({ name: "Error", message: "m", code: "not_git" }))).toBe("init_repo");
  });

  it("错误名对不上、code 不认识、live、没有 error：不路由", () => {
    expect(repoFixRoute(ro({ name: "Error", message: "m", code: "no_commits" }))).toBeNull();
    expect(
      repoFixRoute(ro({ name: "RepoNotReadyError", message: "m", code: "ENOENT" })),
    ).toBeNull();
    expect(repoFixRoute(ro())).toBeNull();
    expect(
      repoFixRoute({
        mode: "live",
        error: { name: "RepoNotReadyError", message: "m", code: "no_main" },
      }),
    ).toBeNull();
  });

  it("横幅原因原样用主进程给的 message（主进程已脱敏）", () => {
    expect(
      readonlyReason(
        ro(
          { name: "RepoNotReadyError", message: "m", code: "no_commits" },
          "仓库没有任何提交，请先提交一次再启动",
        ),
      ),
    ).toBe("仓库没有任何提交，请先提交一次再启动");
  });
});
