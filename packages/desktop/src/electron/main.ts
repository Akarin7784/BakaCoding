// Electron 主进程：单实例 + 写入锁组装组合根；失败则只读打开库。
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron";
import { SECRET_MARKER_FILE, writePricing } from "@bakacoding/config-budget";
import { checkRepo, ensureExcludeLines, writeConfig } from "@bakacoding/app";
import { buildCommit } from "./about.js";
import { configFixHandlers, configTemplateDir } from "./config-fix.js";
import { lastRepoForStart, resolveRepoDbPath, startBackend, type RepoSource } from "./backend.js";
import {
  notifyAppQuitting,
  serveBackend,
  serveBackendReload,
  serveHighRisk,
  serveProjectSettings,
  serveReader,
  serveRepoFix,
  serveSecretProvider,
  serveSupervisorChat,
  serveSyncState,
  serveAbout,
  serveWindowTheme,
} from "./ipc.js";
import { titleBarOverlayFor, usesTitleBarOverlay, windowChromeOptions } from "./window-chrome.js";
import { BackendSwitcher } from "./backend-switcher.js";
import { openEventReader, type EventReader } from "./reader.js";
import { createQuitGuard, createWindowCloseHandler, type QuitGuard } from "./quit-guard.js";
import { readLastRepo, writeLastRepo } from "./repo-store.js";
import { readSavedTheme, writeSavedTheme } from "./theme-store.js";
import { defaultTemplateDir } from "./default-config.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** rebuild:electron 产出的 Electron ABI 版 better-sqlite3；不存在时用默认（Node 版，Electron 下会报错并显示在界面上）。 */
function electronSqliteBinding(): string | undefined {
  const fromEnv = process.env["BAKACODING_SQLITE_BINDING"];
  if (fromEnv) return fromEnv;
  const p = path.join(here, "../native/electron/better_sqlite3.node");
  return existsSync(p) ? p : undefined;
}

let win: BrowserWindow | null = null;
/** T-106：后端组装好后才有；建窗口时用它拦关闭（还没有就按原样关） */
let quitGuardRef: QuitGuard | null = null;

/** 标题栏按钮叠层跟随当前深浅（UI-02）；没有叠层的平台不做。 */
function applyTitleBar(dark: boolean): void {
  if (!win || win.isDestroyed() || !usesTitleBarOverlay(process.platform)) return;
  try {
    win.setTitleBarOverlay(titleBarOverlayFor(dark));
  } catch (e) {
    console.warn("[desktop] 更新标题栏颜色失败", e);
  }
}

function createWindow(): void {
  // UI-08：建窗口前同步读出上次保存的主题偏好，叠层颜色和窗口底色一开始就对（不闪）；
  // 之后渲染进程经 window:theme 同步，主进程再记下来。
  nativeTheme.themeSource = readSavedTheme(app.getPath("userData"));
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "BakaCoding",
    ...windowChromeOptions(process.platform, nativeTheme.shouldUseDarkColors),
    webPreferences: {
      // preload 打包成 CommonJS（preload.cjs），可以在 sandbox 下运行。
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // T-106：点关闭先不关窗口，发起退出并留着窗口显示「正在退出…」，收尾结束后由 app.quit() 关
  const onClose = createWindowCloseHandler({
    guard: { state: () => quitGuardRef?.state() ?? "done" },
    platform: process.platform,
    quit: () => app.quit(),
  });
  win.on("close", (event) => onClose(event));
  win.on("closed", () => (win = null));
  const devUrl = process.env["VITE_DEV_SERVER_URL"];
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(path.join(here, "../dist-renderer/index.html"));
}

// 单实例：第二个进程直接退出（写入锁是第二道闸）
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  void app.whenReady().then(async () => {
    const binding = electronSqliteBinding();
    const userData = app.getPath("userData");
    // T-072：--repo > BAKACODING_REPO > 上次导入的路径 > cwd
    // UI-03a 评审 B1：重载 / 退回原仓库时 switcher 传原来源；原来是 cwd 就不把它当「上次导入」传进去，
    // 来源仍按 cwd 解析（不提供初始化 / 首次提交）。
    const lastRepo = readLastRepo(userData);
    const start = (repo?: string, source?: RepoSource) => {
      const last = lastRepoForStart(repo, source, lastRepo);
      return startBackend({
        argv: process.argv,
        env: process.env,
        cwd: process.cwd(),
        ...(last !== undefined && { lastRepo: last }),
        ...(binding !== undefined && { nativeBinding: binding }),
      });
    };
    const backend = new BackendSwitcher(
      await start(),
      (repo, source) => start(repo, source),
      process.env,
    );

    // 只读端始终开；live 时写连接在 backend 里，只读连接仍用于界面轮询。切换仓库后重开到新库。
    const openReaderFor = (repoRoot: string): EventReader =>
      openEventReader({
        path: resolveRepoDbPath(process.argv, process.env, repoRoot),
        ...(binding !== undefined && { nativeBinding: binding }),
      });
    let currentReader = openReaderFor(backend.repoRoot());
    const reader: EventReader = {
      snapshot: () => currentReader.snapshot(),
      poll: () => currentReader.poll(),
      close: () => currentReader.close(),
    };
    backend.onSwap(() => {
      try {
        currentReader.close();
      } catch {
        /* ignore */
      }
      currentReader = openReaderFor(backend.repoRoot());
    });
    const sink = () => win?.webContents ?? null;
    const stopHighRisk = serveHighRisk(ipcMain, backend, sink);
    const stopReader = serveReader(ipcMain, reader, sink, undefined, () =>
      backend.refreshPendingHighRisk(),
    );
    const stopBackendIpc = serveBackend(ipcMain, backend, sink);
    const stopSyncState = serveSyncState(ipcMain, backend, sink);
    const stopProjectSettings = serveProjectSettings(ipcMain, {
      backend,
      argv: process.argv,
      env: process.env,
      downloadsDir: app.getPath("downloads"),
      saveLastRepo: (repo) => writeLastRepo(userData, repo),
      // T-081：打包版在 exe 同一层 config-templates/；开发时用仓库根 config/（here = packages/desktop/dist-electron）
      templateDir: defaultTemplateDir(
        app.isPackaged,
        process.execPath,
        path.join(here, "../../.."),
      ),
      // T-082 的 ensureExcludeLines（经 @bakacoding/app 再导出）：只给本次新建的配置文件写 .git/info/exclude
      ensureExcludeLines,
      // T-130：打开数据目录（userData：状态 / 标记文件所在）；失败抛错，由 IPC 层换成固定文案
      async openDataDir() {
        const err = await shell.openPath(userData);
        if (err) throw new Error("打开数据目录失败");
      },
      async pickDirectory() {
        const r = win
          ? await dialog.showOpenDialog(win, { properties: ["openDirectory"], title: "导入项目" })
          : await dialog.showOpenDialog({ properties: ["openDirectory"], title: "导入项目" });
        return r.canceled ? null : (r.filePaths[0] ?? null);
      },
      async pickSavePath(defaultPath) {
        const opts = {
          title: "导出诊断包",
          defaultPath,
          filters: [{ name: "zip", extensions: ["zip"] }],
        };
        const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
        return r.canceled || !r.filePath ? null : r.filePath;
      },
    });
    const stopSupervisorChat = serveSupervisorChat(ipcMain, backend);
    // UI-07a：设置 › 关于
    const stopAbout = serveAbout(ipcMain, () => ({
      version: app.getVersion(),
      commit: buildCommit(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    }));
    const stopWindowTheme = serveWindowTheme(ipcMain, {
      setThemeSource(source) {
        nativeTheme.themeSource = source;
        return nativeTheme.shouldUseDarkColors;
      },
      applyTitleBar,
      saveTheme: (source) => writeSavedTheme(userData, source),
    });
    // 跟随系统时系统切深浅色，标题栏按钮颜色跟着变
    const onNativeTheme = () => applyTitleBar(nativeTheme.shouldUseDarkColors);
    nativeTheme.on("updated", onNativeTheme);
    const stopBackendReload = serveBackendReload(ipcMain, backend, process.env);
    // UI-03a：项目准备页的仓库检查与修复，作用于当前仓库；写操作成功后走 reconnect
    const stopRepoFix = serveRepoFix(ipcMain, {
      repoRoot: () => backend.repoRoot(),
      repoSource: () => backend.status().repoSource,
      reconnect: () => backend.reconnect(),
      // T-113：生成配置；模板在 exe 旁边的 config-templates/（开发时用仓库根的 config/）
      config: configFixHandlers({
        repoRoot: () => backend.repoRoot(),
        repoSource: () => backend.status().repoSource,
        reconnect: () => backend.reconnect(),
        argv: process.argv,
        env: process.env,
        templateDir: configTemplateDir(app.isPackaged, process.execPath, here),
        checkRepo: (root) => checkRepo(root),
        writeConfig,
        writePricing,
        ensureExcludeLines,
      }),
    });
    // UI-03b：密钥项与测试连接；标记文件放 userData（不在仓库里），值只交给 3
    const stopSecretProvider = serveSecretProvider(ipcMain, {
      secretDeps: { markerPath: path.join(userData, SECRET_MARKER_FILE) },
      backend,
    });

    // T-105：before-quit 里拦下退出，等 backend.stop()（9 收尾后才关库、放写锁）结束再退；
    // 最多等 QUIT_STOP_TIMEOUT_MS，超时只写一条不带路径的 warn。我们自己再发起的退出直接放行。
    // 收尾期间 IPC 照常开着（界面还能轮询）；切换 / 重载会被 switcher 以「程序正在退出」拒绝。
    // T-106：开始收尾时通知渲染进程显示「正在退出…」（只发一次；窗口已销毁就跳过，不影响退出）。
    const quitGuard = createQuitGuard({
      onStopping: () => void notifyAppQuitting(sink),
      stop: () => backend.stop(),
      afterStop() {
        stopReader();
        stopBackendIpc();
        stopHighRisk();
        stopSyncState();
        stopProjectSettings();
        stopSupervisorChat();
        stopAbout();
        stopWindowTheme();
        nativeTheme.off("updated", onNativeTheme);
        stopBackendReload();
        stopRepoFix();
        stopSecretProvider();
        reader.close();
      },
      warn: (m) => console.warn(`[desktop] ${m}`),
      quit: () => app.quit(),
    });
    quitGuardRef = quitGuard;
    app.on("before-quit", (event) => quitGuard.onBeforeQuit(event));
    createWindow();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}
