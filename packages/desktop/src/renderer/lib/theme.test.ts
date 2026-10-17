// @vitest-environment jsdom
// UI-01：主题偏好的读取、持久化与解析；store 跟随系统深浅色变化。
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_THEME_PREFERENCE,
  THEME_PREFERENCES,
  THEME_STORAGE_KEY,
  readThemePreference,
  resolveTheme,
  systemPrefersDark,
  writeThemePreference,
} from "./theme";
import { createThemeStore } from "./useTheme";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

function fakeMedia(dark: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const mql = {
    matches: dark,
    addEventListener: (_: string, l: (e: MediaQueryListEvent) => void) => listeners.add(l),
    removeEventListener: (_: string, l: (e: MediaQueryListEvent) => void) => listeners.delete(l),
  };
  return {
    win: { matchMedia: () => mql as unknown as MediaQueryList },
    listeners,
    flip(next: boolean) {
      mql.matches = next;
      for (const l of listeners) l({ matches: next } as MediaQueryListEvent);
    },
  };
}

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.colorScheme = "";
});

describe("主题偏好读写", () => {
  it("默认跟随系统；三种偏好都能存下再读回", () => {
    expect(DEFAULT_THEME_PREFERENCE).toBe("system");
    expect(readThemePreference(memoryStorage())).toBe("system");
    for (const p of THEME_PREFERENCES) {
      const s = memoryStorage();
      expect(writeThemePreference(s, p)).toBe(true);
      expect(s.data.get(THEME_STORAGE_KEY)).toBe(p);
      expect(readThemePreference(s)).toBe(p);
    }
  });

  it("存了不认识的值、storage 不可用或抛错，都回到跟随系统", () => {
    expect(readThemePreference(memoryStorage({ [THEME_STORAGE_KEY]: "sepia" }))).toBe("system");
    expect(readThemePreference(undefined)).toBe("system");
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readThemePreference(broken)).toBe("system");
    expect(writeThemePreference(broken, "dark")).toBe(false);
    expect(writeThemePreference(undefined, "dark")).toBe(false);
  });

  it("不写入不认识的偏好", () => {
    const s = memoryStorage();
    expect(writeThemePreference(s, "sepia" as never)).toBe(false);
    expect(s.data.has(THEME_STORAGE_KEY)).toBe(false);
  });
});

describe("主题解析", () => {
  it("跟随系统看系统深浅；浅 / 深 无视系统", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("系统深浅读 prefers-color-scheme；没有 matchMedia 或抛错时当浅色", () => {
    expect(systemPrefersDark(fakeMedia(true).win)).toBe(true);
    expect(systemPrefersDark(fakeMedia(false).win)).toBe(false);
    expect(systemPrefersDark(undefined)).toBe(false);
    const throwing = {
      matchMedia: () => {
        throw new Error("x");
      },
    };
    expect(systemPrefersDark(throwing as never)).toBe(false);
  });
});

describe("主题 store", () => {
  it("建好就把保存的偏好应用到 <html data-theme>", () => {
    const root = document.documentElement;
    createThemeStore({
      storage: memoryStorage({ [THEME_STORAGE_KEY]: "dark" }),
      win: fakeMedia(false).win,
      root,
    });
    expect(root.dataset.theme).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
  });

  it("切换偏好：持久化、应用、通知订阅者；重建 store 后仍是上次的选择", () => {
    const storage = memoryStorage();
    const media = fakeMedia(false);
    const root = document.documentElement;
    const store = createThemeStore({ storage, win: media.win, root });
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.get()).toEqual({ preference: "system", resolved: "light" });

    store.setPreference("dark");
    expect(storage.data.get(THEME_STORAGE_KEY)).toBe("dark");
    expect(root.dataset.theme).toBe("dark");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get()).toEqual({ preference: "dark", resolved: "dark" });

    root.removeAttribute("data-theme");
    const again = createThemeStore({ storage, win: media.win, root });
    expect(again.get().preference).toBe("dark");
    expect(root.dataset.theme).toBe("dark");
  });

  it("跟随系统时系统切到深色立刻跟着变；固定浅色时不受影响", () => {
    const media = fakeMedia(false);
    const root = document.documentElement;
    const store = createThemeStore({ storage: memoryStorage(), win: media.win, root });
    const unsubscribe = store.subscribe(() => {});
    media.flip(true);
    expect(store.get().resolved).toBe("dark");
    expect(root.dataset.theme).toBe("dark");

    store.setPreference("light");
    media.flip(false);
    media.flip(true);
    expect(store.get()).toEqual({ preference: "light", resolved: "light" });
    expect(root.dataset.theme).toBe("light");

    unsubscribe();
    expect(media.listeners.size).toBe(0);
  });

  it("storage 写不进去也能切换本次会话的主题；不认识的偏好被忽略", () => {
    const root = document.documentElement;
    const store = createThemeStore({ storage: undefined, win: fakeMedia(false).win, root });
    store.setPreference("dark");
    expect(store.get().resolved).toBe("dark");
    store.setPreference("sepia" as never);
    expect(store.get().preference).toBe("dark");
  });
});
