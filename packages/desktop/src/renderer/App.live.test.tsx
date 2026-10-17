// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BakaEvent } from "@bakacoding/types";
import { afterEach, describe, expect, it } from "vitest";
import type { BakaDesktopApi, DesktopSnapshot, DesktopUpdate, UiEvent } from "../shared/api";
import { App } from "./App";

afterEach(() => {
  cleanup();
  delete window.bakacoding;
});

const base = (n: number, requirement_id: string | null, ticket_id: string | null = null) => ({
  event_id: `evt-${n}`,
  seq: n,
  ts: `2026-10-17T01:00:0${n}.000Z`,
  trace_id: "trace-1",
  span_id: `span-${n}`,
  parent_span_id: null,
  requirement_id,
  ticket_id,
});

const events = [
  {
    ...base(1, null),
    type: "project_created",
    payload: { project_id: "P-1", name: "real-proj", language: "Go", has_github_remote: false },
  },
  {
    ...base(2, "R-1", "T-1"),
    type: "group_message",
    payload: {
      project_id: "P-1",
      sender: "supervisor",
      kind: "dispatch",
      content: "T-1：真实派单",
      flash_calls: ["evt-3"],
    },
  },
  {
    ...base(3, "R-1", "T-1"),
    type: "call_completed",
    payload: {
      role: "coder",
      provider: "deepseek",
      model: "deepseek-v4.1-flash",
      effort: "low",
      prompt: "",
      output: "真实输出",
      tokens: { input: 10, output: 2, cache_hit_input: 5 },
      cache_hit: true,
      latency_ms: 321,
      cost: 1,
      is_resubmit: false,
      rate_limited_retry: 0,
    },
  },
  {
    ...base(4, "R-1", "T-2"),
    type: "escalated",
    payload: { reason: "review_limit" },
  },
] satisfies BakaEvent[] as UiEvent[];

const snapshot: DesktopSnapshot = {
  db: { path: "/p/.bakacoding/bakacoding.db", state: "ok" },
  events,
  tickets: [
    {
      ticket_id: "T-1",
      project_id: "P-1",
      requirement_id: "R-1",
      created_at: "2026-10-17T01:00:00.000Z",
      title: "真实单一",
      status: "coding",
      resubmit_count: 0,
    },
    {
      ticket_id: "T-2",
      project_id: "P-1",
      requirement_id: "R-1",
      created_at: "2026-10-17T01:00:01.000Z",
      title: "真实单二",
      status: "escalated",
      resubmit_count: 3,
    },
  ],
  last_seq: 4,
};

function fakeApi(snap: DesktopSnapshot) {
  const listeners = new Set<(u: DesktopUpdate) => void>();
  const api: BakaDesktopApi = {
    platform: "linux",
    getSnapshot: async () => snap,
    onUpdate: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  return { api, push: (u: DesktopUpdate) => listeners.forEach((l) => l(u)) };
}

describe("渲染进程从 preload API 读真实数据", () => {
  it("有 window.bakacoding 时不用假数据：项目、话题、Flash 调用、PR 状态都来自快照", async () => {
    const { api } = fakeApi(snapshot);
    window.bakacoding = api;
    render(<App />);
    const btn = await screen.findByRole("button", { name: /real-proj/ });
    expect(screen.queryByRole("button", { name: /baka-todo/ })).toBeNull();
    fireEvent.click(btn);
    expect(screen.getByText("T-1：真实派单")).toBeTruthy();
    expect(document.getElementById("topic-R-1")?.tagName).toBe("DETAILS");
    expect(screen.getByTestId("flash-calls").textContent).toContain("真实输出");

    fireEvent.click(screen.getByRole("button", { name: "打开侧边栏" }));
    expect(screen.getByText("编码中").getAttribute("data-accent")).toBe("true");
    const esc = screen.getAllByText("需要人工介入").find((el) => el.dataset.status === "escalated");
    expect(esc?.getAttribute("data-accent")).toBe("false");
    expect(screen.getByText("×3")).toBeTruthy();
    expect(screen.getByTestId("pool-status").textContent).toContain("未接入");
  });

  it("escalated 事件在项目群顶部提示需要人工介入", async () => {
    render(<App api={fakeApi(snapshot).api} />);
    fireEvent.click(await screen.findByRole("button", { name: /real-proj/ }));
    const alert = screen.getByRole("alert", { name: "需要人工介入" });
    expect(alert.textContent).toContain("需要人工介入 · T-2 · 评审复投超限");
  });

  it("增量更新：新群消息和单状态变化即时显示", async () => {
    const { api, push } = fakeApi(snapshot);
    render(<App api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: /real-proj/ }));
    act(() =>
      push({
        db: snapshot.db,
        events: [
          {
            ...base(5, "R-1", "T-1"),
            type: "group_message",
            payload: {
              project_id: "P-1",
              sender: "sub_agent",
              kind: "report",
              content: "T-1 增量回报",
              flash_calls: [],
            },
          },
        ],
        tickets: [{ ...snapshot.tickets[0]!, status: "merged" }],
        last_seq: 5,
      }),
    );
    await waitFor(() => expect(screen.getByText("T-1 增量回报")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "打开侧边栏" }));
    expect(screen.getByText("已合并").getAttribute("data-accent")).toBe("true");
  });

  it("库还不存在时提示路径；api 为 null 时退回假数据", async () => {
    const { api } = fakeApi({
      db: { path: "/p/.bakacoding/bakacoding.db", state: "missing" },
      events: [],
      tickets: [],
      last_seq: -1,
    });
    render(<App api={api} />);
    expect((await screen.findByRole("status")).textContent).toContain(
      "还没有找到数据库：/p/.bakacoding/bakacoding.db",
    );
    cleanup();
    render(<App api={null} />);
    expect(screen.getByRole("button", { name: /baka-todo/ })).toBeTruthy();
  });
});
