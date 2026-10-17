// T-072：一次组装只对应一个仓库。导入项目时拆掉旧后端、在新仓库上重新组装，桌面侧订阅转到新后端。
import type { Project } from "@bakacoding/config-budget";
import type { PendingHighRisk } from "@bakacoding/supervisor";
import type { BackendHandle, NotifyMessage } from "./backend.js";
import { sanitizeErrorName, sanitizeSyncErrorMessage, unavailableSyncState } from "./sync-state.js";

export type SwitchResult = { ok: true; project: Project } | { ok: false; reason: string };

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

  constructor(
    private current: BackendHandle,
    private readonly start: (repo: string) => Promise<BackendHandle>,
    private readonly env: Readonly<Record<string, string | undefined>> = {},
  ) {
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
      const name = sanitizeErrorName(e instanceof Error ? e.name : "Error");
      const msg = e instanceof Error ? e.message : String(e);
      return { handle: null, why: sanitizeSyncErrorMessage(`${name}：${msg}`, this.env, 500) };
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
        const name = sanitizeErrorName(e instanceof Error ? e.name : "Error");
        const msg = e instanceof Error ? `${name}：${e.message}` : String(e);
        return { ok: false, reason: sanitizeSyncErrorMessage(`导入失败：${msg}`, this.env, 2000) };
      }
    } finally {
      this.switching = false;
    }
  }

  status() {
    return this.current.status();
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
    importCurrentRepo: unavailable,
    exportDiagnostics: unavailable,
    stop: async () => {},
  };
}
