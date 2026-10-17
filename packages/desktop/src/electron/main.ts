// Electron 主进程：单实例 + 写入锁组装组合根；失败则只读打开库。
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, nativeTheme } from "electron";
import { resolveRepoDbPath, resolveRepoPath, startBackend } from "./backend.js";
import {
  serveBackend,
  serveHighRisk,
  serveReader,
  serveSupervisorChat,
  serveSyncState,
} from "./ipc.js";
import { openEventReader } from "./reader.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** rebuild:electron 产出的 Electron ABI 版 better-sqlite3；不存在时用默认（Node 版，Electron 下会报错并显示在界面上）。 */
function electronSqliteBinding(): string | undefined {
  const fromEnv = process.env["BAKACODING_SQLITE_BINDING"];
  if (fromEnv) return fromEnv;
  const p = path.join(here, "../native/electron/better_sqlite3.node");
  return existsSync(p) ? p : undefined;
}

let win: BrowserWindow | null = null;

function createWindow(): void {
  nativeTheme.themeSource = "system";
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "BakaCoding",
    webPreferences: {
      // preload 打包成 CommonJS（preload.cjs），可以在 sandbox 下运行。
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
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
    const repoRoot = resolveRepoPath(process.argv, process.env, process.cwd());
    const dbPath = resolveRepoDbPath(process.argv, process.env, repoRoot);

    const backend = await startBackend({
      argv: process.argv,
      env: process.env,
      cwd: process.cwd(),
      ...(binding !== undefined && { nativeBinding: binding }),
    });

    // 只读端始终开；live 时写连接在 backend 里，只读连接仍用于界面轮询
    const reader = openEventReader({
      path: dbPath,
      ...(binding !== undefined && { nativeBinding: binding }),
    });
    const sink = () => win?.webContents ?? null;
    const stopHighRisk = serveHighRisk(ipcMain, backend, sink);
    const stopReader = serveReader(ipcMain, reader, sink, undefined, () =>
      backend.refreshPendingHighRisk(),
    );
    const stopBackendIpc = serveBackend(ipcMain, backend, sink);
    const stopSyncState = serveSyncState(ipcMain, backend, sink);
    const stopSupervisorChat = serveSupervisorChat(ipcMain, backend);

    app.on("will-quit", () => {
      stopReader();
      stopBackendIpc();
      stopHighRisk();
      stopSyncState();
      stopSupervisorChat();
      reader.close();
      void backend.stop();
    });
    createWindow();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}
