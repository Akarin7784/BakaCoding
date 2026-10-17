// T-105：退出前等后端收尾。before-quit 里先 preventDefault，等 stop() 结束（有上限）再自己发起退出。
import { REPO_GIT_TIMEOUT_MS } from "@bakacoding/app";

/**
 * 退出时最多等后端 stop() 多久：一个本地 git 超时（T-096：9 收尾最坏约一个 REPO_GIT_TIMEOUT_MS）再加 5 秒。
 * 冲突复投 / 重审和 GitHub 请求不受这个上限约束（见 modules.md §9、T-102），超时就不再等。
 */
export const QUIT_STOP_TIMEOUT_MS = REPO_GIT_TIMEOUT_MS + 5_000;

/** 超时 warn 的固定文案：不带路径、不带原始错误。 */
export const QUIT_STOP_TIMEOUT_WARN = `退出时等后端收尾超过 ${Math.round(
  QUIT_STOP_TIMEOUT_MS / 1000,
)} 秒，不再等待，直接退出；没收尾的单留给下次启动接管`;

export interface QuitGuardDeps {
  /** 拆后端（BackendSwitcher.stop()）；约定从不 reject，这里仍兜底 */
  stop(): Promise<void>;
  /** 收尾结束（或超时）后再次发起退出（app.quit()）；再次触发的 before-quit 直接放行 */
  quit(): void;
  /** stop 结束或超时后、quit 之前执行（注销 IPC、关只读连接等） */
  afterStop?(): void;
  /**
   * T-106：第一次拦下退出、开始收尾时调一次（在 stop() 之前），用来通知渲染进程显示「正在退出…」。
   * 只调一次；抛错不影响退出。
   */
  onStopping?(): void;
  warn(message: string): void;
  timeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export interface QuitEventLike {
  preventDefault(): void;
}

export type QuitGuardState = "idle" | "stopping" | "done";

export interface QuitGuard {
  /** 挂到 app.on("before-quit") 上 */
  onBeforeQuit(event: QuitEventLike): void;
  state(): QuitGuardState;
  /** 第一次拦下后开始的收尾（测试用）；还没拦过为 undefined */
  settled(): Promise<void> | undefined;
}

/**
 * - idle：拦下退出（preventDefault），进入 stopping，只调一次 stop()，和超时比谁先到；
 *   超时写一条固定 warn。之后进入 done 并调 quit()。
 * - stopping：再次触发（用户又点了退出）仍拦下，不重复 stop；超时保证不会一直挂着。
 * - done：我们自己发起的退出，直接放行。
 */
export function createQuitGuard(deps: QuitGuardDeps): QuitGuard {
  const timeoutMs = deps.timeoutMs ?? QUIT_STOP_TIMEOUT_MS;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let state: QuitGuardState = "idle";
  let running: Promise<void> | undefined;

  const safe = (fn: () => void): void => {
    try {
      fn();
    } catch {
      /* 退出路径上不让一个步骤挡住后面的 */
    }
  };

  const run = async (): Promise<void> => {
    let timer: unknown;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimer(() => resolve("timeout"), timeoutMs);
    });
    let stopped: Promise<"stopped">;
    try {
      stopped = deps.stop().then(
        () => "stopped" as const,
        () => "stopped" as const,
      );
    } catch {
      stopped = Promise.resolve("stopped" as const);
    }
    const r = await Promise.race([stopped, timedOut]);
    clearTimer(timer);
    if (r === "timeout") safe(() => deps.warn(QUIT_STOP_TIMEOUT_WARN));
    safe(() => deps.afterStop?.());
    state = "done";
    safe(() => deps.quit());
  };

  return {
    onBeforeQuit(event) {
      if (state === "done") return;
      event.preventDefault();
      if (state === "stopping") return;
      state = "stopping";
      safe(() => deps.onStopping?.());
      running = run();
    },
    state: () => state,
    settled: () => running,
  };
}

export interface WindowCloseEventLike {
  preventDefault(): void;
}

/**
 * T-106：窗口的 close 事件。点关闭后窗口先不关，留着显示「正在退出…」，等收尾结束由 app.quit() 统一关窗口。
 * - done：我们自己发起的退出，放行（app.quit() 关窗口时会走到这里）。
 * - stopping：正在收尾，拦下（重复点关闭不会提前关窗口，也不会重复 stop）。
 * - idle：Windows / Linux 关掉最后一个窗口就是退出（window-all-closed → app.quit()），这里拦下窗口关闭、
 *   直接发起退出，before-quit 照常走 quit guard；macOS 关窗口不退出程序，放行，行为不变。
 */
export function createWindowCloseHandler(deps: {
  guard: Pick<QuitGuard, "state">;
  platform: string;
  quit(): void;
}): (event: WindowCloseEventLike) => void {
  return (event) => {
    const st = deps.guard.state();
    if (st === "done") return;
    if (st === "idle" && deps.platform === "darwin") return;
    event.preventDefault();
    if (st === "idle") deps.quit();
  };
}
