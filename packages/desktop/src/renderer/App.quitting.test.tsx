// @vitest-environment jsdom
// T-106：收到主进程的 app:quitting 后，内容区顶部显示固定文案「正在退出…」（中性横幅 + 转圈，不是遮罩）。
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { BakaDesktopApi } from "../shared/api";
import { App } from "./App";
import { QUIT_COPY } from "./lib/copy";

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
afterEach(() => cleanup());

function fakeApi() {
  const listeners = new Set<() => void>();
  const off = vi.fn();
  const api = {
    platform: "linux",
    getSnapshot: async () => ({
      db: { path: "/p/x.db", state: "ok" },
      events: [],
      tickets: [],
      last_seq: 0,
    }),
    onUpdate: () => () => {},
    getBackendStatus: async () => ({ mode: "live" }),
    onQuitting: vi.fn((l: () => void) => {
      listeners.add(l);
      return () => {
        off();
        listeners.delete(l);
      };
    }),
  } as unknown as BakaDesktopApi;
  return { api, emit: () => listeners.forEach((l) => l()), off, listeners };
}

describe("正在退出（T-106）", () => {
  it("文案固定", () => {
    expect(QUIT_COPY).toEqual({
      title: "正在退出…",
      detail: "正在等后台任务收尾，完成后窗口会自动关闭",
    });
  });

  it("没收到通知时不显示；收到后显示固定文案和转圈，读屏可读（role=status）", async () => {
    const f = fakeApi();
    render(<App api={f.api} />);
    await waitFor(() => expect(f.api.onQuitting).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("quitting-banner")).toBeNull();
    act(() => f.emit());
    const banner = await screen.findByTestId("quitting-banner");
    expect(banner.textContent).toBe(`${QUIT_COPY.title}${QUIT_COPY.detail}`);
    expect(banner.dataset["tone"]).toBe("neutral");
    expect(banner.querySelector("svg")?.getAttribute("class")).toContain("animate-spin");
    expect(screen.getByRole("status").textContent).toContain("正在退出…");
    // 不是遮罩：其他操作照常可见可点
    expect(screen.getByRole("button", { name: "导入项目" })).toBeTruthy();
  });

  it("重复收到通知只显示一条", async () => {
    const f = fakeApi();
    render(<App api={f.api} />);
    await waitFor(() => expect(f.listeners.size).toBe(1));
    act(() => {
      f.emit();
      f.emit();
    });
    expect(await screen.findAllByTestId("quitting-banner")).toHaveLength(1);
  });

  it("卸载时取消订阅；旧版 preload 没有 onQuitting 也不报错", async () => {
    const f = fakeApi();
    const r = render(<App api={f.api} />);
    await waitFor(() => expect(f.listeners.size).toBe(1));
    r.unmount();
    expect(f.off).toHaveBeenCalledTimes(1);
    const old = fakeApi().api as unknown as Record<string, unknown>;
    delete old["onQuitting"];
    render(<App api={old as unknown as BakaDesktopApi} />);
    expect(screen.queryByTestId("quitting-banner")).toBeNull();
  });

  it("无 API 时可注入（截图 / 假数据）", () => {
    render(<App api={null} quitting />);
    expect(screen.getByTestId("quitting-banner").textContent).toContain(QUIT_COPY.title);
  });
});
