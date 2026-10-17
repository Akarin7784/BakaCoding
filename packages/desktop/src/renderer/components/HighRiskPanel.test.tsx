// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DesktopPendingHighRisk } from "../../shared/api.js";
import { HighRiskPanel } from "./HighRiskPanel";

afterEach(cleanup);

const item: DesktopPendingHighRisk = {
  ticket_id: "T-1",
  project_id: "P-1",
  pr_id: "pr-9",
  pr_url: "https://example.com/pr/9",
  reasons: ["dependency_file", "dependency_kind"],
  files: [{ path: "x.json", old_path: "package.json" }, { path: "pnpm-lock.yaml" }],
  files_more: 1,
  held_at: "2026-10-17T12:00:00Z",
};

describe("HighRiskPanel（T-062）", () => {
  it("展示理由、改名文件「package.json → x.json」，放行调用 onDecide", async () => {
    const onDecide = vi.fn(async () => ({ ok: true as const }));
    render(<HighRiskPanel items={[item]} onDecide={onDecide} />);
    expect(screen.getByTestId("high-risk-panel")).toBeTruthy();
    expect(screen.getByTestId("high-risk-files").textContent).toContain("package.json → x.json");
    expect(screen.getByTestId("high-risk-files").textContent).toContain("pnpm-lock.yaml");
    expect(screen.getByTestId("high-risk-files").textContent).toContain("另 1 个");
    fireEvent.click(screen.getByTestId("high-risk-release"));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("T-1", "pr-9", "release"));
  });

  it("stale_pr 显示「PR 已更新，请重新查看」", async () => {
    const onDecide = vi.fn(async () => ({
      ok: false as const,
      code: "stale_pr",
      message: "x",
    }));
    render(<HighRiskPanel items={[item]} onDecide={onDecide} />);
    fireEvent.click(screen.getByTestId("high-risk-reject"));
    await waitFor(() =>
      expect(screen.getByTestId("high-risk-error").textContent).toBe("PR 已更新，请重新查看"),
    );
    // UI-01：错误用 danger 红，不用强调蓝
    expect(screen.getByTestId("high-risk-error").className).toContain("text-danger");
  });
});
