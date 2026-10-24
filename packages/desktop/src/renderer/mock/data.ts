// 假数据：仅用于 T-013 壳子展示，接入模块 2/3/9/10 后替换。
import type { TicketView } from "../../shared/api";
import type { FlashCallSummary, ProjectView, SupervisorMessage } from "./types";

// 事件公共字段，形状同 @bakacoding/types 的 EventCommon。
const common = <R extends string | null>(
  n: number,
  requirement_id: R,
  ticket: string | null = null,
) => ({
  event_id: `evt-${n}`,
  seq: n,
  ts: `2026-10-17T0${Math.min(n, 9)}:00:00Z`,
  requirement_id,
  ticket_id: ticket,
  trace_id: `trace-${requirement_id ?? `project-${n}`}`,
  span_id: `span-${n}`,
  parent_span_id: null,
});

export const supervisorMessages: SupervisorMessage[] = [
  {
    id: "s1",
    from: "supervisor",
    content: "项目「baka-todo」已导入，项目群已建好。",
    ts: "2026-10-17T00:00:00Z",
  },
  {
    id: "s2",
    from: "user",
    content: "baka-todo：给待办加上截止日期和按日期排序。",
    ts: "2026-10-17T00:05:00Z",
  },
  {
    id: "s3",
    from: "supervisor",
    content: "收到，拆成 2 张单，已在项目群派单。",
    ts: "2026-10-17T00:06:00Z",
  },
];

export const flashCalls: Record<string, FlashCallSummary> = {
  "call-1": {
    event_id: "call-1",
    model: "deepseek-v4.1-flash",
    effort: "low",
    latency_ms: 8200,
    tokens: { input: 12000, output: 900, cache_hit_input: 9000 },
    output: "新增 due_date 字段与迁移。",
  },
  "call-2": {
    event_id: "call-2",
    model: "deepseek-v4.1-flash",
    effort: "low",
    latency_ms: 6100,
    tokens: { input: 10400, output: 700, cache_hit_input: 8000 },
    output: "排序函数按 due_date 升序，空值置后。",
  },
};

export const projects: ProjectView[] = [
  {
    project: {
      ...common(1, null),
      type: "project_created",
      payload: {
        project_id: "p-todo",
        name: "baka-todo",
        language: "TypeScript",
        has_github_remote: true,
      },
    },
    requirements: [
      { requirement_id: "req-1", title: "待办截止日期" },
      { requirement_id: "req-2", title: "按日期排序" },
    ],
    messages: [
      {
        ...common(2, "req-1", "T-1"),
        type: "group_message",
        payload: {
          project_id: "p-todo",
          sender: "supervisor",
          kind: "dispatch",
          content: "T-1：给 Todo 加 due_date 字段，写入范围 src/model/**。",
          flash_calls: [],
        },
      },
      {
        ...common(3, "req-1", "T-1"),
        type: "group_message",
        payload: {
          project_id: "p-todo",
          sender: "sub_agent",
          kind: "report",
          content: "T-1 已提交 PR #12。",
          flash_calls: ["call-1"],
        },
      },
      {
        ...common(4, "req-1", "T-1"),
        type: "group_message",
        payload: {
          project_id: "p-todo",
          sender: "sub_agent",
          kind: "review_verdict",
          content: "评审通过，进入合并队列。",
          flash_calls: [],
        },
      },
      {
        ...common(5, "req-2", "T-2"),
        type: "group_message",
        payload: {
          project_id: "p-todo",
          sender: "supervisor",
          kind: "dispatch",
          content: "T-2：列表按 due_date 排序，写入范围 src/list/**。",
          flash_calls: [],
        },
      },
      {
        ...common(6, "req-2", "T-2"),
        type: "group_message",
        payload: {
          project_id: "p-todo",
          sender: "sub_agent",
          kind: "resubmit",
          content: "评审未过（空值处理），第 1 次重写。",
          flash_calls: ["call-2"],
        },
      },
    ],
    prs: [
      {
        pr_id: "#12",
        ticket_id: "T-1",
        requirement_id: "req-1",
        title: "due_date 字段",
        status: "merged",
        resubmit_count: 0,
      },
      {
        pr_id: "#13",
        ticket_id: "T-2",
        requirement_id: "req-2",
        title: "按日期排序",
        status: "resubmitting",
        resubmit_count: 1,
      },
    ],
    escalations: [],
    warnings: [],
    git: {
      current_branch: "bakacoding/T-2",
      integration_branch: "bakacoding/integration",
      integration_ahead_of_main: 1,
      main_merge: "user",
    },
    pool: { concurrency: { active: 1, limit: 4 }, rate_limited: false, backpressure: false },
  },
  {
    project: {
      ...common(7, null),
      type: "project_created",
      payload: {
        project_id: "p-blog",
        name: "baka-blog",
        language: "Python",
        has_github_remote: false,
      },
    },
    requirements: [],
    messages: [],
    prs: [],
    escalations: [],
    warnings: [],
    git: {
      current_branch: "main",
      integration_branch: "bakacoding/integration",
      integration_ahead_of_main: 0,
      main_merge: "user",
    },
    pool: { concurrency: { active: 0, limit: 4 }, rate_limited: true, backpressure: true },
  },
];

/** UI-05c：需求页的假单子（快照 tickets 的样子）。 */
export const tickets: TicketView[] = [
  {
    ticket_id: "T-1",
    project_id: "p-todo",
    requirement_id: "req-1",
    created_at: "2026-10-24T01:00:00Z",
    title: "给 Todo 加 due_date 字段",
    status: "merged",
    resubmit_count: 0,
  },
  {
    ticket_id: "T-2",
    project_id: "p-todo",
    requirement_id: "req-2",
    created_at: "2026-10-24T01:05:00Z",
    title: "列表按 due_date 排序",
    status: "re_reviewing",
    resubmit_count: 1,
  },
];
