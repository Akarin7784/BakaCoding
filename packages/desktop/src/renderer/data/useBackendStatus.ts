// UI-08：后端状态（backend:status）。只读横幅、只读禁用、全局状态点都看它。
// 只读可能在运行中出现（租约丢失、存储出错），所以定时再取；重新连接后立刻再取一次。
import { useCallback, useEffect, useRef, useState } from "react";
import type { BakaDesktopApi, DesktopBackendStatus } from "../../shared/api.js";

export const BACKEND_STATUS_POLL_MS = 5000;

/** 只读 = 后端起不来（mode readonly）或运行中掉线（存储租约丢失）（§4.7）。 */
export function isReadonlyStatus(s: DesktopBackendStatus | null | undefined): boolean {
  if (!s) return false;
  return s.mode === "readonly" || s.storage?.lease_lost === true;
}

export interface BackendStatusState {
  status: DesktopBackendStatus | null;
  readonly: boolean;
  refresh(): Promise<void>;
}

export function useBackendStatus(
  api: Pick<BakaDesktopApi, "getBackendStatus"> | undefined,
  pollMs: number = BACKEND_STATUS_POLL_MS,
): BackendStatusState {
  const [status, setStatus] = useState<DesktopBackendStatus | null>(null);
  const alive = useRef(true);
  const refresh = useCallback(async () => {
    if (!api?.getBackendStatus) return;
    try {
      const s = await api.getBackendStatus();
      if (alive.current) setStatus(s);
    } catch {
      /* 取不到按上一次的；从没取到按非只读 */
    }
  }, [api]);
  useEffect(() => {
    alive.current = true;
    void refresh();
    if (!api?.getBackendStatus || pollMs <= 0) return () => void (alive.current = false);
    const t = setInterval(() => void refresh(), pollMs);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [api, pollMs, refresh]);
  return { status, readonly: isReadonlyStatus(status), refresh };
}
