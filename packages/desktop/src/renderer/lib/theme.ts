// UI-01：主题偏好（跟随系统 / 浅 / 深）的读取、持久化与解析（docs/ui-design.md §4.6「通用」、§5.1）。
// 偏好存在渲染进程 localStorage；解析结果写到 <html data-theme>，CSS token 和 dark: 变体都看它。
// 主进程 nativeTheme.themeSource 仍为 system（标题栏随系统；跟随偏好留给 UI-02 的无边框标题栏）。

export const THEME_PREFERENCES = ["system", "light", "dark"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "bakacoding.theme";
export const DEFAULT_THEME_PREFERENCE: ThemePreference = "system";
export const DARK_QUERY = "(prefers-color-scheme: dark)";

/** 界面文案（设置 › 通用）。 */
export const THEME_LABEL: Record<ThemePreference, string> = {
  system: "跟随系统",
  light: "浅色",
  dark: "深色",
};

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function isThemePreference(v: unknown): v is ThemePreference {
  return typeof v === "string" && (THEME_PREFERENCES as readonly string[]).includes(v);
}

/** 读偏好：没存、存了不认识的值、storage 抛错（隐私模式等）都回到「跟随系统」。 */
export function readThemePreference(storage: StorageLike | undefined): ThemePreference {
  try {
    const v = storage?.getItem(THEME_STORAGE_KEY);
    return isThemePreference(v) ? v : DEFAULT_THEME_PREFERENCE;
  } catch {
    return DEFAULT_THEME_PREFERENCE;
  }
}

/** 存偏好；写失败不抛（只是下次启动回到默认）。返回是否写成功。 */
export function writeThemePreference(
  storage: StorageLike | undefined,
  pref: ThemePreference,
): boolean {
  if (!isThemePreference(pref)) return false;
  try {
    storage?.setItem(THEME_STORAGE_KEY, pref);
    return storage !== undefined;
  } catch {
    return false;
  }
}

export function resolveTheme(pref: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (pref === "system") return systemDark ? "dark" : "light";
  return pref;
}

export function systemPrefersDark(win: Pick<Window, "matchMedia"> | undefined): boolean {
  try {
    return win?.matchMedia?.(DARK_QUERY).matches ?? false;
  } catch {
    return false;
  }
}

export function applyTheme(root: HTMLElement, resolved: ResolvedTheme): void {
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
}

export function safeLocalStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
