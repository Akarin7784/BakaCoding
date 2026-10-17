// 主进程 ↔ preload ↔ 渲染进程的只读数据契约。只放类型和通道名，不引入 Node 或存储模块，
// 渲染进程可以安全地 import type。
import type { BakaEvent, TicketStatus } from "@bakacoding/types";

/** IPC 通道名。 */
export const IPC_CHANNELS = {
  /** invoke：取一次完整快照。 */
  snapshot: "bakacoding:snapshot",
  /** 主进程 → 渲染进程：增量更新。 */
  update: "bakacoding:update",
} as const;

/** 界面关心的事件类型；其余事件主进程不下发。 */
export const UI_EVENT_TYPES = [
  "project_created",
  "group_message",
  "call_completed",
  "escalated",
  "ticket_warning",
] as const satisfies readonly BakaEvent["type"][];
export type UiEventType = (typeof UI_EVENT_TYPES)[number];
export type UiEvent = Extract<BakaEvent, { type: UiEventType }>;

/** 需求单在界面上的摘要（来自模块 2 的 tickets / pr_rounds 表）。 */
export interface TicketView {
  ticket_id: string;
  project_id: string;
  requirement_id: string;
  created_at: string;
  /** 需求单原文第一行，最多 80 字。 */
  title: string;
  /** 库里没有状态或状态不认识时按 pending 显示。 */
  status: TicketStatus;
  /** 已保存的 PR 轮次数 - 1，最小 0。 */
  resubmit_count: number;
}

export type DbStatus =
  | { path: string; state: "ok" }
  | { path: string; state: "missing" }
  | { path: string; state: "error"; message: string };

export interface DesktopSnapshot {
  db: DbStatus;
  /** 按 seq 升序；call_completed 的 prompt 不下发（置空串）。 */
  events: UiEvent[];
  tickets: TicketView[];
  /** 已下发的最大 seq，空库为 -1。 */
  last_seq: number;
}

export interface DesktopUpdate {
  db: DbStatus;
  /** seq 大于上次 last_seq 的新事件。 */
  events: UiEvent[];
  /** 需求单有变化时给出完整列表；没变化时省略。 */
  tickets?: TicketView[];
  last_seq: number;
}

/** preload 通过 contextBridge 暴露在 window.bakacoding 上的只读 API。 */
export interface BakaDesktopApi {
  readonly platform: string;
  getSnapshot(): Promise<DesktopSnapshot>;
  /** 订阅增量更新，返回取消订阅函数。 */
  onUpdate(listener: (update: DesktopUpdate) => void): () => void;
}

declare global {
  interface Window {
    bakacoding?: BakaDesktopApi;
  }
}
