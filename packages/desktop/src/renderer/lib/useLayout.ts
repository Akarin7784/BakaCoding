// UI-02：布局状态。窗口宽度 → 断点；左栏收起（宽窗口持久化，窄窗口临时）；右面板开关（默认关，不持久化）。
import { useCallback, useEffect, useState } from "react";
import {
  layoutMode,
  readSidebarPreference,
  sidebarCollapsed,
  writeSidebarPreference,
  type LayoutMode,
} from "./layout";

function currentWidth(): number {
  return globalThis.window?.innerWidth ?? 1280;
}

export function useViewportWidth(): number {
  const [w, setW] = useState(currentWidth);
  useEffect(() => {
    const onResize = () => setW(currentWidth());
    globalThis.window?.addEventListener("resize", onResize);
    return () => globalThis.window?.removeEventListener("resize", onResize);
  }, []);
  return w;
}

export interface LayoutState extends LayoutMode {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  rightPanelOpen: boolean;
  setRightPanelOpen: (open: boolean) => void;
  toggleRightPanel: () => void;
}

export function useLayout(): LayoutState {
  const mode = layoutMode(useViewportWidth());
  const [preference, setPreference] = useState(() => readSidebarPreference());
  const [narrowOverride, setNarrowOverride] = useState<boolean | null>(null);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);

  // 离开窄窗口时丢掉临时展开 / 收起
  useEffect(() => {
    if (!mode.narrow) setNarrowOverride(null);
  }, [mode.narrow]);

  const collapsed = sidebarCollapsed({ preference, narrow: mode.narrow, narrowOverride });
  const toggleSidebar = useCallback(() => {
    if (mode.narrow) {
      setNarrowOverride(!collapsed);
    } else {
      setPreference(!collapsed);
      writeSidebarPreference(!collapsed);
    }
  }, [mode.narrow, collapsed]);

  return {
    ...mode,
    sidebarCollapsed: collapsed,
    toggleSidebar,
    rightPanelOpen,
    setRightPanelOpen,
    toggleRightPanel: useCallback(() => setRightPanelOpen((o) => !o), []),
  };
}
