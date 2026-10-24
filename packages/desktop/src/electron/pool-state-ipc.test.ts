// UI-06b：pool:state——原样转 9 的 backpressureState()，只挑 BackpressureState 的字段；
// 只读 / 未接线固定 ok:false；抛错固定文案不带路径；IPC 无参数；BackendSwitcher 原样转发。
import type { BackpressureState } from "@bakacoding/scheduler";
import { describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS, type DesktopPoolStateResult } from "../shared/api.js";
import { BackendSwitcher, readonlyBackend } from "./backend-switcher.js";
import type { BackendHandle } from "./backend.js";
import { servePoolState, type IpcMainLike } from "./ipc.js";
import { POOL_STATE_FAILED, POOL_STATE_UNAVAILABLE, readPoolState } from "./pool-state.js";

const STATE: BackpressureState = {
  paused: true,
  concurrency: 2,
  reasons: ["review_backlog_halve", "pending_pr_limit"],
  review_backlog: { pending: 5, capacity: 4 },
  supervisor_backlog: null,
  pending_prs: { merge_queued: 3, in_review: 5, total: 8, limit: 6, high_risk_held: 1 },
  daily_budget_exhausted: false,
};

describe("readPoolState", () => {
  it("原样返回 9 的 BackpressureState", async () => {
    const fn = vi.fn(async () => STATE);
    await expect(readPoolState(fn)).resolves.toEqual({ ok: true, state: STATE });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("多出来的字段不过 IPC", async () => {
    const extra = { ...STATE, repo_path: "/home/eva/secret", internal: 1 } as BackpressureState;
    const r = await readPoolState(async () => extra);
    expect(r).toEqual({ ok: true, state: STATE });
    expect(JSON.stringify(r)).not.toContain("/home/eva");
  });

  it("没有调度器（只读 / 未接线）：固定 ok:false", async () => {
    await expect(readPoolState(undefined)).resolves.toEqual({
      ok: false,
      reason: POOL_STATE_UNAVAILABLE,
    });
  });

  it("抛错：固定文案，不带原始报错和路径", async () => {
    const r = await readPoolState(async () => {
      throw new Error("boom at /home/eva/repo/.bakacoding/x.db");
    });
    expect(r).toEqual({ ok: false, reason: POOL_STATE_FAILED });
    expect(JSON.stringify(r)).not.toContain("/home/eva");
  });
});

describe("pool:state IPC", () => {
  function fakeIpc() {
    const handlers = new Map<string, (...a: unknown[]) => unknown>();
    const ipc: IpcMainLike = {
      handle: (c, h) => void handlers.set(c, h),
      removeHandler: (c) => void handlers.delete(c),
    };
    return { ipc, handlers };
  }
  const OK: DesktopPoolStateResult = { ok: true, state: STATE };

  it("invoke 转给 backend.poolState()，不传参数；停掉后注销", async () => {
    const { ipc, handlers } = fakeIpc();
    const poolState = vi.fn(async () => OK);
    const stop = servePoolState(ipc, { poolState });
    const h = handlers.get(IPC_CHANNELS.poolState)!;
    await expect(h({ sender: {} }, { anything: 1 })).resolves.toEqual(OK);
    expect(poolState).toHaveBeenCalledWith();
    stop();
    expect(handlers.has(IPC_CHANNELS.poolState)).toBe(false);
  });

  it("BackendSwitcher.poolState 原样转给当前后端", async () => {
    const poolState = vi.fn(async () => OK);
    const current = {
      onNotify: () => () => {},
      onPendingHighRisk: () => () => {},
      poolState,
    } as unknown as BackendHandle;
    const sw = new BackendSwitcher(current, async () => current);
    await expect(sw.poolState()).resolves.toEqual(OK);
    expect(poolState).toHaveBeenCalledTimes(1);
  });

  it("P3：主管积压与当日预算耗尽经 readPoolState → BackendSwitcher → IPC 原样透传", async () => {
    const src: BackpressureState = {
      ...STATE,
      reasons: ["supervisor_backlog", "daily_budget"],
      supervisor_backlog: { pending: 7, capacity: 3 },
      daily_budget_exhausted: true,
    };
    const current = {
      onNotify: () => () => {},
      onPendingHighRisk: () => () => {},
      poolState: () => readPoolState(async () => src),
    } as unknown as BackendHandle;
    const sw = new BackendSwitcher(current, async () => current);
    const { ipc, handlers } = fakeIpc();
    servePoolState(ipc, sw);
    const r = (await handlers.get(IPC_CHANNELS.poolState)!({
      sender: {},
    })) as DesktopPoolStateResult;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.supervisor_backlog).toEqual({ pending: 7, capacity: 3 });
    expect(r.state.daily_budget_exhausted).toBe(true);
    expect(r.state.reasons).toEqual(["supervisor_backlog", "daily_budget"]);
  });

  it("只读后端：固定 ok:false，不带路径", async () => {
    const b = readonlyBackend("/repo/secret-path", "缺少环境变量 DEEPSEEK_API_KEY");
    const r = await b.poolState();
    expect(r).toEqual({ ok: false, reason: POOL_STATE_UNAVAILABLE });
    expect(JSON.stringify(r)).not.toContain("/repo");
  });
});
