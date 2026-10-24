// @vitest-environment jsdom
// UI-04c：回复卡片按 kind 呈现、ask_project 项目按钮、重试拆单走 supervisor:split、等待三点、失败气泡、空状态。
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatReply, DesktopChatResult, DesktopSplitResult } from "../../shared/api";
import { ChatStore } from "../data/chatStore";
import { CHAT_COPY } from "../lib/copy";
import { MessageItem } from "./MessageItem";
import { SupervisorChat } from "./SupervisorChat";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const PROJECTS = [
  { project_id: "p-1", name: "商城", repo_path: "/x/a" },
  { project_id: "p-2", name: "后台", repo_path: "/x/b" },
];
const listProjects = vi.fn(async () => ({ ok: true as const, projects: PROJECTS }));

function type(text: string) {
  fireEvent.change(screen.getByLabelText("发给主管"), { target: { value: text } });
  fireEvent.click(screen.getByLabelText("发送"));
}

/** 每次调用回一条不同 message_id 的回复 */
function chatSeq(...rs: Omit<ChatReply, "message_id">[]) {
  let i = 0;
  return vi.fn(async (): Promise<DesktopChatResult> => {
    const r = rs[Math.min(i, rs.length - 1)]!;
    i += 1;
    return { ok: true, reply: { ...r, message_id: `ui-c-r${i}` } as ChatReply };
  });
}

describe("MessageItem 按 kind 呈现（UI-04c）", () => {
  it("answer：普通文本，没有标签/卡片/按钮", () => {
    render(<MessageItem reply={{ kind: "answer", message_id: "m1", text: "就是这样" }} />);
    const el = screen.getByTestId("chat-reply");
    expect(el.dataset.kind).toBe("answer");
    expect(el.textContent).toContain("就是这样");
    expect(el.querySelectorAll("button")).toHaveLength(0);
    expect(screen.queryByTestId("chat-decision-tag")).toBeNull();
    expect(screen.queryByTestId("chat-dispatched")).toBeNull();
  });

  it("ask_project：一排项目按钮，点了回调该项目", () => {
    const onPick = vi.fn();
    render(
      <MessageItem
        reply={{ kind: "ask_project", message_id: "m2", text: "哪个项目？" }}
        projects={PROJECTS}
        onPickProject={onPick}
      />,
    );
    const group = screen.getByRole("group", { name: CHAT_COPY.pickProject });
    expect(
      within(group)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["商城", "后台"]);
    fireEvent.click(within(group).getByRole("button", { name: "后台" }));
    expect(onPick).toHaveBeenCalledWith(PROJECTS[1]);
  });

  it("decision_saved：「已记下」小标签", () => {
    render(<MessageItem reply={{ kind: "decision_saved", message_id: "m3", text: "记好了" }} />);
    expect(screen.getByTestId("chat-decision-tag").textContent).toBe("已记下");
    expect(screen.queryByTestId("chat-projects")).toBeNull();
  });

  it("dispatched：「已派单」卡片，需求 + 拆出 N 张单；没有「查看需求」", () => {
    render(
      <MessageItem
        reply={{
          kind: "dispatched",
          message_id: "m4",
          text: "派好了",
          requirement_id: "req-9",
          ticket_ids: ["T-1", "T-2", "T-3"],
        }}
      />,
    );
    const card = screen.getByTestId("chat-dispatched");
    expect(card.textContent).toContain("已派单");
    expect(card.textContent).toContain("req-9");
    expect(card.textContent).toContain("拆出 3 张单");
    expect(screen.getByTestId("chat-tickets").textContent).toBe("单号：T-1、T-2、T-3");
    expect(screen.queryByText("查看需求")).toBeNull();
    expect(document.body.textContent).not.toContain("查看需求");
  });

  it("split_failed：给了 onRetrySplit 才有「重试拆单」", () => {
    const onRetry = vi.fn();
    const reply: ChatReply = { kind: "split_failed", message_id: "m5", text: "拆不动" };
    const { rerender } = render(<MessageItem reply={reply} />);
    expect(screen.queryByTestId("chat-retry-split")).toBeNull();
    rerender(<MessageItem reply={reply} onRetrySplit={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: "重试拆单" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("每个 kind 的 data-kind 都对", () => {
    for (const kind of [
      "answer",
      "ask_project",
      "decision_saved",
      "dispatched",
      "split_failed",
    ] as const) {
      render(<MessageItem reply={{ kind, message_id: `k-${kind}`, text: kind } as ChatReply} />);
      expect(screen.getByTestId("chat-reply").dataset.kind).toBe(kind);
      cleanup();
    }
  });
});

describe("SupervisorChat 接回复卡片（UI-04c）", () => {
  it("ask_project 点项目按钮：带 project_id 重发（新 message_id），不走 split", async () => {
    const supervisorChat = chatSeq(
      { kind: "ask_project", text: "是哪个项目？" },
      { kind: "answer", text: "好的" },
    );
    const supervisorSplit = vi.fn();
    render(
      <SupervisorChat
        store={new ChatStore()}
        initial={[]}
        api={{ supervisorChat, listProjects, supervisorSplit }}
      />,
    );
    type("加个登录页");
    const group = await screen.findByRole("group", { name: CHAT_COPY.pickProject });
    await within(group).findByRole("button", { name: "后台" });
    fireEvent.click(within(group).getByRole("button", { name: "后台" }));
    await waitFor(() => expect(supervisorChat).toHaveBeenCalledTimes(2));
    const [first] = supervisorChat.mock.calls[0] as unknown as [{ message_id: string }];
    const [second] = supervisorChat.mock.calls[1] as unknown as [
      { text: string; project_id: string; message_id: string },
    ];
    expect(second).toMatchObject({ text: "后台", project_id: "p-2" });
    expect(second.message_id).not.toBe(first.message_id);
    await screen.findByText("好的");
    expect(supervisorSplit).not.toHaveBeenCalled();
  });

  it("重试拆单：调 supervisor:split，text 是原用户消息、requirement_id 原样传回，不走 chat", async () => {
    const supervisorChat = chatSeq({
      kind: "split_failed",
      text: "拆单 3 次都不合法",
      project_id: "p-1",
      requirement_id: "req-42",
    });
    const supervisorSplit = vi.fn(async (): Promise<DesktopSplitResult> => ({
      ok: true,
      requirement_id: "req-42",
      ticket_ids: ["T-8", "T-9"],
    }));
    render(
      <SupervisorChat
        store={new ChatStore()}
        initial={[]}
        api={{ supervisorChat, listProjects, supervisorSplit }}
      />,
    );
    type("后台订单加日期筛选");
    fireEvent.click(await screen.findByRole("button", { name: "重试拆单" }));
    await waitFor(() => expect(supervisorSplit).toHaveBeenCalledTimes(1));
    expect(supervisorSplit).toHaveBeenCalledWith({
      project_id: "p-1",
      text: "后台订单加日期筛选",
      requirement_id: "req-42",
    });
    expect(supervisorChat).toHaveBeenCalledTimes(1);
    const card = await screen.findByTestId("chat-dispatched");
    expect(card.textContent).toContain("拆出 2 张单");
    expect(card.textContent).toContain("T-8、T-9");
  });

  it("重试拆单失败：显示（已清洗的）原因，不含路径", async () => {
    const supervisorChat = chatSeq({ kind: "split_failed", text: "拆不动", project_id: "p-1" });
    const supervisorSplit = vi.fn(async (): Promise<DesktopSplitResult> => ({
      ok: false,
      reason: "重试拆单失败：模型超时",
    }));
    render(
      <SupervisorChat
        store={new ChatStore()}
        initial={[]}
        api={{ supervisorChat, listProjects, supervisorSplit }}
      />,
    );
    type("做个导出");
    fireEvent.click(await screen.findByRole("button", { name: "重试拆单" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("模型超时");
    expect(supervisorSplit).toHaveBeenCalledWith({ project_id: "p-1", text: "做个导出" });
  });

  describe("T-151：历史里的 split_failed 按 in_reply_to 重试拆单", () => {
    const user = (id: string, content: string, project_id: string | null = "p-1") => ({
      message_id: id,
      project_id,
      role: "user" as const,
      kind: null,
      content,
      requirement_id: null,
      ticket_ids: [],
      created_at: 1,
      in_reply_to: null,
    });
    const failed = (extra: Record<string, unknown>) => ({
      message_id: "h-r",
      project_id: "p-1" as string | null,
      role: "supervisor" as const,
      kind: "split_failed" as const,
      content: "拆不动",
      requirement_id: "req-1" as string | null,
      ticket_ids: [],
      created_at: 3,
      ...extra,
    });
    function renderHistory(messages: unknown[]) {
      const supervisorSplit = vi.fn(async (): Promise<DesktopSplitResult> => ({
        ok: true,
        requirement_id: "req-1",
        ticket_ids: ["T-1"],
      }));
      const supervisorChat = vi.fn();
      const getSupervisorHistory = vi.fn(async () => ({ ok: true as const, messages }));
      render(
        <SupervisorChat
          store={new ChatStore()}
          api={
            {
              getSupervisorHistory,
              supervisorSplit,
              supervisorChat,
              listProjects,
            } as never
          }
        />,
      );
      return { supervisorSplit, supervisorChat };
    }

    it("按 in_reply_to 取原文（不取前面最近一条），走 split、requirement_id 原样带回、不走 chat", async () => {
      const { supervisorSplit, supervisorChat } = renderHistory([
        user("h-u1", "老需求原文"),
        user("h-u2", "后来的闲聊"),
        failed({ in_reply_to: "h-u1" }),
      ]);
      fireEvent.click(await screen.findByRole("button", { name: "重试拆单" }));
      await waitFor(() => expect(supervisorSplit).toHaveBeenCalledTimes(1));
      expect(supervisorSplit).toHaveBeenCalledWith({
        project_id: "p-1",
        text: "老需求原文",
        requirement_id: "req-1",
      });
      expect(supervisorChat).not.toHaveBeenCalled();
    });

    it("回复没有项目时用那条用户消息的项目", async () => {
      const { supervisorSplit } = renderHistory([
        user("h-u1", "老需求", "p-2"),
        failed({ in_reply_to: "h-u1", project_id: null, requirement_id: null }),
      ]);
      fireEvent.click(await screen.findByRole("button", { name: "重试拆单" }));
      await waitFor(() =>
        expect(supervisorSplit).toHaveBeenCalledWith({ project_id: "p-2", text: "老需求" }),
      );
    });

    it.each([
      ["in_reply_to 为 null", [user("h-u1", "老需求"), failed({ in_reply_to: null })]],
      ["没有 in_reply_to 字段", [user("h-u1", "老需求"), failed({})]],
      ["找不到对应用户消息", [user("h-u1", "老需求"), failed({ in_reply_to: "h-gone" })]],
      [
        "回复和用户消息都没有项目",
        [user("h-u1", "老需求", null), failed({ in_reply_to: "h-u1", project_id: null })],
      ],
    ])("%s：不显示「重试拆单」", async (_name, messages) => {
      renderHistory(messages);
      expect(await screen.findByText("拆不动")).toBeTruthy();
      expect(screen.getByTestId("chat-reply").dataset.kind).toBe("split_failed");
      expect(screen.queryByRole("button", { name: "重试拆单" })).toBeNull();
    });
  });

  it("等待回复：三个点", async () => {
    let resolve!: (r: DesktopChatResult) => void;
    const supervisorChat = vi.fn(() => new Promise<DesktopChatResult>((r) => (resolve = r)));
    render(<SupervisorChat store={new ChatStore()} initial={[]} api={{ supervisorChat }} />);
    type("在吗");
    const dots = await screen.findByTestId("chat-pending");
    expect(dots.getAttribute("aria-label")).toBe(CHAT_COPY.waiting);
    expect(dots.querySelectorAll(".animate-breathe")).toHaveLength(3);
    resolve({ ok: true, reply: { kind: "answer", message_id: "ui-w1", text: "在" } });
    await waitFor(() => expect(screen.queryByTestId("chat-pending")).toBeNull());
  });

  it("发送失败：气泡上「没发出去 · 重试」，点了用同一 message_id 重发", async () => {
    const supervisorChat = vi
      .fn<() => Promise<DesktopChatResult>>()
      .mockResolvedValueOnce({ ok: false, reason: "网络断了" })
      .mockResolvedValueOnce({
        ok: true,
        reply: { kind: "answer", message_id: "ui-f1", text: "收到" },
      });
    render(<SupervisorChat store={new ChatStore()} initial={[]} api={{ supervisorChat }} />);
    type("你好");
    const btn = await screen.findByRole("button", { name: "没发出去 · 重试" });
    fireEvent.click(btn);
    await screen.findByText("收到");
    const calls = supervisorChat.mock.calls as unknown as [{ message_id: string }][];
    expect(calls[1]![0].message_id).toBe(calls[0]![0].message_id);
  });

  it("空状态：三个示例，点了只填进输入框，不发送", async () => {
    const supervisorChat = vi.fn();
    render(<SupervisorChat store={new ChatStore()} initial={[]} api={{ supervisorChat }} />);
    const ex = screen.getAllByTestId("chat-example");
    expect(ex.map((e) => e.textContent)).toEqual([...CHAT_COPY.examples]);
    fireEvent.click(ex[1]!);
    expect((screen.getByLabelText("发给主管") as HTMLTextAreaElement).value).toBe(
      CHAT_COPY.examples[1],
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(supervisorChat).not.toHaveBeenCalled();
  });

  it("有消息后空状态消失", async () => {
    const supervisorChat = chatSeq({ kind: "answer", text: "嗯" });
    render(<SupervisorChat store={new ChatStore()} initial={[]} api={{ supervisorChat }} />);
    expect(screen.getByTestId("chat-empty")).toBeTruthy();
    type("hi");
    await screen.findByText("嗯");
    expect(screen.queryByTestId("chat-empty")).toBeNull();
  });
});

describe("UI-05f：「查看需求」与草稿预填", () => {
  const dispatched = (requirement_id?: string) =>
    ({
      kind: "dispatched",
      message_id: "m5",
      text: "派好了",
      ...(requirement_id && { requirement_id }),
      ticket_ids: ["T-1"],
    }) as ChatReply;

  it("给了 onOpenRequirement 且有需求号：卡片上有「查看需求」，点了带需求号回调", () => {
    const onOpen = vi.fn();
    render(<MessageItem reply={dispatched("req-9")} onOpenRequirement={onOpen} />);
    fireEvent.click(screen.getByTestId("chat-view-requirement"));
    expect(onOpen).toHaveBeenCalledWith("req-9");
    expect(screen.getByTestId("chat-view-requirement").textContent).toBe("查看需求");
  });

  it("没有需求号就不给「查看需求」（即使给了回调）", () => {
    render(<MessageItem reply={dispatched()} onOpenRequirement={vi.fn()} />);
    expect(screen.queryByTestId("chat-view-requirement")).toBeNull();
  });

  it("SupervisorChat 把 onOpenRequirement 传到 dispatched 卡片", async () => {
    const supervisorChat = vi.fn(async (): Promise<DesktopChatResult> => ({
      ok: true,
      reply: dispatched("req-7"),
    }));
    const onOpen = vi.fn();
    render(
      <SupervisorChat
        store={new ChatStore()}
        initial={[]}
        api={{ supervisorChat, listProjects }}
        onOpenRequirement={onOpen}
      />,
    );
    type("加个登录页");
    fireEvent.click(await screen.findByTestId("chat-view-requirement"));
    expect(onOpen).toHaveBeenCalledWith("req-7");
  });

  it("prefill：写进输入框但不发送，用完回调 onPrefillUsed", async () => {
    const supervisorChat = vi.fn();
    const used = vi.fn();
    render(
      <SupervisorChat
        store={new ChatStore()}
        initial={[]}
        api={{ supervisorChat, listProjects }}
        prefill="关于需求「登录」（r1）："
        onPrefillUsed={used}
      />,
    );
    await waitFor(() => expect(used).toHaveBeenCalled());
    expect((screen.getByLabelText("发给主管") as HTMLTextAreaElement).value).toBe(
      "关于需求「登录」（r1）：",
    );
    expect(supervisorChat).not.toHaveBeenCalled();
  });
});

describe("UI-05g：dispatched 卡片需求名", () => {
  const reply = {
    kind: "dispatched",
    message_id: "m6",
    text: "派好了",
    requirement_id: "req-9",
    ticket_ids: ["T-1"],
  } as ChatReply;

  it("给了 requirementNameOf：显示名字", () => {
    render(<MessageItem reply={reply} requirementNameOf={() => "加登录页"} />);
    const t = screen.getByTestId("chat-requirement").textContent!;
    expect(t).toContain("加登录页");
    expect(t).not.toContain("req-9");
  });

  it("名字取不到（空串）：回退需求号", () => {
    render(<MessageItem reply={reply} requirementNameOf={() => ""} />);
    expect(screen.getByTestId("chat-requirement").textContent).toContain("req-9");
  });
});
