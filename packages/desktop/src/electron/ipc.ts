// 把只读数据与后端状态通过 IPC 推给渲染进程。
import {
  IPC_CHANNELS,
  type DesktopChatResult,
  type DesktopDecideHighRiskResult,
  type DesktopExportResult,
  type DesktopImportResult,
  type DesktopReloadResult,
  type DesktopSettings,
  type DesktopSyncState,
  type DesktopUpdate,
  type DesktopWindowThemeResult,
  type SupervisorNotifyMessage,
  type WindowThemeSource,
} from "../shared/api.js";
import type { UserMessage } from "@bakacoding/supervisor";
import path from "node:path";
import type { BackendHandle } from "./backend.js";
import {
  RELOAD_REASON_MAX,
  sanitizeReloadReason,
  type BackendSwitcher,
} from "./backend-switcher.js";
import { checkProjectDir, repoLockedBy, REPO_LOCKED_REASON } from "./project-import.js";
import {
  defaultExportName,
  envPresence,
  EXPORT_REASON_MAX,
  inside,
  isSymlinkTarget,
  type ProjectSettingsDeps,
} from "./project-settings-ipc.js";
import { errorDetail, sanitizeSyncErrorMessage } from "./sync-state.js";
import type { EventReader } from "./reader.js";
import { isWindowThemeSource } from "./window-chrome.js";
import { repoFixHandlers, type RepoFixDeps } from "./repo-fix-ipc.js";
import {
  secretProviderHandlers,
  type SecretProviderDeps,
} from "./secret-provider-ipc.js";

/**
 * 主进程 ipcMain 的最小子集，便于测试注入。
 * 和真实 Electron 一样，handler 的第一个参数是 IpcMainInvokeEvent，渲染进程传的参数从第二个起（T-074）。
 */
export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}

/** 接收更新的一方（BrowserWindow.webContents 的最小子集）。 */
export interface UpdateSink {
  send(channel: string, payload: unknown): void;
  isDestroyed(): boolean;
}

export const DEFAULT_POLL_MS = 1000;

/**
 * T-106：开始退出收尾时通知渲染进程显示「正在退出…」（`app:quitting`，主进程 → 渲染进程，不带内容）。
 * 窗口没有 / 已销毁就跳过；send 抛错也吞掉（退出路径上不能被它挡住）。返回是否发出。
 */
export function notifyAppQuitting(sink: () => UpdateSink | null): boolean {
  try {
    const s = sink();
    if (!s || s.isDestroyed()) return false;
    s.send(IPC_CHANNELS.appQuitting, null);
    return true;
  } catch {
    return false;
  }
}

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
  // 第一个参数是 IpcMainInvokeEvent，渲染进程的参数从 args[1] 起（T-074）
  ipc.handle(IPC_CHANNELS.highRiskDecide, async (...args: unknown[]) => {
    const ticket_id = String(args[1] ?? "");
    const pr_id = String(args[2] ?? "");
    const decision = args[3] === "reject" ? "reject" : "release";
    const detail = typeof args[4] === "string" ? args[4] : undefined;
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

/**
 * 重载 IPC（T-093）：`backend:reload` / `backend:reconnect` 都转给 BackendSwitcher 的同一条路径。
 * 不抛过 IPC：意外异常转成 failed，原因脱敏。
 */
export function serveBackendReload(
  ipc: IpcMainLike,
  switcher: Pick<BackendSwitcher, "reload" | "reconnect" | "repoRoot">,
  env: Readonly<Record<string, string | undefined>> = {},
): () => void {
  const safeRepoRoot = (): string => {
    try {
      return switcher.repoRoot();
    } catch {
      return "";
    }
  };
  const safely = async (fn: () => Promise<DesktopReloadResult>): Promise<DesktopReloadResult> => {
    try {
      return await fn();
    } catch (e) {
      return {
        state: "failed",
        reason: sanitizeReloadReason(errorDetail(e), safeRepoRoot(), env, RELOAD_REASON_MAX),
      };
    }
  };
  ipc.handle(IPC_CHANNELS.backendReload, () => safely(() => switcher.reload()));
  ipc.handle(IPC_CHANNELS.backendReconnect, () => safely(() => switcher.reconnect()));
  return () => {
    ipc.removeHandler(IPC_CHANNELS.backendReload);
    ipc.removeHandler(IPC_CHANNELS.backendReconnect);
  };
}

/** 把渲染进程传来的参数收成 10 的 UserMessage；text 不是字符串时给空串（由后端判空）。 */
export function toUserMessage(arg: unknown): UserMessage {
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

/**
 * 导入项目 / 导出诊断包 / 只读设置 IPC（T-072）。对话框、userData 写入由 main 注入；
 * 依赖与辅助函数在 project-settings-ipc.ts。
 */
export function serveProjectSettings(ipc: IpcMainLike, deps: ProjectSettingsDeps): () => void {
  const now = deps.now ?? (() => new Date());

  ipc.handle(IPC_CHANNELS.projectImport, async () => {
    if (repoLockedBy(deps.argv, deps.env))
      return { ok: false, reason: REPO_LOCKED_REASON } satisfies DesktopImportResult;
    const dir = await deps.pickDirectory();
    if (!dir) return { ok: false, canceled: true } satisfies DesktopImportResult;
    const check = checkProjectDir(dir, deps.env, deps.argv);
    if (!check.ok) {
      return {
        ok: false,
        ...(check.missing && { missing: check.missing }),
        ...(check.reason !== undefined && { reason: check.reason }),
      } satisfies DesktopImportResult;
    }
    const r = await deps.backend.switchTo(path.resolve(dir));
    if (!r.ok) {
      // 新后端已经在跑、只是 importProject 失败：记下的路径要和实际运行的仓库一致
      if (r.switched) deps.saveLastRepo(path.resolve(dir));
      return { ok: false, reason: r.reason } satisfies DesktopImportResult;
    }
    deps.saveLastRepo(path.resolve(dir));
    return {
      ok: true,
      project: r.project,
      ...(check.note !== undefined && { note: check.note }),
    } satisfies DesktopImportResult;
  });

  ipc.handle(IPC_CHANNELS.diagnosticsExport, async () => {
    const st = deps.backend.status();
    if (st.mode === "readonly") {
      // 只读时先拒绝，不弹保存框
      return {
        ok: false,
        reason: sanitizeSyncErrorMessage(
          st.reason ? `只读模式：${st.reason}` : "只读模式：后端未接线",
          deps.env,
          EXPORT_REASON_MAX,
        ),
      } satisfies DesktopExportResult;
    }
    const at = now();
    const target = await deps.pickSavePath(path.join(deps.downloadsDir, defaultExportName(at)));
    if (!target)
      return { ok: false, canceled: true, reason: "已取消" } satisfies DesktopExportResult;
    if (isSymlinkTarget(target)) {
      return {
        ok: false,
        reason: "保存位置是符号链接，请换个位置",
      } satisfies DesktopExportResult;
    }
    if (inside(target, deps.backend.repoRoot())) {
      return {
        ok: false,
        reason: "不能把诊断包保存到仓库目录里，请换个位置",
      } satisfies DesktopExportResult;
    }
    try {
      return {
        ok: true,
        path: await deps.backend.exportDiagnostics(target, at),
      } satisfies DesktopExportResult;
    } catch (e) {
      // 前缀「导出失败：」由界面加，这里只给原因
      return {
        ok: false,
        reason: sanitizeSyncErrorMessage(errorDetail(e), deps.env, EXPORT_REASON_MAX),
      } satisfies DesktopExportResult;
    }
  });

  ipc.handle(IPC_CHANNELS.settingsGet, () => {
    const settings: DesktopSettings = {
      repo: deps.backend.repoRoot() || null,
      env: envPresence(deps.env),
      mode: deps.backend.status().mode === "readonly" ? "readonly" : deps.backend.prMode(),
    };
    return settings;
  });

  return () => {
    ipc.removeHandler(IPC_CHANNELS.projectImport);
    ipc.removeHandler(IPC_CHANNELS.diagnosticsExport);
    ipc.removeHandler(IPC_CHANNELS.settingsGet);
  };
}

/** window:theme 依赖（main 注入 nativeTheme 和窗口；测试注入假的）。 */
export interface WindowThemeDeps {
  /** 设 nativeTheme.themeSource，返回设完后 shouldUseDarkColors */
  setThemeSource(source: WindowThemeSource): boolean;
  /** 按深浅更新标题栏按钮叠层颜色（没有叠层的平台为空操作） */
  applyTitleBar(dark: boolean): void;
  /** 记住偏好，下次启动建窗口前读（UI-08）；写失败只影响下次启动，不算失败 */
  saveTheme?(source: WindowThemeSource): void;
}

/** window:theme 主进程出错时回给渲染进程的固定文案（T-105）：不带任何原始错误内容。 */
export const WINDOW_THEME_FAILED = "主题设置失败";

/**
 * 主题同步 IPC（UI-02）：渲染进程把「跟随系统 / 浅 / 深」发过来，主进程设 nativeTheme.themeSource，
 * 再按实际深浅刷新标题栏叠层颜色。参数不认识就拒绝，不改主进程状态。
 */
export function serveWindowTheme(ipc: IpcMainLike, deps: WindowThemeDeps): () => void {
  ipc.handle(IPC_CHANNELS.windowTheme, (...args: unknown[]) => {
    const source = args[1];
    if (!isWindowThemeSource(source))
      return { ok: false, reason: "不认识的主题" } satisfies DesktopWindowThemeResult;
    try {
      const dark = deps.setThemeSource(source);
      deps.applyTitleBar(dark);
      try {
        deps.saveTheme?.(source);
      } catch {
        /* 存不下只影响下次启动时标题栏先按系统深浅显示 */
      }
      return { ok: true, dark } satisfies DesktopWindowThemeResult;
    } catch {
      // T-105：不把原始错误（可能带路径）传给渲染进程，只回固定文案
      return { ok: false, reason: WINDOW_THEME_FAILED } satisfies DesktopWindowThemeResult;
    }
  });
  return () => {
    ipc.removeHandler(IPC_CHANNELS.windowTheme);
  };
}

/**
 * 项目准备页的仓库检查与修复 IPC（UI-03a）：`repo:check` / `repo:init` / `repo:list-initial-files` /
 * `repo:initial-commit` / `repo:create-main`，都作用于当前后端的仓库根。参数在主进程做类型校验；
 * 失败回 `{ ok: false, code, reason }`（RepoFixError 固定文案）；写操作成功后自动 `backend:reconnect`。
 */
export function serveRepoFix(ipc: IpcMainLike, deps: RepoFixDeps): () => void {
  const h = repoFixHandlers(deps);
  // 第一个参数是 IpcMainInvokeEvent，渲染进程的参数从 args[1] 起（T-074）
  ipc.handle(IPC_CHANNELS.repoCheck, () => h.check());
  ipc.handle(IPC_CHANNELS.repoInit, (...args: unknown[]) => h.init(args[1]));
  ipc.handle(IPC_CHANNELS.repoListInitialFiles, () => h.listInitialFiles());
  ipc.handle(IPC_CHANNELS.repoInitialCommit, (...args: unknown[]) => h.initialCommit(args[1]));
  ipc.handle(IPC_CHANNELS.repoCreateMain, () => h.createMain());
  return () => {
    ipc.removeHandler(IPC_CHANNELS.repoCheck);
    ipc.removeHandler(IPC_CHANNELS.repoInit);
    ipc.removeHandler(IPC_CHANNELS.repoListInitialFiles);
    ipc.removeHandler(IPC_CHANNELS.repoInitialCommit);
    ipc.removeHandler(IPC_CHANNELS.repoCreateMain);
  };
}

/** UI-03b：secret:status / secret:set / secret:clear / provider:test（处理函数和参数校验在 secret-provider-ipc.ts） */
export function serveSecretProvider(ipc: IpcMainLike, deps: SecretProviderDeps): () => void {
  const h = secretProviderHandlers(deps);
  ipc.handle(IPC_CHANNELS.secretStatus, (...args: unknown[]) => h.status(args[1]));
  ipc.handle(IPC_CHANNELS.secretSet, (...args: unknown[]) => h.set(args[1]));
  ipc.handle(IPC_CHANNELS.secretClear, (...args: unknown[]) => h.clear(args[1]));
  ipc.handle(IPC_CHANNELS.providerTest, (...args: unknown[]) => h.test(args[1]));
  return () => {
    ipc.removeHandler(IPC_CHANNELS.secretStatus);
    ipc.removeHandler(IPC_CHANNELS.secretSet);
    ipc.removeHandler(IPC_CHANNELS.secretClear);
    ipc.removeHandler(IPC_CHANNELS.providerTest);
  };
}
