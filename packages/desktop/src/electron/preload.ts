// preload：通过 contextBridge 只暴露只读 API（window.bakacoding），渲染进程拿不到 Node 和 ipcRenderer。
import { contextBridge, ipcRenderer } from "electron";
import { createDesktopApi } from "./preload-api.js";

contextBridge.exposeInMainWorld("bakacoding", createDesktopApi(ipcRenderer, process.platform));
