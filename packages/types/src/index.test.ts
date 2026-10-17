import { describe, expect, expectTypeOf, it } from "vitest";
import {
  CallCtxSchema,
  DiffSchema,
  EVENT_TYPES,
  EffortSchema,
  EventSchema,
  LedgerEntrySchema,
  PermissionListSchema,
  TokensSchema,
  DEFAULT_PERMISSION_LEVEL,
  DEPENDENCY_MANIFEST_GLOBS,
  ESCALATION_REASONS,
  PROJECT_LEVEL_EVENT_TYPES,
  TICKET_WARNING_CODES,
  type EventMap,
  type EventOf,
} from "./index.js";

const common = {
  event_id: "e1",
  seq: 1,
  ts: "2026-10-17T00:00:00.000Z",
  trace_id: "t1",
  span_id: "s1",
  parent_span_id: null,
  requirement_id: "r1",
  ticket_id: "T-001",
};

describe("Effort / CallCtx", () => {
  it("只接受四档", () => {
    expect(EffortSchema.options).toEqual(["off", "low", "high", "max"]);
    expect(EffortSchema.safeParse("medium").success).toBe(false);
  });
  it("ticket_id 可为 null", () => {
    const ctx = {
      role: "supervisor",
      requirement_id: "r1",
      ticket_id: null,
      is_resubmit: false,
      trace: { trace_id: "t", span_id: "s", parent_span_id: null },
    };
    expect(CallCtxSchema.parse(ctx)).toEqual(ctx);
  });
});

describe("EventSchema", () => {
  it("覆盖全部事件名", () => {
    expect([...EVENT_TYPES].sort()).toEqual(
      [
        "call_completed",
        "escalated",
        "group_message",
        "interface_changed",
        "project_created",
        "review_backlog",
        "supervisor_backlog",
        "ticket_warning",
        "write_scope_denied",
        "write_scope_granted",
        "write_scope_requested",
      ].sort(),
    );
  });
  it("解析 call_completed，cost 必须为整数微美元", () => {
    const ev = {
      ...common,
      type: "call_completed",
      payload: {
        role: "coder",
        provider: "deepseek",
        model: "deepseek-flash",
        effort: "low",
        prompt: "p",
        output: "o",
        tokens: { input: 10, output: 5, cache_hit_input: 8 },
        cache_hit: true,
        latency_ms: 120,
        cost: 42,
        is_resubmit: false,
        rate_limited_retry: 0,
      },
    };
    expect(EventSchema.parse(ev).type).toBe("call_completed");
    expect(EventSchema.safeParse({ ...ev, payload: { ...ev.payload, cost: 0.5 } }).success).toBe(
      false,
    );
  });
  it("拒绝非 UTC 时间戳、负 seq 和未知类型", () => {
    const ok = { ...common, type: "supervisor_backlog", payload: { pending: 3, capacity: 5 } };
    expect(EventSchema.safeParse(ok).success).toBe(true);
    expect(EventSchema.safeParse({ ...ok, ts: "2026-10-17T08:00:00+08:00" }).success).toBe(false);
    expect(EventSchema.safeParse({ ...ok, seq: -1 }).success).toBe(false);
    expect(EventSchema.safeParse({ ...ok, type: "nope" }).success).toBe(false);
  });
  it("解析 interface_changed", () => {
    const ev = {
      ...common,
      type: "interface_changed",
      payload: {
        pr_id: "pr1",
        base_commit: "4c01d30",
        changed_interfaces: [{ file: "a.ts", symbol: "foo" }],
        summary: "s",
        affected_ticket_ids: ["T-002"],
      },
    };
    expect(EventSchema.parse(ev)).toEqual(ev);
  });
  it("interface_changed 要求 ticket_id 非 null", () => {
    const ev = {
      ...common,
      ticket_id: null,
      type: "interface_changed",
      payload: {
        pr_id: "pr1",
        base_commit: "4c01d30",
        changed_interfaces: [],
        summary: "s",
        affected_ticket_ids: [],
      },
    };
    expect(EventSchema.safeParse(ev).success).toBe(false);
    expect(EventSchema.safeParse({ ...ev, ticket_id: "T-001" }).success).toBe(true);
  });
  it("写入范围事件要求 ticket_id 与 request_id", () => {
    const req = {
      ...common,
      type: "write_scope_requested",
      payload: { request_id: "q1", requested_scope: ["src/**"], reason: "r" },
    };
    expect(EventSchema.safeParse(req).success).toBe(true);
    expect(EventSchema.safeParse({ ...req, ticket_id: null }).success).toBe(false);
    expect(
      EventSchema.safeParse({ ...req, payload: { requested_scope: ["a"], reason: "r" } }).success,
    ).toBe(false);
    const granted = {
      ...common,
      type: "write_scope_granted",
      payload: { request_id: "q1", granted_scope: ["src/**"] },
    };
    expect(EventSchema.safeParse(granted).success).toBe(true);
    expect(EventSchema.safeParse({ ...granted, payload: { granted_scope: ["a"] } }).success).toBe(
      false,
    );
    const denied = {
      ...common,
      ticket_id: null,
      type: "write_scope_denied",
      payload: { request_id: "q1", requested_scope: ["a"], reason: "no" },
    };
    expect(EventSchema.safeParse(denied).success).toBe(false);
    expect(EventSchema.safeParse({ ...denied, ticket_id: "T-1" }).success).toBe(true);
  });
  it("escalated：reason 枚举，resubmit_counts 可选", () => {
    const ev = { ...common, type: "escalated", payload: { reason: "resplit_limit" } };
    expect(EventSchema.safeParse(ev).success).toBe(true);
    expect(
      EventSchema.safeParse({
        ...ev,
        payload: { reason: "review_limit", resubmit_counts: { review: 3, conflict: 0 } },
      }).success,
    ).toBe(true);
    expect(EventSchema.safeParse({ ...ev, payload: { reason: "lock_failed" } }).success).toBe(
      false,
    );
  });
  it("escalated：coder_failed / budget_exceeded 可解析，未知原因拒绝", () => {
    const base = { ...common, type: "escalated" };
    const coderFailed = {
      ...base,
      payload: {
        reason: "coder_failed",
        detail: "turn_limit",
        resubmit_counts: { review: 0, conflict: 0 },
      },
    };
    expect(EventSchema.parse(coderFailed)).toEqual(coderFailed);
    const budget = { ...base, payload: { reason: "budget_exceeded" } };
    expect(EventSchema.parse(budget)).toEqual(budget);
    expect(ESCALATION_REASONS).toContain("coder_failed");
    expect(ESCALATION_REASONS).toContain("budget_exceeded");
    expect(EventSchema.safeParse({ ...base, payload: { reason: "daily_budget" } }).success).toBe(
      false,
    );
  });
  it("escalated：merged_but（T-038）可解析；DEPENDENCY_MANIFEST_GLOBS 冻结、含清单与锁文件", () => {
    const ev = {
      ...common,
      type: "escalated",
      payload: {
        reason: "merged_but",
        detail: "merged_but: bus down",
        resubmit_counts: { review: 0, conflict: 0 },
      },
    };
    expect(EventSchema.parse(ev)).toEqual(ev);
    expect(ESCALATION_REASONS).toContain("merged_but");
    expect(Object.isFrozen(DEPENDENCY_MANIFEST_GLOBS)).toBe(true);
    for (const g of ["package.json", "**/package.json", "pnpm-lock.yaml", "go.sum", "**/*.lock"])
      expect(DEPENDENCY_MANIFEST_GLOBS).toContain(g);
  });
  it("escalated：internal_error 可解析，带 detail 与 resubmit_counts", () => {
    const base = { ...common, type: "escalated" };
    const internal = {
      ...base,
      payload: {
        reason: "internal_error",
        detail: "review_error: Error: boom",
        resubmit_counts: { review: 1, conflict: 0 },
      },
    };
    expect(EventSchema.parse(internal)).toEqual(internal);
    expect(ESCALATION_REASONS).toContain("internal_error");
    expect(EventSchema.safeParse({ ...base, payload: { reason: "internal" } }).success).toBe(false);
  });
  it("escalated：github_manual 只带 detail", () => {
    const ev = {
      ...common,
      type: "escalated",
      payload: { reason: "github_manual", detail: "PR 需人工合并" },
    };
    expect(EventSchema.parse(ev)).toEqual(ev);
  });
  it("ticket_warning：ticket_id 必填，code 只认 TICKET_WARNING_CODES（T-040）", () => {
    expect(TICKET_WARNING_CODES).toEqual(["write_scope_defaulted", "fields_invalid"]);
    const tw = {
      ...common,
      ticket_id: "req-1-1",
      type: "ticket_warning",
      payload: { project_id: "p", code: "write_scope_defaulted", detail: "按 ** 处理" },
    };
    expect(EventSchema.parse(tw)).toEqual(tw);
    expect(EventSchema.safeParse({ ...tw, ticket_id: null }).success).toBe(false);
    expect(
      EventSchema.safeParse({ ...tw, payload: { ...tw.payload, code: "fields_invalid" } }).success,
    ).toBe(true);
    expect(
      EventSchema.safeParse({ ...tw, payload: { ...tw.payload, code: "other" } }).success,
    ).toBe(false);
    expect(
      EventSchema.safeParse({ ...tw, payload: { project_id: "p", code: "write_scope_defaulted" } })
        .success,
    ).toBe(false);
  });
  it("group_message 支持 escalation，supervisor_backlog 非负", () => {
    const gm = {
      ...common,
      type: "group_message",
      payload: {
        project_id: "p",
        sender: "sub_agent",
        kind: "escalation",
        content: "c",
        flash_calls: [],
      },
    };
    expect(EventSchema.safeParse(gm).success).toBe(true);
    const sb = { ...common, type: "supervisor_backlog", payload: { pending: 0, capacity: -1 } };
    expect(EventSchema.safeParse(sb).success).toBe(false);
    expect(EventSchema.safeParse({ ...sb, payload: { pending: 0, capacity: 2 } }).success).toBe(
      true,
    );
    expect(EventSchema.safeParse({ ...sb, payload: { pending: 0, limit: 2 } }).success).toBe(false);
  });
  it("tokens：cache_hit_input <= input", () => {
    expect(TokensSchema.safeParse({ input: 10, output: 1, cache_hit_input: 10 }).success).toBe(
      true,
    );
    expect(TokensSchema.safeParse({ input: 10, output: 1, cache_hit_input: 11 }).success).toBe(
      false,
    );
  });
  it("EventMap 类型对应 payload", () => {
    expectTypeOf<EventMap["review_backlog"]>().toEqualTypeOf<{
      pending: number;
      capacity: number;
    }>();
  });
});

describe("PermissionList / Diff / Ledger", () => {
  it("默认空列表即全部拒绝", () => {
    expect(PermissionListSchema.parse(undefined)).toEqual([]);
    expect(DEFAULT_PERMISSION_LEVEL).toBe("deny");
    expect(PermissionListSchema.safeParse([{ glob: "src/**", level: "rx" }]).success).toBe(false);
  });
  it("Diff", () => {
    const d = {
      base_sha: "4c01d30",
      head_sha: "abcdef0",
      files: [{ path: "a.ts", status: "modified", additions: 1, deletions: 0, patch: "+x" }],
    };
    expect(DiffSchema.parse(d)).toEqual(d);
    expect(DiffSchema.safeParse({ ...d, base_sha: "XYZ" }).success).toBe(false);
  });
  it("LedgerEntry", () => {
    expect(
      LedgerEntrySchema.safeParse({
        entry_id: "e1",
        ts: common.ts,
        requirement_id: "r1",
        ticket_id: null,
        role: "reviewer",
        cost_micro_usd: 10,
        is_resubmit: false,
        cache_hit: false,
        offpeak: true,
      }).success,
    ).toBe(true);
  });
});

describe("requirement_id 可空规则（T-020）", () => {
  const projectCreated = {
    ...common,
    ticket_id: null,
    type: "project_created",
    payload: { project_id: "p1", name: "demo", language: "typescript", has_github_remote: false },
  };
  it("项目级事件 project_created 允许 requirement_id 为 null", () => {
    expect(PROJECT_LEVEL_EVENT_TYPES).toEqual(["project_created"]);
    expect(EventSchema.safeParse({ ...projectCreated, requirement_id: null }).success).toBe(true);
    expect(EventSchema.safeParse(projectCreated).success).toBe(true);
  });
  it("其他事件 requirement_id 为 null 时校验报错", () => {
    const backlog = { ...common, type: "review_backlog", payload: { pending: 1, capacity: 2 } };
    expect(EventSchema.safeParse(backlog).success).toBe(true);
    expect(EventSchema.safeParse({ ...backlog, requirement_id: null }).success).toBe(false);
    for (const t of EVENT_TYPES.filter((t) => t !== "project_created")) {
      const shape = EventSchema.options.find((o) => o.shape.type.value === t)!.shape;
      expect(shape.requirement_id.safeParse(null).success, t).toBe(false);
    }
  });
  it("类型上：project_created 的 requirement_id 是 string | null，其他事件是 string", () => {
    expectTypeOf<EventOf<"project_created">["requirement_id"]>().toEqualTypeOf<string | null>();
    expectTypeOf<EventOf<"review_backlog">["requirement_id"]>().toEqualTypeOf<string>();
  });
});
