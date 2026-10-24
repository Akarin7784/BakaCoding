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

/** UI-08：未归属入口并进了左栏底部的状态卡 */
async function openUnattributed() {
  fireEvent.click(await screen.findByTestId("status-dot"));
  return await screen.findByRole("button", { name: /未归属上报/ });
}

function openRow(rid: string): HTMLElement {
  return document.querySelector<HTMLElement>(
    `[data-testid="requirement-row"][data-requirement="${rid}"]`,
  )!;
}

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
  it("有 window.bakacoding 时不用假数据：项目、需求、PR 状态都来自快照", async () => {
    const { api } = fakeApi(snapshot);
    window.bakacoding = api;
    render(<App />);
    const btn = await screen.findByRole("button", { name: /real-proj/ });
    expect(screen.queryByRole("button", { name: /baka-todo/ })).toBeNull();
    fireEvent.click(btn);
    // UI-05e：项目页列需求（名字取第一张单的第一行），消息和 Flash 调用在需求页（RequirementPage 测试覆盖）
    const row = openRow("R-1");
    expect(row.textContent).toContain("真实单一");
    expect(row.dataset.category).toBe("attention");

    fireEvent.click(screen.getByRole("button", { name: "打开右面板" }));
    expect(screen.getByText("编码中").getAttribute("data-tone")).toBe("accent");
    const esc = screen.getAllByText("需要人工介入").find((el) => el.dataset.status === "escalated");
    expect(esc?.getAttribute("data-tone")).toBe("danger");
    expect(screen.getByText("×3")).toBeTruthy();
    expect(screen.getByTestId("pool-status").textContent).toContain("未接入");
  });

  it("escalated 事件在项目群顶部提示需要人工介入", async () => {
    render(<App api={fakeApi(snapshot).api} />);
    fireEvent.click(await screen.findByRole("button", { name: /real-proj/ }));
    const alert = screen.getByRole("alert", { name: "需要人工介入" });
    expect(alert.textContent).toContain("需要人工介入 · T-2 · 评审重写超限");
  });

  it("增量更新：单状态变化即时反映到项目页需求行", async () => {
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
    // UI-05e：项目页的需求行即时跟着单状态变
    await waitFor(() => expect(openRow("R-1").textContent).toContain("全部合入"));
    expect(openRow("R-1").dataset.category).toBe("done");
    fireEvent.click(screen.getByRole("button", { name: "打开右面板" }));
    expect(screen.getByText("已合入").getAttribute("data-tone")).toBe("foreground");
  });

  it("库还不存在时提示路径；api 为 null 时退回假数据", async () => {
    const { api } = fakeApi({
      db: { path: "/p/.bakacoding/bakacoding.db", state: "missing" },
      events: [],
      tickets: [],
      last_seq: -1,
    });
    render(<App api={api} />);
    // UI-08：数据库状态在状态卡里
    await openUnattributed();
    expect(screen.getByTestId("status-db").textContent).toContain(
      "还没有建库：/p/.bakacoding/bakacoding.db",
    );
    cleanup();
    render(<App api={null} />);
    expect(screen.getByRole("button", { name: /baka-todo/ })).toBeTruthy();
  });

  it("找不到项目的上报出现在侧栏「未归属」里，带 PR 号和「代码已进集成分支」提示（T-049）", async () => {
    const { api } = fakeApi({
      ...snapshot,
      events: [
        ...events,
        {
          ...base(5, "unattributed:pr-42", null),
          type: "escalated",
          payload: { reason: "github_manual", detail: "merged_but: interface_changed 发送失败" },
        } satisfies BakaEvent as UiEvent,
      ],
      last_seq: 5,
    });
    render(<App api={api} />);
    await screen.findByRole("button", { name: /real-proj/ });
    const btn = await openUnattributed();
    expect(btn.textContent).toContain("1");
    fireEvent.click(btn);
    const alert = screen.getByRole("alert", { name: "需要人工介入" });
    expect(alert.textContent).toContain(
      "需要人工介入 · PR pr-42 · 需人工处理 GitHub（代码已进集成分支）：merged_but: interface_changed 发送失败",
    );
    // 项目里的上报不受影响
    fireEvent.click(screen.getByRole("button", { name: /real-proj/ }));
    expect(screen.getByRole("alert", { name: "需要人工介入" }).textContent).toContain("T-2");
  });

  it("没有未归属的上报时左栏不再有这一项，状态卡里是 0 且点不了（UI-08）", async () => {
    render(<App api={fakeApi(snapshot).api} />);
    await screen.findByRole("button", { name: /real-proj/ });
    expect(screen.queryByRole("button", { name: /未归属/ })).toBeNull();
    const btn = await openUnattributed();
    expect(btn.textContent).toContain("0");
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  const warning = (
    n: number,
    project_id: string,
    ticket_id: string,
    code: string,
    detail: string,
  ) =>
    ({
      ...base(n, "R-1", ticket_id),
      type: "ticket_warning",
      payload: { project_id, code, detail },
    }) as unknown as UiEvent;

  it("ticket_warning 在项目群顶部以提示显示，PR 行带提示图标；不认识的代码原样显示（T-050）", async () => {
    const { api } = fakeApi({
      ...snapshot,
      events: [
        ...events,
        warning(5, "P-1", "T-1", "write_scope_defaulted", "手工单没给 write_scope"),
        warning(6, "P-1", "T-2", "some_future_code", "以后的新代码"),
      ],
      last_seq: 6,
    });
    render(<App api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: /real-proj/ }));
    const list = screen.getByRole("status", { name: "需求单提示" });
    const items = screen.getAllByTestId("ticket-warning").map((el) => el.textContent);
    expect(items).toEqual([
      "T-1 · 没给写入范围，按整个仓库可写处理：手工单没给 write_scope",
      "T-2 · some_future_code：以后的新代码",
    ]);
    expect(list.textContent).not.toContain("需要人工介入");
    // 上报照旧，警告不算上报
    expect(screen.getByRole("alert", { name: "需要人工介入" }).textContent).toContain("T-2");

    fireEvent.click(screen.getByRole("button", { name: "打开右面板" }));
    expect(
      screen.getByRole("img", { name: "提示：没给写入范围，按整个仓库可写处理" }),
    ).toBeTruthy();
    expect(screen.getByRole("img", { name: "提示：some_future_code" })).toBeTruthy();
  });

  it("增量来的 fields_invalid 即时显示；项目对不上的警告进「未归属」（T-050）", async () => {
    const { api, push } = fakeApi(snapshot);
    render(<App api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: /real-proj/ }));
    expect(screen.queryByRole("status", { name: "需求单提示" })).toBeNull();
    act(() =>
      push({
        db: snapshot.db,
        events: [
          warning(5, "P-1", "T-1", "fields_invalid", "fields 为 null"),
          warning(6, "P-gone", "T-8", "fields_invalid", "别的项目"),
        ],
        last_seq: 6,
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "需求单提示" }).textContent).toContain(
        "T-1 · 单子的结构化字段缺失或损坏，不能续跑：fields 为 null",
      ),
    );
    const btn = await openUnattributed();
    expect(btn.textContent).toContain("1");
    fireEvent.click(btn);
    expect(screen.getByRole("status", { name: "需求单提示" }).textContent).toContain("T-8");
    expect(screen.queryByText("没有未归属的上报")).toBeNull();
  });

  it("reason 是 merged_but 的上报带「代码已进集成分支」提示（T-050）", async () => {
    const { api } = fakeApi({
      ...snapshot,
      events: [
        ...events,
        {
          ...base(5, "R-1", "T-1"),
          type: "escalated",
          payload: { reason: "merged_but", detail: "merged_but: save_merge_result 失败" },
        } satisfies BakaEvent as UiEvent,
      ],
      last_seq: 5,
    });
    render(<App api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: /real-proj/ }));
    expect(screen.getByRole("alert", { name: "需要人工介入" }).textContent).toContain(
      "需要人工介入 · T-1 · 合并后续步骤失败（代码已进集成分支）：merged_but: save_merge_result 失败",
    );
  });
});
