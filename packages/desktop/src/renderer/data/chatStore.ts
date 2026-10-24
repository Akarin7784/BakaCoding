// T-072：主管对话记录放在组件外，切换面板 / 组件卸载后历史和「等待中」状态都还在。
// UI-04a：记录用 2 / 10 存下来的消息形状（DesktopSupervisorMessage），按 message_id 去重；
// 首屏 hydrate(messages)，往上滚动时 loadOlder(before) 每次再取 50 条。整条对话一条流，不按项目筛选。
import type {
  ChatReply,
  DesktopHistoryResult,
  DesktopSupervisorMessage,
} from "../../shared/api.js";

/** 一页条数（与主进程 / 2 的默认一致）。 */
export const CHAT_HISTORY_PAGE = 50;

/** 存下来的消息；刚收到的主管回复另带 10 原样的 ChatReply（展示用）。 */
export type ChatMessageItem = DesktopSupervisorMessage & { reply?: ChatReply; failed?: undefined };
/** 本地的失败提示（不落库）；retry 带原消息，重试时沿用同一个 message_id。 */
export interface ChatFailedItem {
  message_id: string;
  role: "system";
  failed: string;
  created_at: number;
  retry?: { message_id: string; text: string; project_id?: string };
  reply?: undefined;
}
export type ChatItem = ChatMessageItem | ChatFailedItem;

export interface ChatSnapshot {
  items: readonly ChatItem[];
  pending: boolean;
  /** 历史里还有更早的消息（上一页取满了） */
  hasOlder: boolean;
  /** 正在取更早的一页 */
  loadingOlder: boolean;
}

/** 10 给主管回复的 message_id：用户消息 id 加 `-r`（T-092），界面据此和历史去重。 */
export const replyMessageId = (userMessageId: string): string => `${userMessageId}-r`;

/** 主管回复在历史里的展示形状（kind 为 null 的旧记录按「回答」显示）。 */
export function storedReply(m: DesktopSupervisorMessage): ChatReply {
  return {
    text: m.content,
    kind: m.kind ?? "answer",
    ...(m.project_id !== null && { project_id: m.project_id }),
    ...(m.requirement_id !== null && { requirement_id: m.requirement_id }),
    ...(m.ticket_ids.length > 0 && { ticket_ids: [...m.ticket_ids] }),
  };
}

export class ChatStore {
  private snap: ChatSnapshot = { items: [], pending: false, hasOlder: false, loadingOlder: false };
  private hydrated = false;
  /** 历史里最早一条的 message_id：loadOlder 的游标（本地追加的消息不算） */
  private oldest: string | undefined;
  private listeners = new Set<() => void>();

  /** 第一次拿到历史时放入（首屏一页）；之后不再覆盖。返回是否放入了。 */
  hydrate(messages: readonly DesktopSupervisorMessage[]): boolean {
    if (this.hydrated) return false;
    this.hydrated = true;
    this.oldest = messages[0]?.message_id;
    this.set({
      ...this.snap,
      items: dedupe([...messages, ...this.snap.items]),
      hasOlder: messages.length >= CHAT_HISTORY_PAGE,
    });
    return true;
  }
  get isHydrated(): boolean {
    return this.hydrated;
  }
  /**
   * 往上滚动时再取一页：before 为当前最早一条的 message_id。取回的消息按 message_id 去重后放到最前；
   * 不满一页说明到头了。取失败只结束加载，不清记录。
   */
  async loadOlder(
    fetchPage: (before: string) => Promise<DesktopHistoryResult>,
  ): Promise<void> {
    const before = this.oldest;
    if (before === undefined || !this.snap.hasOlder || this.snap.loadingOlder) return;
    this.set({ ...this.snap, loadingOlder: true });
    try {
      const r = await fetchPage(before);
      if (!r.ok) {
        this.set({ ...this.snap, loadingOlder: false });
        return;
      }
      if (r.messages.length) this.oldest = r.messages[0]!.message_id;
      this.set({
        ...this.snap,
        items: dedupe([...r.messages, ...this.snap.items]),
        hasOlder: r.messages.length >= CHAT_HISTORY_PAGE,
        loadingOlder: false,
      });
    } catch {
      this.set({ ...this.snap, loadingOlder: false });
    }
  }
  /** 新的 message_id（用户发送时生成；重试沿用同一个）。 */
  newMessageId(): string {
    const rand =
      typeof globalThis.crypto?.randomUUID === "function"
        ? globalThis.crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    return `u-${rand}`;
  }
  /** 追加；同一 message_id 已在记录里时不重复（重试时用户消息只留一条）。 */
  append(item: ChatItem): void {
    if (this.snap.items.some((m) => m.message_id === item.message_id)) return;
    this.set({ ...this.snap, items: [...this.snap.items, item] });
  }
  /** 去掉一条（重试前去掉旧的失败提示）。 */
  remove(message_id: string): void {
    this.set({ ...this.snap, items: this.snap.items.filter((m) => m.message_id !== message_id) });
  }
  /** 只有不在等待时才能开始一条；返回是否成功占到 */
  begin(): boolean {
    if (this.snap.pending) return false;
    this.set({ ...this.snap, pending: true });
    return true;
  }
  end(): void {
    this.set({ ...this.snap, pending: false });
  }
  getSnapshot = (): ChatSnapshot => this.snap;
  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  private set(s: ChatSnapshot): void {
    this.snap = s;
    for (const l of this.listeners) l();
  }
}

/** 按 message_id 去重，先出现的为准，保持顺序。 */
function dedupe(items: readonly ChatItem[]): ChatItem[] {
  const seen = new Set<string>();
  const out: ChatItem[] = [];
  for (const m of items) {
    if (seen.has(m.message_id)) continue;
    seen.add(m.message_id);
    out.push(m);
  }
  return out;
}

/** 整个窗口共用一份 */
export const supervisorChatStore = new ChatStore();
