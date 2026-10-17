// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useWindowControlsInset } from "./useWindowControlsInset";

afterEach(() => {
  cleanup();
  delete (navigator as { windowControlsOverlay?: unknown }).windowControlsOverlay;
});

function installOverlay(width: number) {
  let rectWidth = width;
  const listeners = new Set<() => void>();
  Object.defineProperty(navigator, "windowControlsOverlay", {
    configurable: true,
    value: {
      visible: true,
      getTitlebarAreaRect: () => ({ x: 0, width: rectWidth, height: 40 }),
      addEventListener: (_: string, l: () => void) => listeners.add(l),
      removeEventListener: (_: string, l: () => void) => listeners.delete(l),
    },
  });
  return {
    listeners,
    change(w: number) {
      rectWidth = w;
      act(() => listeners.forEach((l) => l()));
    },
  };
}

describe("useWindowControlsInset", () => {
  it("有 Window Controls Overlay 时按实际几何算，geometrychange 时更新，卸载时退订", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
    const o = installOverlay(1280 - 150);
    const { result, unmount } = renderHook(() => useWindowControlsInset("win32"));
    expect(result.current).toEqual({ left: 0, right: 150 });
    o.change(1280 - 120);
    expect(result.current).toEqual({ left: 0, right: 120 });
    unmount();
    expect(o.listeners.size).toBe(0);
  });

  it("没有这个 API 时退回固定值（Windows / Linux 右 138，macOS 左 76，未知 0）", () => {
    expect(renderHook(() => useWindowControlsInset("win32")).result.current).toEqual({
      left: 0,
      right: 138,
    });
    expect(renderHook(() => useWindowControlsInset("darwin")).result.current).toEqual({
      left: 76,
      right: 0,
    });
    expect(renderHook(() => useWindowControlsInset(undefined)).result.current).toEqual({
      left: 0,
      right: 0,
    });
  });
});
