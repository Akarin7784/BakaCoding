// @vitest-environment jsdom
// T-127：右面板「动态」标签（§4.5.1）：消息列表、发送方 → 接收方、按单过滤下拉、
// 长正文展开、贴底 / 回到最新、底部状态行、空状态。
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityFeed, ACTIVITY_COLLAPSE_CHARS } from "./ActivityFeed";
import { projects } from "../mock/data";
import type { ProjectView } from "../mock/types";

afterEach(cleanup);

const todo = projects[0]!;

function longMessageProject(): ProjectView {
  const first = todo.messages[0]!;
  return {
    ...todo,
    messages: [
      {
        ...first,
        payload: { ...first.payload, content: "长".repeat(ACTIVITY_COLLAPSE_CHARS + 10) },
      },
      ...todo.messages.slice(1),
    ],
  };
}

describe("ActivityFeed（T-127）", () => {
  it("列出消息：发送方 → 接收方、类型、时间、正文；默认全部", () => {
    render(<ActivityFeed project={todo} />);
    const items = screen.getAllByTestId("activity-item");
    expect(items).toHaveLength(5);
    const first = items[0]!;
    expect(first.textContent).toContain("主管 → 副 Agent T-1 · 派单");
    expect(within(first).getByTestId("activity-time").textContent).toMatch(/^\d{2}:\d{2}$/);
    expect(first.textContent).toContain("T-1：给 Todo 加 due_date 字段");
    // 第二个消息是副 Agent 回报 → 主管
    expect(items[1]!.textContent).toContain("副 Agent T-1 → 主管 · 汇报");
    // 按单过滤下拉在（默认全部）
    expect(screen.getByTestId("activity-filter").textContent).toContain("全部");
  });

  it("底部状态行只列在跑的单", () => {
    render(<ActivityFeed project={todo} />);
    expect(screen.getByTestId("activity-status").textContent).toBe("T-2 重写");
  });

  it("长正文可展开 / 收起", () => {
    render(<ActivityFeed project={longMessageProject()} />);
    const items = screen.getAllByTestId("activity-item");
    const first = items[0]!;
    expect(first.querySelector("[data-testid='activity-content']")?.className).toContain(
      "line-clamp-3",
    );
    fireEvent.click(within(first).getByTestId("activity-expand"));
    expect(first.querySelector("[data-testid='activity-content']")?.className).not.toContain(
      "line-clamp-3",
    );
    expect(within(first).getByTestId("activity-expand").textContent).toBe("收起");
  });

  it("短正文没有展开按钮", () => {
    render(<ActivityFeed project={todo} />);
    expect(screen.queryByTestId("activity-expand")).toBeNull();
  });

  it("上翻后不再自动滚到底，出现「回到最新」，点了回到底部", () => {
    render(<ActivityFeed project={todo} />);
    const list = screen.getByTestId("activity-list");
    Object.defineProperty(list, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(list, "clientHeight", { configurable: true, value: 300 });
    Object.defineProperty(list, "scrollTop", { configurable: true, writable: true, value: 100 });
    fireEvent.scroll(list);
    const back = screen.getByTestId("activity-back-to-latest");
    expect(back.textContent).toContain("回到最新");
    fireEvent.click(back);
    expect(list.scrollTop).toBe(1000);
    expect(screen.queryByTestId("activity-back-to-latest")).toBeNull();
  });

  it("没有项目 / 没有消息时给空状态", () => {
    const { rerender } = render(<ActivityFeed project={undefined} />);
    expect(screen.getByText("还没有项目")).toBeTruthy();
    rerender(<ActivityFeed project={{ ...todo, messages: [] }} />);
    expect(screen.getByText("还没有动态")).toBeTruthy();
  });
});
