// T-072：主管对话记录放在组件外，切换面板 / 组件卸载后历史和「等待中」状态都还在。
import type { ChatReply } from "../../shared/api.js";
import type { SupervisorMessage } from "../mock/types";

export type ChatItem =
  | (SupervisorMessage & { reply?: undefined; failed?: undefined })
  | { id: string; from: "supervisor"; reply: ChatReply; ts: string; failed?: undefined }
  | { id: string; from: "system"; failed: string; ts: string; reply?: undefined };

export interface ChatSnapshot {
  items: readonly ChatItem[];
  pending: boolean;
}

export class ChatStore {
  private snap: ChatSnapshot = { items: [], pending: false };
  private seeded = false;
  private seq = 0;
  private listeners = new Set<() => void>();

  /** 第一次挂载时放入初始消息（假数据）；之后不再覆盖 */
  seed(initial: readonly SupervisorMessage[]): void {
    if (this.seeded) return;
    this.seeded = true;
    if (initial.length) this.set({ ...this.snap, items: [...initial, ...this.snap.items] });
  }
  nextId(prefix: string): string {
    return `${prefix}-${this.seq++}`;
  }
  append(item: ChatItem): void {
    this.set({ ...this.snap, items: [...this.snap.items, item] });
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

/** 整个窗口共用一份 */
export const supervisorChatStore = new ChatStore();
