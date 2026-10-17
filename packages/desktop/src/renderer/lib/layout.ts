// UI-02：布局骨架的尺寸、断点与左栏收起偏好（docs/ui-design.md §2）。纯函数，便于测试。
import { safeLocalStorage } from "./theme";

export const LAYOUT = {
  sidebarWidth: 260,
  sidebarCollapsedWidth: 56,
  rightPanelWidth: 360,
  contentMaxWidth: 760,
  titleBarHeight: 40,
  /** 宽度小于它时左栏自动收起 */
  sidebarAutoCollapseBelow: 1024,
  /** 宽度小于它时右面板改为覆盖式抽屉 */
  drawerBelow: 1200,
  /** Windows / Linux 右上角系统按钮叠层大约占的宽度（3 × 46px） */
  windowControlsWidth: 138,
  /** macOS 红绿灯占的宽度 */
  trafficLightsWidth: 76,
} as const;

export interface LayoutMode {
  /** 左栏因窗口窄被自动收起 */
  narrow: boolean;
  /** 右面板以覆盖式抽屉显示 */
  drawer: boolean;
}

export function layoutMode(width: number): LayoutMode {
  return { narrow: width < LAYOUT.sidebarAutoCollapseBelow, drawer: width < LAYOUT.drawerBelow };
}

/**
 * 左栏实际是否收起：窄窗口默认收起，用户可临时展开（override，不持久化）；
 * 宽窗口按用户保存的偏好。
 */
export function sidebarCollapsed(opts: {
  preference: boolean;
  narrow: boolean;
  narrowOverride: boolean | null;
}): boolean {
  if (opts.narrow) return opts.narrowOverride ?? true;
  return opts.preference;
}

export const SIDEBAR_STORAGE_KEY = "bakacoding.sidebarCollapsed";
type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function readSidebarPreference(
  storage: StorageLike | undefined = safeLocalStorage(),
): boolean {
  try {
    return storage?.getItem(SIDEBAR_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeSidebarPreference(
  collapsed: boolean,
  storage: StorageLike | undefined = safeLocalStorage(),
): void {
  try {
    storage?.setItem(SIDEBAR_STORAGE_KEY, collapsed ? "1" : "0");
  } catch {
    /* 存不下只影响下次启动 */
  }
}

/** 标题栏要给系统窗口按钮留的位置（左 / 右）。浏览器预览、测试里平台未知时不留。 */
export function windowControlsInset(platform: string | undefined): { left: number; right: number } {
  if (platform === "win32" || platform === "linux")
    return { left: 0, right: LAYOUT.windowControlsWidth };
  if (platform === "darwin") return { left: LAYOUT.trafficLightsWidth, right: 0 };
  return { left: 0, right: 0 };
}

/** 内容区正文列：最大宽 760、居中（§2）。滚动容器仍占满宽度，滚动条贴边。 */
export const CONTENT_COLUMN = "mx-auto w-full max-w-[760px]";
