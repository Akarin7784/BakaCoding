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
  serveBackendReload,
  serveHighRisk,
  serveProjectSettings,
  serveReader,
  serveRepoFix,
  serveSecretProvider,
  serveSupervisorChat,
  serveSyncState,
  serveAbout,
  serveModelSettings,
  serveProjectList,
  serveWindowTheme,
  type IpcMainLike,
} from "./ipc.js";
import type { ProjectSettingsDeps } from "./project-settings-ipc.js";
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
    // T-072：serveProjectSettings 用到的成员（BackendSwitcher 的 switchTo 也放进来）
    repoRoot: vi.fn(() => "/repo"),
    prMode: vi.fn(() => "local" as const),
    exportDiagnostics: vi.fn(async (t: string) => t),
    switchTo: vi.fn(async () => ({ ok: false as const, reason: "x" })),
    // T-093：BackendSwitcher 的 reload / reconnect
    reload: vi.fn(async () => ({
      state: "queued" as const,
      waitingTickets: 2,
      waitingChat: false,
    })),
    reconnect: vi.fn(async () => ({ state: "reloaded" as const })),
    // UI-07d：设置 › 项目
    listProjects: vi.fn(() => [
      {
        project_id: "p-1",
        name: "demo",
        created_at: "2026-10-24T00:00:00.000Z",
        repo_path: "/abs/demo",
      },
    ]),
    removeProject: vi.fn(async () => ({ removed: true })),
    // UI-07e：ledger:summary
    ledgerStore: vi.fn(() => ({
      totalsByProject: async () => ({
        total_micro_usd: 1_500_000,
        resubmit_micro_usd: 0,
        entries: 2,
        by_role: { coder: 1_500_000, sub_agent: 0, reviewer: 0, supervisor: 0 },
      }),
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
  IPC_CHANNELS.appQuitting,
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
  // UI-07a：设置 › 关于
  serveAbout: (ipc) => serveAbout(ipc, () => ({ version: "1.0.0", commit: "cbd3b41" })),
  // UI-07b：设置 › 模型；仓库不存在，读 / 写都在形状检查后失败，链路测试只看往返
  serveModelSettings: (ipc) =>
    serveModelSettings(ipc, {
      repoRoot: () => "/nonexistent-ui07b",
      repoSource: () => "arg",
      argv: [],
      env: {},
      running: () => 0,
      reload: async () => ({ state: "reloaded" as const }),
      writeConfig: async () => ({ ok: true as const }),
      writePricing: async () => ({ ok: true as const }),
    }),
  serveWindowTheme: (ipc) =>
    serveWindowTheme(ipc, { setThemeSource: (s) => s === "dark", applyTitleBar: () => {} }),
  serveBackendReload: (ipc, backend) =>
    serveBackendReload(ipc, backend as unknown as Parameters<typeof serveBackendReload>[1]),
  // UI-03a：修复函数注入假的，链路测试只看参数往返
  serveRepoFix: (ipc) =>
    serveRepoFix(ipc, {
      repoRoot: () => "/repo",
      repoSource: () => "last_import",
      reconnect: async () => ({ state: "reloaded" as const }),
      fns: {
        checkRepo: async () => ({
          items: [{ id: "git" as const, ok: true }],
          current_branch: "main",
          identity: { name: true, email: true },
        }),
        initRepo: async () => {},
        listInitialCommitFiles: async () => ({ include: ["a.txt"], excluded: [] }),
        initialCommit: async () => ({ commit: "c0ffee" }),
        createMainBranch: async () => ({ from: "master" }),
      },
      // T-113：生成配置注入假的，只看参数原样到主进程
      config: {
        inspect: () => ({ models: "ok", pricing: "ok", models_external: false, errors: [] }),
        initConfig: async (arg: unknown) => ({
          ok: true as const,
          written: ["models" as const],
          backups: [JSON.stringify(arg)],
          excluded: true,
          reload: { state: "reloaded" as const },
        }),
      },
    }),
  // UI-03b：3 的密钥函数注入假的，链路测试只看参数往返
  serveSecretProvider: (ipc) =>
    serveSecretProvider(ipc, {
      secretDeps: {},
      backend: {
        status: () => ({ mode: "live" as const }),
        reconnect: async () => ({ state: "reloaded" as const }),
        testConnection: async () => ({ ok: true as const, latency_ms: 5, cost_micro_usd: 1 }),
      },
      fns: {
        secretStatus: async () => ({ set: true, source: "bakacoding" as const, last4: "WXYZ" }),
        setUserSecret: async () => ({ ok: true as const, last4: "WXYZ" }),
        clearUserSecret: async () => ({ ok: true as const }),
      },
    }),
  // UI-07d：设置 › 项目；打开文件夹注入假的 openPath / isDirectory
  serveProjectList: (ipc, backend) =>
    serveProjectList(ipc, { backend, openPath: async () => "", isDirectory: () => true }),
  serveProjectSettings: (ipc, backend) =>
    serveProjectSettings(ipc, {
      backend: backend as unknown as ProjectSettingsDeps["backend"],
      argv: [],
      env: {},
      pickDirectory: async () => null,
      pickSavePath: async () => null,
      downloadsDir: "/dl",
      saveLastRepo: () => {},
      openDataDir: async () => {},
    }),
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
    // T-072：三个无参数通道（主进程自己弹对话框；这里对话框取消）
    await expect(api.importProject()).resolves.toEqual({ ok: false, canceled: true });
    // T-081：没有待创建配置的目录时拒绝
    await expect(api.createDefaultConfig()).resolves.toMatchObject({ ok: false });
    await expect(api.openDataDir()).resolves.toEqual({ ok: true });
    await expect(api.exportDiagnostics()).resolves.toEqual({
      ok: false,
      canceled: true,
      reason: "已取消",
    });
    await expect(api.getSettings()).resolves.toMatchObject({ repo: "/repo", mode: "local" });
    // UI-07a：关于（无参数）
    await expect(api.getAbout!()).resolves.toMatchObject({ version: "1.0.0", commit: "cbd3b41" });
    // UI-07b：设置 › 模型
    await expect(api.getModelConfig!()).resolves.toMatchObject({ ok: false, code: "read_failed" });
    await expect(api.saveModelConfig!({ form: {} as never, pricing: {} })).resolves.toMatchObject({
      ok: false,
      code: "invalid_input",
      written: [],
    });
    // UI-07c：设置 › 预算（状态无参数；保存走同一个 settings:save）
    await expect(api.getBudgetStatus!()).resolves.toMatchObject({ ok: false, code: "read_failed" });
    await expect(api.saveBudget!({ budget: {} as never })).resolves.toMatchObject({
      ok: false,
      code: "invalid_input",
      written: [],
    });
    // UI-02：主题同步
    await expect(api.setWindowTheme!("dark")).resolves.toEqual({ ok: true, dark: true });
    // T-093：重载 / 重新连接（无参数）
    await expect(api.reloadBackend()).resolves.toEqual({
      state: "queued",
      waitingTickets: 2,
      waitingChat: false,
    });
    await expect(api.reconnectBackend()).resolves.toEqual({ state: "reloaded" });
    // UI-03a：仓库检查与修复
    await expect(api.checkRepo!()).resolves.toMatchObject({ ok: true });
    await expect(api.initRepo!()).resolves.toEqual({ ok: true, reload: { state: "reloaded" } });
    await expect(api.listInitialFiles!()).resolves.toEqual({
      ok: true,
      include: ["a.txt"],
      excluded: [],
    });
    await expect(api.initialCommit!({ files: ["a.txt"] })).resolves.toEqual({
      ok: true,
      commit: "c0ffee",
      reload: { state: "reloaded" },
    });
    await expect(api.createMainBranch!()).resolves.toEqual({
      ok: true,
      from: "master",
      reload: { state: "reloaded" },
    });
    // T-113：生成配置
    await expect(api.initConfig!({ daily_micro_usd: 7, confirm_overwrite: true })).resolves.toEqual(
      {
        ok: true,
        written: ["models"],
        backups: ['{"daily_micro_usd":7,"confirm_overwrite":true}'],
        excluded: true,
        reload: { state: "reloaded" },
      },
    );
    // UI-03b：密钥与测试连接
    const st = { set: true, source: "bakacoding", last4: "WXYZ" };
    await expect(api.secretStatus!("DEEPSEEK_API_KEY")).resolves.toEqual({ ok: true, status: st });
    await expect(api.setSecret!("DEEPSEEK_API_KEY", "sk-wire-test-WXYZ")).resolves.toEqual({
      ok: true,
      status: st,
    });
    await expect(api.clearSecret!("GITHUB_TOKEN")).resolves.toEqual({ ok: true, status: st });
    await expect(api.testProvider!({ provider: "deepseek" })).resolves.toEqual({
      ok: true,
      latency_ms: 5,
      cost_micro_usd: 1,
    });
    // UI-07d：设置 › 项目（列表无参数；移除 / 打开文件夹只传 project_id）
    await expect(api.listProjects!()).resolves.toEqual({
      ok: true,
      projects: [{ project_id: "p-1", name: "demo", repo_path: "/abs/demo" }],
    });
    await expect(api.removeProject!("p-1")).resolves.toEqual({ ok: true, removed: true });
    expect(backend.removeProject).toHaveBeenCalledWith("p-1");
    await expect(api.openProjectFolder!("p-1")).resolves.toEqual({ ok: true });
    // UI-07e：设置 › 预算 各项目累计花费（无参数；不带路径）
    await expect(api.getLedgerSummary!()).resolves.toEqual({
      ok: true,
      projects: [
        {
          project_id: "p-1",
          name: "demo",
          total_micro_usd: 1_500_000,
          resubmit_micro_usd: 0,
          entries: 2,
          by_role: { coder: 1_500_000, sub_agent: 0, reviewer: 0, supervisor: 0 },
        },
      ],
    });
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
      "checkRepo",
      "clearSecret",
      "createDefaultConfig",
      "createMainBranch",
      "decideHighRisk",
      "exportDiagnostics",
      "getAbout",
      "getBackendStatus",
      "getBudgetStatus",
      "getLedgerSummary",
      "getModelConfig",
      "getPendingHighRisk",
      "getSettings",
      "getSnapshot",
      "getSyncState",
      "importProject",
      "initConfig",
      "initRepo",
      "initialCommit",
      "listInitialFiles",
      "listProjects",
      "markSupervisorReady",
      "onPendingHighRisk",
      "onQuitting",
      "onSupervisorNotify",
      "onSyncState",
      "onUpdate",
      "openDataDir",
      "openProjectFolder",
      "platform",
      "reconnectBackend",
      "reloadBackend",
      "removeProject",
      "saveBudget",
      "saveModelConfig",
      "secretStatus",
      "setSecret",
      "setWindowTheme",
      "supervisorChat",
      "testProvider",
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

describe("diagnostics:export 粒度与数据目录（T-130）", () => {
  function setup(over: Partial<ProjectSettingsDeps> = {}) {
    const { ipc, invoke, handlers } = fakeIpcMain();
    const backend = fakeBackend();
    const deps: ProjectSettingsDeps = {
      backend: backend as unknown as ProjectSettingsDeps["backend"],
      argv: [],
      env: {},
      pickDirectory: async () => null,
      pickSavePath: async () => path.join(process.cwd(), "out.zip"),
      downloadsDir: "/dl",
      saveLastRepo: () => {},
      now: () => new Date("2026-10-18T12:00:00Z"),
      ...over,
    };
    const stop = serveProjectSettings(ipc, deps);
    return { invoke, backend, stop, handlers };
  }

  it("省略参数：不传 options（后端按最近 24 小时），保存框 / 保存路径校验不变", async () => {
    const { invoke, backend } = setup();
    await expect(invoke(IPC_CHANNELS.diagnosticsExport)).resolves.toEqual({
      ok: true,
      path: path.join(process.cwd(), "out.zip"),
    });
    expect(backend.exportDiagnostics).toHaveBeenCalledWith(
      path.join(process.cwd(), "out.zip"),
      undefined,
      new Date("2026-10-18T12:00:00Z"),
    );
  });

  it("三种合法粒度原样透传", async () => {
    const cases = [
      { scope: { kind: "ticket", ticket_id: "T-9" } },
      { scope: { kind: "requirement", requirement_id: "R-9" } },
      { scope: { kind: "time_range", from: "2026-10-17T00:00:00Z", to: "2026-10-18T00:00:00Z" } },
    ] as const;
    for (const arg of cases) {
      const { invoke, backend } = setup();
      await expect(invoke(IPC_CHANNELS.diagnosticsExport, arg)).resolves.toEqual({
        ok: true,
        path: path.join(process.cwd(), "out.zip"),
      });
      expect(backend.exportDiagnostics).toHaveBeenCalledWith(
        path.join(process.cwd(), "out.zip"),
        arg,
        new Date("2026-10-18T12:00:00Z"),
      );
    }
  });

  it("非法参数：固定文案、不调用后端、不弹保存框", async () => {
    const badArgs: unknown[] = [
      "x",
      42,
      { scope: "ticket" },
      { scope: { kind: "ticket", ticket_id: "" } },
      { scope: { kind: "ticket", ticket_id: "x".repeat(201) } },
      { scope: { kind: "ticket", ticket_id: 7 } },
      { scope: { kind: "requirement" } },
      { scope: { kind: "time_range", from: "nope", to: "2026-10-18T00:00:00Z" } },
      { scope: { kind: "time_range", from: "2026-10-17", to: "2026-10-18T00:00:00Z" } },
      { scope: { kind: "time_range", from: "10/17/2026", to: "2026-10-18T00:00:00Z" } },
      { scope: { kind: "time_range", from: "Sat Oct 17 2026", to: "2026-10-18T00:00:00Z" } },
      { scope: { kind: "time_range", from: "2026-10-17 08:00", to: "2026-10-18T00:00:00Z" } },
      { scope: { kind: "time_range", from: "2026-10-17T08:00:00", to: "2026-10-18T00:00:00Z" } },
      { scope: { kind: "time_range", from: "2026-02-30T00:00:00Z", to: "2026-10-18T00:00:00Z" } },
      { scope: { kind: "time_range", from: "2026-10-17T24:00:00Z", to: "2026-10-18T00:00:00Z" } },
      { scope: { kind: "time_range", from: "2026-10-18T02:00:00Z", to: "2026-10-18T01:00:00Z" } },
      { scope: { kind: "weird" } },
    ];
    for (const arg of badArgs) {
      const pickSavePath = vi.fn(async () => path.join(process.cwd(), "out.zip"));
      const { invoke, backend } = setup({ pickSavePath });
      await expect(invoke(IPC_CHANNELS.diagnosticsExport, arg)).resolves.toEqual({
        ok: false,
        reason: "导出参数不合法",
      });
      expect(backend.exportDiagnostics).not.toHaveBeenCalled();
      expect(pickSavePath).not.toHaveBeenCalled();
    }
  });

  it("open-data-dir：成功 / 注入失败固定文案 / 未注入", async () => {
    const ok = setup({ openDataDir: async () => {} });
    await expect(ok.invoke(IPC_CHANNELS.diagnosticsOpenDataDir)).resolves.toEqual({ ok: true });

    const failing = setup({
      openDataDir: async () => {
        throw new Error("boom C:\\secret\\path");
      },
    });
    const r = await failing.invoke(IPC_CHANNELS.diagnosticsOpenDataDir);
    expect(r).toEqual({ ok: false, reason: "打开数据目录失败" });
    expect(JSON.stringify(r)).not.toContain("secret");

    const missing = setup();
    await expect(missing.invoke(IPC_CHANNELS.diagnosticsOpenDataDir)).resolves.toEqual({
      ok: false,
      reason: "没有连接主进程，不能打开数据目录",
    });
  });

  it("停止时注销两个新通道", () => {
    const { stop, handlers } = setup();
    expect(handlers.has(IPC_CHANNELS.diagnosticsExport)).toBe(true);
    expect(handlers.has(IPC_CHANNELS.diagnosticsOpenDataDir)).toBe(true);
    stop();
    expect(handlers.has(IPC_CHANNELS.diagnosticsExport)).toBe(false);
    expect(handlers.has(IPC_CHANNELS.diagnosticsOpenDataDir)).toBe(false);
  });
});

const { isStrictIsoDateTime } = ipcModule;

describe("isStrictIsoDateTime（T-137）", () => {
  it("接受带时区的 ISO 日期时间", () => {
    for (const v of [
      "2026-10-18T00:00:00Z",
      "2026-10-18T00:00:00.000Z",
      "2026-10-18T08:00+08:00",
      "2024-02-29T12:30:45-05:30",
    ])
      expect(isStrictIsoDateTime(v)).toBe(true);
  });
  it("拒绝 Date.parse 会放过的非 ISO 写法和不存在的日期", () => {
    for (const v of [
      "2026-10-18",
      "10/18/2026",
      "Sat Oct 18 2026",
      "2026-10-18 08:00",
      "2026-10-18T08:00:00",
      "2026-02-30T00:00:00Z",
      "2025-02-29T00:00:00Z",
      "2026-10-18T24:00:00Z",
      " 2026-10-18T00:00:00Z",
      7,
    ])
      expect(isStrictIsoDateTime(v)).toBe(false);
  });
});
