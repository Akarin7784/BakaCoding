// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatReply, DesktopChatResult, UserMessage } from "../../shared/api";
import { chatReplyView } from "../lib/chat-labels";
import { SupervisorChat } from "./SupervisorChat";

afterEach(cleanup);

const replies: ChatReply[] = [
  { kind: "answer", text: "这是回答" },
  { kind: "ask_project", text: "是哪个项目？" },
  { kind: "decision_saved", text: "已记下这条项目决策", project_id: "P-1" },
  {
    kind: "dispatched",
    text: "已拆成 2 张单",
    project_id: "P-1",
    requirement_id: "r",
    ticket_ids: ["T-1", "T-2"],
  },
  { kind: "split_failed", text: "拆单 3 次都不合法", project_id: "P-1", requirement_id: "r" },
];
const LABEL: Record<ChatReply["kind"], string> = {
  answer: "回答",
  ask_project: "需要选项目",
  decision_saved: "已记下决策",
  dispatched: "已派单",
  split_failed: "拆单失败",
};

function type(text: string) {
  fireEvent.change(screen.getByLabelText("发给主管"), { target: { value: text } });
  fireEvent.click(screen.getByLabelText("发送"));
}

describe("SupervisorChat 接 supervisor:chat（T-071）", () => {
  it.each(replies)("渲染 $kind", async (reply) => {
    const supervisorChat = vi.fn(async (): Promise<DesktopChatResult> => ({ ok: true, reply }));
    render(<SupervisorChat initial={[]} api={{ supervisorChat }} projectId="P-1" />);
    type("做个登录页");
    const el = await screen.findByTestId("chat-reply");
    expect(el.dataset.kind).toBe(reply.kind);
    expect(el.textContent).toContain(LABEL[reply.kind]);
    expect(el.textContent).toContain(reply.text);
    expect(supervisorChat).toHaveBeenCalledWith({ text: "做个登录页", project_id: "P-1" });
    if (reply.kind === "dispatched") {
      expect(screen.getByTestId("chat-tickets").textContent).toBe("单号：T-1、T-2");
    }
    expect(screen.getByText("做个登录页")).toBeTruthy();
  });

  it("chatReplyView 覆盖每个 kind", () => {
    for (const r of replies) expect(chatReplyView(r).label).toBe(LABEL[r.kind]);
    expect(chatReplyView(replies[4]!).tone).toBe("error");
  });

  it("等待中显示状态并禁用发送；上一条回来前不发第二条", async () => {
    let resolve!: (r: DesktopChatResult) => void;
    const supervisorChat = vi.fn(
      (_m: UserMessage) => new Promise<DesktopChatResult>((r) => (resolve = r)), // eslint-disable-line @typescript-eslint/no-unused-vars
    );
    render(<SupervisorChat initial={[]} api={{ supervisorChat }} />);
    type("第一条");
    expect(await screen.findByTestId("chat-pending")).toBeTruthy();
    expect((screen.getByLabelText("发送") as HTMLButtonElement).disabled).toBe(true);
    type("第二条");
    fireEvent.keyDown(screen.getByLabelText("发给主管"), { key: "Enter" });
    expect(supervisorChat).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ ok: true, reply: replies[0]! }));
    await waitFor(() => expect(screen.queryByTestId("chat-pending")).toBeNull());
    expect((screen.getByLabelText("发送") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByLabelText("发送"));
    expect(supervisorChat).toHaveBeenCalledTimes(2);
    expect(supervisorChat.mock.calls[1]![0]).toEqual({ text: "第二条" });
  });

  it("ok:false：显示原因（role=alert）", async () => {
    const supervisorChat = vi.fn(async (): Promise<DesktopChatResult> => ({
      ok: false,
      reason: "只读模式：缺少环境变量 DEEPSEEK_API_KEY",
    }));
    render(<SupervisorChat initial={[]} api={{ supervisorChat }} />);
    type("hi");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "发送失败：只读模式：缺少环境变量 DEEPSEEK_API_KEY",
    );
  });

  it("IPC 被拒：显示通用失败，不原样透出错误信息（不泄露密钥）", async () => {
    const secret = "sk-leak-0123456789abcdef";
    const supervisorChat = vi.fn(async (): Promise<DesktopChatResult> => {
      throw new Error(`Error invoking remote method: Bearer ${secret}`);
    });
    render(<SupervisorChat initial={[]} api={{ supervisorChat }} />);
    type("hi");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("发送失败：和主进程通信失败，请重试");
    expect(document.body.textContent).not.toContain(secret);
    expect((screen.getByLabelText("发送") as HTMLButtonElement).disabled).toBe(false);
  });

  it("没有 api（假数据）时只追加到本地", () => {
    render(<SupervisorChat initial={[]} />);
    type("本地消息");
    expect(screen.getByText("本地消息")).toBeTruthy();
    expect(screen.queryByTestId("chat-pending")).toBeNull();
  });
});
