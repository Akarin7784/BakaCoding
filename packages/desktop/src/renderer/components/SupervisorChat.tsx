import { useState } from "react";
import { Download, FolderOpen, Send, Settings } from "lucide-react";
import { AgentIcon } from "./AgentIcon";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import type { SupervisorMessage } from "../mock/types";

/** 主管 1:1：唯一可输入的地方。壳子阶段消息只追加到本地，不发往模块 10。 */
export interface SupervisorChatActions {
  /** 导入项目（T-072）；没有就不显示按钮 */
  onImport?: () => void;
  /** 打开只读设置页（T-072） */
  onOpenSettings?: () => void;
  /** 导出诊断包（T-072） */
  onExport?: () => void;
  /** 导入 / 导出进行中：对应按钮禁用 */
  busy?: "import" | "export" | null;
}

export function SupervisorChat({
  initial,
  onImport,
  onOpenSettings,
  onExport,
  busy = null,
}: { initial: SupervisorMessage[] } & SupervisorChatActions) {
  const [messages, setMessages] = useState(initial);
  const [draft, setDraft] = useState("");
  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setMessages((m) => [
      ...m,
      { id: `u${m.length}`, from: "user", content: text, ts: new Date().toISOString() },
    ]);
    setDraft("");
  };
  return (
    <section aria-label="主管对话" className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2">
        <AgentIcon supervisor />
        <span className="flex-1 text-sm font-medium">主管</span>
        {onImport && (
          <Button
            variant="ghost"
            size="sm"
            aria-label="导入项目"
            disabled={busy !== null}
            onClick={onImport}
          >
            <FolderOpen strokeWidth={1.5} />
            {busy === "import" ? "导入中…" : "导入项目"}
          </Button>
        )}
        <Button variant="ghost" size="sm" aria-label="设置" onClick={onOpenSettings}>
          <Settings strokeWidth={1.5} />
          设置
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label="导出诊断包"
          disabled={busy !== null}
          onClick={onExport}
        >
          <Download strokeWidth={1.5} />
          {busy === "export" ? "导出中…" : "导出"}
        </Button>
      </header>
      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {messages.map((m) => (
          <div key={m.id} className="flex gap-2 text-sm">
            {m.from === "supervisor" ? (
              <AgentIcon supervisor />
            ) : (
              <span className="w-[18px] text-xs text-muted-foreground">我</span>
            )}
            <p className="whitespace-pre-wrap">{m.content}</p>
          </div>
        ))}
      </div>
      <div className="flex items-end gap-2 border-t border-border p-3">
        <Textarea
          aria-label="发给主管"
          rows={2}
          placeholder="提需求或人工介入，说清是哪个项目"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <Button size="icon" aria-label="发送" onClick={send}>
          <Send strokeWidth={1.5} />
        </Button>
      </div>
    </section>
  );
}
