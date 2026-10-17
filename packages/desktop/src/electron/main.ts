// Electron 主进程：只开一个窗口，跟随系统深浅色。v1 壳子不接任何后端模块。
import { app, BrowserWindow, nativeTheme } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function createWindow(): void {
  nativeTheme.themeSource = "system";
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "BakaCoding",
    webPreferences: { preload: path.join(here, "preload.mjs") },
  });
  const devUrl = process.env["VITE_DEV_SERVER_URL"];
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(path.join(here, "../dist-renderer/index.html"));
}

void app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
