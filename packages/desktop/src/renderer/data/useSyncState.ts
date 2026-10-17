import { useEffect, useState } from "react";
import type { BakaDesktopApi, DesktopSyncState } from "../../shared/api.js";

/** 订阅主进程下发的定时同步状态（T-067）；无 API 时用注入值（测试 / 假数据），都没有为 null。 */
export function useSyncState(
  api: BakaDesktopApi | undefined,
  initial: DesktopSyncState | null = null,
): DesktopSyncState | null {
  const [state, setState] = useState<DesktopSyncState | null>(() => initial);
  useEffect(() => {
    if (!api?.getSyncState) {
      setState(initial);
      return;
    }
    let alive = true;
    void api
      .getSyncState()
      .then((s) => {
        if (alive) setState(s);
      })
      .catch(() => {
        if (alive) setState({ available: false, reason: "读取同步状态失败" });
      });
    const off = api.onSyncState((s) => {
      if (alive) setState(s);
    });
    return () => {
      alive = false;
      off();
    };
  }, [api]); // initial 只在无 api 时用
  return state;
}
