// UI-01：主题 store + hook。全界面共用一个 store，设置页改了偏好，Toaster 等其他订阅者同时更新。
// 偏好变了就持久化并立刻应用；「跟随系统」时监听系统深浅色变化。
import { useSyncExternalStore } from "react";
import {
  DARK_QUERY,
  applyTheme,
  isThemePreference,
  readThemePreference,
  resolveTheme,
  safeLocalStorage,
  systemPrefersDark,
  writeThemePreference,
  type ResolvedTheme,
  type ThemePreference,
} from "./theme";

export interface ThemeSnapshot {
  preference: ThemePreference;
  resolved: ResolvedTheme;
}

export interface ThemeStore {
  get: () => ThemeSnapshot;
  subscribe: (listener: () => void) => () => void;
  setPreference: (pref: ThemePreference) => void;
}

export interface ThemeStoreEnv {
  storage: Pick<Storage, "getItem" | "setItem"> | undefined;
  win: Pick<Window, "matchMedia"> | undefined;
  root: HTMLElement | undefined;
}

export function createThemeStore(env: ThemeStoreEnv): ThemeStore {
  let preference = readThemePreference(env.storage);
  let systemDark = systemPrefersDark(env.win);
  let snapshot: ThemeSnapshot = { preference, resolved: resolveTheme(preference, systemDark) };
  const listeners = new Set<() => void>();
  let unwatch: (() => void) | undefined;
  // 建 store 时就应用一次（main.tsx 在 React 渲染前建），避免先闪一帧浅色
  if (env.root) applyTheme(env.root, snapshot.resolved);

  const update = () => {
    const resolved = resolveTheme(preference, systemDark);
    if (snapshot.preference !== preference || snapshot.resolved !== resolved) {
      snapshot = { preference, resolved };
      for (const l of listeners) l();
    }
    if (env.root) applyTheme(env.root, resolved);
  };

  const watchSystem = () => {
    let mql: MediaQueryList | undefined;
    try {
      mql = env.win?.matchMedia?.(DARK_QUERY);
    } catch {
      mql = undefined;
    }
    if (!mql?.addEventListener) return undefined;
    const onChange = (e: MediaQueryListEvent) => {
      systemDark = e.matches;
      update();
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  };

  return {
    get: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) unwatch = watchSystem();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          unwatch?.();
          unwatch = undefined;
        }
      };
    },
    setPreference(pref) {
      if (!isThemePreference(pref)) return;
      // 存不下（storage 不可用）也照样切换本次会话的主题，只是重启后回到默认
      writeThemePreference(env.storage, pref);
      preference = pref;
      update();
    },
  };
}

let defaultStore: ThemeStore | undefined;
export function themeStore(): ThemeStore {
  defaultStore ??= createThemeStore({
    storage: safeLocalStorage(),
    win: globalThis.window,
    root: globalThis.document?.documentElement,
  });
  return defaultStore;
}

export function useTheme(store: ThemeStore = themeStore()): ThemeSnapshot & {
  setPreference: (pref: ThemePreference) => void;
} {
  const snap = useSyncExternalStore(store.subscribe, store.get, store.get);
  return { ...snap, setPreference: store.setPreference };
}
