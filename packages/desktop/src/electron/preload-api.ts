// preload 暴露的 API。单独成文件，不依赖 electron，便于测试契约形状。
import {
  IPC_CHANNELS,
  type BakaDesktopApi,
  type DesktopBackendStatus,
  type DesktopSnapshot,
  type DesktopUpdate,
  type SupervisorNotifyMessage,
} from "../shared/api.js";

/** ipcRenderer 的最小子集。 */
export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
}

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
    getBackendStatus: () => ipc.invoke(IPC_CHANNELS.backendStatus) as Promise<DesktopBackendStatus>,
    markSupervisorReady: () =>
      ipc.invoke(IPC_CHANNELS.supervisorReady) as Promise<SupervisorNotifyMessage[]>,
    onSupervisorNotify(listener: (msg: SupervisorNotifyMessage) => void) {
      const wrapped = (_event: unknown, msg: unknown) => listener(msg as SupervisorNotifyMessage);
      ipc.on(IPC_CHANNELS.supervisorNotify, wrapped);
      return () => {
        ipc.removeListener(IPC_CHANNELS.supervisorNotify, wrapped);
      };
    },
  });
}
