// T-106：退出收尾时主进程经 app:quitting 通知渲染进程；窗口已销毁就跳过，不影响退出；preload 订阅 / 取消。
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../shared/api.js";
import { notifyAppQuitting, type UpdateSink } from "./ipc.js";
import { createDesktopApi, type IpcRendererLike } from "./preload-api.js";
import { createQuitGuard } from "./quit-guard.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function sinkOf(destroyed = false) {
  const send = vi.fn();
  const s: UpdateSink = { send, isDestroyed: () => destroyed };
  return { s, send };
}

describe("notifyAppQuitting（T-106）", () => {
  it("窗口在：发一次 app:quitting，不带内容", () => {
    const { s, send } = sinkOf();
    expect(notifyAppQuitting(() => s)).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(IPC_CHANNELS.appQuitting, null);
    expect(IPC_CHANNELS.appQuitting).toBe("bakacoding:app:quitting");
  });

  it("没有窗口 / 窗口已销毁：跳过，不报错", () => {
    expect(notifyAppQuitting(() => null)).toBe(false);
    const { s, send } = sinkOf(true);
    expect(notifyAppQuitting(() => s)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("取 webContents 或 send 抛错（销毁竞态）也吞掉", () => {
    expect(
      notifyAppQuitting(() => {
        throw new Error("Object has been destroyed");
      }),
    ).toBe(false);
    const s: UpdateSink = {
      send: () => {
        throw new Error("Object has been destroyed");
      },
      isDestroyed: () => false,
    };
    expect(notifyAppQuitting(() => s)).toBe(false);
  });

  it("接到 quit guard 上：重复触发退出只发一次；窗口已销毁时照样 stop、照样退出", async () => {
    for (const destroyed of [false, true]) {
      const { s, send } = sinkOf(destroyed);
      const stop = vi.fn(async () => {});
      const quit = vi.fn();
      const g = createQuitGuard({
        onStopping: () => void notifyAppQuitting(() => s),
        stop,
        quit,
        warn: () => {},
      });
      const ev = { preventDefault() {} };
      g.onBeforeQuit(ev);
      g.onBeforeQuit(ev);
      await g.settled();
      expect(send).toHaveBeenCalledTimes(destroyed ? 0 : 1);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(quit).toHaveBeenCalledTimes(1);
    }
  });

  it("main.ts：quit guard 的 onStopping 发通知，窗口 close 事件走 createWindowCloseHandler", () => {
    const main = readFileSync(path.join(here, "main.ts"), "utf8");
    expect(main).toMatch(/onStopping:\s*\(\)\s*=>\s*void notifyAppQuitting\(sink\)/);
    expect(main).toMatch(/win\.on\("close",\s*\(event\)\s*=>\s*onClose\(event\)\)/);
    expect(main).toMatch(/quitGuardRef = quitGuard;/);
  });
});

describe("preload onQuitting（T-106）", () => {
  it("订阅 app:quitting，收到即回调（不透出 event）；取消后不再收到", () => {
    const listeners = new Map<string, Set<(e: unknown, ...a: unknown[]) => void>>();
    const ipc: IpcRendererLike = {
      invoke: vi.fn(async () => undefined),
      on: (c, l) => {
        if (!listeners.has(c)) listeners.set(c, new Set());
        listeners.get(c)!.add(l);
      },
      removeListener: (c, l) => listeners.get(c)?.delete(l),
    };
    const api = createDesktopApi(ipc, "win32");
    const got = vi.fn();
    const off = api.onQuitting!(got);
    listeners.get(IPC_CHANNELS.appQuitting)!.forEach((l) => l({ sender: {} }, null));
    expect(got).toHaveBeenCalledTimes(1);
    expect(got).toHaveBeenCalledWith();
    off();
    expect(listeners.get(IPC_CHANNELS.appQuitting)!.size).toBe(0);
    expect(ipc.invoke).not.toHaveBeenCalled();
  });
});
