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
import {
  openStorage,
  StorageLeaseError,
  type Storage,
  type StorageHealth,
} from "@bakacoding/storage";
import type { TakeOverReport } from "@bakacoding/supervisor";
import { DB_PATH_ENV, DEFAULT_DB_RELATIVE, resolveDbPath } from "./config.js";

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
  const notifyUser = (message: NotifyMessage): void => notify.push(message);

  let mode: BackendMode = "readonly";
  let reason: string | undefined;
  let lock: WriterLock | undefined;
  let storage: Storage | undefined;
  let depsHandle: DefaultDepsHandle | undefined;
  let app: App | undefined;
  let takeOver: BackendStatus["takeOver"];

  const cleanupPartial = (): void => {
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
      return notify.markReady();
    },
    pendingNotifications: () => notify.pending(),
    onNotify(listener) {
      return notify.onNotify(listener);
    },
    async stop() {
      cleanupPartial();
    },
  };
}

export { resolveDbPath, DB_PATH_ENV, DEFAULT_DB_RELATIVE };
