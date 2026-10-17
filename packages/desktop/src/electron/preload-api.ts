// preload 暴露的 API。单独成文件，不依赖 electron，便于测试契约形状。
import {
  IPC_CHANNELS,
  type BakaDesktopApi,
  type DesktopBackendStatus,
  type DesktopChatResult,
  type DesktopDecideHighRiskResult,
  type DesktopExportResult,
  type DesktopImportResult,
  type DesktopSettings,
  type DesktopHighRiskDecision,
  type DesktopPendingHighRisk,
  type DesktopSnapshot,
  type DesktopSyncState,
  type DesktopUpdate,
  type SupervisorNotifyMessage,
  type UserMessage,
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
    getPendingHighRisk: () =>
      ipc.invoke(IPC_CHANNELS.highRiskPending) as Promise<DesktopPendingHighRisk[]>,
    decideHighRisk(
      ticket_id: string,
      pr_id: string,
      decision: DesktopHighRiskDecision,
      detail?: string,
    ) {
      return ipc.invoke(
        IPC_CHANNELS.highRiskDecide,
        ticket_id,
        pr_id,
        decision,
        detail,
      ) as Promise<DesktopDecideHighRiskResult>;
    },
    onPendingHighRisk(listener: (list: DesktopPendingHighRisk[]) => void) {
      const wrapped = (_event: unknown, list: unknown) =>
        listener(list as DesktopPendingHighRisk[]);
      ipc.on(IPC_CHANNELS.highRiskPendingUpdate, wrapped);
      return () => {
        ipc.removeListener(IPC_CHANNELS.highRiskPendingUpdate, wrapped);
      };
    },
    getSyncState: () => ipc.invoke(IPC_CHANNELS.syncState) as Promise<DesktopSyncState>,
    onSyncState(listener: (state: DesktopSyncState) => void) {
      const wrapped = (_event: unknown, state: unknown) => listener(state as DesktopSyncState);
      ipc.on(IPC_CHANNELS.syncStateUpdate, wrapped);
      return () => {
        ipc.removeListener(IPC_CHANNELS.syncStateUpdate, wrapped);
      };
    },
    importProject: () => ipc.invoke(IPC_CHANNELS.projectImport) as Promise<DesktopImportResult>,
    exportDiagnostics: () =>
      ipc.invoke(IPC_CHANNELS.diagnosticsExport) as Promise<DesktopExportResult>,
    getSettings: () => ipc.invoke(IPC_CHANNELS.settingsGet) as Promise<DesktopSettings>,
    supervisorChat: (message: UserMessage) =>
      ipc.invoke(IPC_CHANNELS.supervisorChat, message) as Promise<DesktopChatResult>,
  });
}
