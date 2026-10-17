// 状态徽标：强调色只用在这里（运行、复投、冲突、已合并），其余状态用中性色。
import { cn } from "../../lib/utils";
import type { PrStatus } from "../../mock/types";

const ACCENT: ReadonlySet<PrStatus> = new Set(["running", "resubmitting", "conflict", "merged"]);

const LABEL: Record<PrStatus, string> = {
  queued: "排队",
  running: "运行",
  in_review: "评审中",
  resubmitting: "复投",
  conflict: "冲突",
  merged: "已合并",
  escalated: "已上报",
};

export function StatusBadge({ status }: { status: PrStatus }) {
  const accent = ACCENT.has(status);
  return (
    <span
      data-status={status}
      data-accent={accent}
      className={cn(
        "inline-flex items-center rounded border px-1.5 py-0.5 text-xs transition-colors duration-300",
        accent ? "border-accent text-accent" : "border-border text-muted-foreground",
      )}
    >
      {LABEL[status]}
    </span>
  );
}
