// T-072：一次组装只对应一个仓库。导入项目时拆掉旧后端、在新仓库上重新组装，桌面侧订阅转到新后端。
import type { Project } from "@bakacoding/config-budget";
import type { PendingHighRisk } from "@bakacoding/supervisor";
import type { BackendHandle, BackendStatus, NotifyMessage, RepoSource } from "./backend.js";
import { errorDetail, sanitizeSyncErrorMessage, unavailableSyncState } from "./sync-state.js";

export type SwitchResult =
  | { ok: true; project: Project }
  /** switched：新仓库已在运行（只是导入失败），调用方据此记下路径 */
  | { ok: false; reason: string; switched?: true }
  /**
   * UI-03b：新仓库还没准备好（不是 Git 仓库 / 没有提交 / 没有 main），新仓库的只读后端已装上（来源 last_import），
   * 界面进项目准备页；准备好后第一次重载进 live 时补调 importProject。
   */
  | { ok: false; reason: string; switched: true; needsPrep: true };

/** 只读后端的原因能不能在项目准备页修（与渲染进程 repoFixRoute 同一套码） */
export function needsRepoPrep(st: BackendStatus): boolean {
  if (st.mode !== "readonly" || !st.error) return false;
  const { name, code } = st.error;
  // T-113：嵌套仓库（给提示）和本仓库缺配置 / 配置不合法（「生成配置」）也进准备页
  if (code === "not_git" || code === "nested_repo") return true;
  if (code === "config_missing" || code === "config_invalid") return true;
  return name === "RepoNotReadyError" && (code === "no_commits" || code === "no_main");
}

/**
 * `backend:reload` / `backend:reconnect` 的结果（T-093）。
 * reloaded：同一仓库的后端已停掉并重新起来、进入 live；
 * queued：排队时有在途单或主管对话在途；只等排队那一刻在途的单（waitingTickets 为其中还没跑完的张数）和在途对话（waitingChat），之后派出的单不等，到时自动重载（结果看 backend:status 的 reload / mode）；
 * failed：没重载成或没起来，reason 已脱敏（不含绝对路径和密钥值）。
 */
export type ReloadResult =
  | { state: "reloaded" }
  | { state: "queued"; waitingTickets: number; waitingChat: boolean }
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

/** 切换项目失败原因上限（与导入结果同一档） */
export const SWITCH_REASON_MAX = 2000;

/**
 * 切换项目失败原因脱敏（UI-03，同 #95 / T-093 的做法）：新仓库根写成「<新仓库>」、原仓库根写成「<原仓库>」
 * （长的先换，嵌套目录也不会换错），其余绝对路径、密钥值、令牌再走 sanitizeReloadReason。
 */
export function sanitizeSwitchReason(
  message: string,
  newRepo: string,
  oldRepo: string,
  env: Readonly<Record<string, string | undefined>>,
  max = SWITCH_REASON_MAX,
): string {
  const roots = [
    { root: newRepo, label: "<新仓库>" },
    { root: oldRepo, label: "<原仓库>" },
  ]
    .filter((r) => r.root.length > 1)
    .sort((a, b) => b.root.length - a.root.length);
  let out = message;
  for (const r of roots) out = out.split(r.root).join(r.label);
  return sanitizeReloadReason(out, "", env, max);
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
  /** UI-03b：导入时还没准备好的仓库路径；准备好后第一次重载进 live 时补调 importProject */
  private pendingImport: string | null = null;
  private readonly swapListeners: Array<() => void> = [];
  /** 正在停起的那次重载（合并并发请求） */
  private reloading: Promise<ReloadResult> | null = null;
  /** 正在停起（与切换项目的 switching 分开） */
  private restarting = false;
  /** 正在进行的切换项目（stop() 等它结束） */
  private switchPromise: Promise<SwitchResult> | null = null;
  /** 程序退出：之后组装出来的后端一律拆掉、不装上 */
  private stopped = false;
  /** 排队中的重载：定时检查，空闲时执行 */
  private reloadTimer: ReturnType<typeof setInterval> | null = null;
  /** 排队那一刻在途的 ticket_id：只等它们（之后派的单不等，防饿死） */
  private waitFor: Set<string> = new Set();
  private readonly reloadPollMs: number;

  constructor(
    private current: BackendHandle,
    /**
     * 组装后端。source 不传 = 新导入的仓库（按「上次导入」）；重载 / 切换失败退回原仓库时传原来源，
     * 让 cwd 来源重载后仍是 cwd（UI-03a 评审 B1：不能因为重连就变成可初始化的来源）。
     */
    private readonly start: (repo: string, source?: RepoSource) => Promise<BackendHandle>,
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
  private async tryStart(
    repo: string,
    source?: RepoSource,
  ): Promise<{ handle: BackendHandle | null; why: string }> {
    try {
      const handle = await (source === undefined ? this.start(repo) : this.start(repo, source));
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
  switchTo(repo: string): Promise<SwitchResult> {
    if (this.stopped) return Promise.resolve({ ok: false, reason: "程序正在退出" });
    if (this.switching) return Promise.resolve({ ok: false, reason: "正在切换项目，请稍候" });
    if (this.restarting || this.reloading || this.reloadTimer)
      return Promise.resolve({ ok: false, reason: "正在等待重载后端，完成后再切换项目" });
    const busy = this.current.busyCount();
    if (busy > 0)
      return Promise.resolve({
        ok: false,
        reason: `还有 ${busy} 张单在进行中，完成后再切换项目`,
      });
    const p = this.doSwitch(repo).finally(() => {
      this.switchPromise = null;
    });
    this.switchPromise = p;
    return p;
  }

  /** 退出中组装出来的后端：拆掉，不装上 */
  private async discard(handle: BackendHandle | null): Promise<void> {
    try {
      await handle?.stop();
    } catch {
      /* ignore */
    }
  }

  private async doSwitch(repo: string): Promise<SwitchResult> {
    const quitting: SwitchResult = { ok: false, reason: "程序正在退出" };
    this.switching = true;
    const oldRepo = this.current.repoRoot();
    const oldSource = this.current.status().repoSource;
    // UI-03：失败原因里的新 / 原仓库路径和其他绝对路径都换成占位符
    const clean = (m: string) => sanitizeSwitchReason(m, repo, oldRepo, this.env);
    const wasReady = this.rendererReady;
    this.rendererReady = false;
    this.pendingImport = null;
    try {
      await this.teardown();
      const next = await this.tryStart(repo);
      if (this.stopped) {
        await this.discard(next.handle);
        return quitting;
      }
      if (next.handle && next.handle.status().mode === "live") {
        this.install(next.handle);
      } else if (next.handle && needsRepoPrep(next.handle.status())) {
        // UI-03b：没准备好的新仓库不回滚，装上它的只读后端，界面进准备页
        this.install(next.handle);
        this.pendingImport = next.handle.repoRoot();
        this.restoreReady(wasReady);
        return { ok: false, switched: true, needsPrep: true, reason: clean(next.why) };
      } else {
        await next.handle?.stop();
        const back = await this.tryStart(oldRepo, oldSource ?? "cwd");
        if (this.stopped) {
          await this.discard(back.handle);
          return quitting;
        }
        if (back.handle && back.handle.status().mode === "live") {
          this.install(back.handle);
          this.restoreReady(wasReady);
          return { ok: false, reason: clean(`新仓库没能启动（${next.why}），已回到原仓库`) };
        }
        await back.handle?.stop();
        this.install(
          readonlyBackend(
            oldRepo,
            clean(`切换项目失败，原仓库也没能重新启动（${back.why}）`),
            oldSource,
          ),
        );
        this.restoreReady(wasReady);
        return {
          ok: false,
          reason: clean(
            `新仓库没能启动（${next.why}），原仓库也没能重新启动（${back.why}），现在是只读模式，请重启程序`,
          ),
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
          reason: clean(`已切换到新仓库，但导入项目失败：${msg}`),
        };
      }
    } finally {
      this.switching = false;
    }
  }

  /**
   * 重载（T-093）：同一仓库的后端停掉再起来，复用切换流程的拆旧 / 组装。
   * - 只读：直接重新组装（只读横幅的「重新连接」也走这里）。
   * - live 且没有在途单、没有主管对话在途：立即停起。
   * - 否则排队，返回 queued：快照此刻在途的 ticket_id，只等它们跑完和在途对话结束（之后派的单不等，
   *   正常拆旧 + 重启后 takeOver 接手）。不提供「立即重载」。
   * - 重复请求合并：排队中再调返回 queued（不再起计时器、不改快照）；停起中再调拿到同一个结果。
   * - 起不来：装只读占位后端，原因脱敏。预算当日已用额度在台账（模块 2 的库）里，重建后照常读出。
   * - 退出（stop）之后：拒绝；停起中退出，新组装的后端会被拆掉、不装上。
   */
  reload(): Promise<ReloadResult> {
    if (this.stopped) return Promise.resolve({ state: "failed", reason: "程序正在退出" });
    if (this.reloading) return this.reloading;
    if (this.switching)
      return Promise.resolve({ state: "failed", reason: "正在切换项目，请稍候再重载" });
    if (this.reloadTimer) return Promise.resolve(this.queuedResult());
    const live = this.current.status().mode === "live";
    const ids = live ? this.current.runningTicketIds() : [];
    const chat = live ? this.current.chatInFlight() : false;
    if (ids.length > 0 || chat) {
      this.waitFor = new Set(ids);
      this.reloadTimer = setInterval(() => this.checkQueuedReload(), this.reloadPollMs);
      this.reloadTimer.unref?.();
      return Promise.resolve(this.queuedResult());
    }
    return this.runReload();
  }

  /** 只读横幅的「重新连接」（T-093）：与 reload 同一条路径；只读时没有在途单，直接重新组装。 */
  reconnect(): Promise<ReloadResult> {
    return this.reload();
  }

  /** 排队快照里还没跑完的单数与对话是否在途；只读后端两者都按空闲 */
  private waiting(): { tickets: number; chat: boolean } {
    if (this.current.status().mode !== "live") return { tickets: 0, chat: false };
    const now = new Set(this.current.runningTicketIds());
    let tickets = 0;
    for (const id of this.waitFor) if (now.has(id)) tickets++;
    return { tickets, chat: this.current.chatInFlight() };
  }

  private queuedResult(): ReloadResult {
    let w = { tickets: 0, chat: false };
    try {
      w = this.waiting();
    } catch {
      /* ignore */
    }
    return { state: "queued", waitingTickets: w.tickets, waitingChat: w.chat };
  }

  private checkQueuedReload(): void {
    if (this.stopped) {
      this.clearReloadTimer();
      return;
    }
    if (this.reloading || this.switching) return;
    let w: { tickets: number; chat: boolean };
    try {
      w = this.waiting();
    } catch {
      return;
    }
    if (w.tickets > 0 || w.chat) return;
    void this.runReload();
  }

  private clearReloadTimer(): void {
    if (this.reloadTimer) clearInterval(this.reloadTimer);
    this.reloadTimer = null;
    this.waitFor = new Set();
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
    this.restarting = true;
    const repo = this.current.repoRoot();
    const source = this.current.status().repoSource;
    const wasReady = this.rendererReady;
    try {
      try {
        await this.teardown();
      } catch {
        /* 拆旧失败也继续尝试重新组装 */
      }
      // 来源不明（组装失败的只读占位后端没带 repoSource）时按 cwd 传：main 的 lastRepoForStart 对 cwd
      // 不传「上次导入」，新后端按 --repo > BAKACODING_REPO > process.cwd() 解析，可能不是原来的 repo。
      // 这只会更严（cwd 来源不给初始化 / 首次提交 / 新建 main），不会把它当成上次导入而放开写操作（#130 评审，T-106 测试锁住）。
      const next = await this.tryStart(repo, source ?? "cwd");
      if (this.stopped) {
        await this.discard(next.handle);
        return { state: "failed", reason: "程序正在退出" };
      }
      if (next.handle && next.handle.status().mode === "live") {
        this.install(next.handle);
        this.restoreReady(wasReady);
        await this.finishPendingImport();
        return { state: "reloaded" };
      }
      await this.discard(next.handle);
      const why = sanitizeReloadReason(next.why, repo, this.env);
      this.install(readonlyBackend(repo, `重载后端失败（${why}）`, source));
      this.restoreReady(wasReady);
      return {
        state: "failed",
        reason: sanitizeReloadReason(`后端没能重新启动（${why}），现在是只读模式`, repo, this.env),
      };
    } finally {
      this.restarting = false;
    }
  }

  /** UI-03b：导入时没准备好的仓库，准备好后第一次进 live 补调 importProject；失败只写一条不带路径的 warn */
  private async finishPendingImport(): Promise<void> {
    const repo = this.pendingImport;
    if (repo === null || repo !== this.current.repoRoot()) return;
    this.pendingImport = null;
    try {
      await this.current.importCurrentRepo();
    } catch (e) {
      console.warn(`[desktop] 准备好后导入项目失败（${e instanceof Error ? e.name : "unknown"}）`);
    }
  }

  status(): BackendStatus {
    const st = this.current.status();
    if (this.reloading) return { ...st, reload: { state: "running" } };
    if (this.reloadTimer) {
      const q = this.queuedResult();
      if (q.state === "queued")
        return {
          ...st,
          reload: { state: "queued", waitingTickets: q.waitingTickets, waitingChat: q.waitingChat },
        };
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
  runningTicketIds() {
    return this.current.runningTicketIds();
  }
  chatInFlight() {
    return this.current.chatInFlight();
  }
  importCurrentRepo() {
    return this.current.importCurrentRepo();
  }
  supervisorChat(message: Parameters<BackendHandle["supervisorChat"]>[0]) {
    return this.current.supervisorChat(message);
  }
  listProjects() {
    return this.current.listProjects();
  }
  removeProject(project_id: string) {
    return this.current.removeProject(project_id);
  }
  exportDiagnostics(...args: Parameters<BackendHandle["exportDiagnostics"]>) {
    return this.current.exportDiagnostics(...args);
  }
  testConnection(target: Parameters<BackendHandle["testConnection"]>[0]) {
    return this.current.testConnection(target);
  }
  budgetState() {
    return this.current.budgetState();
  }
  ledgerStore() {
    return this.current.ledgerStore();
  }
  /** 退出：先清排队，再等进行中的重载 / 切换结束（它们见 stopped 不装新后端），最后拆当前后端 */
  async stop() {
    this.stopped = true;
    this.clearReloadTimer();
    await this.reloading?.catch(() => undefined);
    await this.switchPromise?.catch(() => undefined);
    for (const off of this.offs.splice(0)) off();
    await this.current.stop();
  }
}

/** 组装都失败时的占位后端：只读，什么都不做（原因只写变量名 / 错误名，已脱敏）。 */
export function readonlyBackend(
  repo: string,
  reason: string,
  repoSource?: RepoSource,
): BackendHandle {
  const unavailable = () => Promise.reject(new Error(`只读模式：${reason}`));
  return {
    status: () => ({ mode: "readonly", reason, ...(repoSource && { repoSource }) }),
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
    runningTicketIds: () => [],
    chatInFlight: () => false,
    importCurrentRepo: unavailable,
    listProjects: () => null,
    removeProject: unavailable,
    exportDiagnostics: unavailable,
    testConnection: async () => ({ ok: false, reason: "unavailable" }),
    budgetState: async () => null,
    ledgerStore: () => null,
    stop: async () => {},
  };
}
