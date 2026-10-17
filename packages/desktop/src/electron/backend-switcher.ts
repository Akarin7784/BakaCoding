// T-072：一次组装只对应一个仓库。导入项目时拆掉旧后端、在新仓库上重新组装，桌面侧订阅转到新后端。
import type { Project } from "@bakacoding/config-budget";
import type { PendingHighRisk } from "@bakacoding/supervisor";
import type { BackendHandle, BackendStatus, NotifyMessage } from "./backend.js";
import { errorDetail, sanitizeSyncErrorMessage, unavailableSyncState } from "./sync-state.js";

export type SwitchResult =
  | { ok: true; project: Project }
  /** switched：新仓库已在运行（只是导入失败），调用方据此记下路径 */
  | { ok: false; reason: string; switched?: true };

/**
 * `backend:reload` / `backend:reconnect` 的结果（T-093）。
 * reloaded：同一仓库的后端已停掉并重新起来、进入 live；
 * queued：有在途单，已排队，等 waitingTickets 张单跑完后自动重载（结果看 backend:status 的 reload / mode）；
 * failed：没重载成或没起来，reason 已脱敏（不含绝对路径和密钥值）。
 */
export type ReloadResult =
  | { state: "reloaded" }
  | { state: "queued"; waitingTickets: number }
  | { state: "failed"; reason: string };

export const RELOAD_POLL_MS = 1000;
export const RELOAD_REASON_MAX = 500;

/**
 * 重载失败原因脱敏（T-093）：先换掉仓库根和其余绝对路径（Unix、Windows 盘符、UNC），
 * 再走 sanitizeSyncErrorMessage（密钥值、令牌）并截断。
 */
export function sanitizeReloadReason(
  message: string,
  repoRoot: string,
  env: Readonly<Record<string, string | undefined>>,
  max = RELOAD_REASON_MAX,
): string {
  let out = message;
  if (repoRoot.length > 1) out = out.split(repoRoot).join("<仓库>");
  out = out
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`()（）,，;；]*/g, "<路径>")
    .replace(/(^|[\s"'`=(（:：])\/[^\s"'`()（）,，;；]+/g, "$1<路径>");
  return sanitizeSyncErrorMessage(out, env, max);
}

export interface SwitcherOptions {
  /** 排队重载时检查在途单的间隔（默认 1000ms，测试注入） */
  reloadPollMs?: number;
}

/**
 * 包一层 BackendHandle：IPC 层只拿这个；切换时把 onNotify / onPendingHighRisk 的订阅转到新后端，
 * 渲染就绪状态也带过去。拆旧：backend.stop() → app.stop()（10 退订 → 8 → 9 stop（含定时 sync）→ 2 attach 退订）
 * → dispose → 关库 → 释放写入锁；之后才组装新的。
 */
export class BackendSwitcher implements BackendHandle {
  private notifyListeners: Array<(m: NotifyMessage) => void> = [];
  private pendingListeners: Array<(l: PendingHighRisk[]) => void> = [];
  private offs: Array<() => void> = [];
  private rendererReady = false;
  private switching = false;
  private readonly swapListeners: Array<() => void> = [];
  /** 正在停起的那次重载（合并并发请求） */
  private reloading: Promise<ReloadResult> | null = null;
  /** 排队中的重载：定时检查在途单，空闲时执行 */
  private reloadTimer: ReturnType<typeof setInterval> | null = null;
  private readonly reloadPollMs: number;

  constructor(
    private current: BackendHandle,
    private readonly start: (repo: string) => Promise<BackendHandle>,
    private readonly env: Readonly<Record<string, string | undefined>> = {},
    opts: SwitcherOptions = {},
  ) {
    this.reloadPollMs = opts.reloadPollMs ?? RELOAD_POLL_MS;
    this.attach();
  }

  private attach(): void {
    this.offs.push(this.current.onNotify((m) => this.notifyListeners.forEach((l) => l(m))));
    this.offs.push(
      this.current.onPendingHighRisk((l) => this.pendingListeners.forEach((x) => x(l))),
    );
  }

  /** 切换后通知（main 用来重开 reader 等桌面侧轮询） */
  onSwap(listener: () => void): void {
    this.swapListeners.push(listener);
  }

  /** 组装一个后端；抛错时返回 null 和原因（错误名过滤、信息脱敏） */
  private async tryStart(repo: string): Promise<{ handle: BackendHandle | null; why: string }> {
    try {
      const handle = await this.start(repo);
      return { handle, why: handle.status().reason ?? "未知原因" };
    } catch (e) {
      return { handle: null, why: sanitizeSyncErrorMessage(errorDetail(e), this.env, 500) };
    }
  }

  private install(handle: BackendHandle): void {
    this.current = handle;
    this.attach();
    for (const l of this.swapListeners) l();
  }

  /** 渲染进程没重载（切换 / 导入失败）：恢复就绪状态，新后端缓冲的通知直接转给订阅方 */
  private restoreReady(wasReady: boolean): void {
    if (!wasReady) return;
    this.rendererReady = true;
    for (const m of this.current.markRendererReady()) this.notifyListeners.forEach((l) => l(m));
  }

  private async teardown(): Promise<void> {
    for (const off of this.offs.splice(0)) off();
    await this.current.stop();
  }

  /**
   * 切到 repo：忙 → 拒绝。否则拆旧 → 组装新；新的没进 live（或组装抛错）→ 拆掉它、用原仓库重组；
   * 原仓库也没起来 → 只读（如实说明）。新的 live 后调 importProject。
   * 成功时渲染进程会重新加载、再调 supervisor:ready，所以就绪状态清掉；失败时恢复。
   */
  async switchTo(repo: string): Promise<SwitchResult> {
    if (this.switching) return { ok: false, reason: "正在切换项目，请稍候" };
    if (this.reloading || this.reloadTimer)
      return { ok: false, reason: "正在等待重载后端，完成后再切换项目" };
    const busy = this.current.busyCount();
    if (busy > 0) return { ok: false, reason: `还有 ${busy} 张单在进行中，完成后再切换项目` };
    this.switching = true;
    const oldRepo = this.current.repoRoot();
    const wasReady = this.rendererReady;
    this.rendererReady = false;
    try {
      await this.teardown();
      const next = await this.tryStart(repo);
      if (next.handle && next.handle.status().mode === "live") {
        this.install(next.handle);
      } else {
        await next.handle?.stop();
        const back = await this.tryStart(oldRepo);
        if (back.handle && back.handle.status().mode === "live") {
          this.install(back.handle);
          this.restoreReady(wasReady);
          return { ok: false, reason: `新仓库没能启动（${next.why}），已回到原仓库` };
        }
        await back.handle?.stop();
        this.install(readonlyBackend(oldRepo, `切换项目失败，原仓库也没能重新启动（${back.why}）`));
        this.restoreReady(wasReady);
        return {
          ok: false,
          reason: `新仓库没能启动（${next.why}），原仓库也没能重新启动（${back.why}），现在是只读模式，请重启程序`,
        };
      }
      try {
        const project = await this.current.importCurrentRepo();
        return { ok: true, project };
      } catch (e) {
        this.restoreReady(wasReady);
        const msg = errorDetail(e);
        return {
          ok: false,
          switched: true,
          reason: sanitizeSyncErrorMessage(
            `已切换到新仓库，但导入项目失败：${msg}`,
            this.env,
            2000,
          ),
        };
      }
    } finally {
      this.switching = false;
    }
  }

  /**
   * 重载（T-093）：同一仓库的后端停掉再起来，复用切换流程的拆旧 / 组装。
   * - 只读：直接重新组装（只读横幅的「重新连接」也走这里）。
   * - live 且没有在途单（runningCount）：立即停起。
   * - 有在途单：排队，返回 queued；空闲后自动执行。不提供「立即重载」。
   * - 重复请求合并：排队中再调返回 queued（不再起计时器）；停起中再调拿到同一个结果。
   * - 起不来：装只读占位后端，原因脱敏。预算当日已用额度在台账（模块 2 的库）里，重建后照常读出。
   */
  reload(): Promise<ReloadResult> {
    if (this.reloading) return this.reloading;
    if (this.switching)
      return Promise.resolve({ state: "failed", reason: "正在切换项目，请稍候再重载" });
    const live = this.current.status().mode === "live";
    const running = live ? this.current.runningCount() : 0;
    if (running > 0) {
      if (!this.reloadTimer) {
        this.reloadTimer = setInterval(() => this.checkQueuedReload(), this.reloadPollMs);
        this.reloadTimer.unref?.();
      }
      return Promise.resolve({ state: "queued", waitingTickets: running });
    }
    return this.runReload();
  }

  /** 只读横幅的「重新连接」（T-093）：与 reload 同一条路径；只读时没有在途单，直接重新组装。 */
  reconnect(): Promise<ReloadResult> {
    return this.reload();
  }

  private checkQueuedReload(): void {
    if (this.reloading || this.switching) return;
    let running: number;
    try {
      running = this.current.status().mode === "live" ? this.current.runningCount() : 0;
    } catch {
      return;
    }
    if (running > 0) return;
    void this.runReload();
  }

  private clearReloadTimer(): void {
    if (this.reloadTimer) clearInterval(this.reloadTimer);
    this.reloadTimer = null;
  }

  private runReload(): Promise<ReloadResult> {
    this.clearReloadTimer();
    const p = this.doReload().finally(() => {
      this.reloading = null;
    });
    this.reloading = p;
    return p;
  }

  private async doReload(): Promise<ReloadResult> {
    this.switching = true;
    const repo = this.current.repoRoot();
    const wasReady = this.rendererReady;
    try {
      try {
        await this.teardown();
      } catch {
        /* 拆旧失败也继续尝试重新组装 */
      }
      const next = await this.tryStart(repo);
      if (next.handle && next.handle.status().mode === "live") {
        this.install(next.handle);
        this.restoreReady(wasReady);
        return { state: "reloaded" };
      }
      try {
        await next.handle?.stop();
      } catch {
        /* ignore */
      }
      const why = sanitizeReloadReason(next.why, repo, this.env);
      this.install(readonlyBackend(repo, `重载后端失败（${why}）`));
      this.restoreReady(wasReady);
      return {
        state: "failed",
        reason: sanitizeReloadReason(`后端没能重新启动（${why}），现在是只读模式`, repo, this.env),
      };
    } finally {
      this.switching = false;
    }
  }

  status(): BackendStatus {
    const st = this.current.status();
    if (this.reloading) return { ...st, reload: { state: "running" } };
    if (this.reloadTimer) {
      let waiting = 0;
      try {
        waiting = this.current.runningCount();
      } catch {
        /* ignore */
      }
      return { ...st, reload: { state: "queued", waitingTickets: waiting } };
    }
    return st;
  }
  markRendererReady() {
    this.rendererReady = true;
    return this.current.markRendererReady();
  }
  pendingNotifications() {
    return this.current.pendingNotifications();
  }
  onNotify(listener: (m: NotifyMessage) => void) {
    this.notifyListeners.push(listener);
    return () => {
      this.notifyListeners = this.notifyListeners.filter((l) => l !== listener);
    };
  }
  pendingHighRisk() {
    return this.current.pendingHighRisk();
  }
  decideHighRisk(...a: Parameters<BackendHandle["decideHighRisk"]>) {
    return this.current.decideHighRisk(...a);
  }
  onPendingHighRisk(listener: (l: PendingHighRisk[]) => void) {
    this.pendingListeners.push(listener);
    return () => {
      this.pendingListeners = this.pendingListeners.filter((l) => l !== listener);
    };
  }
  refreshPendingHighRisk() {
    this.current.refreshPendingHighRisk();
  }
  syncState() {
    return this.current.syncState();
  }
  repoRoot() {
    return this.current.repoRoot();
  }
  prMode() {
    return this.current.prMode();
  }
  busyCount() {
    return this.current.busyCount();
  }
  runningCount() {
    return this.current.runningCount();
  }
  importCurrentRepo() {
    return this.current.importCurrentRepo();
  }
  supervisorChat(message: Parameters<BackendHandle["supervisorChat"]>[0]) {
    return this.current.supervisorChat(message);
  }
  exportDiagnostics(target: string, now?: Date) {
    return this.current.exportDiagnostics(target, now);
  }
  async stop() {
    this.clearReloadTimer();
    for (const off of this.offs.splice(0)) off();
    await this.current.stop();
  }
}

/** 组装都失败时的占位后端：只读，什么都不做（原因只写变量名 / 错误名，已脱敏）。 */
export function readonlyBackend(repo: string, reason: string): BackendHandle {
  const unavailable = () => Promise.reject(new Error(`只读模式：${reason}`));
  return {
    status: () => ({ mode: "readonly", reason }),
    markRendererReady: () => [],
    pendingNotifications: () => [],
    onNotify: () => () => {},
    pendingHighRisk: () => [],
    decideHighRisk: async () => ({
      ok: false,
      code: "unavailable",
      message: `只读模式：${reason}`,
    }),
    onPendingHighRisk: () => () => {},
    refreshPendingHighRisk: () => {},
    syncState: () => unavailableSyncState(reason),
    supervisorChat: async () => ({ ok: false, reason: `只读模式：${reason}` }),
    repoRoot: () => repo,
    prMode: () => "local",
    busyCount: () => 0,
    runningCount: () => 0,
    importCurrentRepo: unavailable,
    exportDiagnostics: unavailable,
    stop: async () => {},
  };
}
