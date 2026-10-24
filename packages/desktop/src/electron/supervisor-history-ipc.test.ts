// UI-04a：supervisor:history 的主进程侧——确实调 10 的 history()、只读回空列表、坏游标的原因已脱敏不带路径。
import { describe, expect, it, vi } from "vitest";
import { StorageError, type SupervisorMessage } from "@bakacoding/storage";
import { IPC_CHANNELS, type DesktopHistoryResult } from "../shared/api.js";
import { serveSupervisorHistory, type IpcMainLike } from "./ipc.js";
import {
  CHAT_REASON_MAX,
  HISTORY_PAGE,
  runSupervisorHistory,
  toHistoryQuery,
} from "./supervisor-chat.js";
import { BackendSwitcher, readonlyBackend } from "./backend-switcher.js";
import type { BackendHandle } from "./backend.js";

const msg = (id: string, role: "user" | "supervisor" = "user"): SupervisorMessage => ({
  message_id: id,
  project_id: "p-1",
  role,
  kind: role === "supervisor" ? "answer" : null,
  content: `内容 ${id}`,
  requirement_id: null,
  ticket_ids: [],
  created_at: 1,
});

const SECRET = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
const ENV = { DEEPSEEK_API_KEY: SECRET };

describe("runSupervisorHistory（UI-04a）", () => {
  it("ok：调 10 的 history()，limit 默认 50，原样返回消息", () => {
    const history = vi.fn(() => [msg("m-1"), msg("m-1-r", "supervisor")]);
    const r = runSupervisorHistory(history, undefined, ENV);
    expect(history).toHaveBeenCalledTimes(1);
    expect(history).toHaveBeenCalledWith({ limit: HISTORY_PAGE });
    expect(r).toEqual({ ok: true, messages: [msg("m-1"), msg("m-1-r", "supervisor")] });
  });

  it("before / limit 透传；limit 夹到 1..200，非法字段丢掉", () => {
    const history = vi.fn(() => []);
    runSupervisorHistory(history, { before: "m-9", limit: 20 }, ENV);
    expect(history).toHaveBeenLastCalledWith({ before: "m-9", limit: 20 });
    expect(toHistoryQuery({ limit: 9999 })).toEqual({ limit: 200 });
    expect(toHistoryQuery({ limit: 0 })).toEqual({ limit: 1 });
    expect(toHistoryQuery({ before: 3, limit: "x" })).toEqual({ limit: 50 });
    expect(toHistoryQuery(null)).toEqual({ limit: 50 });
  });

  it("只读（没有 history）：ok:true 空列表", () => {
    expect(runSupervisorHistory(undefined, { before: "m-1" }, ENV)).toEqual({
      ok: true,
      messages: [],
    });
  });

  it("坏游标：ok:false，reason 脱敏（无密钥、无路径）并截断", () => {
    const history = vi.fn(() => {
      const e = new StorageError("invalid_cursor");
      e.message += ` at /home/eva/.bakacoding/state.db C:\\Users\\eva\\x.db ${SECRET} ${"x".repeat(5000)}`;
      throw e;
    });
    const r = runSupervisorHistory(history, { before: "nope" }, ENV);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("读取对话历史失败");
    expect(r.reason).toContain("invalid_cursor");
    expect(r.reason).not.toContain(SECRET);
    expect(r.reason).not.toContain("/home/eva");
    expect(r.reason).not.toContain("C:\\Users");
    expect([...r.reason].length).toBeLessThanOrEqual(CHAT_REASON_MAX + 1);
  });
});

describe("serveSupervisorHistory（UI-04a）", () => {
  function fakeIpc() {
    const handlers = new Map<string, (...a: unknown[]) => unknown>();
    const ipc: IpcMainLike = {
      handle: (c, h) => void handlers.set(c, h),
      removeHandler: (c) => void handlers.delete(c),
    };
    return { ipc, handlers };
  }

  it("event 不当参数：args[1] 交给后端；停掉后注销", async () => {
    const { ipc, handlers } = fakeIpc();
    const supervisorHistory = vi.fn(async (): Promise<DesktopHistoryResult> => ({
      ok: true,
      messages: [msg("m-1")],
    }));
    const stop = serveSupervisorHistory(ipc, { supervisorHistory });
    const h = handlers.get(IPC_CHANNELS.supervisorHistory)!;
    await expect(h({ sender: {} }, { before: "m-2" })).resolves.toEqual({
      ok: true,
      messages: [msg("m-1")],
    });
    expect(supervisorHistory).toHaveBeenCalledWith({ before: "m-2" });
    stop();
    expect(handlers.has(IPC_CHANNELS.supervisorHistory)).toBe(false);
  });

  it("只读后端：ok:true 空列表", async () => {
    const b = readonlyBackend("/repo/secret-path", "缺少环境变量 DEEPSEEK_API_KEY");
    const r = await b.supervisorHistory({ before: "m-1" });
    expect(r).toEqual({ ok: true, messages: [] });
    expect(JSON.stringify(r)).not.toContain("/repo");
  });

  it("BackendSwitcher.supervisorHistory 把请求原样转给当前后端，结果原样返回（UI-04b 补测）", async () => {
    const supervisorHistory = vi.fn(async (): Promise<DesktopHistoryResult> => ({
      ok: true,
      messages: [msg("m-9")],
    }));
    const current = {
      onNotify: () => () => {},
      onPendingHighRisk: () => () => {},
      supervisorHistory,
    } as unknown as BackendHandle;
    const sw = new BackendSwitcher(current, async () => current);
    const query = { before: "m-10", limit: 50 };
    await expect(sw.supervisorHistory(query)).resolves.toEqual({
      ok: true,
      messages: [msg("m-9")],
    });
    expect(supervisorHistory).toHaveBeenCalledWith(query);
  });
});
