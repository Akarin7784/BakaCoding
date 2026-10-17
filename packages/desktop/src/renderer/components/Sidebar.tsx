import { Hash, Inbox } from "lucide-react";
import { cn } from "../lib/utils";
import { AgentIcon } from "./AgentIcon";
import { Separator } from "./ui/separator";
import type { ProjectView } from "../mock/types";

export type Selection =
  { kind: "supervisor" } | { kind: "project"; projectId: string } | { kind: "unattributed" };

export function ConversationList({
  projects,
  unattributedCount = 0,
  selection,
  onSelect,
}: {
  projects: ProjectView[];
  /** 未归属上报的条数；为 0 时不显示这一项。 */
  unattributedCount?: number;
  selection: Selection;
  onSelect: (s: Selection) => void;
}) {
  const item =
    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted";
  return (
    <nav
      aria-label="对话列表"
      className="flex w-56 shrink-0 flex-col gap-1 border-r border-border bg-sidebar p-2"
    >
      <button
        className={cn(item, selection.kind === "supervisor" && "bg-muted")}
        onClick={() => onSelect({ kind: "supervisor" })}
      >
        <AgentIcon supervisor />
        主管
      </button>
      <Separator className="my-2" />
      <div className="px-2 text-xs text-muted-foreground">项目群</div>
      {projects.map((p) => {
        const id = p.project.payload.project_id;
        const active = selection.kind === "project" && selection.projectId === id;
        return (
          <button
            key={id}
            className={cn(item, active && "bg-muted")}
            onClick={() => onSelect({ kind: "project", projectId: id })}
          >
            <Hash size={16} strokeWidth={1.5} aria-hidden />
            {p.project.payload.name}
          </button>
        );
      })}
      {unattributedCount > 0 && (
        <button
          className={cn(item, selection.kind === "unattributed" && "bg-muted")}
          onClick={() => onSelect({ kind: "unattributed" })}
        >
          <Inbox size={16} strokeWidth={1.5} aria-hidden />
          <span className="flex-1">未归属</span>
          <span className="text-xs text-muted-foreground">{unattributedCount}</span>
        </button>
      )}
    </nav>
  );
}
