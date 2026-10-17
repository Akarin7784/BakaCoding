// UI-02：窗口外框（docs/ui-design.md §2）。不依赖 electron，便于测试。
// - 最小 960×640；
// - Windows / Linux：titleBarStyle hidden + titleBarOverlay，最小化 / 最大化 / 关闭由系统绘制（贴靠分屏、系统菜单可用），
//   其余区域由渲染进程自绘拖拽区；按钮底色和符号色跟随主题（与 index.css 的 background / foreground token 一致）；
// - macOS：hiddenInset，红绿灯由系统绘制。
import { WINDOW_THEME_SOURCES, type WindowThemeSource } from "../shared/api.js";

export const MIN_WINDOW = { width: 960, height: 640 } as const;
/** 标题栏高度，与渲染进程 TITLE_BAR_HEIGHT 一致。 */
export const TITLE_BAR_HEIGHT = 40;

/** index.css `--background` / `--foreground` 的 sRGB 近似值（测试里按 OKLCH 换算核对）。 */
export const TITLE_BAR_COLORS = {
  light: { color: "#fcfcfa", symbolColor: "#1b1a18" },
  dark: { color: "#121210", symbolColor: "#e9e8e5" },
} as const;

export interface TitleBarOverlay {
  color: string;
  symbolColor: string;
  height: number;
}

export function titleBarOverlayFor(dark: boolean): TitleBarOverlay {
  return { ...TITLE_BAR_COLORS[dark ? "dark" : "light"], height: TITLE_BAR_HEIGHT };
}

/** 系统画窗口按钮叠层的平台（Electron 在 Windows、Linux 支持 titleBarOverlay）。 */
export function usesTitleBarOverlay(platform: string): boolean {
  return platform === "win32" || platform === "linux";
}

export interface WindowChromeOptions {
  minWidth: number;
  minHeight: number;
  titleBarStyle: "hidden" | "hiddenInset";
  titleBarOverlay?: TitleBarOverlay;
  backgroundColor: string;
}

export function windowChromeOptions(platform: string, dark: boolean): WindowChromeOptions {
  const base = {
    minWidth: MIN_WINDOW.width,
    minHeight: MIN_WINDOW.height,
    backgroundColor: titleBarOverlayFor(dark).color,
  };
  if (platform === "darwin") return { ...base, titleBarStyle: "hiddenInset" };
  return usesTitleBarOverlay(platform)
    ? { ...base, titleBarStyle: "hidden", titleBarOverlay: titleBarOverlayFor(dark) }
    : { ...base, titleBarStyle: "hidden" };
}

export function isWindowThemeSource(v: unknown): v is WindowThemeSource {
  return typeof v === "string" && (WINDOW_THEME_SOURCES as readonly string[]).includes(v);
}
