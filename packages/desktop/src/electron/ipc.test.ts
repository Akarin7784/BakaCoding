import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS, type DesktopSnapshot, type DesktopUpdate } from "../shared/api.js";
import { serveReader, type IpcMainLike } from "./ipc.js";
import { createDesktopApi, type IpcRendererLike } from "./preload-api.js";
import type { EventReader } from "./reader.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const snap: DesktopSnapshot = {
  db: { path: "/x.db", state: "ok" },
  events: [],
  tickets: [],
  last_seq: -1,
};

afterEach(() => vi.useRealTimers());

describe("主进程 IPC", () => {
  it("invoke 快照通道返回快照；按间隔轮询，有更新才推送；停止后移除 handler", () => {
    vi.useFakeTimers();
    const handlers = new Map<string, (...a: unknown[]) => unknown>();
    const ipc: IpcMainLike = {
      handle: (c, l) => void handlers.set(c, l),
      removeHandler: (c) => void handlers.delete(c),
    };
    const update: DesktopUpdate = { db: snap.db, events: [], last_seq: 3 };
    const polls = [null, update];
    const reader: EventReader = {
      snapshot: () => snap,
      poll: () => polls.shift() ?? null,
      close: () => {},
    };
    const send = vi.fn();
    const stop = serveReader(ipc, reader, () => ({ send, isDestroyed: () => false }), 500);
    expect(handlers.get(IPC_CHANNELS.snapshot)?.()).toBe(snap);
    vi.advanceTimersByTime(500);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(send).toHaveBeenCalledWith(IPC_CHANNELS.update, update);
    stop();
    expect(handlers.has(IPC_CHANNELS.snapshot)).toBe(false);
  });
});

describe("preload 暴露的只读 API", () => {
  function fakeIpc() {
    const listeners = new Map<string, Set<(e: unknown, ...a: unknown[]) => void>>();
    const ipc: IpcRendererLike & { emit(c: string, v: unknown): void } = {
      invoke: vi.fn(async () => snap),
      on: (c, l) => {
        if (!listeners.has(c)) listeners.set(c, new Set());
        listeners.get(c)!.add(l);
      },
      removeListener: (c, l) => listeners.get(c)?.delete(l),
      emit: (c, v) => listeners.get(c)?.forEach((l) => l({}, v)),
    };
    return ipc;
  }

  it("暴露只读与后端状态相关成员，且不可改", () => {
    const api = createDesktopApi(fakeIpc(), "linux");
    expect(Object.keys(api).sort()).toEqual([
      "getBackendStatus",
      "getSnapshot",
      "markSupervisorReady",
      "onSupervisorNotify",
      "onUpdate",
      "platform",
    ]);
    expect(Object.isFrozen(api)).toBe(true);
    expect(typeof api.getSnapshot).toBe("function");
    expect(typeof api.getBackendStatus).toBe("function");
  });

  it("getSnapshot 走快照通道；onUpdate 收更新，取消后不再收到", async () => {
    const ipc = fakeIpc();
    const api = createDesktopApi(ipc, "linux");
    await expect(api.getSnapshot()).resolves.toBe(snap);
    expect(ipc.invoke).toHaveBeenCalledWith(IPC_CHANNELS.snapshot);
    const got: DesktopUpdate[] = [];
    const off = api.onUpdate((u) => got.push(u));
    const u: DesktopUpdate = { db: snap.db, events: [], last_seq: 1 };
    ipc.emit(IPC_CHANNELS.update, u);
    off();
    ipc.emit(IPC_CHANNELS.update, u);
    expect(got).toEqual([u]);
  });

  it("窗口开 contextIsolation、关 nodeIntegration；preload 只经 contextBridge 暴露这个 API", () => {
    const main = readFileSync(path.join(here, "main.ts"), "utf8");
    expect(main).toMatch(/contextIsolation:\s*true/);
    expect(main).toMatch(/nodeIntegration:\s*false/);
    const preload = readFileSync(path.join(here, "preload.ts"), "utf8");
    expect(preload).toMatch(
      /contextBridge\.exposeInMainWorld\("bakacoding", createDesktopApi\(ipcRenderer, process\.platform\)\)/,
    );
    expect(preload.match(/exposeInMainWorld/g)).toHaveLength(1);
  });

  it("渲染进程不直接引入 Node、electron 或存储模块", () => {
    const root = path.join(here, "../renderer");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = path.join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(f)) files.push(p);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(
        /from\s+["'](node:[^"']+|fs|path|electron|better-sqlite3|@bakacoding\/storage)["']/,
      );
    }
  });
});
