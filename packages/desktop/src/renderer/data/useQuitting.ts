import { useEffect, useState } from "react";
import type { BakaDesktopApi } from "../../shared/api.js";

/**
 * T-106：订阅主进程的 `app:quitting`。收到后一直为 true（窗口随后会被主进程关掉，不会回到 false）。
 * 没有 API 或旧版 preload 没有 onQuitting 时为 `initial`（测试 / 假数据注入）。
 */
export function useQuitting(api: BakaDesktopApi | undefined, initial = false): boolean {
  const [quitting, setQuitting] = useState(initial);
  useEffect(() => {
    if (!api?.onQuitting) return;
    let alive = true;
    const off = api.onQuitting(() => {
      if (alive) setQuitting(true);
    });
    return () => {
      alive = false;
      off();
    };
  }, [api]);
  return quitting;
}
