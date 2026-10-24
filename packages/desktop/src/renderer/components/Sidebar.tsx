// UI-02 左栏（docs/ui-design.md §2）：260px，可收起到 56px（只剩图标）；窗口窄于 1024 自动收起。
// 顶部是拖拽区 + 收起按钮；[新需求]、主管、项目列表；底部设置 + 全局状态点（UI-08，§4.8）。
// 原「未归属」入口并进状态卡（UI-08）。项目展开显示需求列表留给 UI-05e。
// UI-05d：需要你处理（高风险待裁决 / 有单上报）的项目行带红点；需求列表上线后（05e）同一套集合标到需求行。
import type { ReactNode } from "react";
import { FolderGit2, PanelLeft, Plus, Settings } from "lucide-react";
import { cn } from "../lib/utils";
import { LAYOUT } from "../lib/layout";
import { SHORTCUT_LABEL } from "../lib/shortcuts";
import { HIGH_RISK_CARD_COPY } from "../lib/copy";
import { AgentIcon } from "./AgentIcon";
import { Separator } from "./ui/separator";
import type { ProjectView } from "../mock/types";

export type Selection =
  { kind: "supervisor" } | { kind: "project"; projectId: string } | { kind: "unattributed" };

export interface SidebarProps {
  projects: ProjectView[];
  selection: Selection;
  onSelect: (s: Selection) => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  onNewRequirement?: () => void;
  onOpenSettings?: () => void;
  /** macOS 红绿灯占的左侧宽度 */
  insetLeft?: number;
  /** 底部齿轮旁的全局状态点（UI-08） */
  status?: ReactNode;
  /** UI-05d：需要你处理的项目 id（项目行红点） */
  attention?: ReadonlySet<string>;
}

export function ConversationList({
  projects,
  selection,
  onSelect,
  collapsed = false,
  onToggleCollapsed,
  onNewRequirement,
  onOpenSettings,
  insetLeft = 0,
  status,
  attention,
}: SidebarProps) {
  const item = cn(
    "app-no-drag flex h-8 w-full items-center gap-2 rounded-md text-left text-sm transition-colors hover:bg-hover",
    collapsed ? "justify-center px-0" : "px-2",
  );
  const active = "bg-hover font-medium [&_svg]:text-accent";
  /** 收起时文字只给读屏和悬停提示 */
  const label = (text: string) => (collapsed ? <span className="sr-only">{text}</span> : text);

  return (
    <nav
      aria-label="对话列表"
      data-collapsed={collapsed}
      style={{ width: collapsed ? LAYOUT.sidebarCollapsedWidth : LAYOUT.sidebarWidth }}
      className="flex h-full shrink-0 flex-col border-r border-border bg-sidebar transition-[width] duration-200 ease-out"
    >
      <div
        data-testid="sidebar-drag"
        className={cn(
          "app-drag flex h-10 shrink-0 items-center gap-2",
          collapsed ? "justify-center" : "px-3",
        )}
        style={insetLeft && !collapsed ? { paddingLeft: insetLeft } : undefined}
      >
        {!collapsed && <span className="flex-1 truncate text-sm font-semibold">BakaCoding</span>}
        {onToggleCollapsed && (
          <button
            type="button"
            aria-label={collapsed ? "展开左栏" : "收起左栏"}
            aria-expanded={!collapsed}
            title={`${collapsed ? "展开左栏" : "收起左栏"}（${SHORTCUT_LABEL.toggleSidebar}）`}
            onClick={onToggleCollapsed}
            className="app-no-drag inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <PanelLeft size={16} strokeWidth={1.5} aria-hidden />
          </button>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2">
        {onNewRequirement && (
          <button
            type="button"
            className={cn(item, "mb-1 bg-secondary hover:bg-secondary-hover")}
            aria-label="新需求"
            title={`新需求（${SHORTCUT_LABEL.newRequirement}）`}
            onClick={onNewRequirement}
          >
            <Plus size={16} strokeWidth={1.5} aria-hidden />
            {label("新需求")}
          </button>
        )}
        <button
          type="button"
          className={cn(item, selection.kind === "supervisor" && active)}
          aria-current={selection.kind === "supervisor" ? "page" : undefined}
          title={collapsed ? "主管" : undefined}
          onClick={() => onSelect({ kind: "supervisor" })}
        >
          <AgentIcon supervisor />
          {label("主管")}
        </button>
        <Separator className="my-2" />
        {!collapsed && <div className="px-2 pb-1 text-xs text-muted-foreground">项目</div>}
        {projects.map((p) => {
          const id = p.project.payload.project_id;
          const on = selection.kind === "project" && selection.projectId === id;
          const name = p.project.payload.name;
          const dot = attention?.has(id) ?? false;
          return (
            <button
              type="button"
              key={id}
              className={cn(item, on && active)}
              aria-current={on ? "page" : undefined}
              title={collapsed ? name : undefined}
              onClick={() => onSelect({ kind: "project", projectId: id })}
            >
              <span className="relative inline-flex">
                <FolderGit2 size={16} strokeWidth={1.5} aria-hidden />
                {dot && collapsed && (
                  <span
                    data-testid="attention-dot"
                    aria-hidden
                    className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-danger"
                  />
                )}
              </span>
              {collapsed ? (
                <span className="sr-only">{name}</span>
              ) : (
                <span className="flex-1 truncate">{name}</span>
              )}
              {dot && !collapsed && (
                <span
                  data-testid="attention-dot"
                  aria-hidden
                  className="size-2 shrink-0 rounded-full bg-danger"
                />
              )}
              {dot && <span className="sr-only">（{HIGH_RISK_CARD_COPY.attentionDot}）</span>}
            </button>
          );
        })}
      </div>
      {(onOpenSettings || status) && (
        <div
          className={cn(
            "flex shrink-0 gap-1 border-t border-border p-2",
            collapsed ? "flex-col items-center" : "items-center",
          )}
        >
          {onOpenSettings && (
            <button
              type="button"
              className={cn(item, !collapsed && "flex-1")}
              aria-label="设置"
              title={`设置（${SHORTCUT_LABEL.settings}）`}
              onClick={onOpenSettings}
            >
              <Settings size={16} strokeWidth={1.5} aria-hidden />
              {label("设置")}
            </button>
          )}
          {status}
        </div>
      )}
    </nav>
  );
}

export { ConversationList as Sidebar };
