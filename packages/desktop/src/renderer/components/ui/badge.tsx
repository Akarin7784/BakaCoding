// 状态徽标：强调色只用在这里（编码中、复投、冲突、已合并），其余状态用中性色。
import type { TicketStatus } from "@bakacoding/types";
import { cn } from "../../lib/utils";

export const ACCENT_STATUSES: ReadonlySet<TicketStatus> = new Set<TicketStatus>([
  "coding",
  "resubmitting",
  "conflict",
  "merged",
]);

export const STATUS_LABEL: Record<TicketStatus, string> = {
  pending: "排队",
  coding: "编码中",
  in_review: "评审中",
  resubmitting: "复投",
  merge_queued: "等待合并",
  conflict: "冲突",
  re_reviewing: "重新评审",
  merged: "已合并",
  escalated: "需要人工介入",
};

export function StatusBadge({ status }: { status: TicketStatus }) {
  const accent = ACCENT_STATUSES.has(status);
  return (
    <span
      data-status={status}
      data-accent={accent}
      className={cn(
        "inline-flex items-center rounded border px-1.5 py-0.5 text-xs transition-colors duration-300",
        accent ? "border-accent text-accent" : "border-border text-muted-foreground",
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}
