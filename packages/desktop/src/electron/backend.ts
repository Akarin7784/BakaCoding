// T-063：桌面主进程后端——拿写入锁、组装组合根、takeOver；失败则退回只读。
import { constants as fsConstants } from "node:fs";
import { copyFile, lstat, mkdtemp, rm, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  acquireWriterLock,
  assemble,
  isTicketActive,
  createDefaultDeps,
  ensureBakacodingIgnored,
  type App,
  type DefaultDepsHandle,
  type WriterLock,
} from "@bakacoding/app";
import {
  ConfigError,
  getConfig,
  importProject as importProjectDefault,
  type Config,
  type Project,
} from "@bakacoding/config-budget";
import { exportPackage } from "@bakacoding/diagnostics";
import { GithubPrProvider } from "@bakacoding/pr";
import { HighRiskDecisionError } from "@bakacoding/scheduler";
import {
  openStorage,
  StorageLeaseError,
  type Storage,
  type StorageHealth,
} from "@bakacoding/storage";
import type { PendingHighRisk, TakeOverReport, UserMessage } from "@bakacoding/supervisor";
import type {
  DesktopBackendError,
  DesktopChatResult,
  DesktopDecideHighRiskResult,
  DesktopSyncState,
} from "../shared/api.js";
import { DB_PATH_ENV, DEFAULT_DB_RELATIVE, resolveDbPath } from "./config.js";
import { createSerialQueue, runSupervisorChat } from "./supervisor-chat.js";
import { backendErrorDetail } from "./backend-error.js";
import { errorDetail, toDesktopSyncState, unavailableSyncState } from "./sync-state.js";

/** 仓库路径：`--repo` > BAKACODING_REPO > cwd */
export const REPO_ENV = "BAKACODING_REPO";
/** 配置路径：`--config` > BAKACODING_CONFIG > `<repo>/config/models.json` */
export const CONFIG_ENV = "BAKACODING_CONFIG";

export type BackendMode = "live" | "readonly";

export interface BackendStatus {
  mode: BackendMode;
  /** 只读原因：只写变量名 / 错误名，不写密钥值 */
  reason?: string;
  /** 只读详情（UI-08）：已脱敏 */
  error?: DesktopBackendError;
  takeOver?: {
    enqueued: number;
    adopted: number;
    escalated: number;
    failed: number;
    held: number;
    skipped_invalid: number;
  };
  storage?: StorageHealth;
  /**
   * 重载进度（T-093，只由 BackendSwitcher 填）：queued = 等在途单跑完，waitingTickets 为当前在途单数；
   * running = 正在停起后端。没有重载在排队 / 进行时不出现。
   */
  reload?: { state: "queued"; waitingTickets: number; waitingChat: boolean } | { state: "running" };
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
  /** 上次导入的仓库路径（T-072）：优先级低于 `--repo` / BAKACODING_REPO，高于 cwd */
  lastRepo?: string;
  /** 测试钩子：组装好之后拿到 App（断言拆除时 10 退订、9 停定时 sync） */
  onAssembled?: (app: App) => void;
  /** 测试钩子：拿到 createDefaultDeps 的结果（T-093 断言重载后预算从台账恢复） */
  onDeps?: (handle: DefaultDepsHandle) => void;
  /** 测试注入：模块 3 的 importProject */
  importProject?: typeof importProjectDefault;
  /** 测试注入：模块 4 的 ensureBakacodingIgnored（T-078） */
  ensureIgnored?: (dir: string) => Promise<boolean>;
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
  /** 当前仓库根目录（T-072） */
  repoRoot(): string;
  /** PR 实现：live 时看 app.pr 是不是 GithubPrProvider；只读时没有 provider，按 local（T-072） */
  prMode(): "local" | "github";
  /** 进行中的单 ∪ 等裁决的高风险单，按 ticket_id 去重计数（T-072 切换前检查） */
  busyCount(): number;
  /**
   * 重载前的「在途」计数（T-093）：状态处于编码、评审（含重新评审、原地重写）、合并队列（含冲突）的单
   * ∪ 等裁决的高风险单，按 ticket_id 去重。pending（还没派单）不算：重载后它们按新配置派单。
   */
  runningCount(): number;
  /** 同上口径的 ticket_id 列表（T-093：排队时快照，只等这些单） */
  runningTicketIds(): string[];
  /** 主管对话在途（T-093）：串行队列里还有没结束的 chat()（含它触发的拆单派单）；在途时重载排队 */
  chatInFlight(): boolean;
  /** 用本后端的总线调 3 的 importProject（发 project_created）；只读抛错（T-072） */
  importCurrentRepo(): Promise<Project>;
  /** 用 11 的 exportPackage 导出当前仓库项目最近 24 小时的诊断包，复制到 target（T-072） */
  exportDiagnostics(target: string, now?: Date): Promise<string>;
  /** 主管 1:1 对话（T-071）：转给 10 的 chat()；只读 / 抛错为 ok:false，reason 已脱敏截断 */
  supervisorChat(message: UserMessage): Promise<DesktopChatResult>;
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
  lastRepo?: string,
): string {
  let fromArg: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--repo=")) fromArg = a.slice("--repo=".length);
    else if (a === "--repo" && argv[i + 1] !== undefined) fromArg = argv[i + 1];
  }
  return path.resolve(cwd, fromArg || env[REPO_ENV] || lastRepo || cwd);
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

/**
 * 切换项目前的「忙」计数（T-072）：ticket_id 的并集——2 的 listTickets() 里状态不是 merged / escalated 的单
 * （与 10 的 integrationIdle 同一判定 `isTicketActive`）∪ 10 的 pendingHighRisk() 的单。高风险待裁决的单在库里
 * 本来就是非终态，取并集避免重复计数。
 */
export function countBusy(
  tickets: readonly { ticket_id: string; status?: string | null }[],
  pendingHighRiskIds: readonly string[],
): number {
  const ids = new Set<string>(pendingHighRiskIds);
  for (const t of tickets) if (isTicketActive(t.status)) ids.add(t.ticket_id);
  return ids.size;
}

/** 挡住重载的状态（T-093）：编码、评审、重写、重新评审、合并队列、冲突。pending 与终态不挡。 */
export const RELOAD_BLOCKING_STATUSES: ReadonlySet<string> = new Set([
  "coding",
  "in_review",
  "resubmitting",
  "re_reviewing",
  "merge_queued",
  "conflict",
]);

/** 重载前的在途 ticket_id（T-093）：见 BackendHandle.runningCount。 */
export function runningIds(
  tickets: readonly { ticket_id: string; status?: string | null }[],
  pendingHighRiskIds: readonly string[],
): string[] {
  const ids = new Set<string>(pendingHighRiskIds);
  for (const t of tickets)
    if (t.status && RELOAD_BLOCKING_STATUSES.has(t.status)) ids.add(t.ticket_id);
  return [...ids];
}

/** 重载前的在途计数（T-093）：见 BackendHandle.runningCount。 */
export function countRunning(
  tickets: readonly { ticket_id: string; status?: string | null }[],
  pendingHighRiskIds: readonly string[],
): number {
  const ids = new Set<string>(pendingHighRiskIds);
  for (const t of tickets)
    if (t.status && RELOAD_BLOCKING_STATUSES.has(t.status)) ids.add(t.ticket_id);
  return ids.size;
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

  const repoRoot = resolveRepoPath(argv, env, cwd, opts.lastRepo);
  const doImport = opts.importProject ?? importProjectDefault;
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
  let startError: DesktopBackendError | undefined;
  let lock: WriterLock | undefined;
  let storage: Storage | undefined;
  let depsHandle: DefaultDepsHandle | undefined;
  let app: App | undefined;
  let takeOver: BackendStatus["takeOver"];
  const busUnsubs: Array<() => void> = [];
  const chatQueue = createSerialQueue();

  /**
   * 拆后端（T-105）：先同步退订，再 await 10/8/9 的 `app.stop()`（T-096：等 9 收尾，从不 reject），
   * 之后才 dispose deps、关库、放写锁——收尾里的写库不会落到已关的库上。
   * 开头就把句柄摘下来，收尾期间别的入口看到的已是「没有 app / storage」，重复调用也不会二次关库。
   */
  const cleanupPartial = async (): Promise<void> => {
    while (busUnsubs.length) {
      try {
        busUnsubs.pop()?.();
      } catch {
        /* ignore */
      }
    }
    const a = app;
    const h = depsHandle;
    const s = storage;
    const l = lock;
    app = undefined;
    depsHandle = undefined;
    storage = undefined;
    lock = undefined;
    try {
      await a?.stop();
    } catch {
      /* ignore：T-096 约定从不 reject，这里只兜底 */
    }
    try {
      h?.dispose();
    } catch {
      /* ignore */
    }
    try {
      s?.close();
    } catch {
      /* ignore */
    }
    if (l && "release" in l) {
      try {
        l.release();
      } catch {
        /* ignore */
      }
    }
  };
  let stopping: Promise<void> | undefined;

  // T-078：建写入锁 / 数据库之前先把 /.bakacoding/ 写进仓库的 .git/info/exclude；传仓库根（db 可能不在仓库里）。
  // 失败只记 warn（只记 errorDetail），不挡启动。
  try {
    if (!(await (opts.ensureIgnored ?? ensureBakacodingIgnored)(repoRoot)))
      logger.warn("仓库不是 git 仓库，未写 .git/info/exclude");
  } catch (e) {
    logger.warn(`写 .git/info/exclude 失败：${errorDetail(e)}`);
  }

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

      opts.onDeps?.(depsHandle);
      app = await assemble(depsHandle.deps);
      opts.onAssembled?.(app);
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
      startError = backendErrorDetail(e, repoRoot, env);
      logger.warn(`退回只读：${reason}`);
      await cleanupPartial();
    }
  }

  return {
    status(): BackendStatus {
      const st: BackendStatus = { mode };
      if (reason !== undefined) st.reason = reason;
      if (startError && mode === "readonly") st.error = startError;
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
    repoRoot: () => repoRoot,
    prMode: () => (app?.pr instanceof GithubPrProvider ? "github" : "local"),
    busyCount(): number {
      if (!storage || !app) return 0;
      return countBusy(
        storage.listTickets(),
        readPending().map((h) => h.ticket_id),
      );
    },
    chatInFlight: () => chatQueue.pending() > 0,
    runningTicketIds(): string[] {
      if (!storage || !app) return [];
      return runningIds(
        storage.listTickets(),
        readPending().map((h) => h.ticket_id),
      );
    },
    runningCount(): number {
      if (!storage || !app) return 0;
      return countRunning(
        storage.listTickets(),
        readPending().map((h) => h.ticket_id),
      );
    },
    async importCurrentRepo(): Promise<Project> {
      const live = app;
      if (!live) throw new Error(reason ? `只读模式：${reason}` : "只读模式：后端未接线");
      return doImport(repoRoot, { publish: (e) => live.bus.publish(e) });
    },
    async exportDiagnostics(target: string, now: Date = new Date()): Promise<string> {
      if (!storage || !app) {
        throw new Error(reason ? `只读模式：${reason}` : "只读模式：后端未接线");
      }
      // 不发事件，只算出当前仓库的 project_id（同一路径同一 id）
      const project = await doImport(repoRoot);
      const out_dir = await mkdtemp(path.join(tmpdir(), "bakacoding-diag-"));
      try {
        const zip = await exportPackage(
          {
            project_id: project.project_id,
            scope: {
              kind: "time_range",
              from: new Date(now.getTime() - 24 * 3600_000).toISOString(),
              to: now.toISOString(),
            },
          },
          { source: storage.diagnosticsSource(), out_dir, now: () => now },
        );
        await copyExclusive(zip, target);
        return target;
      } finally {
        await rm(out_dir, { recursive: true, force: true });
      }
    },
    supervisorChat(message: UserMessage): Promise<DesktopChatResult> {
      // 10 的 chat() 有状态（暂存 ask_project 的需求）：主进程串行，前一条回来才处理下一条
      return chatQueue(() => {
        const sup = app?.supervisor;
        return runSupervisorChat(sup ? (m) => sup.chat(m) : undefined, message, env, reason);
      });
    },
    stop(): Promise<void> {
      // T-105：等 app.stop() 收尾后再关库；重复调用返回同一个 Promise
      stopping ??= (async () => {
        await cleanupPartial();
        // 拆完就不再是 live（切换失败时不能还报 live）
        mode = "readonly";
        reason = reason ?? "后端已停止";
      })();
      return stopping;
    },
  };
}

export { resolveDbPath, DB_PATH_ENV, DEFAULT_DB_RELATIVE };

/**
 * 复制到 target，不跟随符号链接：用 COPYFILE_EXCL（O_EXCL，目标已存在含悬空链接都失败）。
 * 目标已存在且是普通文件（保存框里选了覆盖）→ 删掉再 EXCL 复制一次；是链接或别的就报错。
 */
export async function copyExclusive(src: string, target: string): Promise<void> {
  try {
    await copyFile(src, target, fsConstants.COPYFILE_EXCL);
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const st = await lstat(target);
  if (!st.isFile()) throw new Error("保存位置已存在且不是普通文件（可能是符号链接），已拒绝");
  await unlink(target);
  await copyFile(src, target, fsConstants.COPYFILE_EXCL);
}
