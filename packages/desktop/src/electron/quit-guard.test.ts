// T-105：退出前等后端 stop() 收尾；超时 warn（不带路径）；只 stop 一次；重复触发不挂。
import { REPO_GIT_TIMEOUT_MS } from "@bakacoding/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createQuitGuard,
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
        // app.quit() 会再触发一次 before-quit：这次放行
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
