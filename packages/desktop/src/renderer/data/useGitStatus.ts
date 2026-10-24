// UI-06c：右面板 Git 区——invoke git:status；快照 / 同步状态更新时（引用变）重新取，不轮询。
import { useEffect, useState } from "react";
import type { BakaDesktopApi, DesktopGitStatusResult } from "../../shared/api.js";

export const GIT_STATUS_IPC_FAILED = "读取 Git 状态失败：和主进程通信失败";

/** 无 api / 旧 preload 没有 getGitStatus → null（右面板退回示例数据）。 */
export function useGitStatus(
  api: BakaDesktopApi | undefined,
  /** 快照事件列表引用：有新事件即换新数组，引用变即重取 */
  eventsKey: unknown,
  /** 快照 tickets 引用：单有变化时整表替换，引用变即重取 */
  ticketsKey: unknown,
  /** 同步状态引用：onSyncState 推新状态即重取 */
  syncKey: unknown,
): DesktopGitStatusResult | null {
  const [state, setState] = useState<DesktopGitStatusResult | null>(null);
  useEffect(() => {
    if (!api?.getGitStatus) {
      setState(null);
      return;
    }
    let alive = true;
    api
      .getGitStatus()
      .then((r) => {
        if (alive) setState(r);
      })
      .catch(() => {
        if (alive) setState({ ok: false, reason: GIT_STATUS_IPC_FAILED });
      });
    return () => {
      alive = false;
    };
  }, [api, eventsKey, ticketsKey, syncKey]);
  return state;
}
