// UI-02 右面板（§2、§4.5、§4.5.1）：360px，默认关闭；「概览 / 动态」两个标签。
// 窗口宽度 ≥ 1200 时停靠在右侧，< 1200 时改为覆盖式抽屉（点外面或 Esc 关闭）。
// 概览暂时放现有的编码池 / Git / PR 列表（UI-06 重做），动态是空壳（数据源与样式在后续单）。
import { Activity, X } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { cn } from "../lib/utils";
import { LAYOUT } from "../lib/layout";
import { EmptyState } from "./EmptyState";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

export type RightPanelTab = "overview" | "activity";

export function RightPanelShell({
  open,
  drawer,
  onClose,
  overview,
  tab,
  onTabChange,
  insetRight = 0,
}: {
  open: boolean;
  drawer: boolean;
  onClose: () => void;
  /** 概览标签内容；没有项目时为空 */
  overview: ReactNode;
  tab: RightPanelTab;
  onTabChange: (tab: RightPanelTab) => void;
  insetRight?: number;
}) {
  useEffect(() => {
    if (!open || !drawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    globalThis.window?.addEventListener("keydown", onKey);
    return () => globalThis.window?.removeEventListener("keydown", onKey);
  }, [open, drawer, onClose]);

  if (!open) return null;
  const panel = (
    <aside
      aria-label="右面板"
      data-mode={drawer ? "drawer" : "docked"}
      style={{ width: LAYOUT.rightPanelWidth }}
      className={cn(
        "flex h-full shrink-0 flex-col border-l border-border bg-sidebar text-sm",
        drawer
          ? "fixed inset-y-0 right-0 z-40 shadow-popover animate-slide-in-right"
          : "animate-fade-in",
      )}
    >
      <Tabs
        value={tab}
        onValueChange={(v) => onTabChange(v as RightPanelTab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div
          className="app-drag flex h-10 shrink-0 items-center gap-2 border-b border-border pl-3"
          style={{ paddingRight: 8 + insetRight }}
        >
          <TabsList aria-label="右面板标签" className="app-no-drag flex-1">
            <TabsTrigger value="overview">概览</TabsTrigger>
            <TabsTrigger value="activity">动态</TabsTrigger>
          </TabsList>
          <button
            type="button"
            aria-label="关闭右面板"
            onClick={onClose}
            className="app-no-drag inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <X size={16} strokeWidth={1.5} aria-hidden />
          </button>
        </div>
        <TabsContent value="overview" className="min-h-0 flex-1 overflow-y-auto">
          {overview ?? <EmptyState title="还没有项目" />}
        </TabsContent>
        <TabsContent value="activity" className="min-h-0 flex-1 overflow-y-auto">
          <EmptyState icon={Activity} title="还没有动态" />
        </TabsContent>
      </Tabs>
    </aside>
  );
  if (!drawer) return panel;
  return (
    <>
      <div
        data-testid="drawer-backdrop"
        aria-hidden
        className="fixed inset-0 z-30 bg-transparent"
        onClick={onClose}
      />
      {panel}
    </>
  );
}
