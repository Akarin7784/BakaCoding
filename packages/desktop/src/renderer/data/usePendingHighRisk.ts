import { useCallback, useEffect, useState } from "react";
import type { BakaDesktopApi, DesktopPendingHighRisk } from "../../shared/api.js";

/** 订阅主进程的待裁决高风险清单（T-062）；无 API 时用 props 注入的初始列表。 */
export function usePendingHighRisk(
  api: BakaDesktopApi | undefined,
  initial: DesktopPendingHighRisk[] = [],
): {
  items: DesktopPendingHighRisk[];
  decide: (
    ticket_id: string,
    pr_id: string,
    decision: "release" | "reject",
  ) => Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  live: boolean;
} {
  const [items, setItems] = useState<DesktopPendingHighRisk[]>(() => initial);

  useEffect(() => {
    if (!api?.getPendingHighRisk) {
      setItems(initial);
      return;
    }
    let alive = true;
    void api.getPendingHighRisk().then((list) => {
      if (alive) setItems(list);
    });
    const off = api.onPendingHighRisk((list) => {
      if (alive) setItems(list);
    });
    return () => {
      alive = false;
      off();
    };
  }, [api]); // initial 只在无 api 时作假数据；有 api 后以主进程推送为准

  const decide = useCallback(
    async (ticket_id: string, pr_id: string, decision: "release" | "reject") => {
      if (!api?.decideHighRisk) {
        return { ok: false as const, code: "unavailable", message: "高风险裁决不可用" };
      }
      const r = await api.decideHighRisk(ticket_id, pr_id, decision);
      if (r.ok) return { ok: true as const };
      return { ok: false as const, code: r.code, message: r.message };
    },
    [api],
  );

  return { items, decide, live: Boolean(api?.getPendingHighRisk) };
}
