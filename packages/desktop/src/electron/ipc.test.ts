import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IPC_CHANNELS,
  type DesktopSnapshot,
  type DesktopSyncState,
  type DesktopUpdate,
} from "../shared/api.js";
import type { BackendHandle } from "./backend.js";
import * as ipcModule from "./ipc.js";
import {
  serveBackend,
  serveHighRisk,
  serveReader,
  serveSupervisorChat,
  serveSyncState,
  type IpcMainLike,
} from "./ipc.js";
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

/** 真实 Electron 传给 handle 的第一个参数（IpcMainInvokeEvent）的替身（T-074）。 */
const FAKE_EVENT = Object.freeze({ sender: { id: 1 }, frameId: 1, processId: 1 });

/**
 * 主进程 ipcMain 的替身：和真实 Electron 一样，invoke 时先传 event，再传渲染进程的参数（T-074）。
 * 以前直接 `handler(...args)`，handler 把 event 当成第一个参数也测不出来。
 */
function fakeIpcMain() {
  const handlers = new Map<string, (event: unknown, ...a: unknown[]) => unknown>();
  const ipc: IpcMainLike = {
    handle: (c, l) => {
      if (handlers.has(c)) throw new Error(`重复注册 handler：${c}`);
      handlers.set(c, l);
    },
    removeHandler: (c) => void handlers.delete(c),
  };
  const invoke = (channel: string, ...args: unknown[]): unknown => {
    const h = handlers.get(channel);
    if (!h) throw new Error(`没有注册 handler：${channel}`);
    return h(FAKE_EVENT, ...args);
  };
  return { ipc, handlers, invoke };
}

/** 只实现 IPC 层用到的成员，其余调用就抛错。 */
function fakeBackend(over: Partial<BackendHandle> = {}): BackendHandle {
  const base: Partial<BackendHandle> = {
    status: vi.fn(() => ({ mode: "live" }) as unknown as ReturnType<BackendHandle["status"]>),
    markRendererReady: vi.fn(() => [{ text: "回放" }]),
    onNotify: vi.fn(() => () => {}),
    pendingHighRisk: vi.fn(() => []),
    decideHighRisk: vi.fn(async () => ({
      ok: true as const,
      result: { decision: "release" as const, result: "released" as const },
    })),
    onPendingHighRisk: vi.fn(() => () => {}),
    refreshPendingHighRisk: vi.fn(),
    syncState: vi.fn(() => ({ available: false as const, reason: "x" })),
    supervisorChat: vi.fn(async () => ({
      ok: true as const,
      reply: { text: "好的", kind: "answer" as const },
    })),
    ...over,
  };
  return new Proxy(base as BackendHandle, {
    get(t, k) {
      if (k in t) return (t as unknown as Record<string | symbol, unknown>)[k];
      throw new Error(`fakeBackend 没实现 ${String(k)}`);
    },
  });
}

type ChannelKey = keyof typeof IPC_CHANNELS;

/** 只由主进程 send、渲染进程 on 订阅的通道；其余 IPC_CHANNELS 都是 invoke 通道（T-074）。 */
const PUSH_ONLY: readonly string[] = [
  IPC_CHANNELS.update,
  IPC_CHANNELS.supervisorNotify,
  IPC_CHANNELS.highRiskPendingUpdate,
  IPC_CHANNELS.syncStateUpdate,
];
const INVOKE_CHANNELS = Object.values(IPC_CHANNELS)
  .filter((c) => !PUSH_ONLY.includes(c))
  .sort();

/** 和 main.ts 一样把 ipc.ts 的每个 serve* 都接上；键名必须和 ipc.ts 导出的 serve* 一致。 */
const SERVE: Record<string, (ipc: IpcMainLike, backend: BackendHandle) => () => void> = {
  serveReader: (ipc) =>
    serveReader(ipc, { snapshot: () => snap, poll: () => null, close: () => {} }, () => null, 1000),
  serveBackend: (ipc, backend) => serveBackend(ipc, backend, () => null),
  serveHighRisk: (ipc, backend) => serveHighRisk(ipc, backend, () => null),
  serveSyncState: (ipc, backend) => serveSyncState(ipc, backend, () => null, 1000),
  serveSupervisorChat: (ipc, backend) => serveSupervisorChat(ipc, backend),
};
function wireAll(ipc: IpcMainLike, backend: BackendHandle): Array<() => void> {
  vi.useFakeTimers();
  return Object.values(SERVE).map((serve) => serve(ipc, backend));
}

describe("主进程 IPC", () => {
  it("invoke 快照通道返回快照；按间隔轮询，有更新才推送；停止后移除 handler", () => {
    vi.useFakeTimers();
    const { ipc, handlers, invoke } = fakeIpcMain();
    const update: DesktopUpdate = { db: snap.db, events: [], last_seq: 3 };
    const polls = [null, update];
    const reader: EventReader = {
      snapshot: () => snap,
      poll: () => polls.shift() ?? null,
      close: () => {},
    };
    const send = vi.fn();
    const stop = serveReader(ipc, reader, () => ({ send, isDestroyed: () => false }), 500);
    expect(invoke(IPC_CHANNELS.snapshot)).toBe(snap);
    vi.advanceTimersByTime(500);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(send).toHaveBeenCalledWith(IPC_CHANNELS.update, update);
    stop();
    expect(handlers.has(IPC_CHANNELS.snapshot)).toBe(false);
  });
});

describe("handler 参数：第一个是 event，渲染进程参数从第二个起（T-074）", () => {
  it("high-risk:decide 放行：ticket_id / pr_id / decision 按位置对应，detail 不传为 undefined", async () => {
    const { ipc, invoke } = fakeIpcMain();
    const backend = fakeBackend();
    serveHighRisk(ipc, backend, () => null);
    await expect(invoke(IPC_CHANNELS.highRiskDecide, "T-1", "pr-9", "release")).resolves.toEqual({
      ok: true,
      result: { decision: "release", result: "released" },
    });
    expect(backend.decideHighRisk).toHaveBeenCalledTimes(1);
    expect(backend.decideHighRisk).toHaveBeenCalledWith("T-1", "pr-9", "release", undefined);
  });

  it("high-risk:decide 拒绝：detail 原样传给后端", async () => {
    const { ipc, invoke } = fakeIpcMain();
    const backend = fakeBackend();
    serveHighRisk(ipc, backend, () => null);
    await invoke(IPC_CHANNELS.highRiskDecide, "T-2", "pr-3", "reject", "依赖升级不要");
    expect(backend.decideHighRisk).toHaveBeenCalledWith("T-2", "pr-3", "reject", "依赖升级不要");
  });

  it("high-risk:decide 不把 event 当成参数：event 不会出现在传给后端的任何位置", async () => {
    const { ipc, invoke } = fakeIpcMain();
    const backend = fakeBackend();
    serveHighRisk(ipc, backend, () => null);
    await invoke(IPC_CHANNELS.highRiskDecide, "T-3", "pr-4", "reject");
    const call = vi.mocked(backend.decideHighRisk).mock.calls[0]!;
    expect(call).not.toContain(FAKE_EVENT);
    expect(call.map(String)).not.toContain(String(FAKE_EVENT));
    expect(call).toEqual(["T-3", "pr-4", "reject", undefined]);
  });

  it("high-risk:decide 未知 decision 按 release、非字符串 detail 丢掉（保持 T-062 行为）", async () => {
    const { ipc, invoke } = fakeIpcMain();
    const backend = fakeBackend();
    serveHighRisk(ipc, backend, () => null);
    await invoke(IPC_CHANNELS.highRiskDecide, "T-4", "pr-5", "whatever", 42);
    expect(backend.decideHighRisk).toHaveBeenCalledWith("T-4", "pr-5", "release", undefined);
  });

  it("supervisor:chat：渲染进程传的 UserMessage 原样到后端，event 不会被当成消息", async () => {
    const { ipc, invoke } = fakeIpcMain();
    const backend = fakeBackend();
    serveSupervisorChat(ipc, backend);
    await invoke(IPC_CHANNELS.supervisorChat, { text: "加个按钮", project_id: "p-1" });
    expect(backend.supervisorChat).toHaveBeenCalledWith({ text: "加个按钮", project_id: "p-1" });
  });

  it("不带参数的通道在真实调用形状下照常返回（backend:status / supervisor:ready / high-risk:pending）", () => {
    const { ipc, invoke } = fakeIpcMain();
    const backend = fakeBackend();
    const send = vi.fn();
    serveBackend(ipc, backend, () => ({ send, isDestroyed: () => false }));
    serveHighRisk(ipc, backend, () => null);
    expect(invoke(IPC_CHANNELS.backendStatus)).toEqual({ mode: "live" });
    expect(invoke(IPC_CHANNELS.supervisorReady)).toEqual([{ text: "回放" }]);
    expect(send).toHaveBeenCalledWith(IPC_CHANNELS.supervisorNotify, { text: "回放" });
    expect(invoke(IPC_CHANNELS.highRiskPending)).toEqual([]);
  });

  it("preload → 主进程整条链路：IPC_CHANNELS 里每个 invoke 通道都按真实 Electron 形状往返，参数一一对应", async () => {
    vi.useFakeTimers();
    const { ipc, handlers, invoke } = fakeIpcMain();
    const backend = fakeBackend();
    const stops = wireAll(ipc, backend);
    // 渲染进程一侧：ipcRenderer.invoke(channel, ...args) → 主进程 handler(event, ...args)
    const seen = new Set<string>();
    const bridge: IpcRendererLike = {
      invoke: async (c, ...a) => {
        seen.add(c);
        return invoke(c, ...a);
      },
      on: () => {},
      removeListener: () => {},
    };
    const api = createDesktopApi(bridge, "linux");
    await expect(api.getSnapshot()).resolves.toBe(snap);
    await api.getBackendStatus();
    await api.markSupervisorReady();
    await expect(api.getPendingHighRisk()).resolves.toEqual([]);
    await api.decideHighRisk("T-9", "pr-1", "reject", "不要");
    expect(backend.decideHighRisk).toHaveBeenCalledWith("T-9", "pr-1", "reject", "不要");
    await api.getSyncState();
    await api.supervisorChat({ text: "hi", project_id: "p-2" });
    expect(backend.supervisorChat).toHaveBeenCalledWith({ text: "hi", project_id: "p-2" });
    // 以 IPC_CHANNELS 为准：新增 invoke 通道而这里没往返、或主进程没注册，都会失败
    expect([...seen].sort()).toEqual(INVOKE_CHANNELS);
    expect([...handlers.keys()].sort()).toEqual(INVOKE_CHANNELS);
    for (const stop of stops) stop();
    expect(handlers.size).toBe(0);
  });

  it("PUSH_ONLY 正好是主进程 send、preload 用 on 订阅的通道，且没有 handler", () => {
    const ipcSrc = readFileSync(path.join(here, "ipc.ts"), "utf8");
    const preloadSrc = readFileSync(path.join(here, "preload-api.ts"), "utf8");
    const keysOf = (src: string, re: RegExp) =>
      [...new Set([...src.matchAll(re)].map((m) => IPC_CHANNELS[m[1] as ChannelKey]))].sort();
    const push = [...PUSH_ONLY].sort();
    expect(keysOf(ipcSrc, /\.send\(\s*IPC_CHANNELS\.(\w+)/g)).toEqual(push);
    expect(keysOf(preloadSrc, /ipc\.on\(\s*IPC_CHANNELS\.(\w+)/g)).toEqual(push);
    const { ipc, handlers } = fakeIpcMain();
    wireAll(ipc, fakeBackend());
    for (const c of PUSH_ONLY) expect(handlers.has(c), c).toBe(false);
  });

  it("ipc.ts 导出的每个 serve* 都在本测试 wireAll 和 main.ts 里接上", () => {
    const exported = Object.keys(ipcModule)
      .filter((k) => /^serve[A-Z]/.test(k))
      .sort();
    expect(exported.length).toBeGreaterThan(0);
    expect(Object.keys(SERVE).sort()).toEqual(exported);
    const mainSrc = readFileSync(path.join(here, "main.ts"), "utf8");
    for (const name of exported) {
      expect(mainSrc, name).toMatch(new RegExp(`\\b${name}\\(\\s*ipcMain\\b`));
    }
  });

  it("ipc.ts 里每个 handle 的 listener 要么不带参数，要么是 (...args) 且不从 args[0] 取参数", () => {
    const src = readFileSync(path.join(here, "ipc.ts"), "utf8");
    const total = src.match(/\bipc\.handle\(/g)?.length ?? 0;
    const listeners = [
      ...src.matchAll(/\bipc\.handle\(\s*IPC_CHANNELS\.(\w+),\s*(?:async\s*)?\(([^)]*)\)\s*=>/g),
    ];
    // 每个 handle 都必须是能识别的箭头函数（写成 function / 变量引用的也要被发现）
    expect(listeners.length).toBe(total);
    expect(total).toBe(INVOKE_CHANNELS.length);
    for (const [, channel, params] of listeners) {
      const p = params!.trim();
      // (_e, x) => / (x) => 这类写法会把 event 当成渲染进程参数，一律不允许
      expect(p === "" || /^\.\.\.args(\s*:\s*unknown\[\])?$/.test(p), `${channel}: (${p})`).toBe(
        true,
      );
    }
    expect(src).not.toMatch(/\bargs\[0\]/);
  });
});

describe("同步状态 IPC（T-067）", () => {
  const live: DesktopSyncState = {
    available: true,
    enabled: true,
    last_ok_at: "2026-10-17T15:00:00.000Z",
    last_error: null,
    consecutive_failures: 0,
    rate_limited_until: null,
    next_at: "2026-10-17T15:01:00.000Z",
  };

  it("invoke sync:state 返回当前状态；变化才推 sync:state-update；停止后移除 handler", () => {
    vi.useFakeTimers();
    const { ipc, handlers, invoke } = fakeIpcMain();
    let current: DesktopSyncState = live;
    const send = vi.fn();
    const stop = serveSyncState(
      ipc,
      { syncState: () => current },
      () => ({ send, isDestroyed: () => false }),
      100,
    );
    expect(invoke(IPC_CHANNELS.syncState)).toEqual(live);
    vi.advanceTimersByTime(100);
    expect(send).not.toHaveBeenCalled();
    current = { ...live, enabled: false, disabled_reason: "auth", next_at: null };
    vi.advanceTimersByTime(100);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(IPC_CHANNELS.syncStateUpdate, current);
    vi.advanceTimersByTime(300);
    expect(send).toHaveBeenCalledTimes(1);
    stop();
    expect(handlers.has(IPC_CHANNELS.syncState)).toBe(false);
  });

  it("只读后端：sync:state 返回 available:false", () => {
    const { ipc, invoke } = fakeIpcMain();
    const ro: DesktopSyncState = { available: false, reason: "只读模式：写入锁被占用（pid 1）" };
    const stop = serveSyncState(ipc, { syncState: () => ro }, () => null, 100);
    expect(invoke(IPC_CHANNELS.syncState)).toEqual(ro);
    stop();
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
      "decideHighRisk",
      "getBackendStatus",
      "getPendingHighRisk",
      "getSnapshot",
      "getSyncState",
      "markSupervisorReady",
      "onPendingHighRisk",
      "onSupervisorNotify",
      "onSyncState",
      "onUpdate",
      "platform",
      "supervisorChat",
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

  it("getSyncState 走 sync:state；onSyncState 收 sync:state-update，取消后不再收到（T-067）", async () => {
    const ipc = fakeIpc();
    const api = createDesktopApi(ipc, "linux");
    await api.getSyncState();
    expect(ipc.invoke).toHaveBeenCalledWith(IPC_CHANNELS.syncState);
    const got: DesktopSyncState[] = [];
    const off = api.onSyncState((s) => got.push(s));
    const st: DesktopSyncState = { available: false, reason: "只读模式：x" };
    ipc.emit(IPC_CHANNELS.syncStateUpdate, st);
    off();
    ipc.emit(IPC_CHANNELS.syncStateUpdate, st);
    expect(got).toEqual([st]);
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
