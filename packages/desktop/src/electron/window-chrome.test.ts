import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../shared/api";
import { serveWindowTheme, type IpcMainLike } from "./ipc";
import {
  isWindowThemeSource,
  MIN_WINDOW,
  TITLE_BAR_COLORS,
  titleBarOverlayFor,
  windowChromeOptions,
} from "./window-chrome";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "../renderer/index.css"), "utf8");
const mainSrc = readFileSync(join(here, "main.ts"), "utf8");

function oklchToHex(L: number, C: number, H: number): string {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const f = (x: number) => {
    const c = Math.max(0, Math.min(1, x));
    const g = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
    return Math.round(g * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return "#" + rgb.map(f).join("");
}

/** 取 index.css 里第 n 次出现的某个 token（0 = 浅色 :root，1 = 深色）。 */
function token(name: string, n: number): string {
  const all = [
    ...css.matchAll(new RegExp(`--${name}:\\s*oklch\\(([\\d.]+) ([\\d.]+) ([\\d.]+)\\)`, "g")),
  ];
  const hit = all[n];
  if (!hit) throw new Error(`没找到 --${name} #${n}`);
  return oklchToHex(Number(hit[1]), Number(hit[2]), Number(hit[3]));
}

describe("窗口外框（ui-design §2）", () => {
  it("最小 960×640", () => {
    expect(MIN_WINDOW).toEqual({ width: 960, height: 640 });
    for (const p of ["win32", "linux", "darwin"]) {
      const o = windowChromeOptions(p, false);
      expect([o.minWidth, o.minHeight]).toEqual([960, 640]);
    }
  });

  it("Windows / Linux 无边框 + 系统窗口按钮叠层；macOS 用 hiddenInset", () => {
    expect(windowChromeOptions("win32", false)).toMatchObject({
      titleBarStyle: "hidden",
      titleBarOverlay: { color: "#fcfcfa", symbolColor: "#1b1a18", height: 40 },
    });
    expect(windowChromeOptions("linux", true).titleBarOverlay).toEqual(titleBarOverlayFor(true));
    const mac = windowChromeOptions("darwin", false);
    expect(mac.titleBarStyle).toBe("hiddenInset");
    expect(mac.titleBarOverlay).toBeUndefined();
  });

  it("标题栏按钮颜色与 index.css 的 background / foreground token 一致", () => {
    expect(TITLE_BAR_COLORS.light.color).toBe(token("background", 0));
    expect(TITLE_BAR_COLORS.light.symbolColor).toBe(token("foreground", 0));
    expect(TITLE_BAR_COLORS.dark.color).toBe(token("background", 1));
    expect(TITLE_BAR_COLORS.dark.symbolColor).toBe(token("foreground", 1));
  });

  it("main.ts 用这套外框选项，并监听系统深浅变化刷新标题栏", () => {
    expect(mainSrc).toMatch(/\.\.\.windowChromeOptions\(process\.platform/);
    expect(mainSrc).toMatch(/nativeTheme\.on\("updated"/);
    expect(mainSrc).not.toMatch(/frame:\s*true/);
  });
});

function fakeIpc() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipc: IpcMainLike = {
    handle: (ch, fn) => void handlers.set(ch, fn),
    removeHandler: (ch) => void handlers.delete(ch),
  };
  const call = (...args: unknown[]) => handlers.get(IPC_CHANNELS.windowTheme)!({}, ...args);
  return { ipc, handlers, call };
}

describe("window:theme：渲染进程主题偏好 → nativeTheme.themeSource", () => {
  it("合法取值：设 themeSource，并按结果刷新标题栏颜色", () => {
    const { ipc, call } = fakeIpc();
    const setThemeSource = vi.fn((s: string) => s === "dark");
    const applyTitleBar = vi.fn();
    serveWindowTheme(ipc, { setThemeSource, applyTitleBar });
    expect(call("dark")).toEqual({ ok: true, dark: true });
    expect(call("light")).toEqual({ ok: true, dark: false });
    expect(call("system")).toEqual({ ok: true, dark: false });
    expect(setThemeSource.mock.calls).toEqual([["dark"], ["light"], ["system"]]);
    expect(applyTitleBar.mock.calls).toEqual([[true], [false], [false]]);
  });

  it("不认识的取值直接拒绝，不碰 nativeTheme", () => {
    const { ipc, call } = fakeIpc();
    const setThemeSource = vi.fn(() => true);
    serveWindowTheme(ipc, { setThemeSource, applyTitleBar: () => {} });
    for (const bad of ["blue", "", 1, null, undefined, { source: "dark" }]) {
      expect(call(bad)).toEqual({ ok: false, reason: "不认识的主题" });
    }
    expect(setThemeSource).not.toHaveBeenCalled();
    expect(isWindowThemeSource("dark")).toBe(true);
    expect(isWindowThemeSource("Dark")).toBe(false);
  });

  it("主进程出错时返回原因而不是抛出", () => {
    const { ipc, call } = fakeIpc();
    serveWindowTheme(ipc, {
      setThemeSource: () => true,
      applyTitleBar: () => {
        throw new Error("window destroyed");
      },
    });
    expect(call("dark")).toEqual({
      ok: false,
      reason: expect.stringContaining("window destroyed"),
    });
  });

  it("停止时注销通道", () => {
    const { ipc, handlers } = fakeIpc();
    const stop = serveWindowTheme(ipc, { setThemeSource: () => false, applyTitleBar: () => {} });
    expect(handlers.has(IPC_CHANNELS.windowTheme)).toBe(true);
    stop();
    expect(handlers.has(IPC_CHANNELS.windowTheme)).toBe(false);
  });
});
