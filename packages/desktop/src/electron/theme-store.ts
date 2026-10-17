// UI-08：主进程记住界面主题偏好（userData/window-theme.json），启动时在建窗口之前同步读出，
// 标题栏按钮叠层和窗口底色一开始就是对的，不再先按系统深浅闪一下（UI-02 遗留）。
// 单独一个文件：desktop-state.json 由 repo-store 整个覆盖写，放一起会被冲掉。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { WindowThemeSource } from "../shared/api.js";
import { isWindowThemeSource } from "./window-chrome.js";

export const THEME_STORE_FILE = "window-theme.json";

export function readSavedTheme(userData: string): WindowThemeSource {
  try {
    const v = JSON.parse(readFileSync(path.join(userData, THEME_STORE_FILE), "utf8")) as unknown;
    const t = (v as { theme?: unknown } | null)?.theme;
    return isWindowThemeSource(t) ? t : "system";
  } catch {
    return "system";
  }
}

export function writeSavedTheme(userData: string, theme: WindowThemeSource): void {
  mkdirSync(userData, { recursive: true });
  writeFileSync(path.join(userData, THEME_STORE_FILE), `${JSON.stringify({ theme })}\n`);
}
