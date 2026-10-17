// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TicketWarningList, ticketWarningLabel } from "./Escalations";
import type { TicketWarningView } from "../mock/types";

afterEach(cleanup);

const w = (n: number, ticket_id: string, code: string, detail = ""): TicketWarningView => ({
  event_id: `e${n}`,
  ts: "2026-10-17T00:00:00Z",
  requirement_id: "R-1",
  ticket_id,
  code,
  detail,
});

describe("TicketWarningList（T-062）", () => {
  it("新增警告码有中文文案", () => {
    expect(ticketWarningLabel("requirement_truncated")).toContain("截断");
    expect(ticketWarningLabel("pr_close_failed")).toContain("关闭");
    expect(ticketWarningLabel("high_risk_reject_not_applied")).toBe(
      "PR 已关但裁决未生效，新 PR 仍在等你裁决",
    );
    expect(ticketWarningLabel("takeover_skipped")).toContain("跳过");
  });

  it("同单同码去重显示 ×N；超出 50 条显示 +N 条；detail 截断可悬停", () => {
    const long = "d".repeat(600);
    const warnings = [
      w(1, "T-1", "fields_invalid", long),
      w(2, "T-1", "fields_invalid", "later"),
      ...Array.from({ length: 51 }, (_, i) => w(10 + i, `T-x${i}`, "pr_close_failed")),
    ];
    render(<TicketWarningList warnings={warnings} />);
    const items = screen.getAllByTestId("ticket-warning");
    expect(items[0]!.textContent).toContain("×2");
    expect(items[0]!.textContent).toMatch(/d{500}…/);
    const detail = screen.getAllByTestId("ticket-warning-detail")[0]!;
    expect(detail.getAttribute("title")?.length).toBe(600);
    expect(screen.getByTestId("ticket-warning-more").textContent).toBe("+2 条");
  });
});
