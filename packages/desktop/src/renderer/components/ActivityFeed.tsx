// 右面板「动态」标签（§4.5.1，T-127）：只显示 Agent 之间互相发的消息。
// 数据：现有 group_message 事件（快照里按 seq 升序，不新增后端接口）。
// 每条：头像、发送方 → 接收方、时间、类型标签、正文（超过 3 行折叠）；
// 最新在底部自动滚到底，用户上翻后停止自动滚并给「回到最新」；右上角可按单过滤；底部一行当前状态。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, ChevronDown } from "lucide-react";
import type { ProjectView } from "../mock/types";
import { ACTIVITY_COPY } from "../lib/copy";
import {
  activeTicketLine,
  activityFilterOptions,
  activityItems,
  effectiveTicketFilter,
  filterActivity,
  isNearBottom,
} from "../lib/activity";
import { AgentIcon } from "./AgentIcon";
import { EmptyState } from "./EmptyState";
import { Button } from "./ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

/** 正文超过这个长度才给「展开 / 收起」（设计写的是 3 行，jsdom 量不到行高，用长度近似）。 */
export const ACTIVITY_COLLAPSE_CHARS = 120;

export function ActivityFeed({ project }: { project?: ProjectView }) {
  const [ticketFilter, setTicketFilter] = useState("all");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [atBottom, setAtBottom] = useState(true);
  const listRef = useRef<HTMLDivElement | null>(null);

  const items = useMemo(() => activityItems(project), [project]);
  const tickets = useMemo(() => activityFilterOptions(project), [project]);
  // 切项目重置按单筛选（T-127 评审 P2）：旧单号在新项目里可能不存在
  const projectId = project?.project.payload.project_id;
  useEffect(() => setTicketFilter("all"), [projectId]);
  // 防御：选项里确实没有该单号时也按「全部」显示，Select 和列表保持一致
  const activeFilter = effectiveTicketFilter(ticketFilter, tickets);
  const shown = useMemo(() => filterActivity(items, activeFilter), [items, activeFilter]);
  const statusLine = useMemo(() => activeTicketLine(project), [project]);

  const stickToBottom = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setAtBottom(true);
  }, []);

  // 新消息 / 换筛选时，原本就贴着底部才自动滚到底（用户上翻时不打断）
  useEffect(() => {
    if (atBottom) stickToBottom();
  }, [shown.length, activeFilter, atBottom, stickToBottom]);

  const toggleExpanded = (event_id: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(event_id)) next.delete(event_id);
      else next.add(event_id);
      return next;
    });

  if (!project) return <EmptyState title={ACTIVITY_COPY.noProject} />;

  return (
    <div data-testid="activity-feed" className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-xs text-muted-foreground">{ACTIVITY_COPY.filterLabel}</span>
        <Select value={activeFilter} onValueChange={setTicketFilter}>
          <SelectTrigger
            aria-label={ACTIVITY_COPY.filterLabel}
            className="h-7 w-32 text-xs"
            data-testid="activity-filter"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{ACTIVITY_COPY.filterAll}</SelectItem>
            {tickets.map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div
        ref={listRef}
        data-testid="activity-list"
        onScroll={(e) => {
          const el = e.currentTarget;
          setAtBottom(isNearBottom(el));
        }}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-2"
      >
        {shown.length === 0 ? (
          <EmptyState icon={Activity} title={ACTIVITY_COPY.empty} />
        ) : (
          <ul className="space-y-3">
            {shown.map((m) => {
              const isExpanded = expanded.has(m.event_id);
              const collapsible = m.content.length > ACTIVITY_COLLAPSE_CHARS;
              return (
                <li key={m.event_id} data-testid="activity-item" className="flex gap-2 text-sm">
                  <AgentIcon supervisor={m.supervisorSender} />
                  <div className="min-w-0">
                    <div className="text-xs text-muted-foreground">
                      {m.sender} → {m.receiver} · {m.kindLabel} ·{" "}
                      <span data-testid="activity-time">{m.time}</span>
                    </div>
                    <p
                      data-testid="activity-content"
                      className={isExpanded ? "break-words whitespace-pre-wrap" : "line-clamp-3"}
                    >
                      {m.content}
                    </p>
                    {collapsible && (
                      <button
                        type="button"
                        data-testid="activity-expand"
                        onClick={() => toggleExpanded(m.event_id)}
                        className="mt-0.5 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                      >
                        {isExpanded ? ACTIVITY_COPY.collapse : ACTIVITY_COPY.expand}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {!atBottom && (
          <div className="sticky bottom-1 flex justify-center">
            <Button
              variant="secondary"
              size="sm"
              data-testid="activity-back-to-latest"
              onClick={stickToBottom}
            >
              <ChevronDown strokeWidth={1.5} />
              {ACTIVITY_COPY.backToLatest}
            </Button>
          </div>
        )}
      </div>
      <div
        data-testid="activity-status"
        className="shrink-0 border-t border-border px-3 py-2 text-xs text-muted-foreground"
      >
        {statusLine || ACTIVITY_COPY.idle}
      </div>
    </div>
  );
}
