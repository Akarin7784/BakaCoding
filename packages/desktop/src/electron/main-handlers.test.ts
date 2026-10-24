// UI-06e：main.ts 的 handler 注册 / 停止（registerMainHandlers）——每个 invoke 通道都注册且只注册一次，
// 停止后全部移除（含 integrationReview、supervisorSplit、supervisorHistory），重复停止无效，定时器也停掉。
import { afterEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../shared/api.js";
import type { IpcMainLike } from "./ipc.js";
import { registerMainHandlers, type MainHandlerDeps } from "./main-handlers.js";

afterEach(() => vi.useRealTimers());

const PUSH_ONLY: readonly string[] = [
  IPC_CHANNELS.update,
  IPC_CHANNELS.supervisorNotify,
  IPC_CHANNELS.highRiskPendingUpdate,
  IPC_CHANNELS.syncStateUpdate,
  IPC_CHANNELS.appQuitting,
];
const INVOKE = Object.values(IPC_CHANNELS)
  .filter((c) => !PUSH_ONLY.includes(c))
  .sort();

function fakeIpc() {
  const handlers = new Map<string, unknown>();
  const removed: string[] = [];
  const ipc: IpcMainLike = {
    handle(c, h) {
      // 同 Electron：同一通道注册两次抛错
      if (handlers.has(c)) throw new Error(`duplicate handler ${c}`);
      handlers.set(c, h);
    },
    removeHandler(c) {
      removed.push(c);
      handlers.delete(c);
    },
  };
  return { ipc, handlers, removed };
}

const deps = (): MainHandlerDeps =>
  ({
    backend: {
      onNotify: () => () => {},
      onPendingHighRisk: () => () => {},
      onSyncState: () => () => {},
      refreshPendingHighRisk: () => {},
      syncState: () => null,
      status: () => ({}),
      repoRoot: () => "/r",
    },
    reader: { snapshot: () => ({}), poll: () => null, close: () => {} },
    sink: () => null,
    env: {},
    projectSettings: {},
    about: () => ({}),
    windowTheme: {},
    repoFix: {},
    modelSettings: {},
    projectList: {},
    secretProvider: {},
  }) as unknown as MainHandlerDeps;

describe("registerMainHandlers（main.ts 的 handler 注册与停止）", () => {
  it("注册全部 invoke 通道，没有 push 通道", () => {
    vi.useFakeTimers();
    const { ipc, handlers } = fakeIpc();
    const stop = registerMainHandlers(ipc, deps());
    expect([...handlers.keys()].sort()).toEqual(INVOKE);
    for (const c of [
      IPC_CHANNELS.integrationReview,
      IPC_CHANNELS.supervisorSplit,
      IPC_CHANNELS.supervisorHistory,
      IPC_CHANNELS.mainMerge,
    ])
      expect(handlers.has(c), c).toBe(true);
    for (const c of PUSH_ONLY) expect(handlers.has(c), c).toBe(false);
    stop();
  });

  it("停止后每个通道都移除且只移除一次；再停一次无效；轮询定时器停掉", () => {
    vi.useFakeTimers();
    const { ipc, handlers, removed } = fakeIpc();
    const stop = registerMainHandlers(ipc, deps());
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    stop();
    expect(handlers.size).toBe(0);
    expect([...removed].sort()).toEqual(INVOKE);
    expect(vi.getTimerCount()).toBe(0);
    stop();
    expect(removed.length).toBe(INVOKE.length);
  });

  it("停止后可以重新注册（同一 ipc 不会撞上残留的 handler）", () => {
    vi.useFakeTimers();
    const { ipc, handlers } = fakeIpc();
    registerMainHandlers(ipc, deps())();
    const stop = registerMainHandlers(ipc, deps());
    expect([...handlers.keys()].sort()).toEqual(INVOKE);
    stop();
  });
});

describe("main.ts 接线", () => {
  it("main.ts 用 registerMainHandlers 注册，并在 afterStop 里停止；不再直接调 serve*", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
    expect(src).toMatch(/const stopHandlers = registerMainHandlers\(ipcMain,/);
    expect(src).toMatch(/afterStop\(\) \{\s*stopHandlers\(\);/);
    expect(src).not.toMatch(/\bserve[A-Z]\w*\(ipcMain/);
  });
});
