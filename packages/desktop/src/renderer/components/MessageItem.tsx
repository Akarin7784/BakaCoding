// UI-04c：主管回复按 ChatReply.kind 呈现（docs/ui-design.md §4.2）。实时回复和历史记录走同一个组件。
// answer 普通文本；ask_project 下方一排项目按钮；decision_saved「已记下」小标签；
// dispatched「已派单」卡片（需求、拆出 N 张单、「查看需求」跳到需求页（UI-05f））；split_failed「重试拆单」。
import { Check, ClipboardList, FolderGit2, RotateCcw } from "lucide-react";
import type { ChatReply, DesktopProjectRow } from "../../shared/api";
import { CHAT_COPY, REQUIREMENT_MENU_COPY } from "../lib/copy";
import { cn } from "../lib/utils";
import { AgentIcon } from "./AgentIcon";
import { Button } from "./ui/button";

function assertNever(x: never): never {
  throw new Error(`未知的主管回复类型：${String(x)}`);
}

export interface MessageItemProps {
  reply: ChatReply;
  /** ask_project 的项目按钮（来自 project:list） */
  projects?: readonly Pick<DesktopProjectRow, "project_id" | "name">[];
  /** 等待中 / 只读：按钮禁用 */
  disabled?: boolean;
  /** ask_project：点项目按钮等于回复（带 project_id 重发） */
  onPickProject?: (project: Pick<DesktopProjectRow, "project_id" | "name">) => void;
  /** split_failed：重试拆单；不给（找不到原需求 / 没有项目）就不显示按钮 */
  onRetrySplit?: () => void;
  /** UI-05f：dispatched「查看需求」；不给或没有需求号就不显示按钮 */
  onOpenRequirement?: (requirement_id: string) => void;
}

export function MessageItem({
  reply,
  projects = [],
  disabled = false,
  onPickProject,
  onRetrySplit,
  onOpenRequirement,
}: MessageItemProps) {
  return (
    <div data-testid="chat-reply" data-kind={reply.kind} className="flex gap-2 text-sm">
      <AgentIcon supervisor />
      <div className="min-w-0 flex-1 space-y-2">
        <p className="whitespace-pre-wrap">{reply.text}</p>
        <KindExtra
          reply={reply}
          projects={projects}
          disabled={disabled}
          onPickProject={onPickProject}
          onRetrySplit={onRetrySplit}
          onOpenRequirement={onOpenRequirement}
        />
      </div>
    </div>
  );
}

function KindExtra({
  reply,
  projects,
  disabled,
  onPickProject,
  onRetrySplit,
  onOpenRequirement,
}: Required<Pick<MessageItemProps, "reply" | "projects" | "disabled">> &
  Pick<MessageItemProps, "onPickProject" | "onRetrySplit" | "onOpenRequirement">) {
  switch (reply.kind) {
    case "answer":
      return null;
    case "ask_project":
      if (projects.length === 0 || !onPickProject) return null;
      return (
        <div
          role="group"
          aria-label={CHAT_COPY.pickProject}
          data-testid="chat-projects"
          className="flex flex-wrap gap-1.5"
        >
          {projects.map((p) => (
            <Button
              key={p.project_id}
              variant="secondary"
              size="sm"
              data-project-id={p.project_id}
              disabled={disabled}
              onClick={() => onPickProject(p)}
            >
              <FolderGit2 strokeWidth={1.5} />
              {p.name}
            </Button>
          ))}
        </div>
      );
    case "decision_saved":
      return (
        <span
          data-testid="chat-decision-tag"
          className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground"
        >
          <Check className="size-3" strokeWidth={1.5} />
          {CHAT_COPY.decisionSaved}
        </span>
      );
    case "dispatched": {
      const ids = reply.ticket_ids ?? [];
      return (
        <div
          data-testid="chat-dispatched"
          className="max-w-md space-y-1 rounded-xl border border-border px-3 py-2.5"
        >
          <div className="flex items-center gap-1.5 text-xs font-medium">
            <ClipboardList className="size-3.5 text-muted-foreground" strokeWidth={1.5} />
            {CHAT_COPY.dispatched}
          </div>
          {reply.requirement_id && (
            <p className="text-xs text-muted-foreground" data-testid="chat-requirement">
              {CHAT_COPY.requirement} {reply.requirement_id}
            </p>
          )}
          <p className="text-xs">{CHAT_COPY.ticketCount(ids.length)}</p>
          {ids.length > 0 && (
            <p className="text-xs text-muted-foreground" data-testid="chat-tickets">
              {CHAT_COPY.ticketList}
              {ids.join("、")}
            </p>
          )}
          {reply.requirement_id && onOpenRequirement && (
            <Button
              variant="secondary"
              size="sm"
              data-testid="chat-view-requirement"
              onClick={() => onOpenRequirement(reply.requirement_id!)}
            >
              {REQUIREMENT_MENU_COPY.viewRequirement}
            </Button>
          )}
        </div>
      );
    }
    case "split_failed":
      if (!onRetrySplit) return null;
      return (
        <Button
          variant="secondary"
          size="sm"
          data-testid="chat-retry-split"
          disabled={disabled}
          onClick={onRetrySplit}
        >
          <RotateCcw strokeWidth={1.5} />
          {CHAT_COPY.retrySplit}
        </Button>
      );
    default:
      return assertNever(reply.kind);
  }
}

/** 等待回复：三个点淡入淡出（减少动态效果时由全局规则停住）。 */
export function WaitingDots() {
  return (
    <div
      role="status"
      aria-label={CHAT_COPY.waiting}
      data-testid="chat-pending"
      className="flex items-center gap-2 py-1"
    >
      <AgentIcon supervisor />
      <span className="flex gap-1" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={cn("size-1.5 animate-breathe rounded-full bg-muted-foreground")}
            style={{ animationDelay: `${i * 200}ms`, animationDuration: "1.2s" }}
          />
        ))}
      </span>
    </div>
  );
}

/** 空状态：一句引导 + 三个示例（点一下只填进输入框，不发送）。 */
export function ChatEmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div data-testid="chat-empty" className="flex flex-col items-center gap-3 py-16 text-center">
      <AgentIcon supervisor />
      <p className="text-sm font-medium">{CHAT_COPY.emptyTitle}</p>
      <p className="text-xs text-muted-foreground">{CHAT_COPY.emptyHint}</p>
      <div className="flex w-full max-w-md flex-col gap-1.5">
        {CHAT_COPY.examples.map((t) => (
          <button
            key={t}
            type="button"
            data-testid="chat-example"
            className="rounded-xl border border-border px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
            onClick={() => onPick(t)}
          >
            {t}
          </button>
        ))}
      </div>
    </div>
  );
}
