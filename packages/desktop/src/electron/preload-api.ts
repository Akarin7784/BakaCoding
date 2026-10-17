// preload 暴露的只读 API。单独成文件，不依赖 electron，便于测试契约形状。
import {
  IPC_CHANNELS,
  type BakaDesktopApi,
  type DesktopSnapshot,
  type DesktopUpdate,
} from "../shared/api.js";

/** ipcRenderer 的最小子集。 */
export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
}

/** 只有这三个成员；不暴露 ipcRenderer 本身，也没有任何写操作。 */
export function createDesktopApi(ipc: IpcRendererLike, platform: string): BakaDesktopApi {
  return Object.freeze({
    platform,
    getSnapshot: () => ipc.invoke(IPC_CHANNELS.snapshot) as Promise<DesktopSnapshot>,
    onUpdate(listener: (update: DesktopUpdate) => void) {
      const wrapped = (_event: unknown, update: unknown) => listener(update as DesktopUpdate);
      ipc.on(IPC_CHANNELS.update, wrapped);
      return () => {
        ipc.removeListener(IPC_CHANNELS.update, wrapped);
      };
    },
  });
}
