// UI-08：主进程记住界面主题偏好（userData/window-theme.json），启动时在建窗口之前同步读出，
// 标题栏按钮叠层和窗口底色一开始就是对的，不再先按系统深浅闪一下（UI-02 遗留）。
// 单独一个文件：desktop-state.json 由 repo-store 整个覆盖写，放一起会被冲掉。
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

/** 写主题文件用到的 fs 操作（测试注入，模拟写 / rename 失败）。 */
export interface ThemeStoreFs {
  writeFileSync: (file: string, data: string, opts: { flag: string }) => void;
  renameSync: (from: string, to: string) => void;
  rmSync: (file: string, opts: { force: boolean }) => void;
}

const defaultFs: ThemeStoreFs = { writeFileSync, renameSync, rmSync };

/**
 * T-105：原子写——先写同目录下的临时文件（`wx`，不覆盖别人的），再 rename 到 window-theme.json；
 * 中途失败（写不完、rename 失败）删掉临时文件再抛，旧文件保持原样，不会留下写了一半的 JSON。
 */
export function writeSavedTheme(
  userData: string,
  theme: WindowThemeSource,
  fs: ThemeStoreFs = defaultFs,
): void {
  mkdirSync(userData, { recursive: true });
  const target = path.join(userData, THEME_STORE_FILE);
  const tmp = path.join(
    userData,
    `.${THEME_STORE_FILE}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    fs.writeFileSync(tmp, `${JSON.stringify({ theme })}\n`, { flag: "wx" });
    fs.renameSync(tmp, target);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 清不掉也不盖住原来的错误 */
    }
    throw e;
  }
}
