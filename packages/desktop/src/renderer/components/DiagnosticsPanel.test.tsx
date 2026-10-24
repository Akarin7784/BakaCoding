// @vitest-environment jsdom
// T-130：设置 › 诊断面板（UI-09）：三种粒度导出、打开数据目录、最近启动错误、只读禁用。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BakaDesktopApi, DesktopSnapshot } from "../../shared/api";
import { DiagnosticsPanel } from "./DiagnosticsPanel";

afterEach(cleanup);

const snap = {
  db: { path: "/repo/.bakacoding/bakacoding.db", state: "ok" },
  events: [],
  tickets: [
    {
      ticket_id: "T-1",
      project_id: "p-1",
      requirement_id: "R-1",
      created_at: "2026-10-17T00:00:00.000Z",
      title: "登录验证码",
      status: "coding",
      resubmit_count: 0,
    },
    {
      ticket_id: "T-2",
      project_id: "p-1",
      requirement_id: "R-1",
      created_at: "2026-10-17T01:00:00.000Z",
      title: "退出登录",
      status: "pending",
      resubmit_count: 1,
    },
  ],
  last_seq: 5,
} as unknown as DesktopSnapshot;

function api(over: Partial<BakaDesktopApi> = {}) {
  return {
    getSnapshot: vi.fn(async () => snap),
    getBackendStatus: vi.fn(async () => ({
      mode: "live" as const,
      error: { name: "Error", message: "启动失败（DiskError）", code: "not_git" },
    })),
    exportDiagnostics: vi.fn(async () => ({ ok: true as const, path: "/tmp/diag.zip" })),
    openDataDir: vi.fn(async () => ({ ok: true as const })),
    ...over,
  } as unknown as BakaDesktopApi;
}

describe("DiagnosticsPanel（T-130）", () => {
  it("默认最近 24 小时：导出不带粒度参数；点「打开数据目录」调 IPC", async () => {
    const a = api();
    render(<DiagnosticsPanel api={a} />);
    await screen.findByTestId("diagnostics-panel");
    fireEvent.click(screen.getByTestId("diag-export"));
    await waitFor(() => expect(a.exportDiagnostics).toHaveBeenCalledWith(undefined));
    fireEvent.click(screen.getByTestId("diag-open-data-dir"));
    await waitFor(() => expect(a.openDataDir).toHaveBeenCalledWith());
  });

  it("按需求 / 按单张单：下拉来自快照，导出带对应 scope", async () => {
    const a = api();
    render(<DiagnosticsPanel api={a} />);
    await waitFor(() => expect(screen.queryByTestId("diag-requirement")).toBeNull());

    fireEvent.click(screen.getByTestId("diag-mode-requirement"));
    const req = (await screen.findByTestId("diag-requirement")) as HTMLSelectElement;
    // 需求去重：两条单同属一个需求
    expect(req.options).toHaveLength(1);
    fireEvent.click(screen.getByTestId("diag-export"));
    await waitFor(() =>
      expect(a.exportDiagnostics).toHaveBeenLastCalledWith({
        scope: { kind: "requirement", requirement_id: "R-1" },
      }),
    );

    fireEvent.click(screen.getByTestId("diag-mode-ticket"));
    const tk = (await screen.findByTestId("diag-ticket")) as HTMLSelectElement;
    expect(tk.options).toHaveLength(2);
    fireEvent.change(tk, { target: { value: "T-2" } });
    fireEvent.click(screen.getByTestId("diag-export"));
    await waitFor(() =>
      expect(a.exportDiagnostics).toHaveBeenLastCalledWith({
        scope: { kind: "ticket", ticket_id: "T-2" },
      }),
    );
  });

  it("指定时间段：转成 ISO 传给主进程；倒置的时间段不调用导出", async () => {
    const a = api();
    render(<DiagnosticsPanel api={a} />);
    await screen.findByTestId("diagnostics-panel");
    fireEvent.click(screen.getByTestId("diag-mode-range"));
    fireEvent.change(screen.getByTestId("diag-from"), { target: { value: "2026-10-18T08:00" } });
    fireEvent.change(screen.getByTestId("diag-to"), { target: { value: "2026-10-18T12:00" } });
    fireEvent.click(screen.getByTestId("diag-export"));
    await waitFor(() =>
      expect(a.exportDiagnostics).toHaveBeenLastCalledWith({
        scope: {
          kind: "time_range",
          from: new Date("2026-10-18T08:00").toISOString(),
          to: new Date("2026-10-18T12:00").toISOString(),
        },
      }),
    );

    fireEvent.change(screen.getByTestId("diag-from"), { target: { value: "2026-10-18T13:00" } });
    fireEvent.click(screen.getByTestId("diag-export"));
    await waitFor(() => expect(screen.queryAllByText(/时间段不合法/)).toBeTruthy());
    expect(a.exportDiagnostics).toHaveBeenCalledTimes(1);
  });

  it("只读时导出禁用；打开数据目录仍可用；显示最近启动错误详情", async () => {
    const a = api();
    render(<DiagnosticsPanel api={a} readonly />);
    await screen.findByTestId("diagnostics-panel");
    const btn = screen.getByTestId("diag-export") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toContain("只读");
    fireEvent.click(screen.getByTestId("diag-open-data-dir"));
    await waitFor(() => expect(a.openDataDir).toHaveBeenCalledWith());
    const details = await screen.findByTestId("diag-last-error");
    expect(details.textContent).toContain("启动失败（DiskError）");
    expect(details.textContent).toContain("not_git");
  });

  it("没有 preload API 时整块不渲染", () => {
    render(<DiagnosticsPanel />);
    expect(screen.queryByTestId("diagnostics-panel")).toBeNull();
  });
});
