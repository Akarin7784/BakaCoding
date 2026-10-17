// UI-01：需求单状态图标（docs/ui-design.md §5.2）。形状为主、颜色为辅，色弱也能分清：
// 9 个 TicketStatus 各对应一个 lucide 图标和一种色调；转圈的图标尊重「减少动态效果」。
import type { TicketStatus } from "@bakacoding/types";
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  GitCompareArrows,
  GitPullRequest,
  LoaderCircle,
  RotateCcw,
  type LucideIcon,
} from "lucide-react";
import { RESUBMIT_COPY, TICKET_STATUS_LABEL } from "../lib/copy";
import { cn } from "../lib/utils";

export type StatusTone = "muted" | "accent" | "danger" | "foreground";

export interface StatusIconSpec {
  icon: LucideIcon;
  /** lucide 图标名（kebab-case，与 §5.2 表一致，测试和文档对照用） */
  name: string;
  tone: StatusTone;
  /** 缓慢旋转（运行中） */
  spin: boolean;
}

/** Record 穷举 TicketStatus：types 新增状态时这里编译不过。 */
export const STATUS_ICON: Record<TicketStatus, StatusIconSpec> = {
  pending: { icon: CircleDashed, name: "circle-dashed", tone: "muted", spin: false },
  coding: { icon: LoaderCircle, name: "loader-circle", tone: "accent", spin: true },
  in_review: { icon: LoaderCircle, name: "loader-circle", tone: "accent", spin: true },
  re_reviewing: { icon: LoaderCircle, name: "loader-circle", tone: "accent", spin: true },
  resubmitting: { icon: RotateCcw, name: "rotate-ccw", tone: "accent", spin: false },
  merge_queued: { icon: GitPullRequest, name: "git-pull-request", tone: "muted", spin: false },
  conflict: { icon: GitCompareArrows, name: "git-compare-arrows", tone: "danger", spin: false },
  merged: { icon: CircleCheck, name: "circle-check", tone: "foreground", spin: false },
  escalated: { icon: CircleAlert, name: "circle-alert", tone: "danger", spin: false },
};

export const STATUS_TONE_CLASS: Record<StatusTone, string> = {
  muted: "text-muted-foreground",
  accent: "text-accent",
  danger: "text-danger",
  foreground: "text-foreground",
};

export function StatusIcon({
  status,
  size = 16,
  resubmitCount,
  className,
  decorative = false,
}: {
  status: TicketStatus;
  /** §5.5：列表 16，按钮 20 */
  size?: 16 | 20;
  /** resubmitting 时在图标旁显示次数（§5.2「rotate-ccw + 次数」） */
  resubmitCount?: number;
  className?: string;
  /** 旁边已有文字时设为 true：图标只作装饰，不再朗读一遍 */
  decorative?: boolean;
}) {
  const spec = STATUS_ICON[status];
  const Icon = spec.icon;
  const showCount = status === "resubmitting" && resubmitCount !== undefined;
  const label = showCount
    ? `${TICKET_STATUS_LABEL[status]}（${RESUBMIT_COPY.count(resubmitCount)}）`
    : TICKET_STATUS_LABEL[status];
  return (
    <span
      {...(decorative
        ? { "aria-hidden": true }
        : { role: "img", "aria-label": label, title: label })}
      data-status={status}
      data-tone={spec.tone}
      data-icon={spec.name}
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5",
        STATUS_TONE_CLASS[spec.tone],
        className,
      )}
    >
      <Icon
        size={size}
        strokeWidth={1.5}
        aria-hidden
        className={cn(spec.spin && "animate-spin-slow motion-reduce:animate-none")}
      />
      {showCount && <span className="text-xs tabular-nums">{resubmitCount}</span>}
    </span>
  );
}
