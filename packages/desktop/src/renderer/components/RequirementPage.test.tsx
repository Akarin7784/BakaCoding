// @vitest-environment jsdom
// UI-05c：需求页（docs/ui-design.md §4.4）。页面级测试：TicketStepper 真的渲染在页面里（蓝色大肥鱼 P3）。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopModelConfigResult, DesktopRequirementDetailResult } from "../../shared/api";
import { REQUIREMENT_PAGE_COPY, STEPPER_COPY } from "../lib/copy";
import { call, changed, msg, ticketOf } from "../lib/testEvents";
import { RequirementPage, needsFold } from "./RequirementPage";

afterEach(cleanup);

const LONG = ["第一行", "第二行", "第三行", "第四行 /home/eva/proj/a.ts"].join("\n");

function apiOf(
  detail: DesktopRequirementDetailResult = {
    ok: true,
    detail: {
      requirement_id: "r1",
      name: "加登录页",
      requirement_text: LONG,
      decomposition_summary: "拆成两张单，token sk-abcdefghijklmnopqrstuvwx",
      tickets: [],
    },
  },
  review = 3,
) {
  return {
    getRequirementDetail: vi.fn(async () => detail),
    getModelConfig: vi.fn(
      async () =>
        ({
          ok: true,
          pipeline: { resubmit_limits: { review } },
        }) as unknown as DesktopModelConfigResult,
    ),
  };
}

const tickets = [
  ticketOf({ ticket_id: "T-1", status: "re_reviewing", resubmit_count: 1 }),
  ticketOf({ ticket_id: "T-2", status: "merged", title: "改 /Users/eva/x.ts" }),
  ticketOf({ ticket_id: "T-9", requirement_id: "r2" }),
];

describe("RequirementPage", () => {
  it("每张本需求的单渲染一行 TicketStepper（别的需求的单不出现）", async () => {
    render(<RequirementPage requirementId="r1" tickets={tickets} events={[]} api={apiOf()} />);
    expect(screen.getByRole("group", { name: STEPPER_COPY.label("T-1") })).toBeTruthy();
    expect(screen.getByRole("group", { name: STEPPER_COPY.label("T-2") })).toBeTruthy();
    expect(screen.queryByRole("group", { name: STEPPER_COPY.label("T-9") })).toBeNull();
    await screen.findByTestId("requirement-original");
  });

  it("评审上限 = resubmit_limits.review + 1（「第 2 轮 / 6」）", async () => {
    render(
      <RequirementPage
        requirementId="r1"
        tickets={tickets}
        events={[]}
        api={apiOf(undefined, 5)}
      />,
    );
    const row = screen.getByRole("group", { name: STEPPER_COPY.label("T-1") });
    await waitFor(() => expect(row.textContent).toContain("第 2 轮 / 6"));
  });

  it("需求原文超过 3 行默认折叠，点展开后完整显示", async () => {
    render(<RequirementPage requirementId="r1" tickets={tickets} events={[]} api={apiOf()} />);
    const p = await screen.findByTestId("requirement-original");
    expect(p.getAttribute("data-collapsed")).toBe("true");
    expect(p.className).toContain("line-clamp-3");
    fireEvent.click(screen.getByRole("button", { name: REQUIREMENT_PAGE_COPY.expand }));
    expect(p.getAttribute("data-collapsed")).toBeNull();
    expect(needsFold("短")).toBe(false);
    expect(needsFold("a".repeat(400))).toBe(true);
  });

  it("拆单推理摘要默认折叠", async () => {
    render(<RequirementPage requirementId="r1" tickets={tickets} events={[]} api={apiOf()} />);
    const d = (await screen.findByTestId("decomposition-summary")) as HTMLDetailsElement;
    expect(d.open).toBe(false);
  });

  it("原文、摘要、标题、时间线都过脱敏", async () => {
    const { container } = render(
      <RequirementPage
        requirementId="r1"
        tickets={tickets}
        events={[msg("r1", "见 C:\\Users\\eva\\a.txt")]}
        api={apiOf()}
      />,
    );
    await screen.findByTestId("requirement-original");
    const html = container.innerHTML;
    for (const s of ["/home/eva", "/Users/eva", "C:\\Users", "sk-abcdefghijklmnopqrstuvwx"])
      expect(html).not.toContain(s);
  });

  it("时间线只含本需求，Flash 调用折成一行，合并只显示「已合入」", async () => {
    render(
      <RequirementPage
        requirementId="r1"
        tickets={tickets}
        events={[
          call("r1"),
          call("r1"),
          call("r1"),
          msg("r2", "别的需求的话"),
          changed("r1", "merged", "T-2"),
        ]}
        api={apiOf()}
      />,
    );
    await screen.findByTestId("requirement-original");
    const tl = screen.getByRole("region", { name: REQUIREMENT_PAGE_COPY.timeline });
    expect(tl.textContent).not.toContain("别的需求的话");
    expect(tl.querySelectorAll('[data-testid="flash-calls"]')).toHaveLength(1);
    expect(tl.textContent).toContain("Flash 调用 ×3");
    expect(tl.textContent).toContain("已合入");
  });

  it("后端只读（requirement:detail 固定失败）：显示固定提示，进度照样从快照出", async () => {
    render(
      <RequirementPage
        requirementId="r1"
        tickets={tickets}
        events={[]}
        api={apiOf({ ok: false, reason: "REQUIREMENT_DETAIL_UNAVAILABLE" })}
      />,
    );
    expect((await screen.findByTestId("detail-unavailable")).textContent).toBe(
      REQUIREMENT_PAGE_COPY.detailUnavailable,
    );
    expect(screen.getByRole("group", { name: STEPPER_COPY.label("T-1") })).toBeTruthy();
  });
});
