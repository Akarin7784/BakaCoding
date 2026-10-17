// 把只读数据通过 IPC 推给渲染进程：invoke 取快照，之后轮询推增量。
import { IPC_CHANNELS, type DesktopUpdate } from "../shared/api.js";
import type { EventReader } from "./reader.js";

/** 主进程 ipcMain 的最小子集，便于测试注入。 */
export interface IpcMainLike {
  handle(channel: string, listener: (...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}

/** 接收更新的一方（BrowserWindow.webContents 的最小子集）。 */
export interface UpdateSink {
  send(channel: string, update: DesktopUpdate): void;
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
