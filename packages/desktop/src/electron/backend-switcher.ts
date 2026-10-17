// T-072：一次组装只对应一个仓库。导入项目时拆掉旧后端、在新仓库上重新组装，桌面侧订阅转到新后端。
import type { Project } from "@bakacoding/config-budget";
import type { PendingHighRisk } from "@bakacoding/supervisor";
import type { BackendHandle, NotifyMessage } from "./backend.js";
import { sanitizeSyncErrorMessage } from "./sync-state.js";

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

  /**
   * 切到 repo：忙（有进行中的单或等裁决的高风险单）→ 拒绝；否则拆旧、组装新、调 importProject。
   * 新后端没进 live（锁被占、配置坏等）→ 拆掉它、回到旧仓库，返回原因。
   */
  async switchTo(repo: string): Promise<SwitchResult> {
    if (this.switching) return { ok: false, reason: "正在切换项目，请稍候" };
    const busy = this.current.busyCount();
    if (busy > 0) return { ok: false, reason: `还有 ${busy} 张单在进行中，完成后再切换项目` };
    this.switching = true;
    const oldRepo = this.current.repoRoot();
    try {
      // 成功后渲染进程会重新加载并再调 supervisor:ready，所以新后端先缓冲通知（含项目已导入）
      await this.replace(repo, false);
      const st = this.current.status();
      if (st.mode !== "live") {
        const why = st.reason ?? "未知原因";
        await this.replace(oldRepo, true);
        return { ok: false, reason: `新仓库没能启动（${why}），已回到原仓库` };
      }
      try {
        const project = await this.current.importCurrentRepo();
        return { ok: true, project };
      } catch (e) {
        const msg = e instanceof Error ? `${e.name}：${e.message}` : String(e);
        return { ok: false, reason: sanitizeSyncErrorMessage(`导入失败：${msg}`, this.env, 2000) };
      }
    } finally {
      this.switching = false;
    }
  }

  private async replace(repo: string, keepReady: boolean): Promise<void> {
    for (const off of this.offs.splice(0)) off();
    await this.current.stop();
    this.current = await this.start(repo);
    this.attach();
    if (keepReady && this.rendererReady) {
      // 渲染进程没重载：缓冲的通知直接转给订阅方
      for (const m of this.current.markRendererReady()) this.notifyListeners.forEach((l) => l(m));
    } else {
      this.rendererReady = false;
    }
    for (const l of this.swapListeners) l();
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
