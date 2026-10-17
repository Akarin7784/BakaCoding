// Electron 主进程：开一个窗口，跟随系统深浅色；只读打开模块 2 的库，经 IPC 推给渲染进程。
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, nativeTheme } from "electron";
import { resolveDbPath } from "./config.js";
import { serveReader } from "./ipc.js";
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

void app.whenReady().then(() => {
  const reader = openEventReader({
    path: resolveDbPath(process.argv, process.env, process.cwd()),
    nativeBinding: electronSqliteBinding(),
  });
  const stop = serveReader(ipcMain, reader, () => win?.webContents ?? null);
  app.on("will-quit", () => {
    stop();
    reader.close();
  });
  createWindow();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
