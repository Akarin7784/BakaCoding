// @vitest-environment jsdom
// UI-06a：右面板单列表（§4.5 第 3 项）：只列当前项目、状态图标 + 脱敏标题 + ×重写次数、
// 按状态筛选、点单 / 行内导出回调。
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { TicketView } from "../../shared/api";
import { projects } from "../mock/data";
import { RightPanel } from "./RightPanel";

afterEach(cleanup);
beforeAll(() => {
  // Radix Select 在 jsdom 里要这几个
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.releasePointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
});

const view = projects[0]!; // p-todo
const pid = view.project.payload.project_id;
const tk = (o: Partial<TicketView> & Pick<TicketView, "ticket_id">): TicketView => ({
  project_id: pid,
  requirement_id: "req-1",
  created_at: "2026-10-24T01:00:00Z",
  title: o.ticket_id,
  status: "pending",
  resubmit_count: 0,
  ...o,
});
const tickets: TicketView[] = [
  tk({ ticket_id: "T-1", title: "加字段", status: "merged" }),
  tk({
    ticket_id: "T-2",
    requirement_id: "req-2",
    created_at: "2026-10-24T02:00:00Z",
    title: "改 /home/eva/todo/sort.ts",
    status: "resubmitting",
    resubmit_count: 2,
  }),
  tk({ ticket_id: "Z-1", project_id: "p-other", title: "别的项目" }),
];

const rows = () => screen.getAllByTestId("ticket-row");
const row = (id: string) => rows().find((r) => r.dataset.ticket === id)!;

describe("RightPanel 单列表（UI-06a）", () => {
  it("只列当前项目；状态图标、脱敏标题、×重写次数", () => {
    render(<RightPanel view={view} tickets={tickets} onOpenTicket={() => {}} />);
    expect(rows().map((r) => r.dataset.ticket)).toEqual(["T-1", "T-2"]);
    const t2 = row("T-2");
    expect(within(t2).getByRole("img", { name: /重写/ }).dataset.status).toBe("resubmitting");
    expect(t2.textContent).not.toContain("/home/eva");
    expect(t2.textContent).toContain("[REDACTED");
    expect(t2.textContent).toContain("×2");
    expect(screen.queryByText(/别的项目/)).toBeNull();
  });

  it("没有单时显示空状态，不显示筛选", () => {
    render(<RightPanel view={view} tickets={[]} onOpenTicket={() => {}} />);
    expect(screen.getByText("暂无需求单")).toBeTruthy();
    expect(screen.queryByTestId("ticket-status-filter")).toBeNull();
  });

  it("按状态筛选：选「已合入」只剩 T-1", async () => {
    render(<RightPanel view={view} tickets={tickets} onOpenTicket={() => {}} />);
    const trigger = screen.getByTestId("ticket-status-filter");
    fireEvent.keyDown(trigger, { key: "Enter" });
    const option = await screen.findByRole("option", { name: "已合入" });
    // 选项只有「全部 + 本项目出现过的状态」
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "全部状态",
      "重写",
      "已合入",
    ]);
    fireEvent.click(option);
    expect(rows().map((r) => r.dataset.ticket)).toEqual(["T-1"]);
  });

  it("点单：回调需求号和单号；行内导出：回调单号", () => {
    const onOpenTicket = vi.fn();
    const onExportTicket = vi.fn();
    render(
      <RightPanel
        view={view}
        tickets={tickets}
        onOpenTicket={onOpenTicket}
        onExportTicket={onExportTicket}
      />,
    );
    fireEvent.click(within(row("T-2")).getByRole("button", { name: /^T-2 / }));
    expect(onOpenTicket).toHaveBeenCalledWith("req-2", "T-2");
    fireEvent.click(screen.getByRole("button", { name: "导出 T-2 诊断包" }));
    expect(onExportTicket).toHaveBeenCalledWith("T-2");
  });

  it("只读或正在导出时行内导出禁用", () => {
    const { rerender } = render(
      <RightPanel view={view} tickets={tickets} onOpenTicket={() => {}} onExportTicket={() => {}} readonly />,
    );
    expect((screen.getByRole("button", { name: "导出 T-1 诊断包" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(
      <RightPanel view={view} tickets={tickets} onOpenTicket={() => {}} onExportTicket={() => {}} exportBusy />,
    );
    expect((screen.getByRole("button", { name: "导出 T-1 诊断包" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<RightPanel view={view} tickets={tickets} onOpenTicket={() => {}} onExportTicket={() => {}} />);
    expect((screen.getByRole("button", { name: "导出 T-1 诊断包" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
