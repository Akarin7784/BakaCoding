// @vitest-environment jsdom
// UI-06a：右面板单列表接到 App：点单打开所属需求页并选中该单（窄屏关抽屉）、
// 主管对话里跟随输入框 chip 选中的项目（不回退到最后一个项目）。
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { LAST_PROJECT_STORAGE_KEY } from "./lib/lastProject";

beforeAll(() => {
  Element.prototype.scrollIntoView ??= function () {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

function setWidth(w: number) {
  act(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: w });
    window.dispatchEvent(new Event("resize"));
  });
}

beforeEach(() => {
  localStorage.clear();
  setWidth(1300);
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

const openPanel = () => fireEvent.click(screen.getByRole("button", { name: "打开右面板" }));
const ticketRow = (id: string) =>
  screen.getAllByTestId("ticket-row").find((r) => r.dataset.ticket === id)!;
const clickTicket = (id: string) =>
  fireEvent.click(within(ticketRow(id)).getByRole("button", { name: new RegExp(`^${id} `) }));

describe("右面板点单（UI-06a）", () => {
  it("打开所属需求页并选中该单；停靠时面板不关", () => {
    render(<App api={null} />);
    fireEvent.click(screen.getByRole("button", { name: /baka-todo/ }));
    openPanel();
    clickTicket("T-2");
    expect(window.location.hash).toBe("#requirement=req-2");
    const item = document.querySelector<HTMLElement>('[data-ticket-item="T-2"]')!;
    expect(item.dataset.selected).toBe("true");
    expect(screen.getByRole("complementary", { name: "右面板" })).toBeTruthy();
  });

  it("从主管对话点单：也选中所属项目再打开需求页", () => {
    localStorage.setItem(LAST_PROJECT_STORAGE_KEY, "p-todo");
    render(<App api={null} />);
    openPanel();
    clickTicket("T-1");
    expect(window.location.hash).toBe("#requirement=req-1");
    expect(
      document.querySelector<HTMLElement>('[data-ticket-item="T-1"]')!.dataset.selected,
    ).toBe("true");
    // 离开主管对话，左栏高亮所属项目下的需求行
    const nav = screen.getByRole("navigation", { name: "对话列表" });
    expect(
      nav.querySelector<HTMLElement>('[data-requirement="req-1"]')!.getAttribute("aria-current"),
    ).toBe("page");
  });

  it("窄屏抽屉：点单后关闭抽屉", () => {
    setWidth(1100);
    render(<App api={null} />);
    fireEvent.click(screen.getByRole("button", { name: /baka-todo/ }));
    openPanel();
    expect(screen.getByRole("dialog", { name: "右面板" })).toBeTruthy();
    clickTicket("T-1");
    expect(window.location.hash).toBe("#requirement=req-1");
    expect(screen.queryByRole("dialog", { name: "右面板" })).toBeNull();
  });

  it("离开需求页再进别的需求：不再高亮旧单", () => {
    render(<App api={null} />);
    fireEvent.click(screen.getByRole("button", { name: /baka-todo/ }));
    openPanel();
    clickTicket("T-1");
    fireEvent.click(screen.getByRole("button", { name: /baka-todo/ }));
    fireEvent.click(document.querySelector<HTMLElement>('[data-requirement="req-1"]')!);
    expect(window.location.hash).toBe("#requirement=req-1");
    expect(document.querySelector('[data-ticket-item][data-selected]')).toBeNull();
  });
});

describe("主管对话里右面板跟随输入框选中的项目（UI-06a）", () => {
  it("输入框没选项目：概览不回退到最后一个项目，提示去选", () => {
    render(<App api={null} />);
    // 先进过项目再回主管对话，也不回退
    fireEvent.click(screen.getByRole("button", { name: /baka-todo/ }));
    fireEvent.click(screen.getByRole("button", { name: /主管/ }));
    openPanel();
    const panel = screen.getByRole("complementary", { name: "右面板" });
    expect(within(panel).queryByTestId("project-overview")).toBeNull();
    expect(within(panel).getByText("在输入框里选一个项目，这里显示它的概览")).toBeTruthy();
  });

  it("输入框 chip 选中的项目：概览显示它的单", () => {
    localStorage.setItem(LAST_PROJECT_STORAGE_KEY, "p-todo");
    render(<App api={null} />);
    openPanel();
    const panel = screen.getByRole("complementary", { name: "右面板" });
    expect(within(panel).getByTestId("project-overview")).toBeTruthy();
    expect(within(panel).getAllByTestId("ticket-row").map((r) => r.dataset.ticket)).toEqual([
      "T-1",
      "T-2",
    ]);
  });
});
