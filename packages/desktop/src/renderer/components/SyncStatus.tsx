// T-067：9 的定时同步状态一行（上次成功 / 运行或停止 / 下次尝试 + 鉴权停、限流提示）。
import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { DesktopSyncState } from "../../shared/api.js";
import { describeSyncState } from "../lib/sync-labels";
import { truncateDetail } from "../lib/warnings";
import { cn } from "../lib/utils";

export interface SyncStatusProps {
  state: DesktopSyncState;
  /** 测试注入当前时刻；默认每秒刷新一次相对时长 */
  now?: number;
}

export function SyncStatus({ state, now }: SyncStatusProps) {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (now !== undefined) return;
    const t = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [now]);
  const view = describeSyncState(state, now ?? tick);
  const detail = view.errorDetail ? truncateDetail(view.errorDetail) : null;
  const alert = view.tone === "error" || view.tone === "warn";

  return (
    <section
      aria-label="GitHub 同步状态"
      data-testid="sync-status"
      data-tone={view.tone}
      className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border px-4 py-1 text-xs text-muted-foreground"
    >
      <span className="flex items-center gap-1">
        <RefreshCw size={12} strokeWidth={1.5} aria-hidden />
        <span
          data-testid="sync-status-label"
          className={cn(
            alert && "font-medium text-accent",
            view.tone === "ok" && "text-foreground",
          )}
        >
          {view.label}
        </span>
      </span>
      {view.lastOk && <span data-testid="sync-last-ok">上次成功：{view.lastOk}</span>}
      {view.next && <span data-testid="sync-next">下次尝试：{view.next}</span>}
      {view.hint && (
        <span
          data-testid="sync-hint"
          role={alert ? "alert" : undefined}
          className={cn(alert && "text-accent")}
        >
          {view.hint}
        </span>
      )}
      {detail && (
        <span data-testid="sync-error-detail" title={detail.title} className="basis-full break-all">
          {detail.preview}
        </span>
      )}
    </section>
  );
}
