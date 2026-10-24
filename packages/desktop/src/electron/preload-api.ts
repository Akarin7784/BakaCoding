// preload 暴露的 API。单独成文件，不依赖 electron，便于测试契约形状。
import {
  IPC_CHANNELS,
  type BakaDesktopApi,
  type DesktopBackendStatus,
  type DesktopChatResult,
  type DesktopDecideHighRiskResult,
  type DesktopExportOptions,
  type DesktopExportResult,
  type DesktopImportResult,
  type DesktopOpenDataDirResult,
  type DesktopSettings,
  type DesktopHighRiskDecision,
  type DesktopPendingHighRisk,
  type DesktopReloadResult,
  type DesktopRepoCheckResult,
  type DesktopRepoFilesResult,
  type DesktopRepoFixResult,
  type DesktopConfigFixResult,
  type DesktopInitConfigRequest,
  type DesktopInitialCommitRequest,
  type DesktopGitIdentity,
  type DesktopProviderTarget,
  type DesktopProviderTestResult,
  type DesktopSecretClearResult,
  type DesktopSecretName,
  type DesktopSecretSetResult,
  type DesktopSecretStatusResult,
  type DesktopSnapshot,
  type DesktopSyncState,
  type DesktopUpdate,
  type DesktopWindowThemeResult,
  type WindowThemeSource,
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
    createDefaultConfig: () =>
      ipc.invoke(IPC_CHANNELS.projectCreateDefaultConfig) as Promise<DesktopImportResult>,
    exportDiagnostics: (options?: DesktopExportOptions) =>
      ipc.invoke(IPC_CHANNELS.diagnosticsExport, options) as Promise<DesktopExportResult>,
    openDataDir: () =>
      ipc.invoke(IPC_CHANNELS.diagnosticsOpenDataDir) as Promise<DesktopOpenDataDirResult>,
    getSettings: () => ipc.invoke(IPC_CHANNELS.settingsGet) as Promise<DesktopSettings>,
    supervisorChat: (message: UserMessage) =>
      ipc.invoke(IPC_CHANNELS.supervisorChat, message) as Promise<DesktopChatResult>,
    setWindowTheme: (source: WindowThemeSource) =>
      ipc.invoke(IPC_CHANNELS.windowTheme, source) as Promise<DesktopWindowThemeResult>,
    reloadBackend: () => ipc.invoke(IPC_CHANNELS.backendReload) as Promise<DesktopReloadResult>,
    reconnectBackend: () =>
      ipc.invoke(IPC_CHANNELS.backendReconnect) as Promise<DesktopReloadResult>,
    checkRepo: () => ipc.invoke(IPC_CHANNELS.repoCheck) as Promise<DesktopRepoCheckResult>,
    initRepo: (req: { identity?: DesktopGitIdentity } = {}) =>
      ipc.invoke(IPC_CHANNELS.repoInit, req) as Promise<DesktopRepoFixResult>,
    listInitialFiles: () =>
      ipc.invoke(IPC_CHANNELS.repoListInitialFiles) as Promise<DesktopRepoFilesResult>,
    initialCommit: (req: DesktopInitialCommitRequest) =>
      ipc.invoke(IPC_CHANNELS.repoInitialCommit, req) as Promise<DesktopRepoFixResult>,
    createMainBranch: () =>
      ipc.invoke(IPC_CHANNELS.repoCreateMain) as Promise<DesktopRepoFixResult>,
    initConfig: (req: DesktopInitConfigRequest) =>
      ipc.invoke(IPC_CHANNELS.repoInitConfig, req) as Promise<DesktopConfigFixResult>,
    secretStatus: (name: DesktopSecretName) =>
      ipc.invoke(IPC_CHANNELS.secretStatus, { name }) as Promise<DesktopSecretStatusResult>,
    setSecret: (name: DesktopSecretName, value: string) =>
      ipc.invoke(IPC_CHANNELS.secretSet, { name, value }) as Promise<DesktopSecretSetResult>,
    clearSecret: (name: DesktopSecretName) =>
      ipc.invoke(IPC_CHANNELS.secretClear, { name }) as Promise<DesktopSecretClearResult>,
    testProvider: (target: DesktopProviderTarget) =>
      ipc.invoke(IPC_CHANNELS.providerTest, target) as Promise<DesktopProviderTestResult>,
    onQuitting(listener: () => void) {
      const wrapped = () => listener();
      ipc.on(IPC_CHANNELS.appQuitting, wrapped);
      return () => {
        ipc.removeListener(IPC_CHANNELS.appQuitting, wrapped);
      };
    },
  });
}
