import type { BakaEvent } from "@bakacoding/types";
import { describe, expect, it } from "vitest";
import type { UiEvent } from "../../shared/api";
import { escalationTarget, isMergedBut, ticketWarningLabel } from "../components/Escalations";
import { buildViews, type LiveState } from "./views";

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
    payload: { project_id: "P-1", name: "proj", language: "Go", has_github_remote: true },
  },
  { ...base(2, "R-1", "T-1"), type: "escalated", payload: { reason: "review_limit" } },
  {
    ...base(3, "unattributed:pr-42", null),
    type: "escalated",
    payload: { reason: "github_manual", detail: "merged_but: interface_changed 发送失败" },
  },
  { ...base(4, "R-unknown", "T-9"), type: "escalated", payload: { reason: "coder_failed" } },
] satisfies BakaEvent[] as UiEvent[];

const state: LiveState = {
  db: { path: "/p/db", state: "ok" },
  events,
  tickets: [
    {
      ticket_id: "T-1",
      project_id: "P-1",
      requirement_id: "R-1",
      created_at: "2026-10-17T01:00:00.000Z",
      title: "单一",
      status: "escalated",
      resubmit_count: 3,
    },
  ],
  last_seq: 4,
};

describe("buildViews：找不到项目的上报进「未归属」（T-049）", () => {
  it("能对上项目的留在项目里；unattributed:* 和对不上的需求号都进未归属，按顺序，不丢", () => {
    const v = buildViews(state);
    expect(v.projects[0]!.escalations.map((e) => e.event_id)).toEqual(["evt-2"]);
    expect(v.unattributed.map((e) => e.event_id)).toEqual(["evt-3", "evt-4"]);
    expect(v.unattributed[0]).toMatchObject({
      requirement_id: "unattributed:pr-42",
      ticket_id: null,
      reason: "github_manual",
      detail: "merged_but: interface_changed 发送失败",
    });
  });

  it("没有任何上报时未归属为空", () => {
    const v = buildViews({ ...state, events: events.slice(0, 1) });
    expect(v.unattributed).toEqual([]);
  });

  it("显示对象：unattributed:* 显示 PR 号，其余显示单号或需求号；识别 merged_but", () => {
    const v = buildViews(state);
    expect(escalationTarget(v.unattributed[0]!)).toBe("PR pr-42");
    expect(escalationTarget(v.unattributed[1]!)).toBe("T-9");
    expect(escalationTarget({ ...v.unattributed[1]!, ticket_id: null })).toBe("R-unknown");
    expect(isMergedBut(v.unattributed[0]!)).toBe(true);
    expect(isMergedBut(v.unattributed[1]!)).toBe(false);
  });
});

describe("ticket_warning 和 merged_but（T-050）", () => {
  const warn = (n: number, project_id: string, ticket_id: string, code: string, detail = "") =>
    ({
      ...base(n, "R-1", ticket_id),
      type: "ticket_warning",
      payload: { project_id, code, detail },
    }) as unknown as UiEvent;

  it("警告按 payload.project_id 归到项目，按 seq 顺序；项目对不上的进未归属，不丢", () => {
    const v = buildViews({
      ...state,
      events: [
        ...events,
        warn(5, "P-1", "T-1", "write_scope_defaulted", "按 ** 处理"),
        warn(6, "P-x", "T-7", "fields_invalid"),
        warn(7, "P-1", "T-1", "fields_invalid"),
      ],
      last_seq: 7,
    });
    expect(v.projects[0]!.warnings.map((w) => [w.event_id, w.ticket_id, w.code])).toEqual([
      ["evt-5", "T-1", "write_scope_defaulted"],
      ["evt-7", "T-1", "fields_invalid"],
    ]);
    expect(v.projects[0]!.warnings[0]!.detail).toBe("按 ** 处理");
    expect(v.unattributedWarnings.map((w) => w.event_id)).toEqual(["evt-6"]);
    // 警告不混进上报
    expect(v.projects[0]!.escalations.map((e) => e.event_id)).toEqual(["evt-2"]);
  });

  it("没有警告时两边都为空", () => {
    const v = buildViews(state);
    expect(v.projects[0]!.warnings).toEqual([]);
    expect(v.unattributedWarnings).toEqual([]);
  });

  it("文案：两个已知代码有中文；不认识的代码原样显示，原型链上的名字不当成文案", () => {
    expect(ticketWarningLabel("write_scope_defaulted")).toContain("整个仓库");
    expect(ticketWarningLabel("fields_invalid")).toContain("不能续跑");
    expect(ticketWarningLabel("some_future_code")).toBe("some_future_code");
    expect(ticketWarningLabel("toString")).toBe("toString");
  });

  it("isMergedBut：reason 是 merged_but 就算（T-038 起），旧的 detail 前缀照样认", () => {
    const e = { event_id: "e", ts: "t", requirement_id: "R-1", ticket_id: "T-1" };
    expect(isMergedBut({ ...e, reason: "merged_but" })).toBe(true);
    expect(isMergedBut({ ...e, reason: "merged_but", detail: "merged_but: x" })).toBe(true);
    expect(isMergedBut({ ...e, reason: "github_manual", detail: "  merged_but: x" })).toBe(true);
    expect(isMergedBut({ ...e, reason: "internal_error", detail: "merge_error: x" })).toBe(false);
    expect(isMergedBut({ ...e, reason: "review_limit" })).toBe(false);
  });
});
