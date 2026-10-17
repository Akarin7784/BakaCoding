// T-063：桌面主进程后端——拿写入锁、组装组合根、takeOver；失败则退回只读。
import { existsSync } from "node:fs";
import path from "node:path";
import {
  acquireWriterLock,
  assemble,
  createDefaultDeps,
  type App,
  type DefaultDepsHandle,
  type WriterLock,
} from "@bakacoding/app";
import { ConfigError, getConfig, type Config } from "@bakacoding/config-budget";
import { HighRiskDecisionError } from "@bakacoding/scheduler";
import {
  openStorage,
  StorageLeaseError,
  type Storage,
  type StorageHealth,
} from "@bakacoding/storage";
import type { PendingHighRisk, TakeOverReport } from "@bakacoding/supervisor";
import type { DesktopDecideHighRiskResult, DesktopSyncState } from "../shared/api.js";
import { DB_PATH_ENV, DEFAULT_DB_RELATIVE, resolveDbPath } from "./config.js";
import { toDesktopSyncState, unavailableSyncState } from "./sync-state.js";

/** 仓库路径：`--repo` > BAKACODING_REPO > cwd */
export const REPO_ENV = "BAKACODING_REPO";
/** 配置路径：`--config` > BAKACODING_CONFIG > `<repo>/config/models.json` */
export const CONFIG_ENV = "BAKACODING_CONFIG";

export type BackendMode = "live" | "readonly";

export interface BackendStatus {
  mode: BackendMode;
  /** 只读原因：只写变量名 / 错误名，不写密钥值 */
  reason?: string;
  takeOver?: {
    enqueued: number;
    adopted: number;
    escalated: number;
    failed: number;
    held: number;
    skipped_invalid: number;
  };
  storage?: StorageHealth;
}

export interface NotifyMessage {
  text: string;
  project_id?: string;
  requirement_id?: string;
}

export interface BackendOptions {
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  nativeBinding?: string;
  logger?: {
    warn(message: string, detail?: unknown): void;
    error?(message: string, detail?: unknown): void;
  };
  openStorage?: typeof openStorage;
  getConfig?: (path: string) => Config;
  pricingPath?: string;
}

export interface BackendHandle {
  status(): BackendStatus;
  /** 渲染进程就绪后调用一次：回放缓冲的通知并清空 */
  markRendererReady(): NotifyMessage[];
  pendingNotifications(): readonly NotifyMessage[];
  /** live 模式下，渲染就绪后新通知走这里 */
  onNotify(listener: (m: NotifyMessage) => void): () => void;
  /** 等裁决的高风险清单（同步；只读为空）（T-062） */
  pendingHighRisk(): PendingHighRisk[];
  /** 放行 / 拒绝；只读或未接线返回 unavailable（T-062） */
  decideHighRisk(
    ticket_id: string,
    pr_id: string,
    decision: "release" | "reject",
    detail?: string,
  ): Promise<DesktopDecideHighRiskResult>;
  /** 清单变化时通知（onHighRiskHeld / escalated / 裁决后等）（T-062） */
  onPendingHighRisk(listener: (list: PendingHighRisk[]) => void): () => void;
  /** 主动再取一次清单并推给订阅方（PR 状态变化时由 IPC 层调用） */
  refreshPendingHighRisk(): void;
  /** 9 的定时同步状态（T-067）；只读 / 未接线为 available:false；错误信息已脱敏截断 */
  syncState(): DesktopSyncState;
  stop(): Promise<void>;
}

const NOTIFY_BUFFER_MAX = 200;

export class NotifyBuffer {
  private buf: NotifyMessage[] = [];
  private ready = false;
  private listeners: Array<(m: NotifyMessage) => void> = [];
  constructor(
    private readonly max = NOTIFY_BUFFER_MAX,
    private readonly onOverflow?: () => void,
  ) {}
  push(message: NotifyMessage): void {
    if (!this.ready) {
      this.buf.push(message);
      while (this.buf.length > this.max) {
        this.buf.shift();
        this.onOverflow?.();
      }
      return;
    }
    for (const l of this.listeners) l(message);
  }
  markReady(): NotifyMessage[] {
    this.ready = true;
    return this.buf.splice(0, this.buf.length);
  }
  pending(): readonly NotifyMessage[] {
    return this.buf;
  }
  onNotify(listener: (m: NotifyMessage) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }
}

export function resolveRepoPath(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): string {
  let fromArg: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--repo=")) fromArg = a.slice("--repo=".length);
    else if (a === "--repo" && argv[i + 1] !== undefined) fromArg = argv[i + 1];
  }
  return path.resolve(cwd, fromArg || env[REPO_ENV] || cwd);
}

export function resolveConfigPath(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  repoRoot: string,
): string {
  let fromArg: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--config=")) fromArg = a.slice("--config=".length);
    else if (a === "--config" && argv[i + 1] !== undefined) fromArg = argv[i + 1];
  }
  const p = fromArg || env[CONFIG_ENV] || path.join("config", "models.json");
  return path.isAbsolute(p) ? p : path.resolve(repoRoot, p);
}

/** `--db` / BAKACODING_DB_PATH > `<repo>/.bakacoding/bakacoding.db`（相对路径相对 repo） */
export function resolveRepoDbPath(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  repoRoot: string,
): string {
  let fromArg: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--db=")) fromArg = a.slice("--db=".length);
    else if (a === "--db" && argv[i + 1] !== undefined) fromArg = argv[i + 1];
  }
  if (fromArg) return path.resolve(repoRoot, fromArg);
  if (env[DB_PATH_ENV]) return path.resolve(repoRoot, env[DB_PATH_ENV]!);
  return path.join(repoRoot, DEFAULT_DB_RELATIVE);
}

function takeOverCounts(r: TakeOverReport): NonNullable<BackendStatus["takeOver"]> {
  return {
    enqueued: r.enqueued.length,
    adopted: r.adopted.length,
    escalated: r.escalated.length,
    failed: r.failed.length,
    held: r.held.length,
    skipped_invalid: r.skipped_invalid.length,
  };
}

function readonlyReasonFromError(e: unknown): string {
  if (e instanceof StorageLeaseError) return "库被其他进程占用（StorageLeaseError）";
  if (e instanceof ConfigError) {
    if (e.message.includes("DEEPSEEK_API_KEY")) return "缺少环境变量 DEEPSEEK_API_KEY";
    return "配置校验失败（ConfigError）";
  }
  const name = e instanceof Error ? e.name : "unknown";
  // 绝不把 Error.message 原样透出（可能含路径里的敏感片段以外的值）；只用名字
  return `启动失败（${name}）`;
}

/**
 * 启动后端：写入锁 → openStorage → getConfig → createDefaultDeps → assemble（含 takeOver）。
 * 失败（缺密钥、坏配置、锁被占、StorageLeaseError）→ 只读，reason 只含变量名 / 错误名。
 */
export async function startBackend(opts: BackendOptions = {}): Promise<BackendHandle> {
  const argv = opts.argv ?? process.argv;
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const logger = opts.logger ?? {
    warn: (m: string, d?: unknown) => console.warn(`[desktop/backend] ${m}`, d ?? ""),
  };
  const open = opts.openStorage ?? openStorage;
  const loadConfig = opts.getConfig ?? getConfig;

  const repoRoot = resolveRepoPath(argv, env, cwd);
  const dbPath = resolveRepoDbPath(argv, env, repoRoot);
  const configPath = resolveConfigPath(argv, env, repoRoot);

  const notify = new NotifyBuffer(NOTIFY_BUFFER_MAX, () =>
    logger.warn(`supervisor 通知缓冲已满（${NOTIFY_BUFFER_MAX}），丢弃最旧的一条`),
  );
  const pendingListeners: Array<(list: PendingHighRisk[]) => void> = [];
  const emitPending = (list: PendingHighRisk[]): void => {
    for (const l of pendingListeners) l(list);
  };
  const readPending = (): PendingHighRisk[] => {
    if (!app) return [];
    try {
      return app.supervisor.pendingHighRisk();
    } catch (e) {
      logger.warn("pendingHighRisk 失败", e);
      return [];
    }
  };
  const refreshPendingHighRisk = (): void => {
    emitPending(readPending());
  };

  // 主管通知（含 highRiskHeld）之后刷新待裁决清单
  const notifyUser = (message: NotifyMessage): void => {
    notify.push(message);
    refreshPendingHighRisk();
  };

  let mode: BackendMode = "readonly";
  let reason: string | undefined;
  let lock: WriterLock | undefined;
  let storage: Storage | undefined;
  let depsHandle: DefaultDepsHandle | undefined;
  let app: App | undefined;
  let takeOver: BackendStatus["takeOver"];
  const busUnsubs: Array<() => void> = [];

  const cleanupPartial = (): void => {
    while (busUnsubs.length) {
      try {
        busUnsubs.pop()?.();
      } catch {
        /* ignore */
      }
    }
    try {
      app?.stop();
    } catch {
      /* ignore */
    }
    app = undefined;
    try {
      depsHandle?.dispose();
    } catch {
      /* ignore */
    }
    depsHandle = undefined;
    try {
      storage?.close();
    } catch {
      /* ignore */
    }
    storage = undefined;
    if (lock && "release" in lock) {
      try {
        lock.release();
      } catch {
        /* ignore */
      }
    }
    lock = undefined;
  };

  const acquired = acquireWriterLock(dbPath);
  if ("heldBy" in acquired) {
    reason = `写入锁被占用（pid ${acquired.heldBy}）`;
    logger.warn(`退回只读：${reason}`);
  } else {
    lock = acquired;
    try {
      storage = open({
        path: dbPath,
        ...(opts.nativeBinding !== undefined && { nativeBinding: opts.nativeBinding }),
        logger: { warn: (m) => logger.warn(m) },
      });

      if (!existsSync(configPath)) {
        throw new ConfigError([
          `配置文件不存在：请设置 ${CONFIG_ENV} 或提供 <repo>/config/models.json`,
        ]);
      }
      const config = loadConfig(configPath);

      depsHandle = await createDefaultDeps(config, storage, {
        repoRoot,
        notifyUser,
        ...(opts.pricingPath !== undefined && { pricingPath: opts.pricingPath }),
        env,
        logger: { warn: (m, d) => logger.warn(m, d) },
        onError: (err, where) => logger.warn(String(where), err),
      });

      app = await assemble(depsHandle.deps);
      takeOver = takeOverCounts(app.takeOver);
      // 上报 / 单级警告（含高风险拒绝未生效）后刷新清单；不新增事件类型
      busUnsubs.push(
        app.bus.subscribe("escalated", () => {
          refreshPendingHighRisk();
        }),
      );
      busUnsubs.push(
        app.bus.subscribe("ticket_warning", () => {
          refreshPendingHighRisk();
        }),
      );
      mode = "live";
      reason = undefined;
    } catch (e) {
      reason = readonlyReasonFromError(e);
      logger.warn(`退回只读：${reason}`);
      cleanupPartial();
    }
  }

  return {
    status(): BackendStatus {
      const st: BackendStatus = { mode };
      if (reason !== undefined) st.reason = reason;
      if (takeOver) st.takeOver = takeOver;
      if (storage) {
        try {
          st.storage = storage.health();
        } catch {
          /* ignore */
        }
      }
      return st;
    },
    markRendererReady(): NotifyMessage[] {
      const replay = notify.markReady();
      // 渲染就绪时推一次当前清单
      refreshPendingHighRisk();
      return replay;
    },
    pendingNotifications: () => notify.pending(),
    onNotify(listener) {
      return notify.onNotify(listener);
    },
    pendingHighRisk: () => readPending(),
    async decideHighRisk(ticket_id, pr_id, decision, detail) {
      if (!app) {
        return {
          ok: false,
          code: "unavailable",
          message: "后端只读或未接线，不能裁决高风险 PR",
        };
      }
      try {
        const result = await app.supervisor.decideHighRisk(ticket_id, pr_id, decision, detail);
        refreshPendingHighRisk();
        return { ok: true, result };
      } catch (e) {
        refreshPendingHighRisk();
        if (e instanceof HighRiskDecisionError) {
          const message = e.code === "stale_pr" ? "PR 已更新，请重新查看" : e.message;
          return { ok: false, code: e.code, message };
        }
        const message = e instanceof Error ? e.message : String(e);
        return { ok: false, code: "unavailable", message };
      }
    },
    onPendingHighRisk(listener) {
      pendingListeners.push(listener);
      return () => {
        const i = pendingListeners.indexOf(listener);
        if (i >= 0) pendingListeners.splice(i, 1);
      };
    },
    refreshPendingHighRisk,
    syncState(): DesktopSyncState {
      if (!app) return unavailableSyncState(reason);
      try {
        return toDesktopSyncState(app.scheduler.syncState(), env);
      } catch (e) {
        const name = e instanceof Error ? e.name : "unknown";
        logger.warn(`syncState 失败（${name}）`);
        return { available: false, reason: `读取同步状态失败（${name}）` };
      }
    },
    async stop() {
      cleanupPartial();
    },
  };
}

export { resolveDbPath, DB_PATH_ENV, DEFAULT_DB_RELATIVE };
