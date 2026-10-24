import { useEffect, useMemo, useState } from "react";
import type { BakaDesktopApi } from "../../shared/api";
import { applyUpdate, buildViews, fromSnapshot, type LiveState, type LiveViews } from "./views";

export interface DesktopData extends LiveViews {
  db: LiveState["db"] | null;
  /** UI-05c 需求页：快照单子（当前状态只看它）和事件（只给标记 / 时间线） */
  tickets: LiveState["tickets"];
  events: LiveState["events"];
  loading: boolean;
}

/** 有 API 时读快照并订阅增量；没有 API（测试、浏览器开发）时返回 null，由调用方退回假数据。 */
export function useDesktopData(api: BakaDesktopApi | undefined): DesktopData | null {
  const [state, setState] = useState<LiveState | null>(null);

  useEffect(() => {
    if (!api) return;
    let alive = true;
    const pending: Parameters<Parameters<BakaDesktopApi["onUpdate"]>[0]>[0][] = [];
    let base: LiveState | null = null;
    const off = api.onUpdate((u) => {
      if (!alive) return;
      if (!base) {
        pending.push(u);
        return;
      }
      setState((s) => (s ? applyUpdate(s, u) : s));
    });
    void api.getSnapshot().then((snap) => {
      if (!alive) return;
      base = pending.reduce(applyUpdate, fromSnapshot(snap));
      setState(base);
    });
    return () => {
      alive = false;
      off();
    };
  }, [api]);

  const views = useMemo(() => (state ? buildViews(state) : null), [state]);
  if (!api) return null;
  if (!state || !views)
    return {
      projects: [],
      flashCalls: {},
      unattributed: [],
      unattributedWarnings: [],
      db: null,
      tickets: [],
      events: [],
      loading: true,
    };
  return { ...views, db: state.db, tickets: state.tickets, events: state.events, loading: false };
}
