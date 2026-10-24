// UI-06e：main.ts 里注册 / 停止全部 IPC handler 的部分拆到这里，便于测试：
// registerMainHandlers 接上 ipc.ts 的每个 serve*，返回的 stop 按同一顺序全部停掉（与原 main.ts afterStop 的顺序一致），重复调用无效。
import type { RawAbout } from "./about.js";
import type { BackendSwitcher } from "./backend-switcher.js";
import {
  serveAbout,
  serveBackend,
  serveBackendReload,
  serveGitStatus,
  serveHighRisk,
  serveIntegrationReview,
  serveMainMerge,
  serveModelSettings,
  servePoolState,
  serveProjectList,
  serveProjectSettings,
  serveReader,
  serveRepoFix,
  serveRequirementDetail,
  serveSecretProvider,
  serveSupervisorChat,
  serveSupervisorHistory,
  serveSupervisorSplit,
  serveSyncState,
  serveWindowTheme,
  type IpcMainLike,
  type UpdateSink,
  type WindowThemeDeps,
} from "./ipc.js";
import type { ModelSettingsDeps } from "./model-settings.js";
import type { ProjectListDeps } from "./project-list-ipc.js";
import type { ProjectSettingsDeps } from "./project-settings-ipc.js";
import type { EventReader } from "./reader.js";
import type { RepoFixDeps } from "./repo-fix-ipc.js";
import type { SecretProviderDeps } from "./secret-provider-ipc.js";

export interface MainHandlerDeps {
  backend: BackendSwitcher;
  reader: EventReader;
  sink: () => UpdateSink | null;
  env: Readonly<Record<string, string | undefined>>;
  projectSettings: ProjectSettingsDeps;
  about: () => RawAbout;
  windowTheme: WindowThemeDeps;
  repoFix: RepoFixDeps;
  modelSettings: ModelSettingsDeps;
  projectList: ProjectListDeps;
  secretProvider: SecretProviderDeps;
}

export function registerMainHandlers(ipc: IpcMainLike, d: MainHandlerDeps): () => void {
  const { backend, sink } = d;
  const stops: (() => void)[] = [
    serveReader(ipc, d.reader, sink, undefined, () => backend.refreshPendingHighRisk()),
    serveBackend(ipc, backend, sink),
    serveHighRisk(ipc, backend, sink),
    serveSyncState(ipc, backend, sink),
    serveProjectSettings(ipc, d.projectSettings),
    serveSupervisorChat(ipc, backend),
    serveSupervisorHistory(ipc, backend),
    serveSupervisorSplit(ipc, backend),
    serveRequirementDetail(ipc, backend),
    serveGitStatus(ipc, backend),
    serveMainMerge(ipc, backend),
    serveIntegrationReview(ipc, backend),
    servePoolState(ipc, backend),
    serveAbout(ipc, d.about),
    serveWindowTheme(ipc, d.windowTheme),
    serveBackendReload(ipc, backend, d.env),
    serveRepoFix(ipc, d.repoFix),
    serveModelSettings(ipc, d.modelSettings),
    serveProjectList(ipc, d.projectList),
    serveSecretProvider(ipc, d.secretProvider),
  ];
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    for (const stop of stops) stop();
  };
}
