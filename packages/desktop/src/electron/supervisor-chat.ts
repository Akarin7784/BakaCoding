// T-071：主管 1:1 对话的主进程侧——把 10 的 chat() 包成不抛过 IPC 的结果，失败原因脱敏截断。
import type { ChatReply, UserMessage } from "@bakacoding/supervisor";
import type {
  DesktopChatResult,
  DesktopHistoryQuery,
  DesktopHistoryResult,
  DesktopSupervisorMessage,
} from "../shared/api.js";
import { errorDetail, sanitizeErrorName, sanitizeSyncErrorMessage } from "./sync-state.js";

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
export interface SerialQueue {
  <T>(task: () => Promise<T>): Promise<T>;
  /** 已提交、还没结束（成功或失败）的任务数（T-093：主管对话在途时重载要排队） */
  pending(): number;
}

export function createSerialQueue(): SerialQueue {
  let chain: Promise<unknown> = Promise.resolve();
  let pending = 0;
  const q = <T>(task: () => Promise<T>): Promise<T> => {
    pending++;
    const run = chain.then(task);
    const done = (): void => {
      pending--;
    };
    chain = run.then(done, done);
    return run;
  };
  return Object.assign(q, { pending: () => pending });
}

/** 历史一页默认条数（UI-04a，与 2 / 10 的默认一致）；上限同 2 的 200。 */
export const HISTORY_PAGE = 50;
export const HISTORY_LIMIT_MAX = 200;
const HISTORY_CURSOR_MAX = 200;

/** 把渲染进程传来的参数收成 `{before?, limit?}`；不合法的字段丢掉，limit 夹到 1..200。 */
export function toHistoryQuery(arg: unknown): { before?: string; limit: number } {
  const o = (typeof arg === "object" && arg !== null ? arg : {}) as Record<string, unknown>;
  const before =
    typeof o.before === "string" && o.before && o.before.length <= HISTORY_CURSOR_MAX
      ? o.before
      : undefined;
  const raw = typeof o.limit === "number" && Number.isFinite(o.limit) ? Math.floor(o.limit) : NaN;
  const limit = Number.isNaN(raw) ? HISTORY_PAGE : Math.min(HISTORY_LIMIT_MAX, Math.max(1, raw));
  return { ...(before !== undefined && { before }), limit };
}

/**
 * 调 10 的 history()（UI-04a）。`history` 为 undefined 表示只读 / 未接线：回 ok:true 空列表。
 * 抛错（游标不存在等）→ ok:false，reason 走 sanitizeChatReason；整条对话一条流，不按项目筛选。
 */
export function runSupervisorHistory(
  history: ((opts: DesktopHistoryQuery) => readonly DesktopSupervisorMessage[]) | undefined,
  query: unknown,
  env: Readonly<Record<string, string | undefined>>,
): DesktopHistoryResult {
  if (!history) return { ok: true, messages: [] };
  try {
    const messages = history(toHistoryQuery(query)).map((m) => ({
      ...m,
      ticket_ids: [...m.ticket_ids],
    }));
    return { ok: true, messages };
  } catch (e) {
    return {
      ok: false,
      reason: sanitizeChatReason(`读取对话历史失败：${historyErrorText(e)}`, env),
    };
  }
}

/**
 * 历史出错只带错误名和 2 的错误码（如 `StorageError(invalid_cursor)`），不带 message：
 * 存储 / SQLite 的 message 可能带数据库绝对路径，界面上不能出现路径（UI-04a）。
 */
function historyErrorText(e: unknown): string {
  const name = sanitizeErrorName(e instanceof Error ? e.name : "Error");
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(code) ? `${name}(${code})` : name;
}
