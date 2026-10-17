// 把只读数据与后端状态通过 IPC 推给渲染进程。
import {
  IPC_CHANNELS,
  type DesktopChatResult,
  type DesktopDecideHighRiskResult,
  type DesktopSyncState,
  type DesktopUpdate,
  type SupervisorNotifyMessage,
} from "../shared/api.js";
import type { BackendHandle } from "./backend.js";
import type { EventReader } from "./reader.js";

/** 主进程 ipcMain 的最小子集，便于测试注入。 */
export interface IpcMainLike {
  handle(channel: string, listener: (...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}

/** 接收更新的一方（BrowserWindow.webContents 的最小子集）。 */
export interface UpdateSink {
  send(channel: string, payload: unknown): void;
  isDestroyed(): boolean;
}

export const DEFAULT_POLL_MS = 1000;

export function serveReader(
  ipc: IpcMainLike,
  reader: EventReader,
  sink: () => UpdateSink | null,
  pollMs: number = DEFAULT_POLL_MS,
  /** 每次轮询有机会刷新高风险清单（PR 状态经 sync 变化时不发新事件，靠这里补）（T-062） */
  onPoll?: () => void,
): () => void {
  ipc.handle(IPC_CHANNELS.snapshot, () => reader.snapshot());
  const timer = setInterval(() => {
    const s = sink();
    if (!s || s.isDestroyed()) return;
    let update: DesktopUpdate | null;
    try {
      update = reader.poll();
    } catch (e) {
      console.error("[desktop] 读取事件失败", e);
      return;
    }
    if (update) s.send(IPC_CHANNELS.update, update);
    // 有或没有 UI 增量都刷新一次：sync 合入 / 关 PR 可能只改库里的状态
    try {
      onPoll?.();
    } catch (e) {
      console.error("[desktop] 刷新高风险清单失败", e);
    }
  }, pollMs);
  return () => {
    clearInterval(timer);
    ipc.removeHandler(IPC_CHANNELS.snapshot);
  };
}

/** 挂 backend:status / supervisor:ready / supervisor:notify。 */
export function serveBackend(
  ipc: IpcMainLike,
  backend: BackendHandle,
  sink: () => UpdateSink | null,
): () => void {
  ipc.handle(IPC_CHANNELS.backendStatus, () => backend.status());
  ipc.handle(IPC_CHANNELS.supervisorReady, () => {
    const replay = backend.markRendererReady();
    const s = sink();
    if (s && !s.isDestroyed()) {
      for (const m of replay) s.send(IPC_CHANNELS.supervisorNotify, m);
    }
    return replay;
  });
  const off = backend.onNotify((m: SupervisorNotifyMessage) => {
    const s = sink();
    if (s && !s.isDestroyed()) s.send(IPC_CHANNELS.supervisorNotify, m);
  });
  return () => {
    off();
    ipc.removeHandler(IPC_CHANNELS.backendStatus);
    ipc.removeHandler(IPC_CHANNELS.supervisorReady);
  };
}

/**
 * 高风险 PR 裁决 IPC（T-062）：pendingHighRisk / decideHighRisk，清单变化推 pending-update。
 * 刷新触发：onHighRiskHeld（经 notify）、escalated / ticket_warning、裁决后、以及 reader 轮询（PR 状态）。
 */
export function serveHighRisk(
  ipc: IpcMainLike,
  backend: BackendHandle,
  sink: () => UpdateSink | null,
): () => void {
  ipc.handle(IPC_CHANNELS.highRiskPending, () => backend.pendingHighRisk());
  ipc.handle(IPC_CHANNELS.highRiskDecide, async (...args: unknown[]) => {
    const ticket_id = String(args[0] ?? "");
    const pr_id = String(args[1] ?? "");
    const decision = args[2] === "reject" ? "reject" : "release";
    const detail = typeof args[3] === "string" ? args[3] : undefined;
    const result: DesktopDecideHighRiskResult = await backend.decideHighRisk(
      ticket_id,
      pr_id,
      decision,
      detail,
    );
    return result;
  });
  const off = backend.onPendingHighRisk((list) => {
    const s = sink();
    if (s && !s.isDestroyed()) s.send(IPC_CHANNELS.highRiskPendingUpdate, list);
  });
  return () => {
    off();
    ipc.removeHandler(IPC_CHANNELS.highRiskPending);
    ipc.removeHandler(IPC_CHANNELS.highRiskDecide);
  };
}

/** 同步状态轮询间隔（9 的 syncState() 是同步内存读，开销很小）。 */
export const DEFAULT_SYNC_STATE_POLL_MS = 2000;

/**
 * 定时同步状态 IPC（T-067）：invoke `sync:state` 取一次；按间隔读 9 的 syncState()，
 * 内容有变化才推 `sync:state-update`（next_at / last_ok_at 等每轮会变，所以每轮同步后都会推一次）。
 */
export function serveSyncState(
  ipc: IpcMainLike,
  backend: Pick<BackendHandle, "syncState">,
  sink: () => UpdateSink | null,
  pollMs: number = DEFAULT_SYNC_STATE_POLL_MS,
): () => void {
  let last: string | undefined;
  const read = (): DesktopSyncState => {
    const st = backend.syncState();
    last = JSON.stringify(st);
    return st;
  };
  ipc.handle(IPC_CHANNELS.syncState, () => read());
  const timer = setInterval(() => {
    const s = sink();
    if (!s || s.isDestroyed()) return;
    let st: DesktopSyncState;
    try {
      st = backend.syncState();
    } catch (e) {
      console.error("[desktop] 读取同步状态失败", e instanceof Error ? e.name : "unknown");
      return;
    }
    const key = JSON.stringify(st);
    if (key === last) return;
    last = key;
    s.send(IPC_CHANNELS.syncStateUpdate, st);
  }, pollMs);
  return () => {
    clearInterval(timer);
    ipc.removeHandler(IPC_CHANNELS.syncState);
  };
}

/** 把渲染进程传来的参数收成 10 的 UserMessage；text 不是字符串时给空串（由后端判空）。 */
export function toUserMessage(arg: unknown): {
  text: string;
  project_id?: string;
  message_id?: string;
} {
  const o = (typeof arg === "object" && arg !== null ? arg : {}) as Record<string, unknown>;
  return {
    text: typeof o.text === "string" ? o.text : "",
    ...(typeof o.project_id === "string" && o.project_id && { project_id: o.project_id }),
    ...(typeof o.message_id === "string" && o.message_id && { message_id: o.message_id }),
  };
}

/** 主管对话 IPC（T-071）：invoke `supervisor:chat` → backend.supervisorChat → 10 的 chat()。 */
export function serveSupervisorChat(
  ipc: IpcMainLike,
  backend: Pick<BackendHandle, "supervisorChat">,
): () => void {
  ipc.handle(IPC_CHANNELS.supervisorChat, async (...args: unknown[]) => {
    // ipcMain.handle 的第一个参数是 event；测试注入时也按这个约定
    const result: DesktopChatResult = await backend.supervisorChat(toUserMessage(args[1]));
    return result;
  });
  return () => {
    ipc.removeHandler(IPC_CHANNELS.supervisorChat);
  };
}
