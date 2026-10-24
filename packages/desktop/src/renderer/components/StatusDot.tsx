// UI-08：全局状态点 + 状态卡（§4.8）。左栏底部齿轮旁：灰 = 空闲，强调色呼吸 = 有单在跑，红 = 有需要你处理的事。
// 点开状态卡：后端模式、数据库路径、待处理事项、未归属上报数（原「未归属」入口并到这里）。
import { useState } from "react";
import { ChevronRight, Inbox } from "lucide-react";
import type { DesktopBackendStatus, DesktopSnapshot } from "../../shared/api.js";
import { GLOBAL_LEVEL_LABEL, type GlobalLevel } from "../lib/globalStatus";
import { readonlyReason } from "../lib/readonly";
import { cn } from "../lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[4.5rem_1fr] gap-2 py-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-xs break-all">{children}</dd>
    </div>
  );
}

function dbText(db: DesktopSnapshot["db"] | null | undefined): string {
  if (!db) return "未连接（示例数据）";
  if (db.state === "ok") return db.path;
  if (db.state === "missing") return `还没有建库：${db.path}`;
  return `打不开：${db.message}`;
}

export function StatusDot({
  level,
  backend,
  db,
  attention,
  running,
  unattributed,
  onOpenUnattributed,
  collapsed = false,
}: {
  level: GlobalLevel;
  backend: DesktopBackendStatus | null;
  db: DesktopSnapshot["db"] | null | undefined;
  attention: string[];
  running: number;
  unattributed: number;
  onOpenUnattributed: () => void;
  collapsed?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const label = `全局状态：${GLOBAL_LEVEL_LABEL[level]}`;
  const backendText = !backend
    ? "未连接"
    : backend.mode === "live" && !backend.storage?.lease_lost
      ? "运行中"
      : `只读（${readonlyReason(backend)}）`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={label}
        title={label}
        data-testid="status-dot"
        data-level={level}
        className={cn(
          "inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          collapsed && "mx-auto",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "block size-2 rounded-full",
            level === "idle" && "bg-muted-foreground/60",
            level === "running" && "bg-accent animate-breathe",
            level === "attention" && "bg-danger",
          )}
        />
      </PopoverTrigger>
      <PopoverContent side="top" align="start" aria-label="状态卡" data-testid="status-card">
        <div className="mb-1 text-sm font-medium">{GLOBAL_LEVEL_LABEL[level]}</div>
        {attention.length > 0 && (
          <ul data-testid="status-attention" className="mb-2 space-y-0.5 text-xs text-danger">
            {attention.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        )}
        <dl className="border-t border-border pt-1">
          <Row label="后端">{backendText}</Row>
          <Row label="在跑">{running > 0 ? `${running} 张单` : "没有"}</Row>
          <Row label="数据库">
            <span data-testid="status-db">{dbText(db)}</span>
          </Row>
        </dl>
        <button
          type="button"
          className="mt-2 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
          disabled={unattributed === 0}
          onClick={() => {
            setOpen(false);
            onOpenUnattributed();
          }}
        >
          <Inbox size={14} strokeWidth={1.5} aria-hidden />
          <span className="flex-1">未归属上报</span>
          <span className="text-muted-foreground">{unattributed}</span>
          <ChevronRight size={14} strokeWidth={1.5} aria-hidden />
        </button>
      </PopoverContent>
    </Popover>
  );
}
