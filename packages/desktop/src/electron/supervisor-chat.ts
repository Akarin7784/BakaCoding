// T-071：主管 1:1 对话的主进程侧——把 10 的 chat() 包成不抛过 IPC 的结果，失败原因脱敏截断。
import type { ChatReply, UserMessage } from "@bakacoding/supervisor";
import type { DesktopChatResult } from "../shared/api.js";
import { errorDetail, sanitizeSyncErrorMessage } from "./sync-state.js";

/** ok:false 时 reason 的上限（与同步错误同一套脱敏：先换密钥值，再 light，最后截断）。 */
export const CHAT_REASON_MAX = 2000;
/** 单条消息的上限（码点），超了直接拒绝，不送进模型。 */
export const CHAT_TEXT_MAX = 20000;

export function sanitizeChatReason(
  message: string,
  env: Readonly<Record<string, string | undefined>> = {},
): string {
  return sanitizeSyncErrorMessage(message, env, CHAT_REASON_MAX);
}

/**
 * 调 10 的 chat()。`chat` 为 undefined 表示只读 / 未接线（readonlyReason 只含变量名 / 错误名）。
 * chat() 抛错（预算耗尽、网络、限流重试用尽等）→ ok:false，reason 脱敏截断；10 的接口不改。
 */
export async function runSupervisorChat(
  chat: ((m: UserMessage) => Promise<ChatReply>) | undefined,
  message: UserMessage,
  env: Readonly<Record<string, string | undefined>>,
  readonlyReason: string | undefined,
): Promise<DesktopChatResult> {
  if (!chat) {
    return {
      ok: false,
      reason: sanitizeChatReason(
        readonlyReason ? `只读模式：${readonlyReason}` : "只读模式：后端未接线",
        env,
      ),
    };
  }
  const text = message.text.trim();
  if (!text) return { ok: false, reason: "消息为空" };
  if ([...text].length > CHAT_TEXT_MAX) {
    return { ok: false, reason: `消息太长（超过 ${CHAT_TEXT_MAX} 字）` };
  }
  try {
    const reply = await chat({ ...message, text });
    return { ok: true, reply };
  } catch (e) {
    return { ok: false, reason: sanitizeChatReason(`主管回复失败：${errorDetail(e)}`, env) };
  }
}

/**
 * 串行队列（T-072）：10 的 chat() 有状态，主进程里前一条回来才调下一条；
 * 渲染进程卸载 / 重挂丢了自己的防重入也不会并发。前一条失败不影响后一条。
 */
export function createSerialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
