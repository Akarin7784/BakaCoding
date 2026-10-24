import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AlertCircle, Download, FolderOpen, Settings } from "lucide-react";
import type { BakaDesktopApi, DesktopProjectRow, DesktopSupervisorMessage } from "../../shared/api";
import {
  CHAT_HISTORY_PAGE,
  answeredUserMessage,
  storedReply,
  supervisorChatStore,
  type ChatItem,
  type ChatStore,
} from "../data/chatStore";
import { chatFailureText, splitFailureText } from "../lib/chat-labels";
import { CHAT_COPY } from "../lib/copy";
import { cn } from "../lib/utils";
import { CONTENT_COLUMN } from "../lib/layout";
import { AgentIcon } from "./AgentIcon";
import { Button } from "./ui/button";
import { READONLY_COPY } from "../lib/readonly";
import { readLastProject, writeLastProject } from "../lib/lastProject";
import { Composer } from "./Composer";
import { ChatEmptyState, MessageItem, WaitingDots } from "./MessageItem";

export interface SupervisorChatProps {
  /** 没有 getSupervisorHistory 时（假数据 / 测试）首屏放入的消息（UI-04a：存储形状） */
  initial?: readonly DesktopSupervisorMessage[];
  /**
   * 有 api 时发到 10 的 chat()（T-071）；没有（假数据 / 测试）只追加到本地。
   * UI-04a：有 getSupervisorHistory 时首屏取 50 条历史，往上滚到顶再取 50 条。
   */
  api?:
    | (Pick<BakaDesktopApi, "supervisorChat"> &
        Partial<Pick<BakaDesktopApi, "getSupervisorHistory" | "listProjects" | "supervisorSplit">>)
    | undefined;
  /**
   * 界面当前选中的项目：有就作为 chip 的默认值（UI-04b）；没有就用上次用的项目（localStorage）。
   * 最终随消息传给主管的是 chip 上选中的项目，「不指定」不传。
   */
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
  /** UI-05f：「已派单」卡片「查看需求」 */
  onOpenRequirement?: (requirement_id: string) => void;
  /** UI-05f：从需求页追问 / 需要你处理带回的草稿（只填输入框，不发送）；用过后回调 onPrefillUsed */
  /** UI-05g：dispatched 卡片显示需求名（同项目页规则）；不给或取不到就显示需求号 */
  requirementNameOf?: (requirement_id: string) => string;
  prefill?: string | null;
  onPrefillUsed?: () => void;
  /** UI-06a：输入框 chip 当前选中的项目（含初始值）变了就回调；右面板在主管对话里跟随它 */
  onChipProjectChange?: (projectId: string | undefined) => void;
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
  onOpenRequirement,
  requirementNameOf,
  prefill = null,
  onPrefillUsed,
  onChipProjectChange,
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
  useEffect(() => {
    if (prefill === null) return;
    setDraft(prefill);
    onPrefillUsed?.();
  }, [prefill, onPrefillUsed]);
  // UI-04b：项目 chip。默认 = 外层选中的项目 → 上次用的项目 → 不指定
  const [chipProject, setChipProject] = useState<string | undefined>(
    () => projectId ?? readLastProject(),
  );
  useEffect(() => {
    if (projectId !== undefined) setChipProject(projectId);
  }, [projectId]);
  useEffect(() => {
    onChipProjectChange?.(chipProject);
  }, [chipProject, onChipProjectChange]);
  const pickProject = (id: string | undefined) => {
    setChipProject(id);
    writeLastProject(id);
  };
  const listProjects = api?.listProjects;
  const [projectRows, setProjectRows] = useState<DesktopProjectRow[]>([]);
  useEffect(() => {
    if (!listProjects) return;
    let live = true;
    listProjects().then(
      (r) => {
        if (live && r.ok) setProjectRows(r.projects);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [listProjects]);
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
            // T-149：用 10 返回的回复自身 id（T-148）和历史去重，不假定 id 格式
            message_id: r.reply.message_id,
            project_id: r.reply.project_id ?? null,
            role: "supervisor",
            kind: r.reply.kind,
            content: r.reply.text,
            requirement_id: r.reply.requirement_id ?? null,
            ticket_ids: [...(r.reply.ticket_ids ?? [])],
            created_at: Date.now(),
            reply: r.reply,
            // UI-04c / T-151：回答的是哪条用户消息（与 10 落库的 in_reply_to 一致）
            in_reply_to: message_id,
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

  /**
   * UI-04c：重试拆单走 supervisor:split（10 的 split()），不经 chat。text 取这条回复所回答的用户消息原文，
   * requirement_id 有就原样传回。结果只在本地补一条（不落库）。
   */
  const retrySplit = async (
    replyId: string,
    req: { project_id: string; text: string; requirement_id?: string },
  ) => {
    const split = api?.supervisorSplit;
    if (!split || readonly || !store.begin()) return;
    let item: ChatItem;
    try {
      const r = await split(req);
      item = r.ok
        ? {
            message_id: store.newMessageId(),
            project_id: req.project_id,
            role: "supervisor",
            kind: "dispatched",
            content: CHAT_COPY.splitRetried(r.ticket_ids.length),
            requirement_id: r.requirement_id,
            ticket_ids: [...r.ticket_ids],
            created_at: Date.now(),
          }
        : {
            message_id: `${replyId}-split-e-${Date.now()}`,
            role: "system",
            failed: splitFailureText(r.reason),
            created_at: Date.now(),
          };
    } catch {
      item = {
        message_id: `${replyId}-split-e-${Date.now()}`,
        role: "system",
        failed: splitFailureText("和主进程通信失败，请重试"),
        created_at: Date.now(),
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
    writeLastProject(chipProject);
    await deliver(text, store.newMessageId(), chipProject);
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
                      className="shrink-0 text-xs text-danger hover:underline disabled:opacity-50"
                      disabled={pending || readonly}
                      onClick={() => {
                        const r = m.retry!;
                        store.remove(m.message_id);
                        void deliver(r.text, r.message_id, r.project_id);
                      }}
                    >
                      {CHAT_COPY.sendFailed} · {CHAT_COPY.retry}
                    </button>
                  )}
                </div>
              );
            }
            if (m.role === "supervisor") {
              const reply = m.reply ?? storedReply(m);
              const user =
                reply.kind === "split_failed" ? answeredUserMessage(messages, m) : undefined;
              const splitProject = reply.project_id ?? user?.project_id ?? undefined;
              return (
                <MessageItem
                  key={m.message_id}
                  reply={reply}
                  projects={projectRows}
                  disabled={pending || readonly}
                  {...(onOpenRequirement && { onOpenRequirement })}
                  {...(requirementNameOf && { requirementNameOf })}
                  onPickProject={(p) => {
                    if (readonly || store.getSnapshot().pending) return;
                    void deliver(p.name, store.newMessageId(), p.project_id);
                  }}
                  {...(user &&
                    splitProject &&
                    api?.supervisorSplit && {
                      onRetrySplit: () =>
                        void retrySplit(m.message_id, {
                          project_id: splitProject,
                          text: user.content,
                          ...(reply.requirement_id && { requirement_id: reply.requirement_id }),
                        }),
                    })}
                />
              );
            }
            return (
              <div key={m.message_id} className="flex gap-2 text-sm">
                <span className="w-[18px] text-xs text-muted-foreground">我</span>
                <p className="whitespace-pre-wrap">{m.content}</p>
              </div>
            );
          })}
          {pending && <WaitingDots />}
          {messages.length === 0 && !pending && <ChatEmptyState onPick={setDraft} />}
        </div>
      </div>
      <div className="px-4 pb-4 pt-2">
        <div className={CONTENT_COLUMN}>
          <Composer
            value={draft}
            onChange={setDraft}
            onSend={() => void send()}
            projects={projectRows}
            projectId={chipProject}
            onProjectChange={pickProject}
            readonly={readonly}
            pending={pending}
            composerId={compact ? "compact" : "supervisor"}
            {...(readonly && {
              placeholder: READONLY_COPY.composerPlaceholder,
              sendTitle: READONLY_COPY.composerPlaceholder,
            })}
          />
        </div>
      </div>
    </section>
  );
}
