import { useEffect, useState, useSyncExternalStore } from "react";
import { AlertCircle, Download, FolderOpen, Loader2, Send, Settings } from "lucide-react";
import type { BakaDesktopApi } from "../../shared/api";
import { supervisorChatStore, type ChatItem, type ChatStore } from "../data/chatStore";
import { chatFailureText, chatReplyView, type ChatTone } from "../lib/chat-labels";
import { cn } from "../lib/utils";
import { AgentIcon } from "./AgentIcon";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import type { SupervisorMessage } from "../mock/types";

const TONE_CLASS: Record<ChatTone, string> = {
  normal: "text-muted-foreground",
  ask: "text-foreground",
  ok: "text-foreground",
  error: "font-medium text-danger",
};

export interface SupervisorChatProps {
  initial: SupervisorMessage[];
  /** 有 api 时发到 10 的 chat()（T-071）；没有（假数据 / 测试）只追加到本地。 */
  api?: Pick<BakaDesktopApi, "supervisorChat"> | undefined;
  /** 界面当前选中的项目；有就随消息传给主管 */
  projectId?: string | undefined;
  /** 对话记录（默认整个窗口共用一份，组件卸载不丢）；测试注入新的 */
  store?: ChatStore;
  /** 选中项目时嵌在群聊下方：不显示顶栏 */
  compact?: boolean;
  /** 导入项目（T-072）；没有就不显示按钮 */
  onImport?: () => void;
  /** 打开只读设置页（T-072） */
  onOpenSettings?: () => void;
  /** 导出诊断包（T-072） */
  onExport?: () => void;
  /** 导入 / 导出进行中：对应按钮禁用 */
  busy?: "import" | "export" | null;
}

/** 主管 1:1：唯一可输入的地方。一次只发一条（chat 有状态），等上一条回来才能再发。 */
export function SupervisorChat({
  initial,
  api,
  projectId,
  store = supervisorChatStore,
  compact = false,
  onImport,
  onOpenSettings,
  onExport,
  busy = null,
}: SupervisorChatProps) {
  useEffect(() => store.seed(initial), [store, initial]);
  const { items: messages, pending } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [draft, setDraft] = useState("");
  const now = () => new Date().toISOString();

  const send = async () => {
    const text = draft.trim();
    // 等待状态在 store 里：组件卸载重挂也挡得住重复发送（主进程另有串行）
    if (!text || store.getSnapshot().pending) return;
    store.append({ id: store.nextId("u"), from: "user", content: text, ts: now() });
    setDraft("");
    if (!api?.supervisorChat) return;
    if (!store.begin()) return;
    let item: ChatItem;
    try {
      const r = await api.supervisorChat({ text, ...(projectId && { project_id: projectId }) });
      item = r.ok
        ? { id: store.nextId("s"), from: "supervisor", reply: r.reply, ts: now() }
        : { id: store.nextId("e"), from: "system", failed: chatFailureText(r.reason), ts: now() };
    } catch {
      // IPC 本身被拒：错误对象可能带主进程路径等，不原样显示
      item = {
        id: store.nextId("e"),
        from: "system",
        failed: chatFailureText("和主进程通信失败，请重试"),
        ts: now(),
      };
    } finally {
      store.end();
    }
    store.append(item);
  };

  return (
    <section
      aria-label="主管对话"
      className={cn(
        "flex min-w-0 flex-col",
        compact ? "h-64 shrink-0 border-t border-border" : "flex-1",
      )}
    >
      {!compact && (
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
      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {messages.map((m) => {
          if (m.failed !== undefined) {
            return (
              <div
                key={m.id}
                role="alert"
                data-testid="chat-error"
                className="flex gap-2 text-sm text-danger"
              >
                <AlertCircle className="mt-0.5 size-4 shrink-0" strokeWidth={1.5} />
                <p className="whitespace-pre-wrap">{m.failed}</p>
              </div>
            );
          }
          if (m.reply) {
            const v = chatReplyView(m.reply);
            return (
              <div
                key={m.id}
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
            <div key={m.id} className="flex gap-2 text-sm">
              {m.from === "supervisor" ? (
                <AgentIcon supervisor />
              ) : (
                <span className="w-[18px] text-xs text-muted-foreground">我</span>
              )}
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
      <div className="flex items-end gap-2 border-t border-border p-3">
        <Textarea
          aria-label="发给主管"
          rows={2}
          placeholder="提需求或人工介入，说清是哪个项目"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <Button size="icon" aria-label="发送" disabled={pending} onClick={() => void send()}>
          <Send strokeWidth={1.5} />
        </Button>
      </div>
    </section>
  );
}
