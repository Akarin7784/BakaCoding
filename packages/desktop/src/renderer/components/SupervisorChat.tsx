import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AlertCircle, Download, FolderOpen, Loader2, Send, Settings } from "lucide-react";
import type { BakaDesktopApi, DesktopSupervisorMessage } from "../../shared/api";
import {
  CHAT_HISTORY_PAGE,
  replyMessageId,
  storedReply,
  supervisorChatStore,
  type ChatItem,
  type ChatStore,
} from "../data/chatStore";
import { chatFailureText, chatReplyView, type ChatTone } from "../lib/chat-labels";
import { cn } from "../lib/utils";
import { CONTENT_COLUMN } from "../lib/layout";
import { AgentIcon } from "./AgentIcon";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { READONLY_COPY } from "../lib/readonly";

const TONE_CLASS: Record<ChatTone, string> = {
  normal: "text-muted-foreground",
  ask: "text-foreground",
  ok: "text-foreground",
  error: "font-medium text-danger",
};

export interface SupervisorChatProps {
  /** 没有 getSupervisorHistory 时（假数据 / 测试）首屏放入的消息（UI-04a：存储形状） */
  initial?: readonly DesktopSupervisorMessage[];
  /**
   * 有 api 时发到 10 的 chat()（T-071）；没有（假数据 / 测试）只追加到本地。
   * UI-04a：有 getSupervisorHistory 时首屏取 50 条历史，往上滚到顶再取 50 条。
   */
  api?:
    | (Pick<BakaDesktopApi, "supervisorChat"> &
        Partial<Pick<BakaDesktopApi, "getSupervisorHistory">>)
    | undefined;
  /** 界面当前选中的项目；有就随消息传给主管 */
  projectId?: string | undefined;
  /** 对话记录（默认整个窗口共用一份，组件卸载不丢）；测试注入新的 */
  store?: ChatStore;
  /** 选中项目时嵌在群聊下方：不显示顶栏 */
  compact?: boolean;
  /** UI-02：放进新布局时标题和按钮在外层标题栏里，这里不再画顶栏 */
  showHeader?: boolean;
  /** 导入项目（T-072）；没有就不显示按钮 */
  onImport?: () => void;
  /** 打开只读设置页（T-072） */
  onOpenSettings?: () => void;
  /** 导出诊断包（T-072） */
  onExport?: () => void;
  /** 导入 / 导出进行中：对应按钮禁用 */
  busy?: "import" | "export" | null;
  /** 后端只读（UI-08，§4.7）：输入框和发送禁用 */
  readonly?: boolean;
}

/** 主管 1:1：唯一可输入的地方。一次只发一条（chat 有状态），等上一条回来才能再发。 */
export function SupervisorChat({
  initial,
  api,
  projectId,
  store = supervisorChatStore,
  compact = false,
  showHeader = true,
  onImport,
  onOpenSettings,
  onExport,
  busy = null,
  readonly = false,
}: SupervisorChatProps) {
  const getHistory = api?.getSupervisorHistory;
  useEffect(() => {
    if (store.isHydrated) return;
    if (!getHistory) {
      store.hydrate(initial ?? []);
      return;
    }
    let live = true;
    getHistory({ limit: CHAT_HISTORY_PAGE }).then(
      (r) => {
        if (live && r.ok) store.hydrate(r.messages);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [store, initial, getHistory]);
  const { items: messages, pending } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el || el.scrollTop > 0 || !getHistory) return;
    void store.loadOlder((before) => getHistory({ before, limit: CHAT_HISTORY_PAGE }));
  };

  /** 发一条；message_id 由界面生成，重试时传回同一个（10 / 2 按 message_id 幂等）。 */
  const deliver = async (text: string, message_id: string, project_id?: string) => {
    store.append({
      message_id,
      project_id: project_id ?? null,
      role: "user",
      kind: null,
      content: text,
      requirement_id: null,
      ticket_ids: [],
      created_at: Date.now(),
    });
    if (!api?.supervisorChat) return;
    if (!store.begin()) return;
    let item: ChatItem;
    const retry = { message_id, text, ...(project_id && { project_id }) };
    try {
      const r = await api.supervisorChat({ text, message_id, ...(project_id && { project_id }) });
      item = r.ok
        ? {
            message_id: replyMessageId(message_id),
            project_id: r.reply.project_id ?? null,
            role: "supervisor",
            kind: r.reply.kind,
            content: r.reply.text,
            requirement_id: r.reply.requirement_id ?? null,
            ticket_ids: [...(r.reply.ticket_ids ?? [])],
            created_at: Date.now(),
            reply: r.reply,
          }
        : {
            message_id: `${message_id}-e`,
            role: "system",
            failed: chatFailureText(r.reason),
            created_at: Date.now(),
            retry,
          };
    } catch {
      // IPC 本身被拒：错误对象可能带主进程路径等，不原样显示
      item = {
        message_id: `${message_id}-e`,
        role: "system",
        failed: chatFailureText("和主进程通信失败，请重试"),
        created_at: Date.now(),
        retry,
      };
    } finally {
      store.end();
    }
    store.append(item);
  };

  const send = async () => {
    const text = draft.trim();
    // 等待状态在 store 里：组件卸载重挂也挡得住重复发送（主进程另有串行）
    if (readonly || !text || store.getSnapshot().pending) return;
    setDraft("");
    await deliver(text, store.newMessageId(), projectId);
  };

  return (
    <section
      aria-label="主管对话"
      className={cn(
        "flex min-w-0 flex-col",
        compact ? "h-64 shrink-0 border-t border-border" : "flex-1",
      )}
    >
      {!compact && showHeader && (
        <header className="flex items-center gap-2 border-b border-border px-4 py-2">
          <AgentIcon supervisor />
          <span className="flex-1 text-sm font-medium">主管</span>
          {onImport && (
            <Button
              variant="secondary"
              size="sm"
              aria-label="导入项目"
              disabled={busy !== null}
              onClick={onImport}
            >
              <FolderOpen strokeWidth={1.5} />
              {busy === "import" ? "导入中…" : "导入项目"}
            </Button>
          )}
          <Button variant="secondary" size="sm" aria-label="设置" onClick={onOpenSettings}>
            <Settings strokeWidth={1.5} />
            设置
          </Button>
          <Button
            variant="secondary"
            size="sm"
            aria-label="导出诊断包"
            disabled={busy !== null}
            onClick={onExport}
          >
            <Download strokeWidth={1.5} />
            {busy === "export" ? "导出中…" : "导出"}
          </Button>
        </header>
      )}
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto px-4 py-4">
        <div className={cn(CONTENT_COLUMN, "space-y-4")}>
          {messages.map((m) => {
            if (m.failed !== undefined) {
              return (
                <div key={m.message_id} className="flex items-start gap-2">
                  <div
                    role="alert"
                    data-testid="chat-error"
                    className="flex gap-2 text-sm text-danger"
                  >
                    <AlertCircle className="mt-0.5 size-4 shrink-0" strokeWidth={1.5} />
                    <p className="whitespace-pre-wrap">{m.failed}</p>
                  </div>
                  {m.retry && (
                    <button
                      type="button"
                      data-testid="chat-retry"
                      className="shrink-0 text-xs text-muted-foreground underline"
                      disabled={pending || readonly}
                      onClick={() => {
                        const r = m.retry!;
                        store.remove(m.message_id);
                        void deliver(r.text, r.message_id, r.project_id);
                      }}
                    >
                      重试
                    </button>
                  )}
                </div>
              );
            }
            if (m.role === "supervisor") {
              const v = chatReplyView(m.reply ?? storedReply(m));
              return (
                <div
                  key={m.message_id}
                  data-testid="chat-reply"
                  data-kind={v.kind}
                  className="flex gap-2 text-sm"
                >
                  <AgentIcon supervisor />
                  <div className="min-w-0 space-y-1">
                    <span className={cn("text-xs", TONE_CLASS[v.tone])}>{v.label}</span>
                    <p className={cn("whitespace-pre-wrap", v.tone === "error" && "text-danger")}>
                      {v.text}
                    </p>
                    {v.ticketIds.length > 0 && (
                      <p className="text-xs text-muted-foreground" data-testid="chat-tickets">
                        单号：{v.ticketIds.join("、")}
                      </p>
                    )}
                  </div>
                </div>
              );
            }
            return (
              <div key={m.message_id} className="flex gap-2 text-sm">
                <span className="w-[18px] text-xs text-muted-foreground">我</span>
                <p className="whitespace-pre-wrap">{m.content}</p>
              </div>
            );
          })}
          {pending && (
            <div
              role="status"
              data-testid="chat-pending"
              className="flex items-center gap-2 text-xs text-muted-foreground"
            >
              <Loader2 className="size-3 animate-spin" strokeWidth={1.5} />
              主管思考中…
            </div>
          )}
        </div>
      </div>
      <div className="border-t border-border p-3">
        <div className={cn(CONTENT_COLUMN, "flex items-end gap-2")}>
          <Textarea
            aria-label="发给主管"
            data-composer={compact ? "compact" : "supervisor"}
            rows={2}
            placeholder={
              readonly ? READONLY_COPY.composerPlaceholder : "提需求或人工介入，说清是哪个项目"
            }
            disabled={readonly}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <Button
            size="icon"
            aria-label="发送"
            title={readonly ? READONLY_COPY.composerPlaceholder : undefined}
            disabled={pending || readonly}
            onClick={() => void send()}
          >
            <Send strokeWidth={1.5} />
          </Button>
        </div>
      </div>
    </section>
  );
}
