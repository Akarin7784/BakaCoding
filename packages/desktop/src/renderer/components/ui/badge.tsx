// 状态徽标：图标 + 文案。颜色、图标按 StatusIcon（§5.2），文案取自文案表（§5.6）。
import type { TicketStatus } from "@bakacoding/types";
import { TICKET_STATUS_LABEL } from "../../lib/copy";
import { cn } from "../../lib/utils";
import { STATUS_ICON, STATUS_TONE_CLASS, StatusIcon } from "../StatusIcon";

/** 兼容旧引用：状态文案以 lib/copy.ts 为准。 */
export const STATUS_LABEL = TICKET_STATUS_LABEL;

export function StatusBadge({ status }: { status: TicketStatus }) {
  const tone = STATUS_ICON[status].tone;
  return (
    <span
      data-status={status}
      data-tone={tone}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-xs transition-colors duration-200",
        STATUS_TONE_CLASS[tone],
      )}
    >
      <StatusIcon status={status} decorative className="[&_svg]:size-3" />
      {TICKET_STATUS_LABEL[status]}
    </span>
  );
}
