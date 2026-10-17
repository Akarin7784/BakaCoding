import { describe, expect, it, vi } from "vitest";
import type { ChatReply, UserMessage } from "@bakacoding/supervisor";
import { IPC_CHANNELS, type DesktopChatResult } from "../shared/api.js";
import { serveSupervisorChat, type IpcMainLike } from "./ipc.js";
import { createDesktopApi, type IpcRendererLike } from "./preload-api.js";
import { redact } from "@bakacoding/config-budget";
import { CHAT_REASON_MAX, createSerialQueue, runSupervisorChat } from "./supervisor-chat.js";

// light 规则认不出的假值：只有「环境变量值替换」这一步能遮掉它
const SECRET = "plainvalue-QwErTy-778899";
const env = { DEEPSEEK_API_KEY: SECRET, HOME: "/home/x" };

const replies: ChatReply[] = [
  { kind: "answer", text: "你好" },
  { kind: "ask_project", text: "是哪个项目？" },
  { kind: "decision_saved", text: "已记下", project_id: "P-1" },
  {
    kind: "dispatched",
    text: "已拆成 2 张单",
    project_id: "P-1",
    requirement_id: "req-1",
    ticket_ids: ["T-1", "T-2"],
  },
  { kind: "split_failed", text: "拆单 3 次都不合法", project_id: "P-1", requirement_id: "req-2" },
];

function harness(backend: { supervisorChat(m: UserMessage): Promise<DesktopChatResult> }) {
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  const ipc: IpcMainLike = {
    handle: (c, l) => void handlers.set(c, l),
    removeHandler: (c) => void handlers.delete(c),
  };
  const stop = serveSupervisorChat(ipc, backend);
  // 模拟 ipcMain.handle：第一个参数是 event
  const invoke = (arg: unknown) =>
    handlers.get(IPC_CHANNELS.supervisorChat)!({ sender: {} }, arg) as Promise<DesktopChatResult>;
  return { handlers, stop, invoke };
}

describe("supervisor:chat IPC（T-071）", () => {
  it.each(replies)("把 10 的 $kind 原样转回", async (reply) => {
    const chat = vi.fn(async () => reply);
    const { invoke, stop, handlers } = harness({
      supervisorChat: (m) => runSupervisorChat(chat, m, env, undefined),
    });
    await expect(invoke({ text: " 做个登录页 ", project_id: "P-1" })).resolves.toEqual({
      ok: true,
      reply,
    });
    expect(chat).toHaveBeenCalledWith({ text: "做个登录页", project_id: "P-1" });
    stop();
    expect(handlers.has(IPC_CHANNELS.supervisorChat)).toBe(false);
  });

  it("参数不合法时只取 text / project_id 字符串字段", async () => {
    const seen: UserMessage[] = [];
    const { invoke } = harness({
      supervisorChat: async (m) => {
        seen.push(m);
        return { ok: false, reason: "x" };
      },
    });
    await invoke({ text: "hi", project_id: 3, extra: "no" });
    await invoke(null);
    expect(seen).toEqual([{ text: "hi" }, { text: "" }]);
  });

  it("只读 / 未接线：ok:false，带只读原因，不调 chat", async () => {
    await expect(
      runSupervisorChat(undefined, { text: "hi" }, env, "缺少环境变量 DEEPSEEK_API_KEY"),
    ).resolves.toEqual({ ok: false, reason: "只读模式：缺少环境变量 DEEPSEEK_API_KEY" });
    await expect(runSupervisorChat(undefined, { text: "hi" }, env, undefined)).resolves.toEqual({
      ok: false,
      reason: "只读模式：后端未接线",
    });
  });

  it("空消息不调 chat", async () => {
    const chat = vi.fn();
    await expect(runSupervisorChat(chat, { text: "  " }, env, undefined)).resolves.toEqual({
      ok: false,
      reason: "消息为空",
    });
    expect(chat).not.toHaveBeenCalled();
  });

  it("chat() 抛错：ok:false，reason 带错误名和信息，密钥值被替换且截断", async () => {
    const chat = vi.fn(async () => {
      const e = new Error(`upstream rejected key ${SECRET} ${"x".repeat(5000)}`);
      e.name = "Budget<script>ExhaustedError";
      throw e;
    });
    const r = await runSupervisorChat(chat, { text: "hi" }, env, undefined);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(redact(SECRET, "light").text).toBe(SECRET);
    expect(r.reason).toContain("BudgetscriptExhaustedError");
    expect(r.reason).not.toContain("<script>");
    expect(r.reason).toContain("[REDACTED:DEEPSEEK_API_KEY]");
    expect(r.reason).not.toContain(SECRET);
    expect(r.reason.length).toBeLessThanOrEqual(CHAT_REASON_MAX + 1);
  });

  it("preload supervisorChat 走 supervisor:chat 通道", async () => {
    const ipc: IpcRendererLike = {
      invoke: vi.fn(async () => ({ ok: true, reply: replies[0] })),
      on: () => undefined,
      removeListener: () => undefined,
    };
    const api = createDesktopApi(ipc, "linux");
    await expect(api.supervisorChat({ text: "hi" })).resolves.toEqual({
      ok: true,
      reply: replies[0],
    });
    expect(ipc.invoke).toHaveBeenCalledWith(IPC_CHANNELS.supervisorChat, { text: "hi" });
  });

  it("截断按码点，不拆代理对", async () => {
    const chat = vi.fn(async () => {
      throw new Error("😀".repeat(CHAT_REASON_MAX + 10));
    });
    const r = await runSupervisorChat(chat, { text: "hi" }, {}, undefined);
    if (r.ok) throw new Error("expected failure");
    expect(r.reason.endsWith("…")).toBe(true);
    expect(Array.from(r.reason)).toHaveLength(CHAT_REASON_MAX + 1);
    expect(r.reason).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("主进程串行（T-072）：两条并发，第二条等第一条回来才调 chat()", async () => {
    const q = createSerialQueue();
    const order: string[] = [];
    let release!: () => void;
    const first = q(
      () =>
        new Promise<string>((r) => {
          order.push("start-1");
          release = () => {
            order.push("end-1");
            r("1");
          };
        }),
    );
    const second = q(async () => {
      order.push("start-2");
      return "2";
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(["start-1"]);
    release();
    await expect(first).resolves.toBe("1");
    await expect(second).resolves.toBe("2");
    expect(order).toEqual(["start-1", "end-1", "start-2"]);
    // 前一条失败不挡后一条
    const bad = q(async () => {
      throw new Error("x");
    });
    await expect(bad).rejects.toThrow("x");
    await expect(q(async () => "ok")).resolves.toBe("ok");
  });
});
