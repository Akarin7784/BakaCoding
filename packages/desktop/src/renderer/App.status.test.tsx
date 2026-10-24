// @vitest-environment jsdom
// UI-08：只读横幅与详情、重新连接、只读禁用、toast、全局状态点与状态卡、抽屉焦点管理。
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BakaDesktopApi,
  DesktopBackendStatus,
  DesktopPendingHighRisk,
  DesktopReloadResult,
} from "../shared/api";
import { App } from "./App";
import { toast, Toaster } from "./components/ui/sonner";
import { projects as mockProjects, tickets as mockTickets } from "./mock/data";

beforeAll(() => {
  Element.prototype.scrollIntoView ??= function () {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  window.matchMedia ??= ((q: string) => ({
    matches: false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

function setWidth(w: number) {
  act(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: w });
    window.dispatchEvent(new Event("resize"));
  });
}

let clip: string[] = [];
beforeEach(() => {
  localStorage.clear();
  setWidth(1440);
  clip = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (t: string) => void clip.push(t) },
  });
});
afterEach(() => {
  // 错误 toast 不自动消失：sonner 的全局队列要手动清
  toast.dismiss();
  cleanup();
});

const READONLY: DesktopBackendStatus = {
  mode: "readonly",
  reason: "启动失败（DiskError）",
  error: { name: "DiskError", message: "cannot open <仓库>/x.db", code: "EACCES" },
};

function fakeApi(status: DesktopBackendStatus, extra: Partial<BakaDesktopApi> = {}) {
  let current = status;
  const api = {
    platform: "win32",
    getSnapshot: async () => ({
      db: { path: "/p/x.db", state: "ok" },
      events: [],
      tickets: [],
      last_seq: 0,
    }),
    onUpdate: () => () => {},
    getBackendStatus: vi.fn(async () => current),
    ...extra,
  } as unknown as BakaDesktopApi;
  return { api, set: (s: DesktopBackendStatus) => (current = s) };
}

const hr: DesktopPendingHighRisk = {
  ticket_id: "T-1",
  project_id: mockProjects[0]!.project.payload.project_id,
  pr_id: "pr-9",
  pr_url: "https://example.com/pr/9",
  reasons: ["dependency_file"],
  files: [{ path: "package.json" }],
  files_more: 0,
  held_at: "2026-10-17T12:00:00Z",
};

/** 这条文字所在的 sonner toast 还没被移除（sonner 移除时先把 data-removed 设成 true，200ms 后才卸载）（T-109） */
function expectToastKept(text: string) {
  const li = screen.getByText(text).closest("[data-sonner-toast]");
  expect(li, text).not.toBeNull();
  expect(li!.getAttribute("data-removed"), text).toBe("false");
}

const renderApp = (props: Parameters<typeof App>[0]) =>
  render(
    <>
      <App {...props} />
      <Toaster />
    </>,
  );

describe("只读横幅（§4.7）", () => {
  it("内容区顶部一条横幅：只读模式 + 原因；查看详情列错误名 / 信息 / 错误码，可复制", async () => {
    const { api } = fakeApi(READONLY);
    renderApp({ api, projects: mockProjects });
    const banner = await screen.findByRole("region", { name: "只读模式" });
    expect(banner.textContent).toContain("只读模式：启动失败（DiskError）");
    expect(banner.dataset.tone).toBe("danger");
    // 在标题栏下面、内容上面
    const main = screen.getByRole("main", { name: "内容区" });
    expect(main.children[1]).toBe(banner);

    fireEvent.click(within(banner).getByRole("button", { name: "查看详情" }));
    const dialog = await screen.findByRole("dialog", { name: "只读详情" });
    const details = within(dialog).getByTestId("readonly-details").textContent;
    expect(details).toContain("DiskError");
    expect(details).toContain("cannot open <仓库>/x.db");
    expect(details).toContain("EACCES");
    fireEvent.click(within(dialog).getByRole("button", { name: "复制详情" }));
    await waitFor(() => expect(clip[0]).toContain("错误码：EACCES"));
  });

  it("不是只读时没有横幅", async () => {
    const { api } = fakeApi({ mode: "live" });
    renderApp({ api });
    await waitFor(() => expect(api.getBackendStatus).toHaveBeenCalled());
    expect(screen.queryByRole("region", { name: "只读模式" })).toBeNull();
  });

  it("运行中存储租约丢失也显示横幅", async () => {
    const { api } = fakeApi({
      mode: "live",
      storage: { ok: false, lease_lost: true, closed: false, ingest_failures: 0 },
    });
    renderApp({ api });
    expect((await screen.findByTestId("readonly-reason")).textContent).toContain("其他程序接管");
  });

  it("重新连接：成功后横幅消失并提示；排队时说明还在等；失败时错误 toast 不自动消失、可复制详情", async () => {
    const results: DesktopReloadResult[] = [
      { state: "queued", waitingTickets: 2, waitingChat: false },
      { state: "failed", reason: "ConfigError：models.json 不合法" },
      { state: "reloaded" },
    ];
    const reconnectBackend = vi.fn(async () => results.shift()!);
    const f = fakeApi(READONLY, { reconnectBackend });
    renderApp({ api: f.api });
    const btn = await screen.findByRole("button", { name: "重新连接" });

    fireEvent.click(btn);
    expect(await screen.findByText("还有 2 张单在进行中，完成后自动重新连接")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "重新连接" }));
    expect(await screen.findByText("重新连接失败：ConfigError：models.json 不合法")).toBeTruthy();
    const copy = await screen.findByRole("button", { name: "复制详情" });
    await act(async () => fireEvent.click(copy));
    await waitFor(() => expect(clip).toContain("重新连接失败：ConfigError：models.json 不合法"));
    // T-109：点「复制详情」不关错误 toast。以前 sonner 默认关掉它（200ms 后卸载），
    // 末尾断言能否通过取决于测试跑得比 200ms 快不快，负载高时偶发失败。这里直接看移除标记，不靠时间。
    expectToastKept("重新连接失败：ConfigError：models.json 不合法");

    f.set({ mode: "live" });
    fireEvent.click(screen.getByRole("button", { name: "重新连接" }));
    expect(await screen.findByText("已重新连接")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("region", { name: "只读模式" })).toBeNull());
    expect(reconnectBackend).toHaveBeenCalledTimes(3);
    // 错误 toast 还在（不自动消失，复制后也不关）
    expectToastKept("重新连接失败：ConfigError：models.json 不合法");
  });

  it("没有 reconnectBackend（旧 preload）时不显示「重新连接」", async () => {
    const { api } = fakeApi(READONLY);
    renderApp({ api });
    await screen.findByRole("region", { name: "只读模式" });
    expect(screen.queryByRole("button", { name: "重新连接" })).toBeNull();
  });
});

describe("只读时禁用并说明（§4.7）", () => {
  it("输入框禁用并提示；裁决、导出、合入 main 禁用并有说明", async () => {
    const { api } = fakeApi(READONLY, { exportDiagnostics: vi.fn() });
    renderApp({ api, projects: mockProjects, tickets: mockTickets, pendingHighRisk: [hr] });
    await screen.findByRole("region", { name: "只读模式" });
    const box = screen.getByRole("textbox", { name: "发给主管" }) as HTMLTextAreaElement;
    expect(box.disabled).toBe(true);
    expect(box.placeholder).toBe("只读模式下不能发消息");
    expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true);
    const exp = screen.getByRole("button", { name: "导出诊断包" }) as HTMLButtonElement;
    expect(exp.disabled).toBe(true);
    expect(exp.title).toBe("只读模式下不能导出");
    expect((screen.getByTestId("high-risk-release") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("high-risk-reject") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("high-risk-actions").title).toBe("只读模式下不能裁决");

    fireEvent.click(screen.getByRole("button", { name: /baka-todo/ }));
    expect(
      (screen.getByRole("textbox", { name: "发给主管" }) as HTMLTextAreaElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "打开右面板" }));
    const merge = screen.getByRole("button", { name: /合入 main/ }) as HTMLButtonElement;
    expect(merge.disabled).toBe(true);
    expect(merge.title).toBe("只读模式下不能合入 main");
    // UI-06a：单列表行内导出（只读时禁用并说明）
    const prExport = screen.getByRole("button", { name: "导出 T-1 诊断包" }) as HTMLButtonElement;
    expect(prExport.disabled).toBe(true);
    expect(prExport.title).toBe("只读模式下不能导出");
  });

  it("不只读时这些都可用", async () => {
    const { api } = fakeApi({ mode: "live" });
    renderApp({ api, projects: mockProjects, pendingHighRisk: [hr] });
    await waitFor(() => expect(api.getBackendStatus).toHaveBeenCalled());
    expect(
      (screen.getByRole("textbox", { name: "发给主管" }) as HTMLTextAreaElement).disabled,
    ).toBe(false);
    expect((screen.getByTestId("high-risk-release") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId("high-risk-actions").title).toBe("");
  });
});

describe("操作结果用 toast（§3）", () => {
  it("导出成功：右下角提示，不再是顶部小字", async () => {
    const exportDiagnostics = vi.fn(async () => ({ ok: true as const, path: "/d/diag.zip" }));
    const { api } = fakeApi({ mode: "live" }, { exportDiagnostics });
    renderApp({ api });
    fireEvent.click(await screen.findByRole("button", { name: "导出诊断包" }));
    expect(await screen.findByText("诊断包已导出：/d/diag.zip")).toBeTruthy();
    expect(screen.queryByTestId("action-notice")).toBeNull();
  });

  it("导出失败：错误 toast 带「复制详情」，不自动消失", async () => {
    const exportDiagnostics = vi.fn(async () => ({ ok: false as const, reason: "磁盘满了" }));
    const { api } = fakeApi({ mode: "live" }, { exportDiagnostics });
    renderApp({ api });
    fireEvent.click(await screen.findByRole("button", { name: "导出诊断包" }));
    expect(await screen.findByText("导出失败：磁盘满了")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "复制详情" })));
    await waitFor(() => expect(clip).toEqual(["导出失败：磁盘满了"]));
    // T-109：原来等 50ms 再看，只因为短于 sonner 的 200ms 卸载才过；改成看移除标记
    expectToastKept("导出失败：磁盘满了");
  });
});

describe("全局状态点与状态卡（§4.8）", () => {
  const dot = () => screen.getByTestId("status-dot");

  it("假数据里有重写中的单 → 有单在跑（强调色呼吸）", () => {
    renderApp({ api: null });
    expect(dot().dataset.level).toBe("running");
    expect(dot().getAttribute("aria-label")).toBe("全局状态：有单在跑");
    expect(dot().querySelector("span")!.className).toContain("animate-breathe");
  });

  it("没有在跑的单 → 空闲（灰）", () => {
    const quiet = mockProjects.map((p) => ({
      ...p,
      prs: p.prs.map((pr) => ({ ...pr, status: "merged" as const })),
    }));
    renderApp({ api: null, projects: quiet });
    expect(dot().dataset.level).toBe("idle");
  });

  it("只读 / 待裁决 / 未归属 → 红，状态卡列出原因、后端模式、数据库路径", async () => {
    const { api } = fakeApi(READONLY);
    renderApp({ api, projects: mockProjects, pendingHighRisk: [hr] });
    await screen.findByRole("region", { name: "只读模式" });
    expect(dot().dataset.level).toBe("attention");
    fireEvent.click(dot());
    const card = await screen.findByTestId("status-card");
    expect(within(card).getByTestId("status-attention").textContent).toContain("后端处于只读模式");
    expect(within(card).getByTestId("status-attention").textContent).toContain(
      "1 个高风险 PR 待裁决",
    );
    expect(card.textContent).toContain("只读（启动失败（DiskError））");
    await waitFor(() => expect(within(card).getByTestId("status-db").textContent).toBe("/p/x.db"));
  });

  it("左栏收起时状态点仍在", () => {
    localStorage.setItem("bakacoding.sidebarCollapsed", "1");
    renderApp({ api: null });
    expect(dot()).toBeTruthy();
  });
});

describe("右面板抽屉的焦点（窄屏，Radix Dialog）", () => {
  it("打开时焦点进抽屉、Tab 不出抽屉；关上后焦点回到标题栏开关；遮罩是淡 --overlay", async () => {
    setWidth(1100);
    renderApp({ api: null });
    press(".");
    const drawer = await screen.findByRole("dialog", { name: "右面板" });
    await waitFor(() => expect(drawer.contains(document.activeElement)).toBe(true));
    expect(screen.getByTestId("drawer-backdrop").className).toContain("bg-overlay");

    // Tab 走到最后一个再按 Tab 回到第一个（焦点困在抽屉里）
    const focusables = [...drawer.querySelectorAll<HTMLElement>("button, [tabindex='0']")].filter(
      (el) =>
        !el.hasAttribute("disabled") &&
        el.tabIndex >= 0 &&
        !el.closest("[hidden]") &&
        el.dataset.state !== "inactive",
    );
    const last = focusables.at(-1)!;
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    // jsdom 自己不会因 Tab 移焦点；焦点从最后一个换到了抽屉里的另一个元素，说明是 FocusScope 绕回了开头
    expect(document.activeElement).not.toBe(last);
    expect(drawer.contains(document.activeElement)).toBe(true);

    act(() => {
      fireEvent.keyDown(drawer, { key: "Escape" });
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "右面板" })).toBeNull());
    expect(document.activeElement).toBe(screen.getByTestId("right-panel-toggle"));
  });

  it("停靠模式不是弹层，不抢焦点", () => {
    renderApp({ api: null });
    const box = screen.getByRole("textbox", { name: "发给主管" });
    box.focus();
    press(".");
    expect(screen.getByRole("complementary", { name: "右面板" })).toBeTruthy();
    expect(document.activeElement).toBe(box);
  });
});

function press(key: string) {
  act(() => {
    fireEvent.keyDown(window, { key, ctrlKey: true });
  });
}
