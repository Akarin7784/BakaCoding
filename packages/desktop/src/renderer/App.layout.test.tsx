// @vitest-environment jsdom
// UI-02：新布局骨架——左栏收起与断点、右面板与抽屉、全局快捷键、现有视图都还能到达。
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { BakaDesktopApi } from "../shared/api";
import { App } from "./App";
import { SIDEBAR_STORAGE_KEY } from "./lib/layout";
import { projects as mockProjects } from "./mock/data";
import type { EscalationView } from "./mock/types";

const escalation: EscalationView = {
  event_id: "e-1",
  ticket_id: "T-9",
  requirement_id: "R-9",
  reason: "review_limit",
  ts: "2026-10-17T01:00:00.000Z",
};

beforeAll(() => {
  // cmdk 在 jsdom 里要用到
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
  setWidth(1440);
});
afterEach(() => cleanup());

/** UI-08：未归属入口并进了左栏底部的状态卡 */
async function openUnattributed() {
  fireEvent.click(await screen.findByTestId("status-dot"));
  return await screen.findByRole("button", { name: /未归属上报/ });
}

const sidebar = () => screen.getByRole("navigation", { name: "对话列表" });
const press = (key: string, mods: KeyboardEventInit = { ctrlKey: true }) =>
  act(() => {
    fireEvent.keyDown(window, { key, ...mods });
  });

describe("左栏：收起 / 展开、持久化、断点", () => {
  it("默认展开 260，点收起变 56 并记住；重开后仍收起", () => {
    const first = render(<App api={null} />);
    expect(sidebar().style.width).toBe("260px");
    expect(sidebar().dataset.collapsed).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "收起左栏" }));
    expect(sidebar().style.width).toBe("56px");
    expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe("1");
    first.unmount();

    render(<App api={null} />);
    expect(sidebar().dataset.collapsed).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "展开左栏" }));
    expect(sidebar().dataset.collapsed).toBe("false");
    expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe("0");
  });

  it("收起后项目仍可点，名字留给读屏和 tooltip", () => {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, "1");
    render(<App api={null} />);
    const btn = within(sidebar()).getByRole("button", { name: /baka-todo/ });
    expect(btn.getAttribute("title")).toBe("baka-todo");
    fireEvent.click(btn);
    expect(screen.getByRole("region", { name: "项目页" })).toBeTruthy();
  });

  it("窗口 < 1024 自动收起；窄时临时展开不改偏好；变宽后回到偏好", () => {
    render(<App api={null} />);
    expect(sidebar().dataset.collapsed).toBe("false");
    setWidth(1000);
    expect(sidebar().dataset.collapsed).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "展开左栏" }));
    expect(sidebar().dataset.collapsed).toBe("false");
    expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBeNull();
    setWidth(1023);
    expect(sidebar().dataset.collapsed).toBe("false");
    setWidth(1024);
    expect(sidebar().dataset.collapsed).toBe("false");
    // 宽时收起写入偏好；再变窄仍是收起，再变宽仍是收起
    fireEvent.click(screen.getByRole("button", { name: "收起左栏" }));
    setWidth(960);
    expect(sidebar().dataset.collapsed).toBe("true");
    setWidth(1280);
    expect(sidebar().dataset.collapsed).toBe("true");
  });

  it("窄时临时展开，离开窄窗口再回来又是默认收起", () => {
    render(<App api={null} />);
    setWidth(1000);
    fireEvent.click(screen.getByRole("button", { name: "展开左栏" }));
    setWidth(1300);
    setWidth(1000);
    expect(sidebar().dataset.collapsed).toBe("true");
  });
});

describe("右面板：开关、停靠与抽屉", () => {
  it("默认关；≥ 1200 停靠在右侧，宽 360；有 概览 / 动态 两个标签", () => {
    render(<App api={null} />);
    // UI-06a：主管对话里不再回退到最后一个项目，先选项目
    fireEvent.click(screen.getByRole("button", { name: /baka-todo/ }));
    expect(screen.queryByRole("complementary", { name: "右面板" })).toBeNull();
    const toggle = screen.getByRole("button", { name: "打开右面板" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    const panel = screen.getByRole("complementary", { name: "右面板" });
    expect(panel.dataset.mode).toBe("docked");
    expect(panel.style.width).toBe("360px");
    expect(screen.queryByTestId("drawer-backdrop")).toBeNull();
    const tabs = within(panel)
      .getAllByRole("tab")
      .map((t) => t.textContent);
    expect(tabs).toEqual(["概览", "动态"]);
    // 概览：现有的项目概览（编码池 / Git / PR）
    expect(within(panel).getByTestId("project-overview")).toBeTruthy();
    expect(within(panel).getByTestId("pool-status")).toBeTruthy();
    // 面板里的 ✕ 与标题栏的开关都能关
    fireEvent.click(within(panel).getByRole("button", { name: "关闭右面板" }));
    expect(screen.queryByRole("complementary", { name: "右面板" })).toBeNull();
  });

  it("动态标签接活动流：显示 Agent 消息与底部状态行（T-127）", async () => {
    render(<App api={null} />);
    fireEvent.click(screen.getByRole("button", { name: /baka-todo/ }));
    fireEvent.click(screen.getByRole("button", { name: "打开右面板" }));
    const tab = screen.getByRole("tab", { name: "动态" });
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);
    await waitFor(() => expect(screen.getByTestId("activity-feed")).toBeTruthy());
    expect(screen.getAllByTestId("activity-item")).toHaveLength(5);
    // UI-06a：状态行来自快照 tickets（mock 里 T-2 重新评审）
    expect(screen.getByTestId("activity-status").textContent).toBe("T-2 重新评审");
  });

  it("面板关着时来了新消息：右面板开关亮小点，打开看过动态后熄灭（T-127）", async () => {
    const base = mockProjects[0]!;
    const { rerender } = render(<App api={null} />);
    fireEvent.click(screen.getByRole("button", { name: /baka-todo/ }));
    expect(screen.queryByTestId("right-panel-dot")).toBeNull();

    const last = base.messages.at(-1)!;
    const withNew = {
      ...base,
      messages: [
        ...base.messages,
        {
          ...last,
          event_id: "evt-t127-new",
          seq: 999,
          ts: "2026-10-17T09:30:00Z",
          payload: { ...last.payload, content: "T-2 复投完成，已提交新 PR。" },
        },
      ],
    };
    rerender(<App api={null} projects={[withNew, ...mockProjects.slice(1)]} />);
    await waitFor(() => expect(screen.getByTestId("right-panel-dot")).toBeTruthy());

    // 打开面板但停在概览：动态标签上亮小点
    fireEvent.click(screen.getByRole("button", { name: "打开右面板" }));
    expect(screen.getByTestId("activity-dot")).toBeTruthy();
    const tab = screen.getByRole("tab", { name: /动态/ });
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);
    await waitFor(() => expect(screen.queryByTestId("activity-dot")).toBeNull());
  });

  it("< 1200 改为覆盖式抽屉：点遮罩或按 Esc 关闭", async () => {
    setWidth(1100);
    render(<App api={null} />);
    fireEvent.click(screen.getByRole("button", { name: "打开右面板" }));
    expect(screen.getByRole("dialog", { name: "右面板" }).dataset.mode).toBe("drawer");
    // Radix 在下一拍才挂「点外面」的监听
    await act(() => new Promise((r) => setTimeout(r, 0)));
    fireEvent.pointerDown(screen.getByTestId("drawer-backdrop"));
    expect(screen.queryByRole("dialog", { name: "右面板" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "打开右面板" }));
    act(() => {
      fireEvent.keyDown(screen.getByRole("dialog", { name: "右面板" }), { key: "Escape" });
    });
    expect(screen.queryByRole("dialog", { name: "右面板" })).toBeNull();
  });

  it("打开时窗口变窄，停靠自动转为抽屉；变宽又停靠", () => {
    render(<App api={null} />);
    fireEvent.click(screen.getByRole("button", { name: "打开右面板" }));
    setWidth(1199);
    expect(screen.getByRole("dialog", { name: "右面板" }).dataset.mode).toBe("drawer");
    setWidth(1200);
    expect(screen.getByRole("complementary", { name: "右面板" }).dataset.mode).toBe("docked");
  });
});

describe("全局快捷键", () => {
  it("Ctrl+B 收起 / 展开左栏，Ctrl+. 开关右面板", () => {
    render(<App api={null} />);
    press("b");
    expect(sidebar().dataset.collapsed).toBe("true");
    press("b");
    expect(sidebar().dataset.collapsed).toBe("false");
    press(".");
    expect(screen.getByRole("complementary", { name: "右面板" })).toBeTruthy();
    press(".");
    expect(screen.queryByRole("complementary", { name: "右面板" })).toBeNull();
  });

  it("Ctrl+, 打开设置弹窗，里面是原来的设置页", async () => {
    render(<App api={null} />);
    press(",");
    const dialog = await screen.findByRole("dialog", { name: "设置" });
    expect(within(dialog).getByTestId("settings-title")).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "返回" })).toBeNull();
    act(() => {
      fireEvent.keyDown(dialog, { key: "Escape" });
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "设置" })).toBeNull());
  });

  it("Ctrl+K 打开搜索与跳转，选项目就跳过去", async () => {
    render(<App api={null} />);
    press("k");
    const dialog = await screen.findByRole("dialog", { name: "搜索与跳转" });
    fireEvent.click(within(dialog).getByText("baka-blog"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "搜索与跳转" })).toBeNull());
    expect(screen.getByTestId("title-bar").textContent).toContain("# baka-blog");
  });

  it("Ctrl+N 回到主管对话并聚焦输入框", async () => {
    render(<App api={null} />);
    fireEvent.click(within(sidebar()).getByRole("button", { name: /baka-todo/ }));
    expect(screen.getByRole("region", { name: "项目页" })).toBeTruthy();
    press("n");
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("data-composer")).toBe("supervisor"),
    );
    expect(screen.queryByRole("region", { name: "项目页" })).toBeNull();
  });

  it("不带 Ctrl 的同名键不触发；输入框里 Enter 仍是发送", () => {
    render(<App api={null} />);
    press("b", {});
    expect(sidebar().dataset.collapsed).toBe("false");
    const box = screen.getByRole("textbox", { name: "发给主管" });
    fireEvent.change(box, { target: { value: "回车发送" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(screen.getByText("回车发送")).toBeTruthy();
  });

  it("macOS 上用 ⌘", () => {
    const api = {
      platform: "darwin",
      getSnapshot: async () => ({ db: null, events: [], tickets: [], last_seq: 0 }),
      onUpdate: () => () => {},
    } as unknown as BakaDesktopApi;
    render(<App api={api} />);
    press("b");
    expect(sidebar().dataset.collapsed).toBe("false");
    press("b", { metaKey: true });
    expect(sidebar().dataset.collapsed).toBe("true");
  });
});

describe("现有界面都挂进新骨架", () => {
  it("主管对话在中间；项目、未归属、设置都能从左栏到达", async () => {
    render(<App api={null} unattributed={[]} />);
    const main = screen.getByRole("main", { name: "内容区" });
    expect(within(main).getByRole("region", { name: "主管对话" })).toBeTruthy();
    expect(screen.getByTestId("title-bar").textContent).toContain("主管");

    fireEvent.click(within(sidebar()).getByRole("button", { name: /baka-todo/ }));
    expect(within(main).getByRole("region", { name: "项目页" })).toBeTruthy();
    expect(screen.getByTestId("title-bar").textContent).toContain("# baka-todo");
    // 选中项目时仍能和主管说话
    expect(within(main).getByRole("textbox", { name: "发给主管" })).toBeTruthy();

    fireEvent.click(within(sidebar()).getByRole("button", { name: /主管/ }));
    expect(within(main).getByRole("region", { name: "主管对话" })).toBeTruthy();

    fireEvent.click(within(sidebar()).getByRole("button", { name: "设置" }));
    expect(await screen.findByRole("dialog", { name: "设置" })).toBeTruthy();
  });

  it("未归属有内容时从状态卡进去，是原来的未归属列表（UI-08）", async () => {
    render(<App api={null} unattributed={[escalation]} />);
    fireEvent.click(await openUnattributed());
    expect(screen.getByRole("region", { name: "未归属" })).toBeTruthy();
    expect(screen.getByTestId("title-bar").textContent).toContain("未归属");
  });

  it("后端只读时标题栏带「只读」标签", async () => {
    const api = {
      platform: "win32",
      getSnapshot: async () => ({ db: null, events: [], tickets: [], last_seq: 0 }),
      onUpdate: () => () => {},
      getBackendStatus: async () => ({ mode: "readonly", reason: "另一个实例在跑" }),
    } as unknown as BakaDesktopApi;
    render(<App api={api} unattributed={[escalation]} />);
    fireEvent.click(await openUnattributed());
    expect(await screen.findByTestId("readonly-tag")).toBeTruthy();
    // Windows 上标题栏右侧给系统窗口按钮留位
    expect(screen.getByTestId("title-bar").style.paddingRight).toBe("146px");
  });

  it("骨架不新增主按钮：主管页只有发送一个主按钮", () => {
    render(<App api={null} pendingHighRisk={[]} />);
    const primaries = document.querySelectorAll('[data-variant="primary"]');
    expect([...primaries].map((b) => b.getAttribute("aria-label"))).toEqual(["发送"]);
  });
});
