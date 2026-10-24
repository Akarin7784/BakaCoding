// UI-02 内容区标题栏（§2）：自绘拖拽区，高 40；标题 + 操作按钮 + 右面板开关。
// Windows / Linux 右上角是系统画的最小化 / 最大化 / 关闭（titleBarOverlay），用 insetRight 让出位置。
import { PanelRight } from "lucide-react";
import type { ReactNode } from "react";
import { SHORTCUT_LABEL } from "../lib/shortcuts";
import { ActivityDot } from "./ActivityDot";
import { RIGHT_PANEL_TOGGLE_ID } from "./RightPanelShell";

export function TitleBar({
  title,
  actions,
  rightPanelOpen,
  onToggleRightPanel,
  rightPanelDot = false,
  insetRight = 0,
}: {
  title: ReactNode;
  actions?: ReactNode;
  rightPanelOpen: boolean;
  onToggleRightPanel: () => void;
  /** 面板关着时动态来了新消息：开关上亮一个小点（§4.5.1，T-127） */
  rightPanelDot?: boolean;
  insetRight?: number;
}) {
  const label = rightPanelOpen ? "关闭右面板" : "打开右面板";
  return (
    <header
      data-testid="title-bar"
      className="app-drag flex h-10 shrink-0 items-center gap-2 border-b border-border pl-4"
      style={{ paddingRight: 8 + insetRight }}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium">{title}</div>
      {actions && <div className="app-no-drag flex items-center gap-1">{actions}</div>}
      <button
        type="button"
        aria-label={label}
        id={RIGHT_PANEL_TOGGLE_ID}
        data-testid="right-panel-toggle"
        aria-pressed={rightPanelOpen}
        title={`${label}（${SHORTCUT_LABEL.toggleRightPanel}）`}
        onClick={onToggleRightPanel}
        className="app-no-drag relative inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none aria-pressed:text-accent"
      >
        <PanelRight size={16} strokeWidth={1.5} aria-hidden />
        {rightPanelDot && (
          <ActivityDot testId="right-panel-dot" className="absolute top-1 right-1" />
        )}
      </button>
    </header>
  );
}
