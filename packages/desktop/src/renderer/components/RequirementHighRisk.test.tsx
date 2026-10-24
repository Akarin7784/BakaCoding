// @vitest-environment jsdom
// UI-05d：需求页里的高风险待办卡片（页面级：渲染 RequirementPage）。
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HIGH_RISK_CARD_COPY as C } from "../lib/copy";
import { hr, ticketOf } from "../lib/testEvents";
import { RequirementPage } from "./RequirementPage";

afterEach(cleanup);

const tickets = [
  ticketOf({ ticket_id: "T-1", requirement_id: "r1" }),
  ticketOf({ ticket_id: "T-9", requirement_id: "r2" }),
];
const items = [
  hr({ ticket_id: "T-1", pr_id: "pr-1", files: [{ path: "/home/eva/proj/package.json" }] }),
  hr({ ticket_id: "T-9", pr_id: "pr-9" }),
];

function page(onDecide = vi.fn(async () => ({ ok: true as const })), readonly = false) {
  render(
    <RequirementPage
      requirementId="r1"
      tickets={tickets}
      events={[]}
      highRisk={items}
      onDecideHighRisk={onDecide}
      readonly={readonly}
    />,
  );
  return onDecide;
}

function card() {
  return screen.getByRole("region", { name: C.label });
}

describe("需求页高风险卡片", () => {
  it("只显示本需求的单，红底卡片，文件路径脱敏", () => {
    page();
    const cards = screen.getAllByTestId("requirement-high-risk");
    expect(cards.map((c) => c.dataset.ticket)).toEqual(["T-1"]);
    expect(cards[0]!.className).toContain("bg-danger-soft");
    expect(cards[0]!.textContent).not.toContain("/home/eva");
    expect(within(card()).getByText(C.title("T-1"))).toBeTruthy();
  });

  it("没有本需求的高风险时不渲染卡片区", () => {
    render(
      <RequirementPage
        requirementId="r2"
        tickets={tickets}
        events={[]}
        highRisk={[items[0]!]}
        onDecideHighRisk={vi.fn()}
      />,
    );
    expect(screen.queryByRole("region", { name: C.label })).toBeNull();
  });

  it("放行走现有 decide（ticket_id, pr_id, release），不带 detail", async () => {
    const d = page();
    fireEvent.click(within(card()).getByRole("button", { name: C.release }));
    await waitFor(() => expect(d).toHaveBeenCalledWith("T-1", "pr-1", "release"));
  });

  it("拒绝需填理由：空理由不能确认，填了理由作为 detail 传出", async () => {
    const d = page();
    fireEvent.click(within(card()).getByRole("button", { name: C.reject }));
    const confirm = within(card()).getByRole("button", { name: C.confirmReject });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    expect(confirm.className).toContain("text-danger");
    fireEvent.change(within(card()).getByLabelText(C.rejectReason), {
      target: { value: "  依赖升级不要  " },
    });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(d).toHaveBeenCalledWith("T-1", "pr-1", "reject", "依赖升级不要"));
  });

  it("stale_pr 显示固定文案", async () => {
    page(vi.fn(async () => ({ ok: false as const, code: "stale_pr", message: "x /home/eva" })));
    fireEvent.click(within(card()).getByRole("button", { name: C.release }));
    expect((await screen.findByRole("alert")).textContent).toBe("PR 已更新，请重新查看");
  });

  it("后端只读时按钮禁用", () => {
    page(undefined, true);
    expect(
      (within(card()).getByRole("button", { name: C.release }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (within(card()).getByRole("button", { name: C.reject }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
