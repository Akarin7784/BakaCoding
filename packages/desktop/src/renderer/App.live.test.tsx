// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { BakaEvent } from "@bakacoding/types";
import { afterEach, describe, expect, it, vi } from "vitest";
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

const ticketRow = (id: string) =>
  screen.getAllByTestId("ticket-row").find((el) => el.dataset.ticket === id) as HTMLElement;

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
    // UI-06a：右面板单列表来自快照 tickets（状态图标 + ×重写次数）
    const t1 = ticketRow("T-1");
    expect(within(t1).getByRole("img", { name: "编码中" }).dataset.tone).toBe("accent");
    const t2 = ticketRow("T-2");
    expect(within(t2).getByRole("img", { name: "需要人工介入" }).dataset.tone).toBe("danger");
    expect(t2.textContent).toContain("×3");
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
    expect(within(ticketRow("T-1")).getByRole("img", { name: "已合入" }).dataset.tone).toBe(
      "foreground",
    );
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

describe("UI-05f：需求页（api mock）", () => {
  afterEach(() => {
    window.location.hash = "";
  });

  function reqApi(snap: DesktopSnapshot = snapshot) {
    const { api } = fakeApi(snap);
    const exportDiagnostics = vi.fn(async () => ({ ok: true as const, path: "/tmp/d.zip" }));
    const getRequirementDetail = vi.fn(async () => ({
      ok: true as const,
      detail: {
        requirement_id: "R-1",
        name: "真实单一",
        requirement_text: "做两张单",
        decomposition_summary: "拆成两张",
        tickets: [],
      },
    }));
    return { api: { ...api, exportDiagnostics, getRequirementDetail }, exportDiagnostics };
  }

  async function openReq(api: BakaDesktopApi) {
    render(<App api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: /real-proj/ }));
    fireEvent.click(openRow("R-1"));
  }

  // #252 从 App.live.test / App.test 挪来的三条断言：群消息、Flash 调用（默认收起、含输出）、agent 图标
  it("需求页里有群消息、Flash 调用（默认收起、含输出）和 agent 图标", async () => {
    await openReq(reqApi().api as unknown as BakaDesktopApi);
    expect(await screen.findByText("T-1：真实派单")).toBeTruthy();
    const calls = screen.getAllByTestId("flash-calls");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.textContent).toContain("真实输出");
    expect((calls[0] as HTMLDetailsElement).open).toBe(false);
  });

  it("需求页里子 agent 的消息带 agent 图标（假数据 req-1）", async () => {
    window.location.hash = "#requirement=req-1";
    render(<App />);
    expect((await screen.findAllByTestId("icon-agent")).length).toBeGreaterThan(0);
  });

  it("「⋯」导出这个需求的诊断包：api.exportDiagnostics 收到 requirement scope", async () => {
    const { api, exportDiagnostics } = reqApi();
    await openReq(api as unknown as BakaDesktopApi);
    fireEvent.keyDown(await screen.findByTestId("requirement-menu"), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "导出这个需求的诊断包" }));
    await waitFor(() =>
      expect(exportDiagnostics).toHaveBeenCalledWith({
        scope: { kind: "requirement", requirement_id: "R-1" },
      }),
    );
  });

  it("UI-06a：右面板单列表行内导出：api.exportDiagnostics 收到 ticket scope", async () => {
    const { api, exportDiagnostics } = reqApi();
    render(<App api={api as unknown as BakaDesktopApi} />);
    fireEvent.click(await screen.findByRole("button", { name: /real-proj/ }));
    fireEvent.click(screen.getByRole("button", { name: "打开右面板" }));
    fireEvent.click(screen.getByRole("button", { name: "导出 T-2 诊断包" }));
    await waitFor(() =>
      expect(exportDiagnostics).toHaveBeenCalledWith({
        scope: { kind: "ticket", ticket_id: "T-2" },
      }),
    );
  });

  it("「⋯」追问：回主管对话，输入框预填需求，不自动发送", async () => {
    const { api } = reqApi();
    const supervisorChat = vi.fn();
    await openReq({ ...api, supervisorChat } as unknown as BakaDesktopApi);
    fireEvent.keyDown(await screen.findByTestId("requirement-menu"), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "在主管对话里追问" }));
    await waitFor(() => expect(window.location.hash).toBe(""));
    const box = document.querySelector<HTMLTextAreaElement>(
      'textarea[data-composer="supervisor"]',
    )!;
    await waitFor(() => expect(box.value).toBe("关于需求「真实单一」（R-1）："));
    expect(supervisorChat).not.toHaveBeenCalled();
  });

  it("「需要你处理」：回主管对话，草稿带单号和需求名", async () => {
    await openReq(reqApi().api as unknown as BakaDesktopApi);
    fireEvent.click(await screen.findByRole("button", { name: "需要你处理" }));
    await waitFor(() => expect(window.location.hash).toBe(""));
    const box = document.querySelector<HTMLTextAreaElement>(
      'textarea[data-composer="supervisor"]',
    )!;
    await waitFor(() => expect(box.value).toBe("T-2（需求「真实单一」）需要我处理："));
  });
});

describe("UI-06a P3：取不到需求名时草稿退回需求号", () => {
  afterEach(() => {
    window.location.hash = "";
  });
  // 单子标题全空白 → requirementName 为空 → requirementNameOf 退回需求号
  const nameless: DesktopSnapshot = {
    ...snapshot,
    tickets: snapshot.tickets.map((t) => ({ ...t, title: "   " })),
  };
  const api = () => {
    const { api } = fakeApi(nameless);
    const getRequirementDetail = vi.fn(async () => ({
      ok: true as const,
      detail: {
        requirement_id: "R-1",
        name: "",
        requirement_text: "做两张单",
        decomposition_summary: "拆成两张",
        tickets: [],
      },
    }));
    return { ...api, getRequirementDetail } as unknown as BakaDesktopApi;
  };
  const composer = () =>
    document.querySelector<HTMLTextAreaElement>('textarea[data-composer="supervisor"]')!;
  const open = async () => {
    render(<App api={api()} />);
    fireEvent.click(await screen.findByRole("button", { name: /real-proj/ }));
    fireEvent.click(openRow("R-1"));
  };

  it("「追问」草稿写需求号", async () => {
    await open();
    fireEvent.keyDown(await screen.findByTestId("requirement-menu"), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "在主管对话里追问" }));
    await waitFor(() => expect(composer().value).toBe("关于需求「R-1」（R-1）："));
  });

  it("「需要你处理」草稿写需求号", async () => {
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "需要你处理" }));
    await waitFor(() => expect(composer().value).toBe("T-2（需求「R-1」）需要我处理："));
  });
});

describe("UI-05g：派单卡片需求名、Ctrl+N、查看需求选中项目、回主管对话聚焦", () => {
  afterEach(() => {
    window.location.hash = "";
  });

  const noDetail = async () => ({ ok: false as const, reason: "x" });
  const composer = () =>
    document.querySelector<HTMLTextAreaElement>('textarea[data-composer="supervisor"]')!;

  async function dispatchTo(requirement_id: string) {
    const { api } = fakeApi(snapshot);
    const supervisorChat = vi.fn(async () => ({
      ok: true as const,
      reply: {
        kind: "dispatched" as const,
        message_id: `m-${requirement_id}`,
        text: "派好了",
        requirement_id,
        ticket_ids: ["T-1"],
      },
    }));
    render(
      <App
        api={
          { ...api, supervisorChat, getRequirementDetail: noDetail } as unknown as BakaDesktopApi
        }
      />,
    );
    await screen.findByRole("button", { name: /real-proj/ });
    fireEvent.change(screen.getByLabelText("发给主管"), { target: { value: "做" } });
    fireEvent.click(screen.getByLabelText("发送"));
    await waitFor(() => expect(supervisorChat).toHaveBeenCalled());
    // 主管对话的 store 是全局的，前面用例的卡片还在：按需求号挑出这次的卡片
    const id = requirement_id === "R-1" ? "真实单一" : requirement_id;
    await waitFor(() =>
      expect(
        screen.getAllByTestId("chat-dispatched").some((c) => c.textContent?.includes(id)),
      ).toBe(true),
    );
    return screen.getAllByTestId("chat-dispatched").find((c) => c.textContent?.includes(id))!;
  }

  it("dispatched 卡片显示需求名（最早一张单第一行），不显示需求号", async () => {
    const card = await dispatchTo("R-1");
    const req = card.querySelector('[data-testid="chat-requirement"]')!;
    expect(req.textContent).toContain("真实单一");
    expect(req.textContent).not.toContain("R-1");
  });

  it("快照里没有这个需求的单：回退显示需求号", async () => {
    const card = await dispatchTo("R-404");
    expect(card.querySelector('[data-testid="chat-requirement"]')!.textContent).toContain("R-404");
  });

  it("「查看需求」打开需求页并选中所属项目", async () => {
    const card = await dispatchTo("R-1");
    fireEvent.click(card.querySelector<HTMLElement>('[data-testid="chat-view-requirement"]')!);
    expect(window.location.hash).toBe("#requirement=R-1");
    // 左栏里 R-1 行是当前项；关掉需求路由后停在所属项目的项目页（而不是主管对话）
    await waitFor(() =>
      expect(
        document.querySelector('nav [aria-current="page"]')?.textContent?.includes("真实单一"),
      ).toBe(true),
    );
    act(() => {
      window.location.hash = "";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(await screen.findByRole("region", { name: "项目页" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /real-proj/ }).getAttribute("aria-current")).toBe(
      "page",
    );
  });

  it("Ctrl+N 清掉 #requirement 路由，回主管对话", async () => {
    window.location.hash = "#requirement=R-1";
    render(
      <App
        api={
          { ...fakeApi(snapshot).api, getRequirementDetail: noDetail } as unknown as BakaDesktopApi
        }
      />,
    );
    await screen.findByRole("button", { name: /real-proj/ });
    fireEvent.keyDown(window, { key: "n", ctrlKey: true });
    await waitFor(() => expect(window.location.hash).toBe(""));
    await waitFor(() => expect(document.activeElement).toBe(composer()));
  });

  it("「需要你处理」回主管对话后光标在输入框里", async () => {
    const { api } = fakeApi(snapshot);
    render(<App api={{ ...api, getRequirementDetail: noDetail } as unknown as BakaDesktopApi} />);
    fireEvent.click(await screen.findByRole("button", { name: /real-proj/ }));
    fireEvent.click(openRow("R-1"));
    fireEvent.click(await screen.findByRole("button", { name: "需要你处理" }));
    await waitFor(() => expect(composer()).toBeTruthy());
    await waitFor(() => expect(document.activeElement).toBe(composer()));
  });
});

describe("编码池行接 pool:state（UI-06b）", () => {
  const bp = (paused: boolean, reasons: string[]) => ({
    ok: true as const,
    state: {
      paused,
      concurrency: 4,
      reasons: reasons as never,
      review_backlog: { pending: 0, capacity: 8 },
      supervisor_backlog: null,
      pending_prs: { merge_queued: 0, in_review: 0, total: 0, limit: 10, high_risk_held: 0 },
      daily_budget_exhausted: false,
    },
  });

  it("首读按快照 coding 数显示；快照更新才重取（不轮询），反压开整行强调色", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { api, push } = fakeApi(snapshot);
      let current = bp(false, []);
      const getPoolState = vi.fn(async () => current);
      api.getPoolState = getPoolState;
      render(<App api={api} />);
      fireEvent.click(await screen.findByRole("button", { name: /real-proj/ }));
      fireEvent.click(screen.getByRole("button", { name: "打开右面板" }));
      const pool = screen.getByTestId("pool-status");
      await waitFor(() => expect(pool.textContent).toBe("并发 1/4 · 反压 关"));
      const calls = getPoolState.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(getPoolState.mock.calls.length).toBe(calls); // 不轮询
      current = bp(true, ["review_backlog_pause", "daily_budget"]);
      act(() =>
        push({
          db: snapshot.db,
          events: [],
          tickets: [snapshot.tickets[0]!, { ...snapshot.tickets[1]!, status: "coding" }],
          last_seq: 5,
        }),
      );
      await waitFor(() =>
        expect(pool.textContent).toBe("并发 2/4 · 反压 开 · 评审积压：暂停派单、今日预算已用完"),
      );
      expect(getPoolState.mock.calls.length).toBeGreaterThan(calls);
      expect(within(pool).getByText(/反压 开/).className).toContain("text-accent");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ok:false（只读）显示原因，不回退假数据", async () => {
    const { api } = fakeApi(snapshot);
    api.getPoolState = async () => ({
      ok: false,
      reason: "编码池状态暂不可用（后端只读或未接线）",
    });
    render(<App api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: /real-proj/ }));
    fireEvent.click(screen.getByRole("button", { name: "打开右面板" }));
    await waitFor(() =>
      expect(screen.getByTestId("pool-status").textContent).toBe(
        "编码池状态暂不可用（后端只读或未接线）",
      ),
    );
  });

  it("getPoolState 抛错 → 固定文案", async () => {
    const { api } = fakeApi(snapshot);
    api.getPoolState = async () => {
      throw new Error("/secret/path boom");
    };
    render(<App api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: /real-proj/ }));
    fireEvent.click(screen.getByRole("button", { name: "打开右面板" }));
    await waitFor(() =>
      expect(screen.getByTestId("pool-status").textContent).toBe("读取编码池状态失败"),
    );
  });
});

describe("UI-06c：右面板 Git 区（git:status + 同步状态）", () => {
  const sync = {
    available: true as const,
    enabled: true,
    last_ok_at: "2026-10-17T14:59:00.000Z",
    last_error: null,
    consecutive_failures: 0,
    rate_limited_until: null,
    next_at: null,
  };
  function gitApi() {
    const { api, push } = fakeApi(snapshot);
    const syncListeners = new Set<(s: typeof sync) => void>();
    let ahead = 2;
    const getGitStatus = vi.fn(async () => ({
      ok: true as const,
      current_branch: "feat/x",
      integration_branch: "bakacoding/integration",
      ahead: ahead++,
      main_merge: "user" as const,
    }));
    Object.assign(api, {
      getGitStatus,
      getSyncState: async () => sync,
      onSyncState: (l: (s: typeof sync) => void) => {
        syncListeners.add(l);
        return () => syncListeners.delete(l);
      },
    });
    return {
      api,
      push,
      getGitStatus,
      pushSync: (s: typeof sync) => syncListeners.forEach((l) => l(s)),
    };
  }

  it("显示当前分支、集成领先 main、上次同步；快照 / 同步更新时重取，不轮询", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { api, push, getGitStatus, pushSync } = gitApi();
      window.bakacoding = api;
      render(<App />);
      fireEvent.click(await screen.findByRole("button", { name: /real-proj/ }));
      fireEvent.click(screen.getByRole("button", { name: "打开右面板" }));
      const git = await screen.findByTestId("git-live");
      await waitFor(() =>
        expect(within(git).getByTestId("git-current").textContent).toBe("当前 feat/x"),
      );
      expect(within(git).getByTestId("git-ahead").textContent).toContain("领先 main");
      expect(within(git).getByTestId("git-last-sync").textContent).toMatch(/^上次同步：2026/);
      // 只显示最后一次成功同步时间：不显示运行中 / 下次尝试
      expect(within(git).queryByTestId("sync-status")).toBeNull();
      expect(git.textContent).not.toContain("下次尝试");
      expect(within(git).queryByTestId("git-sync-error")).toBeNull();
      // 合入 main 按钮留给 06d
      expect(within(git).queryByRole("button")).toBeNull();
      const calls = getGitStatus.mock.calls.length;
      // 不轮询：一分钟没有事件不重取
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(getGitStatus.mock.calls.length).toBe(calls);
      // 快照更新 → 重取
      act(() => push({ db: snapshot.db, events: [], tickets: [...snapshot.tickets], last_seq: 4 }));
      await waitFor(() => expect(getGitStatus.mock.calls.length).toBe(calls + 1));
      // 新事件 → 重取
      act(() =>
        push({
          db: snapshot.db,
          events: [{ ...events[3]!, event_id: "evt-9", seq: 9 } as UiEvent],
          last_seq: 9,
        }),
      );
      await waitFor(() => expect(getGitStatus.mock.calls.length).toBe(calls + 2));
      // 同步更新 → 重取
      act(() => pushSync({ ...sync, last_ok_at: "2026-10-17T15:00:00.000Z" }));
      await waitFor(() => expect(getGitStatus.mock.calls.length).toBe(calls + 3));
    } finally {
      vi.useRealTimers();
    }
  });

  it("ok:false：显示固定原因；分离 HEAD 显示说明", async () => {
    const { api } = gitApi();
    api.getGitStatus = vi.fn(async () => ({ ok: false as const, reason: "还没有集成分支" }));
    window.bakacoding = api;
    const { unmount } = render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /real-proj/ }));
    fireEvent.click(screen.getByRole("button", { name: "打开右面板" }));
    expect((await screen.findByTestId("git-unavailable")).textContent).toBe("还没有集成分支");
    unmount();
    api.getGitStatus = vi.fn(async () => ({
      ok: true as const,
      current_branch: null,
      integration_branch: "bakacoding/integration",
      ahead: 0,
      main_merge: "user" as const,
    }));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /real-proj/ }));
    fireEvent.click(screen.getByRole("button", { name: "打开右面板" }));
    expect((await screen.findByTestId("git-current")).textContent).toContain("分离 HEAD");
  });
  it("同步出错：左下状态卡待处理列表有固定提示「同步异常，见右面板 Git 区」", async () => {
    const { api, pushSync } = gitApi();
    window.bakacoding = api;
    render(<App />);
    fireEvent.click(await screen.findByTestId("status-dot"));
    await screen.findByTestId("status-card");
    expect(screen.queryByTestId("status-attention")?.textContent ?? "").not.toContain("同步异常");
    act(() =>
      pushSync({
        ...sync,
        consecutive_failures: 2,
        last_error: { name: "Error", message: "boom /home/x" },
      } as typeof sync),
    );
    const items = await screen.findByTestId("status-attention");
    expect(within(items).getByText("同步异常，见右面板 Git 区")).toBeTruthy();
    // (a) Git 区显示固定文案错误提示，不透出原始错误
    fireEvent.click(screen.getByRole("button", { name: /real-proj/ }));
    fireEvent.click(screen.getByRole("button", { name: "打开右面板" }));
    const err = await screen.findByTestId("git-sync-error");
    expect(err.textContent).toBe("同步失败，稍后自动重试");
    expect(screen.getByTestId("git-live").textContent).not.toContain("boom");
  });
});
