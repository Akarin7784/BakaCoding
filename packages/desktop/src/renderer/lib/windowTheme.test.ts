// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { WINDOW_THEME_SOURCES } from "../../shared/api";
import { THEME_PREFERENCES } from "./theme";
import { createThemeStore } from "./useTheme";
import { syncWindowTheme } from "./windowTheme";

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
}

function fakeWin(dark = false) {
  let onChange: ((e: MediaQueryListEvent) => void) | undefined;
  const win = {
    matchMedia: () =>
      ({
        matches: dark,
        addEventListener: (_: string, l: (e: MediaQueryListEvent) => void) => (onChange = l),
        removeEventListener: () => (onChange = undefined),
      }) as unknown as MediaQueryList,
  };
  return { win, flip: (m: boolean) => onChange?.({ matches: m } as MediaQueryListEvent) };
}

describe("主题偏好同步到主进程（window:theme）", () => {
  it("主进程接受的取值与渲染进程的主题偏好一致", () => {
    expect([...WINDOW_THEME_SOURCES]).toEqual([...THEME_PREFERENCES]);
  });

  it("启动时发一次当前偏好，切换偏好时再发", () => {
    const { win } = fakeWin();
    const store = createThemeStore({ storage: memoryStorage(), win, root: undefined });
    const setWindowTheme = vi.fn(async () => ({ ok: true as const, dark: false }));
    const stop = syncWindowTheme(store, { setWindowTheme });
    expect(setWindowTheme.mock.calls).toEqual([["system"]]);
    store.setPreference("dark");
    store.setPreference("dark");
    store.setPreference("light");
    expect(setWindowTheme.mock.calls).toEqual([["system"], ["dark"], ["light"]]);
    stop();
    store.setPreference("system");
    expect(setWindowTheme).toHaveBeenCalledTimes(3);
  });

  it("跟随系统时系统深浅变化不重复发（主进程自己监听 nativeTheme）", () => {
    const { win, flip } = fakeWin();
    const store = createThemeStore({ storage: memoryStorage(), win, root: undefined });
    const setWindowTheme = vi.fn(async () => ({ ok: true as const, dark: true }));
    syncWindowTheme(store, { setWindowTheme });
    flip(true);
    expect(store.get().resolved).toBe("dark");
    expect(setWindowTheme).toHaveBeenCalledTimes(1);
  });

  it("没有 preload API（浏览器预览）或旧主进程拒绝时不崩", async () => {
    const store = createThemeStore({ storage: memoryStorage(), win: undefined, root: undefined });
    expect(() => syncWindowTheme(store, undefined)()).not.toThrow();
    expect(() => syncWindowTheme(store, {})()).not.toThrow();
    const rejecting = vi.fn(() => Promise.reject(new Error("No handler registered")));
    syncWindowTheme(store, { setWindowTheme: rejecting });
    await Promise.resolve();
    expect(rejecting).toHaveBeenCalledWith("system");
  });
});
