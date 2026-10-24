// UI-05f：需求页右上角「⋯」菜单（docs/ui-design.md §4.4 / §1 表）：
// 导出这个需求的诊断包、导出单张单（每张单一项）、在主管对话里追问。
// 导出走现有 diagnostics:export 的 scope（requirement / ticket），不加新接口；追问交给 App 跳回主管对话并带上下文。
import { MoreHorizontal } from "lucide-react";
import { REQUIREMENT_MENU_COPY as C } from "../lib/copy";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

export type RequirementExportScope =
  { kind: "requirement"; requirement_id: string } | { kind: "ticket"; ticket_id: string };

export function RequirementMenu({
  requirementId,
  ticketIds,
  onExport,
  onAsk,
  exportDisabled = false,
}: {
  requirementId: string;
  ticketIds: readonly string[];
  onExport?: (scope: RequirementExportScope) => void;
  onAsk?: () => void;
  /** 正在导出时禁用导出项 */
  exportDisabled?: boolean;
}) {
  if (!onExport && !onAsk) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={C.trigger}
        data-testid="requirement-menu"
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <MoreHorizontal size={16} strokeWidth={1.5} aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        {onExport && (
          <>
            <DropdownMenuItem
              disabled={exportDisabled}
              onSelect={() => onExport({ kind: "requirement", requirement_id: requirementId })}
            >
              {C.exportRequirement}
            </DropdownMenuItem>
            {ticketIds.length > 0 && (
              <>
                <DropdownMenuLabel className="text-xs text-muted-foreground">
                  {C.exportTicketGroup}
                </DropdownMenuLabel>
                {ticketIds.map((id) => (
                  <DropdownMenuItem
                    key={id}
                    disabled={exportDisabled}
                    onSelect={() => onExport({ kind: "ticket", ticket_id: id })}
                  >
                    {C.exportTicket(id)}
                  </DropdownMenuItem>
                ))}
              </>
            )}
          </>
        )}
        {onExport && onAsk && <DropdownMenuSeparator />}
        {onAsk && <DropdownMenuItem onSelect={onAsk}>{C.ask}</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
