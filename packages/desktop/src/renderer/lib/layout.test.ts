import { describe, expect, it } from "vitest";
import {
  LAYOUT,
  layoutMode,
  readSidebarPreference,
  SIDEBAR_STORAGE_KEY,
  sidebarCollapsed,
  windowControlsInset,
  writeSidebarPreference,
} from "./layout";

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    map: m,
  };
}

describe("布局尺寸与断点（ui-design §2）", () => {
  it("尺寸与文档一致", () => {
    expect(LAYOUT.sidebarWidth).toBe(260);
    expect(LAYOUT.sidebarCollapsedWidth).toBe(56);
    expect(LAYOUT.rightPanelWidth).toBe(360);
    expect(LAYOUT.contentMaxWidth).toBe(760);
  });

  it("< 1024 左栏自动收起；< 1200 右面板变抽屉", () => {
    expect(layoutMode(960)).toEqual({ narrow: true, drawer: true });
    expect(layoutMode(1023)).toEqual({ narrow: true, drawer: true });
    expect(layoutMode(1024)).toEqual({ narrow: false, drawer: true });
    expect(layoutMode(1199)).toEqual({ narrow: false, drawer: true });
    expect(layoutMode(1200)).toEqual({ narrow: false, drawer: false });
    expect(layoutMode(1600)).toEqual({ narrow: false, drawer: false });
  });

  it("窄窗口默认收起，可临时展开；宽窗口按偏好", () => {
    expect(sidebarCollapsed({ preference: false, narrow: true, narrowOverride: null })).toBe(true);
    expect(sidebarCollapsed({ preference: false, narrow: true, narrowOverride: false })).toBe(
      false,
    );
    expect(sidebarCollapsed({ preference: true, narrow: false, narrowOverride: false })).toBe(true);
    expect(sidebarCollapsed({ preference: false, narrow: false, narrowOverride: true })).toBe(
      false,
    );
  });
});

describe("左栏收起偏好持久化", () => {
  it("写入后读回；默认展开", () => {
    const s = memoryStorage();
    expect(readSidebarPreference(s)).toBe(false);
    writeSidebarPreference(true, s);
    expect(s.map.get(SIDEBAR_STORAGE_KEY)).toBe("1");
    expect(readSidebarPreference(s)).toBe(true);
    writeSidebarPreference(false, s);
    expect(readSidebarPreference(s)).toBe(false);
  });

  it("storage 不可用或抛错时不崩", () => {
    const bad = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readSidebarPreference(bad)).toBe(false);
    expect(() => writeSidebarPreference(true, bad)).not.toThrow();
    expect(readSidebarPreference(undefined)).toBe(false);
  });
});

describe("标题栏给系统窗口按钮留位", () => {
  it("Windows / Linux 右侧留位，macOS 左侧留红绿灯，未知平台不留", () => {
    expect(windowControlsInset("win32")).toEqual({ left: 0, right: 138 });
    expect(windowControlsInset("linux")).toEqual({ left: 0, right: 138 });
    expect(windowControlsInset("darwin")).toEqual({ left: 76, right: 0 });
    expect(windowControlsInset(undefined)).toEqual({ left: 0, right: 0 });
  });
});
