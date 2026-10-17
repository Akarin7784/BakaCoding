// T-105：退出前等后端 stop() 收尾；超时 warn（不带路径）；只 stop 一次；重复触发不挂。
import { REPO_GIT_TIMEOUT_MS } from "@bakacoding/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createQuitGuard,
  createWindowCloseHandler,
  QUIT_STOP_TIMEOUT_MS,
  QUIT_STOP_TIMEOUT_WARN,
  type QuitEventLike,
} from "./quit-guard.js";

function ev(): QuitEventLike & { prevented: number } {
  const e = {
    prevented: 0,
    preventDefault() {
      e.prevented += 1;
    },
  };
  return e;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createQuitGuard（T-105）", () => {
  it("上限 = REPO_GIT_TIMEOUT_MS + 5 秒", () => {
    expect(QUIT_STOP_TIMEOUT_MS).toBe(REPO_GIT_TIMEOUT_MS + 5_000);
  });

  it("拦下第一次退出，等 stop() resolve 之后才收尾、再发起退出；第二次（自己发起的）放行", async () => {
    const d = deferred();
    const order: string[] = [];
    const stop = vi.fn(() => {
      order.push("stop:begin");
      return d.promise.then(() => order.push("stop:end")).then(() => undefined);
    });
    const warn = vi.fn();
    const g = createQuitGuard({
      stop,
      afterStop: () => order.push("afterStop"),
      quit: () => {
        order.push("quit");
        // app.quit() 会再触发一次 before-quit：这次放行（只模拟一次，回滚时不会无限重入）
        if (order.filter((x) => x === "quit").length > 1) return;
        const again = ev();
        g.onBeforeQuit(again);
        order.push(`again:prevented=${again.prevented}`);
      },
      warn,
    });
    const e = ev();
    g.onBeforeQuit(e);
    expect(e.prevented).toBe(1);
    expect(g.state()).toBe("stopping");
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["stop:begin"]);
    d.resolve();
    await g.settled();
    expect(order).toEqual(["stop:begin", "stop:end", "afterStop", "quit", "again:prevented=0"]);
    expect(g.state()).toBe("done");
    expect(stop).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("收尾中再触发退出：仍拦下，不重复 stop；stop 结束后只退出一次", async () => {
    const d = deferred();
    const stop = vi.fn(() => d.promise);
    const quit = vi.fn();
    const g = createQuitGuard({ stop, quit, warn: () => {} });
    const e1 = ev();
    const e2 = ev();
    const e3 = ev();
    g.onBeforeQuit(e1);
    g.onBeforeQuit(e2);
    g.onBeforeQuit(e3);
    expect([e1.prevented, e2.prevented, e3.prevented]).toEqual([1, 1, 1]);
    expect(stop).toHaveBeenCalledTimes(1);
    d.resolve();
    await g.settled();
    expect(quit).toHaveBeenCalledTimes(1);
    const e4 = ev();
    g.onBeforeQuit(e4);
    expect(e4.prevented).toBe(0);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("stop() 一直不结束：到上限写一条 warn（不含路径、不含原始错误）后照样退出，重复触发不挂", async () => {
    vi.useFakeTimers();
    const stop = vi.fn(() => new Promise<void>(() => {}));
    const quit = vi.fn();
    const afterStop = vi.fn();
    const warn = vi.fn();
    const g = createQuitGuard({ stop, quit, afterStop, warn });
    g.onBeforeQuit(ev());
    g.onBeforeQuit(ev());
    await vi.advanceTimersByTimeAsync(QUIT_STOP_TIMEOUT_MS - 1);
    expect(quit).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await g.settled();
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0]![0]);
    expect(msg).toBe(QUIT_STOP_TIMEOUT_WARN);
    expect(warn.mock.calls[0]).toHaveLength(1);
    expect(msg).not.toMatch(/[\\/]/);
    expect(msg).toContain(String(QUIT_STOP_TIMEOUT_MS / 1000));
    expect(afterStop).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    const e = ev();
    g.onBeforeQuit(e);
    expect(e.prevented).toBe(0);
  });

  it("stop() 抛错 / reject（违反约定）也照样退出，不写 warn、不泄露错误", async () => {
    for (const stop of [
      () => Promise.reject(new Error("/home/secret/repo boom")),
      () => {
        throw new Error("/home/secret/repo boom");
      },
    ]) {
      const quit = vi.fn();
      const warn = vi.fn();
      const g = createQuitGuard({ stop: stop as () => Promise<void>, quit, warn });
      g.onBeforeQuit(ev());
      await g.settled();
      expect(quit).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
    }
  });

  it("stop 按时结束时清掉计时器，之后不会再补一条 warn", async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const g = createQuitGuard({ stop: async () => {}, quit: () => {}, warn });
    g.onBeforeQuit(ev());
    await g.settled();
    await vi.advanceTimersByTimeAsync(QUIT_STOP_TIMEOUT_MS * 2);
    expect(warn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("退出时通知渲染进程（T-106）", () => {
  it("第一次拦下时、stop() 之前调一次 onStopping；收尾中重复触发不再调；自己发起的那次也不调", async () => {
    const d = deferred();
    const order: string[] = [];
    const onStopping = vi.fn(() => order.push("notify"));
    const g = createQuitGuard({
      onStopping,
      stop: () => {
        order.push("stop");
        return d.promise;
      },
      quit: () => order.push("quit"),
      warn: () => {},
    });
    g.onBeforeQuit(ev());
    g.onBeforeQuit(ev());
    g.onBeforeQuit(ev());
    expect(onStopping).toHaveBeenCalledTimes(1);
    d.resolve();
    await g.settled();
    g.onBeforeQuit(ev());
    expect(onStopping).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["notify", "stop", "quit"]);
  });

  it("onStopping 抛错（比如窗口已销毁）不影响收尾和退出", async () => {
    const stop = vi.fn(async () => {});
    const quit = vi.fn();
    const g = createQuitGuard({
      onStopping: () => {
        throw new Error("Object has been destroyed");
      },
      stop,
      quit,
      warn: () => {},
    });
    const e = ev();
    expect(() => g.onBeforeQuit(e)).not.toThrow();
    expect(e.prevented).toBe(1);
    await g.settled();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
  });
});

describe("窗口关闭按钮（T-106）", () => {
  function closeEv() {
    const e = {
      prevented: 0,
      preventDefault() {
        e.prevented += 1;
      },
    };
    return e;
  }

  it("Windows / Linux 空闲时点关闭：窗口先不关，发起退出", () => {
    for (const platform of ["win32", "linux"]) {
      const quit = vi.fn();
      const h = createWindowCloseHandler({ guard: { state: () => "idle" }, platform, quit });
      const e = closeEv();
      h(e);
      expect(e.prevented, platform).toBe(1);
      expect(quit, platform).toHaveBeenCalledTimes(1);
    }
  });

  it("收尾中再点关闭：仍拦下，不再发起退出；收尾结束（done）后放行", () => {
    let state: "idle" | "stopping" | "done" = "stopping";
    const quit = vi.fn();
    const h = createWindowCloseHandler({ guard: { state: () => state }, platform: "win32", quit });
    const e1 = closeEv();
    const e2 = closeEv();
    h(e1);
    h(e2);
    expect([e1.prevented, e2.prevented]).toEqual([1, 1]);
    expect(quit).not.toHaveBeenCalled();
    state = "done";
    const e3 = closeEv();
    h(e3);
    expect(e3.prevented).toBe(0);
    expect(quit).not.toHaveBeenCalled();
  });

  it("macOS 空闲时关窗口不退出程序（放行，行为不变）；收尾中照样拦下", () => {
    let state: "idle" | "stopping" = "idle";
    const quit = vi.fn();
    const h = createWindowCloseHandler({ guard: { state: () => state }, platform: "darwin", quit });
    const e1 = closeEv();
    h(e1);
    expect(e1.prevented).toBe(0);
    state = "stopping";
    const e2 = closeEv();
    h(e2);
    expect(e2.prevented).toBe(1);
    expect(quit).not.toHaveBeenCalled();
  });

  it("和 quit guard 连起来：连点三次关闭，只 stop 一次、只通知一次、只退出一次，窗口最后才放行", async () => {
    const d = deferred();
    const stop = vi.fn(() => d.promise);
    const onStopping = vi.fn();
    let windowClosed = false;
    // 模拟 app.quit()：先 before-quit，没被拦下才关窗口（再走一次 close）
    const appQuit = vi.fn(() => {
      const bq = ev();
      g.onBeforeQuit(bq);
      if (bq.prevented) return;
      const ce = closeEv();
      onClose(ce);
      if (!ce.prevented) windowClosed = true;
    });
    const g = createQuitGuard({ stop, onStopping, quit: appQuit, warn: () => {} });
    const onClose = createWindowCloseHandler({ guard: g, platform: "win32", quit: appQuit });
    for (let i = 0; i < 3; i++) {
      const ce = closeEv();
      onClose(ce);
      expect(ce.prevented).toBe(1);
    }
    expect(windowClosed).toBe(false);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(onStopping).toHaveBeenCalledTimes(1);
    d.resolve();
    await g.settled();
    expect(windowClosed).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(onStopping).toHaveBeenCalledTimes(1);
    // 第一次点关闭发起 1 次，收尾结束 guard 自己发起 1 次
    expect(appQuit).toHaveBeenCalledTimes(2);
  });
});

describe("组合：stop 挂住 + 收尾中点关闭 + 到点放行窗口（T-109）", () => {
  it("stop() 一直不返回：收尾中连点关闭都拦下、不重复发起；到 QUIT_STOP_TIMEOUT_MS 才放行窗口、只退出一次", async () => {
    vi.useFakeTimers();
    const stop = vi.fn(() => new Promise<void>(() => {}));
    const warn = vi.fn();
    const afterStop = vi.fn();
    const onStopping = vi.fn();
    let windowClosed = 0;
    let exited = 0;
    /** 每次 app.quit() 触发的 before-quit 有没有被拦下 */
    const beforeQuitPrevented: number[] = [];
    const closeEv = () => {
      const e = {
        prevented: 0,
        preventDefault() {
          e.prevented += 1;
        },
      };
      return e;
    };
    // 模拟 app.quit()：先 before-quit，没被拦下才关窗口（再走一次 close），窗口放行就算退出
    const appQuit = vi.fn(() => {
      const bq = ev();
      g.onBeforeQuit(bq);
      beforeQuitPrevented.push(bq.prevented);
      if (bq.prevented) return;
      const ce = closeEv();
      onClose(ce);
      if (!ce.prevented) {
        windowClosed += 1;
        exited += 1;
      }
    });
    const g = createQuitGuard({ stop, onStopping, afterStop, warn, quit: appQuit });
    const onClose = createWindowCloseHandler({ guard: g, platform: "win32", quit: appQuit });

    // 第一次点关闭：窗口拦下、发起退出、开始收尾
    const first = closeEv();
    onClose(first);
    expect(first.prevented).toBe(1);
    expect(g.state()).toBe("stopping");

    // 收尾中隔一会儿就点一次关闭，一直到上限前 1ms
    const step = 5_000;
    for (let t = step; t < QUIT_STOP_TIMEOUT_MS; t += step) {
      await vi.advanceTimersByTimeAsync(step);
      const e = closeEv();
      onClose(e);
      expect(e.prevented, `t=${t}`).toBe(1);
    }
    // 上面已走到 floor((上限-1)/step)*step，再补到上限前 1ms
    const elapsed = Math.floor((QUIT_STOP_TIMEOUT_MS - 1) / step) * step;
    await vi.advanceTimersByTimeAsync(QUIT_STOP_TIMEOUT_MS - 1 - elapsed);
    const lastClick = closeEv();
    onClose(lastClick);
    expect(lastClick.prevented).toBe(1);
    // 收尾中用户又按了一次退出快捷键（再走一次 app.quit() → before-quit）：仍拦下，窗口不关
    appQuit();
    expect(beforeQuitPrevented).toEqual([1, 1]);
    expect(g.state()).toBe("stopping");
    expect(windowClosed).toBe(0);
    expect(exited).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    // 收尾中的关闭只拦不发起：除了上面手动按的那次，只有第一次点关闭调过 app.quit()
    expect(appQuit).toHaveBeenCalledTimes(2);

    // 到上限：写一条 warn，afterStop，guard 自己发起退出，窗口放行
    await vi.advanceTimersByTimeAsync(1);
    await g.settled();
    expect(g.state()).toBe("done");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(QUIT_STOP_TIMEOUT_WARN);
    expect(afterStop).toHaveBeenCalledTimes(1);
    expect(windowClosed).toBe(1);
    expect(exited).toBe(1);
    expect(appQuit).toHaveBeenCalledTimes(3);
    expect(beforeQuitPrevented).toEqual([1, 1, 0]);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(onStopping).toHaveBeenCalledTimes(1);

    // 之后再有关闭 / 退出（比如系统再发一次）直接放行，不再 stop、不再 warn
    const late = closeEv();
    onClose(late);
    expect(late.prevented).toBe(0);
    await vi.advanceTimersByTimeAsync(QUIT_STOP_TIMEOUT_MS);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
