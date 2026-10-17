// 把只读数据与后端状态通过 IPC 推给渲染进程。
import { IPC_CHANNELS, type DesktopUpdate, type SupervisorNotifyMessage } from "../shared/api.js";
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
