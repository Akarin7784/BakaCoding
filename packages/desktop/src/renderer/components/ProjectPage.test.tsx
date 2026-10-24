// @vitest-environment jsdom
// UI-05e：项目页（需求列表）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ProjectPage } from "./ProjectPage";
import { projects } from "../mock/data";
import { ticketOf } from "../lib/testEvents";
import { PROJECT_PAGE_COPY as C } from "../lib/copy";

afterEach(cleanup);

const view = {
  ...projects[0]!,
  project: {
    ...projects[0]!.project,
    payload: { ...projects[0]!.project.payload, project_id: "p1" },
  },
  escalations: [],
  warnings: [],
};
const tickets = [
  ticketOf({
    ticket_id: "T-1",
    requirement_id: "r1",
    title: "进行中的需求",
    status: "coding",
    created_at: "2026-10-24T03:00:00Z",
  }),
  ticketOf({
    ticket_id: "T-2",
    requirement_id: "r2",
    title: "做完的需求",
    status: "merged",
    created_at: "2026-10-24T02:00:00Z",
  }),
  ticketOf({
    ticket_id: "T-3",
    requirement_id: "r3",
    title: "要你处理的需求",
    status: "escalated",
    created_at: "2026-10-24T01:00:00Z",
  }),
];
const rowIds = () => screen.queryAllByTestId("requirement-row").map((r) => r.dataset.requirement);

function page(over: Partial<Parameters<typeof ProjectPage>[0]> = {}) {
  const onOpen = vi.fn();
  const onNew = vi.fn();
  render(
    <ProjectPage
      view={view}
      tickets={tickets}
      events={[]}
      attention={new Set(["r3"])}
      onOpenRequirement={onOpen}
      onNewRequirement={onNew}
      {...over}
    />,
  );
  return { onOpen, onNew };
}

describe("ProjectPage", () => {
  it("按最近活动列出需求，名字、摘要、需要处理的行标红", () => {
    page();
    expect(rowIds()).toEqual(["r1", "r2", "r3"]);
    const r3 = screen.getAllByTestId("requirement-row")[2]!;
    expect(r3.textContent).toContain("要你处理的需求");
    expect(r3.dataset.category).toBe("attention");
    expect(r3.className).toContain("bg-danger-soft");
    const r1 = screen.getAllByTestId("requirement-row")[0]!;
    expect(r1.className).not.toContain("bg-danger-soft");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("点需求行进需求页", () => {
    const { onOpen } = page();
    fireEvent.click(screen.getAllByTestId("requirement-row")[1]!);
    expect(onOpen).toHaveBeenCalledWith("r2");
  });

  it("汇总计数可点过滤，再点一次取消", () => {
    page();
    expect(screen.getByTestId("filter-active").textContent).toBe(`${C.filter.active} 1`);
    expect(screen.getByTestId("filter-attention").textContent).toBe(`${C.filter.attention} 1`);
    expect(screen.getByTestId("filter-done").textContent).toBe(`${C.filter.done} 1`);
    fireEvent.click(screen.getByTestId("filter-done"));
    expect(rowIds()).toEqual(["r2"]);
    expect(screen.getByTestId("filter-done").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("filter-done"));
    expect(rowIds()).toEqual(["r1", "r2", "r3"]);
    expect(screen.getByTestId("filter-done").getAttribute("aria-pressed")).toBe("false");
  });

  it("过滤后这一类为空时提示", () => {
    page({ attention: new Set() });
    fireEvent.click(screen.getByTestId("filter-attention"));
    expect(rowIds()).toEqual([]);
    expect(screen.getByText(C.emptyFiltered)).toBeTruthy();
  });

  it("没有需求：空状态 + 去主管对话按钮；有需求时没有空状态", () => {
    const { onNew } = page({ tickets: [] });
    const empty = screen.getByTestId("project-empty");
    expect(empty.textContent).toContain(C.empty);
    fireEvent.click(within(empty).getByRole("button", { name: C.emptyAction }));
    expect(onNew).toHaveBeenCalled();
    cleanup();
    page();
    expect(screen.queryByTestId("project-empty")).toBeNull();
  });

  it("只列本项目的需求", () => {
    page({
      tickets: [
        ...tickets,
        ticketOf({ ticket_id: "T-9", project_id: "other", requirement_id: "rx" }),
      ],
    });
    expect(rowIds()).not.toContain("rx");
  });
});

describe("UI-05f P3：需求名先脱敏再截 80 字", () => {
  it("密钥跨过第 80 个字：行里不留密钥前缀（反向：先截再脱敏会漏出 sk-ab）", () => {
    // 前 75 个字是填充，密钥从第 76 个字开始，跨过 80 字的边界
    const title = "需".repeat(75) + "sk-abcdefghijklmnopqrstuvwx 之后";
    page({
      tickets: [ticketOf({ ticket_id: "T-1", requirement_id: "r1", title, status: "coding" })],
    });
    const row = screen.getByTestId("requirement-row");
    expect(row.textContent).toContain("需".repeat(75));
    expect(row.textContent).not.toContain("sk-");
    expect(row.textContent).not.toContain("abcdefgh");
  });
});
