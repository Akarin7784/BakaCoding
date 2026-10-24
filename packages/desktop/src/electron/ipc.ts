// 把只读数据与后端状态通过 IPC 推给渲染进程。
import { toSplitRequest } from "./supervisor-chat.js";
import { aboutInfo, type RawAbout } from "./about.js";
import { modelSettingsHandlers, type ModelSettingsDeps } from "./model-settings.js";
import { projectListHandlers, type ProjectListDeps } from "./project-list-ipc.js";
import {
  IPC_CHANNELS,
  type DesktopChatResult,
  type DesktopHistoryResult,
  type DesktopSplitResult,
  type DesktopRequirementDetailResult,
  type DesktopDecideHighRiskResult,
  type DesktopExportOptions,
  type DesktopExportResult,
  type DesktopImportResult,
  type DesktopOpenDataDirResult,
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
import {
  checkProjectDir,
  IMPORT_REASON_MAX,
  repoLockedBy,
  REPO_LOCKED_REASON,
  type DirCheck,
} from "./project-import.js";
import { canCreateDefaultConfig, createDefaultConfigFiles } from "./default-config.js";
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
import { secretProviderHandlers, type SecretProviderDeps } from "./secret-provider-ipc.js";

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

/** 主管对话历史 IPC（UI-04a）：invoke `supervisor:history` → backend.supervisorHistory → 10 的 history()。 */
export function serveSupervisorHistory(
  ipc: IpcMainLike,
  backend: Pick<BackendHandle, "supervisorHistory">,
): () => void {
  ipc.handle(IPC_CHANNELS.supervisorHistory, async (...args: unknown[]) => {
    const result: DesktopHistoryResult = await backend.supervisorHistory(args[1]);
    return result;
  });
  return () => {
    ipc.removeHandler(IPC_CHANNELS.supervisorHistory);
  };
}

/**
 * fs / git 报错的 message 里带绝对路径（如 `copyfile 'C:\\…' -> 'C:\\…'`），只把错误码交给界面（T-126，§12 口径）。
 * 取不到合法错误码时给 `unknown`，不透出原始 message。
 */
export function errorCodeOnly(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "unknown";
}

const EXPORT_ID_MAX = 200;

/**
 * `diagnostics:export` 的可选粒度参数（T-130）：渲染进程可能传任意值，主进程先做类型 / 长度 / ISO 校验，
 * 不认识就返回 `{ ok: false }`（handler 回固定文案，不抛）。省略参数 = 最近 24 小时（T-072 行为不变）。
 */
export function parseExportOptions(
  arg: unknown,
): { ok: true; options?: DesktopExportOptions } | { ok: false } {
  if (arg === undefined || arg === null) return { ok: true };
  if (typeof arg !== "object") return { ok: false };
  const scope = (arg as Record<string, unknown>).scope;
  if (scope === undefined) return { ok: true, options: {} };
  if (typeof scope !== "object" || scope === null) return { ok: false };
  const s = scope as Record<string, unknown>;
  const validId = (v: unknown): v is string =>
    typeof v === "string" && v.length > 0 && v.length <= EXPORT_ID_MAX;
  if (s.kind === "ticket") {
    return validId(s.ticket_id)
      ? { ok: true, options: { scope: { kind: "ticket", ticket_id: s.ticket_id } } }
      : { ok: false };
  }
  if (s.kind === "requirement") {
    return validId(s.requirement_id)
      ? { ok: true, options: { scope: { kind: "requirement", requirement_id: s.requirement_id } } }
      : { ok: false };
  }
  if (s.kind === "time_range") {
    const validIso = isStrictIsoDateTime;
    if (!validIso(s.from) || !validIso(s.to)) return { ok: false };
    if (Date.parse(s.from as string) > Date.parse(s.to as string)) return { ok: false };
    return {
      ok: true,
      options: { scope: { kind: "time_range", from: s.from as string, to: s.to as string } },
    };
  }
  return { ok: false };
}

/**
 * 导入项目 / 导出诊断包 / 只读设置 IPC（T-072）。对话框、userData 写入由 main 注入；
 * 依赖与辅助函数在 project-settings-ipc.ts。
 */
export function serveProjectSettings(ipc: IpcMainLike, deps: ProjectSettingsDeps): () => void {
  const now = deps.now ?? (() => new Date());

  /**
   * T-081：上次导入对话框选中、且「只缺配置文件」的目录。只在主进程里记，
   * createDefaultConfig 只写这个目录，渲染进程传不进任何路径。
   */
  let pendingDir: string | null = null;

  /**
   * 校验失败的结果；只缺配置时记下目录、带上按钮标记和模板位置提示。
   * UI-03b 起不是 Git 仓库不再进 `missing`，这里按 `notGit` 单独判：写不了 .git/info/exclude，不给按钮；
   * `--config` / BAKACODING_CONFIG 指向的文件不存在时补模板也过不了，同样不给。
   */
  const failure = (dir: string, check: Extract<DirCheck, { ok: false }>): DesktopImportResult => {
    const can =
      canCreateDefaultConfig(check.missing) &&
      !check.notGit &&
      !check.envConfigMissing &&
      !!deps.templateDir;
    pendingDir = can ? dir : null;
    const hint = can ? "。模板在安装目录的 config-templates 文件夹，可点「用默认模板创建」" : "";
    return {
      ok: false,
      ...(check.missing && { missing: check.missing }),
      ...(check.reason !== undefined && { reason: `${check.reason}${hint}` }),
      ...(can && { canCreateDefaultConfig: true as const }),
    };
  };

  /** 校验通过后的切换（导入成功路径；createDefaultConfig 复用，含 UI-03b 的 needsPrep） */
  const complete = async (dir: string, note?: string): Promise<DesktopImportResult> => {
    pendingDir = null;
    const abs = path.resolve(dir);
    const r = await deps.backend.switchTo(abs);
    if (!r.ok && "needsPrep" in r) {
      // UI-03b：没准备好的文件夹也算导入了（记下路径），界面进准备页
      deps.saveLastRepo(abs);
      return {
        ok: false,
        needsPrep: true,
        reason: r.reason,
        ...(note !== undefined && { note }),
      } satisfies DesktopImportResult;
    }
    if (!r.ok) {
      // 新后端已经在跑、只是 importProject 失败：记下的路径要和实际运行的仓库一致
      if (r.switched) deps.saveLastRepo(abs);
      return { ok: false, reason: r.reason };
    }
    deps.saveLastRepo(abs);
    return { ok: true, project: r.project, ...(note !== undefined && { note }) };
  };

  ipc.handle(IPC_CHANNELS.projectImport, async () => {
    // 每次导入都清掉上次失败记下的目录：取消 / 选了别的文件夹后，不能再对旧目录建配置
    pendingDir = null;
    if (repoLockedBy(deps.argv, deps.env))
      return { ok: false, reason: REPO_LOCKED_REASON } satisfies DesktopImportResult;
    const dir = await deps.pickDirectory();
    if (!dir) return { ok: false, canceled: true } satisfies DesktopImportResult;
    const check = checkProjectDir(dir, deps.env, deps.argv);
    if (!check.ok) return failure(dir, check);
    return complete(dir, check.note);
  });

  ipc.handle(IPC_CHANNELS.projectCreateDefaultConfig, async () => {
    if (repoLockedBy(deps.argv, deps.env))
      return { ok: false, reason: REPO_LOCKED_REASON } satisfies DesktopImportResult;
    const dir = pendingDir;
    if (!dir || !deps.templateDir)
      return {
        ok: false,
        reason: "没有待创建配置的项目，请先点「导入项目」选择仓库",
      } satisfies DesktopImportResult;
    const clean = (t: string) => sanitizeSyncErrorMessage(t, deps.env, IMPORT_REASON_MAX);
    let made;
    try {
      made = createDefaultConfigFiles(dir, deps.templateDir, deps.argv, deps.env);
    } catch (e) {
      // T-126：fs 报错的 message 带绝对路径，只把错误码交给界面（§12 口径）
      return { ok: false, reason: `创建配置失败（${errorCodeOnly(e)}）` };
    }
    if (!made.ok) return { ok: false, reason: clean(made.reason) } satisfies DesktopImportResult;
    let warn: string | undefined;
    if (made.created.length && deps.ensureExcludeLines) {
      try {
        // T-082 的约定：dir 不是 git 仓库时返回 false、不抛错。两种都只提醒，不挡导入。
        const ok = await deps.ensureExcludeLines(
          dir,
          made.created.map((f) => `/${f}`),
        );
        if (!ok) warn = "没能写入 .git/info/exclude（不是 Git 仓库）";
      } catch (e) {
        // 写 exclude 失败只提醒，不挡导入；同样只留错误码
        warn = `没能写入 .git/info/exclude（${errorCodeOnly(e)}）`;
      }
    }
    const check = checkProjectDir(dir, deps.env, deps.argv);
    if (!check.ok) {
      const r = failure(dir, check);
      return warn && !r.ok ? { ...r, reason: `${r.reason ?? ""}；${warn}` } : r;
    }
    const notes = [
      `已用默认模板创建 ${made.created.join("、") || "（无，文件已存在）"}`,
      ...(check.note ? [check.note] : []),
      ...(warn ? [warn] : []),
    ];
    return complete(dir, notes.join("；"));
  });

  ipc.handle(IPC_CHANNELS.diagnosticsExport, async (...args: unknown[]) => {
    const parsed = parseExportOptions(args[1]);
    if (!parsed.ok) {
      return { ok: false, reason: "导出参数不合法" } satisfies DesktopExportResult;
    }
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
        path: await deps.backend.exportDiagnostics(target, parsed.options, at),
      } satisfies DesktopExportResult;
    } catch (e) {
      // 前缀「导出失败：」由界面加，这里只给原因
      return {
        ok: false,
        reason: sanitizeSyncErrorMessage(errorDetail(e), deps.env, EXPORT_REASON_MAX),
      } satisfies DesktopExportResult;
    }
  });

  ipc.handle(IPC_CHANNELS.diagnosticsOpenDataDir, async () => {
    if (!deps.openDataDir)
      return {
        ok: false,
        reason: "没有连接主进程，不能打开数据目录",
      } satisfies DesktopOpenDataDirResult;
    try {
      await deps.openDataDir();
      return { ok: true } satisfies DesktopOpenDataDirResult;
    } catch {
      // 固定文案：shell.openPath 的失败信息可能带路径，不透出
      return { ok: false, reason: "打开数据目录失败" } satisfies DesktopOpenDataDirResult;
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
    ipc.removeHandler(IPC_CHANNELS.projectCreateDefaultConfig);
    ipc.removeHandler(IPC_CHANNELS.diagnosticsExport);
    ipc.removeHandler(IPC_CHANNELS.diagnosticsOpenDataDir);
    ipc.removeHandler(IPC_CHANNELS.settingsGet);
  };
}

/**
 * 设置 › 模型（UI-07b）：`settings:config-get`（无参数）和 `settings:save`（一个参数）；
 * 设置 › 预算（UI-07c）：`budget:status`（无参数），保存也走 `settings:save`（参数是 `{ budget }`）。
 * 逻辑在 model-settings.ts：密钥只回是否已设，外部配置只读，保存按 校验 → 写 config → 写 pricing → 重载。
 */
export function serveModelSettings(ipc: IpcMainLike, deps: ModelSettingsDeps): () => void {
  const h = modelSettingsHandlers(deps);
  ipc.handle(IPC_CHANNELS.settingsConfigGet, () => h.configGet());
  ipc.handle(IPC_CHANNELS.settingsSave, (...args: unknown[]) => h.save(args[1]));
  // UI-07c：设置 › 预算的状态（无参数）；保存仍走上面的 settings:save
  ipc.handle(IPC_CHANNELS.budgetStatus, () => h.budgetStatus());
  return () => {
    ipc.removeHandler(IPC_CHANNELS.settingsConfigGet);
    ipc.removeHandler(IPC_CHANNELS.settingsSave);
    ipc.removeHandler(IPC_CHANNELS.budgetStatus);
  };
}

/**
 * 设置 › 项目（UI-07d）：`project:list`（无参数）、`project:remove`（project_id）、`project:open-folder`（project_id）。
 * 逻辑在 project-list-ipc.ts：打开文件夹只认 project_id，路径由主进程按记录取并检查绝对路径、存在；失败固定文案不带路径。
 */
export function serveProjectList(ipc: IpcMainLike, deps: ProjectListDeps): () => void {
  const h = projectListHandlers(deps);
  ipc.handle(IPC_CHANNELS.projectList, () => h.list());
  ipc.handle(IPC_CHANNELS.projectRemove, (...args: unknown[]) => h.remove(args[1]));
  ipc.handle(IPC_CHANNELS.projectOpenFolder, (...args: unknown[]) => h.openFolder(args[1]));
  ipc.handle(IPC_CHANNELS.ledgerSummary, () => h.summary());
  return () => {
    ipc.removeHandler(IPC_CHANNELS.projectList);
    ipc.removeHandler(IPC_CHANNELS.projectRemove);
    ipc.removeHandler(IPC_CHANNELS.projectOpenFolder);
    ipc.removeHandler(IPC_CHANNELS.ledgerSummary);
  };
}

/**
 * 设置 › 关于（UI-07a）：`app:about`。main 注入原始值（app.getVersion、构建时 commit、process.versions），
 * 这里统一走 aboutInfo 白名单过滤；取值抛错时回全 null，不透出错误。
 */
export function serveAbout(ipc: IpcMainLike, raw: () => RawAbout): () => void {
  ipc.handle(IPC_CHANNELS.appAbout, () => {
    try {
      return aboutInfo(raw());
    } catch {
      return aboutInfo({ version: null, commit: null });
    }
  });
  return () => {
    ipc.removeHandler(IPC_CHANNELS.appAbout);
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
 * `repo:initial-commit` / `repo:create-main`，以及 T-113 的 `repo:init-config`，都作用于当前后端的仓库根。参数在主进程做类型校验；
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
  ipc.handle(IPC_CHANNELS.repoInitConfig, (...args: unknown[]) => h.initConfig(args[1]));
  return () => {
    ipc.removeHandler(IPC_CHANNELS.repoCheck);
    ipc.removeHandler(IPC_CHANNELS.repoInit);
    ipc.removeHandler(IPC_CHANNELS.repoListInitialFiles);
    ipc.removeHandler(IPC_CHANNELS.repoInitialCommit);
    ipc.removeHandler(IPC_CHANNELS.repoCreateMain);
    ipc.removeHandler(IPC_CHANNELS.repoInitConfig);
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

/**
 * 严格 ISO 8601 日期时间（T-137）：必须带时间和时区（Z 或 ±HH:MM），
 * 日期要真实存在（拒绝 2026-02-30 这种 Date.parse 会顺延的值）。
 */
const ISO_DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-](\d{2}):(\d{2}))$/;

export function isStrictIsoDateTime(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const m = ISO_DATETIME_RE.exec(v);
  if (!m) return false;
  const [, y, mo, d, h, mi, sec, , oh, om] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1) return false;
  if (day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return false;
  if (Number(h) > 23 || Number(mi) > 59 || Number(sec ?? 0) > 59) return false;
  if (oh !== undefined && (Number(oh) > 23 || Number(om) > 59)) return false;
  return !Number.isNaN(Date.parse(v));
}

/** 需求详情 IPC（UI-05a，只读）：invoke `requirement:detail` → backend.requirementDetail；args[0] 是 event。 */
export function serveRequirementDetail(
  ipc: IpcMainLike,
  backend: Pick<BackendHandle, "requirementDetail">,
): () => void {
  ipc.handle(IPC_CHANNELS.requirementDetail, async (...args: unknown[]) => {
    const result: DesktopRequirementDetailResult = await backend.requirementDetail(args[1]);
    return result;
  });
  return () => {
    ipc.removeHandler(IPC_CHANNELS.requirementDetail);
  };
}

/** 重试拆单 IPC（UI-04c）：invoke `supervisor:split` → backend.supervisorSplit → 10 的 split()，不经 chat。 */
export function serveSupervisorSplit(
  ipc: IpcMainLike,
  backend: Pick<BackendHandle, "supervisorSplit">,
): () => void {
  ipc.handle(IPC_CHANNELS.supervisorSplit, async (...args: unknown[]) => {
    const result: DesktopSplitResult = await backend.supervisorSplit(toSplitRequest(args[1]));
    return result;
  });
  return () => {
    ipc.removeHandler(IPC_CHANNELS.supervisorSplit);
  };
}
