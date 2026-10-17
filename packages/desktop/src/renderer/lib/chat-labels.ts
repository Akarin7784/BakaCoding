// T-071：10 的 chat() 回复在 1:1 里的展示文案。switch 穷举 ChatReply.kind，10 新增 kind 时这里编译不过。
import type { ChatReply, ChatReplyKind } from "../../shared/api.js";

export type ChatTone = "normal" | "ask" | "ok" | "error";

export interface ChatReplyView {
  kind: ChatReplyKind;
  /** 小标签：回答 / 需要选项目 / 已记下决策 / 已派单 / 拆单失败 */
  label: string;
  tone: ChatTone;
  text: string;
  /** 已派单时的单号；其他为空数组 */
  ticketIds: string[];
}

function assertNever(x: never): never {
  throw new Error(`未知的主管回复类型：${String(x)}`);
}

export function chatReplyView(reply: ChatReply): ChatReplyView {
  const base = { kind: reply.kind, text: reply.text, ticketIds: [] as string[] };
  switch (reply.kind) {
    case "answer":
      return { ...base, label: "回答", tone: "normal" };
    case "ask_project":
      return { ...base, label: "需要选项目", tone: "ask" };
    case "decision_saved":
      return { ...base, label: "已记下决策", tone: "ok" };
    case "dispatched":
      return { ...base, label: "已派单", tone: "ok", ticketIds: [...(reply.ticket_ids ?? [])] };
    case "split_failed":
      return { ...base, label: "拆单失败", tone: "error" };
    default:
      return assertNever(reply.kind);
  }
}

/** ok:false 时界面上的文案（reason 主进程已脱敏截断，这里再按约 500 字预览截断）。 */
export const CHAT_REASON_PREVIEW = 500;
export function chatFailureText(reason: string): string {
  const r =
    reason.length > CHAT_REASON_PREVIEW ? `${reason.slice(0, CHAT_REASON_PREVIEW)}…` : reason;
  return `发送失败：${r}`;
}
