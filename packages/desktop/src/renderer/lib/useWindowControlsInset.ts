// UI-08：标题栏给系统窗口按钮留多少位置。优先用 Window Controls Overlay API
// （navigator.windowControlsOverlay.getTitlebarAreaRect()，几何变化时 geometrychange），
// 取不到（macOS hiddenInset、浏览器预览、API 不可用、叠层不可见）时退回固定值（UI-02：右 138 / 左 76）。
import { useEffect, useState } from "react";
import { windowControlsInset } from "./layout";

export interface Inset {
  left: number;
  right: number;
}

interface OverlayLike {
  visible?: boolean;
  getTitlebarAreaRect(): { x: number; width: number; height?: number };
  addEventListener?(type: "geometrychange", l: () => void): void;
  removeEventListener?(type: "geometrychange", l: () => void): void;
}

export function overlayOf(nav: unknown): OverlayLike | undefined {
  const o = (nav as { windowControlsOverlay?: OverlayLike } | undefined)?.windowControlsOverlay;
  return o && typeof o.getTitlebarAreaRect === "function" ? o : undefined;
}

/** 由标题栏可用区算出左右要让出的宽度；量不出来（不可见、宽 0、算出负数）返回 null。 */
export function insetFromOverlay(o: OverlayLike | undefined, viewportWidth: number): Inset | null {
  if (!o || o.visible === false) return null;
  let r: { x: number; width: number };
  try {
    r = o.getTitlebarAreaRect();
  } catch {
    return null;
  }
  if (!r || !(r.width > 0) || !(viewportWidth > 0)) return null;
  const left = Math.max(0, Math.round(r.x));
  const right = Math.max(0, Math.round(viewportWidth - (r.x + r.width)));
  if (left + right >= viewportWidth) return null;
  return { left, right };
}

export function useWindowControlsInset(platform: string | undefined): Inset {
  const fallback = windowControlsInset(platform);
  const measure = (): Inset =>
    insetFromOverlay(overlayOf(globalThis.navigator), globalThis.window?.innerWidth ?? 0) ??
    fallback;
  const [inset, setInset] = useState<Inset>(measure);
  useEffect(() => {
    const update = () => setInset(measure());
    update();
    const o = overlayOf(globalThis.navigator);
    o?.addEventListener?.("geometrychange", update);
    globalThis.window?.addEventListener("resize", update);
    return () => {
      o?.removeEventListener?.("geometrychange", update);
      globalThis.window?.removeEventListener("resize", update);
    };
    // measure / fallback 只随 platform 变
  }, [platform]);
  return inset;
}
