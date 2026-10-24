// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatReply, DesktopChatResult, UserMessage } from "../../shared/api";
import { chatReplyView } from "../lib/chat-labels";
import { ChatStore } from "../data/chatStore";
import { SupervisorChat } from "./SupervisorChat";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const MID = expect.stringMatching(/^u-/);

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
    render(
      <SupervisorChat
        store={new ChatStore()}
        initial={[]}
        api={{ supervisorChat }}
        projectId="P-1"
      />,
    );
    type("做个登录页");
    const el = await screen.findByTestId("chat-reply");
    expect(el.dataset.kind).toBe(reply.kind);
    expect(el.textContent).toContain(LABEL[reply.kind]);
    expect(el.textContent).toContain(reply.text);
    expect(supervisorChat).toHaveBeenCalledWith({
      text: "做个登录页",
      project_id: "P-1",
      message_id: MID,
    });
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
    render(<SupervisorChat store={new ChatStore()} initial={[]} api={{ supervisorChat }} />);
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
    expect(supervisorChat.mock.calls[1]![0]).toEqual({ text: "第二条", message_id: MID });
  });

  it("ok:false：显示原因（role=alert）", async () => {
    const supervisorChat = vi.fn(async (): Promise<DesktopChatResult> => ({
      ok: false,
      reason: "只读模式：缺少环境变量 DEEPSEEK_API_KEY",
    }));
    render(<SupervisorChat store={new ChatStore()} initial={[]} api={{ supervisorChat }} />);
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
    render(<SupervisorChat store={new ChatStore()} initial={[]} api={{ supervisorChat }} />);
    type("hi");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("发送失败：和主进程通信失败，请重试");
    expect(document.body.textContent).not.toContain(secret);
    // UI-04b：输入框已清空，发送按钮置灰；重新输入后可以再发
    expect((screen.getByLabelText("发送") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("发给主管"), { target: { value: "再来" } });
    expect((screen.getByLabelText("发送") as HTMLButtonElement).disabled).toBe(false);
  });

  it("没有 api（假数据）时只追加到本地", () => {
    render(<SupervisorChat store={new ChatStore()} initial={[]} />);
    type("本地消息");
    expect(screen.getByText("本地消息")).toBeTruthy();
    expect(screen.queryByTestId("chat-pending")).toBeNull();
  });

  it("等待中卸载再挂上（切面板）：历史还在、仍在等待、不能再发（T-072）", async () => {
    let resolve!: (r: DesktopChatResult) => void;
    const supervisorChat = vi.fn(() => new Promise<DesktopChatResult>((r) => (resolve = r)));
    const store = new ChatStore();
    const first = render(<SupervisorChat store={store} initial={[]} api={{ supervisorChat }} />);
    type("第一条");
    expect(await screen.findByTestId("chat-pending")).toBeTruthy();
    first.unmount();
    render(<SupervisorChat store={store} initial={[]} api={{ supervisorChat }} projectId="P-9" />);
    expect(screen.getByText("第一条")).toBeTruthy();
    expect(screen.getByTestId("chat-pending")).toBeTruthy();
    type("第二条");
    expect(supervisorChat).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ ok: true, reply: replies[0]! }));
    expect((await screen.findByTestId("chat-reply")).dataset.kind).toBe("answer");
    fireEvent.click(screen.getByLabelText("发送"));
    expect(supervisorChat).toHaveBeenCalledTimes(2);
    expect(supervisorChat.mock.calls[1]).toEqual([
      { text: "第二条", project_id: "P-9", message_id: MID },
    ]);
  });
});

describe("SupervisorChat 历史与重试（UI-04a）", () => {
  it("挂载时取首屏 50 条历史并显示；主管消息按存储的 kind 渲染", async () => {
    const getSupervisorHistory = vi.fn(async () => ({
      ok: true as const,
      messages: [
        {
          message_id: "m1",
          project_id: "P-1",
          role: "user" as const,
          kind: null,
          content: "历史提问",
          requirement_id: null,
          ticket_ids: [],
          created_at: 1,
        },
        {
          message_id: "m1-r",
          project_id: "P-1",
          role: "supervisor" as const,
          kind: "dispatched" as const,
          content: "历史派单",
          requirement_id: "r",
          ticket_ids: ["T-7"],
          created_at: 2,
        },
      ],
    }));
    const supervisorChat = vi.fn(async (): Promise<DesktopChatResult> => ({
      ok: false,
      reason: "x",
    }));
    render(
      <SupervisorChat store={new ChatStore()} api={{ supervisorChat, getSupervisorHistory }} />,
    );
    expect(await screen.findByText("历史提问")).toBeTruthy();
    expect(getSupervisorHistory).toHaveBeenCalledWith({ limit: 50 });
    expect(screen.getByTestId("chat-reply").dataset.kind).toBe("dispatched");
    expect(screen.getByTestId("chat-tickets").textContent).toBe("单号：T-7");
  });

  it("重试沿用同一个 message_id，用户消息只留一条", async () => {
    const supervisorChat = vi
      .fn<(m: UserMessage) => Promise<DesktopChatResult>>()
      .mockResolvedValueOnce({ ok: false, reason: "网络错误" })
      .mockResolvedValueOnce({ ok: true, reply: { kind: "answer", text: "好了" } });
    render(<SupervisorChat store={new ChatStore()} api={{ supervisorChat }} />);
    type("再试试");
    fireEvent.click(await screen.findByTestId("chat-retry"));
    await screen.findByTestId("chat-reply");
    const [a, b] = supervisorChat.mock.calls.map((c) => c[0].message_id);
    expect(a).toMatch(/^u-/);
    expect(b).toBe(a);
    expect(screen.getAllByText("再试试")).toHaveLength(1);
    expect(screen.queryByTestId("chat-error")).toBeNull();
  });
});

describe("SupervisorChat 输入框项目 chip（UI-04b）", () => {
  const listProjects = vi.fn(async () => ({
    ok: true as const,
    projects: [
      { project_id: "p-1", name: "商城", repo_path: "/x/a" },
      { project_id: "p-2", name: "后台", repo_path: "/x/b" },
    ],
  }));
  const ok = vi.fn(async (): Promise<DesktopChatResult> => ({ ok: true, reply: replies[0]! }));
  const openChip = () => fireEvent.keyDown(screen.getByTestId("composer-chip"), { key: "Enter" });
  const sendBtn = () => screen.getByLabelText("发送") as HTMLButtonElement;

  it("chip 选中的项目随 chat 传 project_id（列表来自 project:list）", async () => {
    const supervisorChat = vi.fn(ok);
    render(
      <SupervisorChat
        store={new ChatStore()}
        initial={[]}
        api={{ supervisorChat, listProjects }}
      />,
    );
    openChip();
    fireEvent.click(await screen.findByRole("menuitem", { name: "后台" }));
    type("加个导出");
    await screen.findByTestId("chat-reply");
    expect(supervisorChat).toHaveBeenCalledWith({
      text: "加个导出",
      project_id: "p-2",
      message_id: MID,
    });
  });

  it("选「不指定」：chat 不带 project_id", async () => {
    const supervisorChat = vi.fn(ok);
    render(
      <SupervisorChat
        store={new ChatStore()}
        initial={[]}
        api={{ supervisorChat, listProjects }}
        projectId="p-1"
      />,
    );
    openChip();
    fireEvent.click(await screen.findByRole("menuitem", { name: "不指定" }));
    type("随便问问");
    await screen.findByTestId("chat-reply");
    expect(supervisorChat.mock.calls[0]![0]).toEqual({ text: "随便问问", message_id: MID });
  });

  it("空内容时发送置灰，有内容才可点", () => {
    render(<SupervisorChat store={new ChatStore()} initial={[]} api={{ supervisorChat: ok }} />);
    expect(sendBtn().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("发给主管"), { target: { value: "x" } });
    expect(sendBtn().disabled).toBe(false);
  });

  it("只读：有内容也置灰，Enter 不发", () => {
    const supervisorChat = vi.fn(ok);
    render(
      <SupervisorChat store={new ChatStore()} initial={[]} api={{ supervisorChat }} readonly />,
    );
    fireEvent.change(screen.getByLabelText("发给主管"), { target: { value: "x" } });
    expect(sendBtn().disabled).toBe(true);
    fireEvent.keyDown(screen.getByLabelText("发给主管"), { key: "Enter" });
    expect(supervisorChat).not.toHaveBeenCalled();
  });

  it("Enter 发送，Shift+Enter 不发送", async () => {
    const supervisorChat = vi.fn(ok);
    render(<SupervisorChat store={new ChatStore()} initial={[]} api={{ supervisorChat }} />);
    const box = screen.getByLabelText("发给主管");
    fireEvent.change(box, { target: { value: "两行" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(supervisorChat).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    await screen.findByTestId("chat-reply");
    expect(supervisorChat).toHaveBeenCalledTimes(1);
  });

  it("记住上次用的项目：重挂后 chip 默认就是它，发消息带上它", async () => {
    const supervisorChat = vi.fn(ok);
    const first = render(
      <SupervisorChat
        store={new ChatStore()}
        initial={[]}
        api={{ supervisorChat, listProjects }}
      />,
    );
    openChip();
    fireEvent.click(await screen.findByRole("menuitem", { name: "商城" }));
    first.unmount();
    render(
      <SupervisorChat
        store={new ChatStore()}
        initial={[]}
        api={{ supervisorChat, listProjects }}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("composer-chip").textContent).toContain("商城"));
    type("继续");
    await screen.findByTestId("chat-reply");
    expect(supervisorChat).toHaveBeenCalledWith({
      text: "继续",
      project_id: "p-1",
      message_id: MID,
    });
  });
});
