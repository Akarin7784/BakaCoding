import { useEffect, useState } from "react";
import type { BakaDesktopApi, DesktopPoolStateResult } from "../../shared/api.js";

export const POOL_STATE_READ_FAILED = "读取编码池状态失败";

/**
 * 读编码池状态（UI-06b）：快照对象一变（refreshKey）就重取一次，不轮询。
 * 无 api 或 api 没有 getPoolState 时为 null（调用方回退假数据）。
 */
export function usePoolState(
  api: BakaDesktopApi | undefined,
  refreshKey: unknown,
): DesktopPoolStateResult | null {
  const [state, setState] = useState<DesktopPoolStateResult | null>(null);
  useEffect(() => {
    if (!api?.getPoolState) {
      setState(null);
      return;
    }
    let alive = true;
    void api
      .getPoolState()
      .then((r) => {
        if (alive) setState(r);
      })
      .catch(() => {
        if (alive) setState({ ok: false, reason: POOL_STATE_READ_FAILED });
      });
    return () => {
      alive = false;
    };
  }, [api, refreshKey]);
  return state;
}
