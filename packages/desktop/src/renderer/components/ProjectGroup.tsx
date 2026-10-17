import { ChevronDown, ChevronRight, PanelRight } from "lucide-react";
import { AgentIcon } from "./AgentIcon";
import { Button } from "./ui/button";
import { EscalationItem, TicketWarningList } from "./Escalations";
import { GROUP_MESSAGE_KIND_LABEL } from "../lib/copy";
import type { FlashCallSummary, GroupMessageEvent, ProjectView } from "../mock/types";

function FlashCalls({ ids, calls }: { ids: string[]; calls: Record<string, FlashCallSummary> }) {
  if (ids.length === 0) return null;
  // <details> 默认折叠
  return (
    <details className="mt-1 text-xs text-muted-foreground" data-testid="flash-calls">
      <summary className="cursor-pointer select-none">Flash 调用 {ids.length} 次</summary>
      <ul className="mt-1 space-y-1 border-l border-border pl-3">
        {ids.map((id) => {
          const c = calls[id];
          return (
            <li key={id}>
              {c
                ? `${c.model} · ${c.effort} · ${c.latency_ms} ms · 输入 ${c.tokens.input}（缓存命中 ${c.tokens.cache_hit_input}）· 输出 ${c.tokens.output}：${c.output}`
                : id}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

function Message({ m, calls }: { m: GroupMessageEvent; calls: Record<string, FlashCallSummary> }) {
  return (
    <div className="flex gap-2 text-sm">
      <AgentIcon supervisor={m.payload.sender === "supervisor"} />
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">
          {m.payload.sender === "supervisor" ? "主管" : `副 Agent ${m.ticket_id ?? ""}`} ·{" "}
          {GROUP_MESSAGE_KIND_LABEL[m.payload.kind]}
        </div>
        <p>{m.payload.content}</p>
        <FlashCalls ids={m.payload.flash_calls} calls={calls} />
      </div>
    </div>
  );
}

/** 项目群：只读，没有输入框；按需求分成可折叠话题。 */
export function ProjectGroup({
  view,
  calls,
  sidebarOpen,
  onToggleSidebar,
  readonly = false,
}: {
  view: ProjectView;
  calls: Record<string, FlashCallSummary>;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  /** 后端只读时显示「只读」标签（T-077） */
  readonly?: boolean;
}) {
  return (
    <section aria-label="项目群" className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2">
        <span className="flex-1 text-sm font-medium"># {view.project.payload.name}</span>
        {readonly && (
          <span className="text-xs text-muted-foreground" data-testid="readonly-tag">
            只读
          </span>
        )}
        <Button
          variant="secondary"
          size="icon"
          aria-label={sidebarOpen ? "关闭侧边栏" : "打开侧边栏"}
          aria-pressed={sidebarOpen}
          onClick={onToggleSidebar}
        >
          <PanelRight strokeWidth={1.5} />
        </Button>
      </header>
      {view.escalations.length > 0 && (
        <ul
          role="alert"
          aria-label="需要人工介入"
          className="border-b border-border px-4 py-2 text-sm"
        >
          {view.escalations.map((e) => (
            <EscalationItem key={e.event_id} e={e} />
          ))}
        </ul>
      )}
      <TicketWarningList warnings={view.warnings} />
      <div className="flex-1 overflow-y-auto px-4 py-2">
        {view.requirements.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">还没有需求</p>
        )}
        {view.requirements.map((r) => (
          <details
            key={r.requirement_id}
            id={`topic-${r.requirement_id}`}
            open
            className="group border-b border-border py-2"
          >
            <summary className="flex cursor-pointer select-none items-center gap-1 text-sm font-medium [&::-webkit-details-marker]:hidden">
              <ChevronRight size={14} className="group-open:hidden" aria-hidden />
              <ChevronDown size={14} className="hidden group-open:inline" aria-hidden />
              {r.title}
            </summary>
            <div className="mt-2 space-y-3 pl-5">
              {view.messages
                .filter((m) => m.requirement_id === r.requirement_id)
                .map((m) => (
                  <Message key={m.event_id} m={m} calls={calls} />
                ))}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
