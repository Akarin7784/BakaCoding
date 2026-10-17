// preload：壳子阶段只暴露平台信息；接入模块 10 时再加发消息通道。
import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("bakacoding", { platform: process.platform });
