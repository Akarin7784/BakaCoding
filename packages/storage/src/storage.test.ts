import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEventBus, type PublishInput } from "@bakacoding/event-bus";
import type { PrRecord, PrStore } from "@bakacoding/pr";
import type { BakaEvent } from "@bakacoding/types";
import { MODULE_ID, openStorage, StorageLeaseError, type Storage } from "./index.js";

const KEY = "sk-" + "a".repeat(40);
let dirs: string[] = [];
let opened: Storage[] = [];
afterEach(() => {
  for (const s of opened) s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  opened = [];
});
function tmpDb(): string {
  const d = mkdtempSync(join(tmpdir(), "bc-storage-"));
  dirs.push(d);
  return join(d, "bakacoding.db");
}
function open(opts: Partial<Parameters<typeof openStorage>[0]> = {}): Storage {
  const s = openStorage({ path: tmpDb(), ...opts });
  opened.push(s);
  return s;
}

let n = 0;
function ev(type: string, payload: unknown, extra: Partial<BakaEvent> = {}): BakaEvent {
  n += 1;
  return {
    event_id: `ev-${n}`,
    seq: n,
    ts: "2026-10-17T06:00:00.000Z",
    trace_id: "tr-1",
    span_id: `sp-${n}`,
    parent_span_id: null,
    requirement_id: "R-1",
    ticket_id: "T-1",
    type,
    payload,
    ...extra,
  } as BakaEvent;
}
const call = (extra: Partial<BakaEvent> = {}, prompt = "写一个函数", output = "function f() {}") =>
  ev(
    "call_completed",
    {
      role: "coder",
      provider: "deepseek",
      model: "deepseek-flash",
      effort: "low",
      prompt,
      output,
      tokens: { input: 100, output: 20, cache_hit_input: 60 },
      cache_hit: true,
      latency_ms: 1200,
      cost: 37,
      is_resubmit: false,
      rate_limited_retry: 0,
    },
    extra,
  );
const projectCreated = () =>
  ev(
    "project_created",
    { project_id: "P-1", name: "demo", language: "typescript", has_github_remote: false },
    { requirement_id: null, ticket_id: null },
  );
const ticket = (ticket_id = "T-1", created_at = "2026-10-17T06:00:00.000Z") => ({
  ticket_id,
  project_id: "P-1",
  requirement_id: "R-1",
  created_at,
  ticket_text: `实现 foo，测试用 key ${KEY}`,
  base_commit: "abc1234",
  permission_list: [{ glob: "src/**", level: "rw" as const }],
  context_snippets: [{ path: "src/a.ts", content: "export const a = 1;" }],
});

describe("@bakacoding/storage", () => {
  it("导出模块编号", () => expect(MODULE_ID).toBe(2));

  it("打开后是 WAL 模式，空库 nextSeq 为 0", () => {
    const s = open();
    expect(s.nextSeq()).toBe(0);
  });

  it("事件落库带三个追踪字段，同一 event_id 只记一次", () => {
    const s = open();
    const e = ev("review_backlog", { pending: 3, capacity: 2 }, { parent_span_id: "sp-0" });
    s.ingest(e);
    s.ingest(e);
    const got = s.queryEvents();
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual(e);
    expect(s.backlogMetrics("review_backlog")).toEqual([{ ts: e.ts, pending: 3, capacity: 2 }]);
  });

  it("schema 不合法的事件拒绝写入", () => {
    const s = open();
    expect(() => s.ingest(ev("review_backlog", { pending: -1, capacity: 2 }))).toThrow();
    expect(s.queryEvents()).toHaveLength(0);
  });

  it("project_created 建项目和群记录；按项目过滤靠需求登记，登记晚于事件也能查到", () => {
    const s = open();
    s.ingest(projectCreated());
    const before = call();
    s.ingest(before);
    expect(s.queryEvents({ project_id: "P-1" }).map((e) => e.type)).toEqual(["project_created"]);
    s.registerRequirement("R-1", "P-1");
    expect(s.queryEvents({ project_id: "P-1" }).map((e) => e.event_id)).toContain(before.event_id);
    expect(s.queryEvents({ project_id: "P-2" })).toHaveLength(0);
  });

  it("group_message 落群消息表并自动登记需求所属项目", () => {
    const s = open();
    s.ingest(
      ev("group_message", {
        project_id: "P-1",
        sender: "supervisor",
        kind: "dispatch",
        content: `派单，别泄露 ${KEY}`,
        flash_calls: ["ev-x"],
      }),
    );
    const msgs = s.groupMessages("P-1");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.content).not.toContain(KEY);
    expect(msgs[0]!.flash_calls).toEqual(["ev-x"]);
    s.ingest(call());
    expect(s.queryEvents({ project_id: "P-1", types: ["call_completed"] })).toHaveLength(1);
  });

  it("call_completed 写调用日志，落库前轻脱敏", () => {
    const s = open();
    const e = call({}, `用这个 key：${KEY}`, "好的");
    s.ingest(e);
    const [got] = s.queryEvents({ types: ["call_completed"] });
    expect(got!.type).toBe("call_completed");
    const p = (got as Extract<BakaEvent, { type: "call_completed" }>).payload;
    expect(p.prompt).not.toContain(KEY);
    expect(p.tokens).toEqual({ input: 100, output: 20, cache_hit_input: 60 });
    expect(p.cost).toBe(37);
  });

  it("过滤：requirement / ticket / trace / 时间段（两端都含） / after_seq / limit", () => {
    const s = open();
    const a = call({ ts: "2026-10-01T00:00:00.000Z" });
    const b = call({ ts: "2026-10-02T00:00:00.000Z", ticket_id: "T-2" });
    const c = call({ ts: "2026-10-03T00:00:00.000Z", requirement_id: "R-2", trace_id: "tr-2" });
    for (const e of [a, b, c]) s.ingest(e);
    expect(s.queryEvents({ requirement_id: "R-1" }).map((e) => e.event_id)).toEqual([
      a.event_id,
      b.event_id,
    ]);
    expect(s.queryEvents({ ticket_id: "T-2" }).map((e) => e.event_id)).toEqual([b.event_id]);
    expect(s.queryEvents({ trace_id: "tr-2" }).map((e) => e.event_id)).toEqual([c.event_id]);
    expect(
      s
        .queryEvents({ from: "2026-10-02T00:00:00.000Z", to: "2026-10-03T00:00:00.000Z" })
        .map((e) => e.event_id),
    ).toEqual([b.event_id, c.event_id]);
    expect(s.queryEvents({ after_seq: a.seq, limit: 1 }).map((e) => e.event_id)).toEqual([
      b.event_id,
    ]);
  });

  it("挂到总线：* 订阅全部落库；重启后 nextSeq 接着库里最大 seq", async () => {
    const path = tmpDb();
    const s1 = openStorage({ path });
    const bus1 = createEventBus({ initialSeq: s1.nextSeq() });
    s1.attach(bus1);
    const base = {
      trace_id: "tr",
      span_id: "sp",
      parent_span_id: null,
      requirement_id: "R-1",
      ticket_id: null,
    };
    await bus1.publish({
      ...base,
      type: "review_backlog",
      payload: { pending: 1, capacity: 2 },
    } as PublishInput);
    await bus1.publish({
      ...base,
      type: "supervisor_backlog",
      payload: { pending: 0, capacity: 1 },
    } as PublishInput);
    expect(s1.nextSeq()).toBe(2);
    s1.close();

    const s2 = openStorage({ path });
    opened.push(s2);
    expect(s2.queryEvents().map((e) => e.seq)).toEqual([0, 1]);
    const bus2 = createEventBus({ initialSeq: s2.nextSeq() });
    s2.attach(bus2);
    const e = await bus2.publish({
      ...base,
      type: "review_backlog",
      payload: { pending: 2, capacity: 2 },
    } as PublishInput);
    expect(e.seq).toBe(2);
    expect(s2.queryEvents()).toHaveLength(3);
  });

  it("单一写入者：另一个进程持有未过期租约时打不开；过期后可接管，原持有者再写会报错", () => {
    const path = tmpDb();
    let t = 0;
    const now = () => new Date(Date.UTC(2026, 9, 17) + t);
    const a = openStorage({ path, owner: "A", lease_ttl_ms: 1000, now });
    opened.push(a);
    expect(() => openStorage({ path, owner: "B", lease_ttl_ms: 1000, now })).toThrow(
      StorageLeaseError,
    );
    t = 5000;
    const b = openStorage({ path, owner: "B", lease_ttl_ms: 1000, now });
    opened.push(b);
    expect(() => a.ingest(call())).toThrow(StorageLeaseError);
    expect(() => b.ingest(call())).not.toThrow();
  });

  it("关闭时释放租约，别的写入者可以马上打开", () => {
    const path = tmpDb();
    const a = openStorage({ path, owner: "A" });
    a.close();
    const b = openStorage({ path, owner: "B" });
    opened.push(b);
    expect(b.nextSeq()).toBe(0);
  });

  it("需求单、各轮 PR 记录、合并结果：query 拼成 TicketRecord，落库前轻脱敏", () => {
    const s = open();
    s.saveTicket(ticket());
    const diff = { base_sha: "a".repeat(40), head_sha: "b".repeat(40), files: [] };
    s.savePrRecord({ ticket_id: "T-1", round: 1, diff, verdict: "fail", fail_reasons: ["缺测试"] });
    s.savePrRecord({ ticket_id: "T-1", round: 2, diff, verdict: "pass", fail_reasons: [] });
    s.savePrRecord({
      ticket_id: "T-1",
      round: 2,
      diff,
      verdict: "pass",
      fail_reasons: [],
      review_comments: "ok",
    });
    s.saveMergeResult("T-1", {
      conflicted: false,
      base_changed: false,
      re_reviewed: false,
      merged: true,
    });
    const [rec] = s.query({ project_id: "P-1" });
    expect(rec!.ticket_text).not.toContain(KEY);
    expect(rec!.rounds.map((r) => r.round)).toEqual([1, 2]);
    expect(rec!.rounds[1]!.review_comments).toBe("ok");
    expect(rec!.merge?.merged).toBe(true);
    expect(rec!.marked_for_eval_set).toBe(false);
    expect(s.query({ project_id: "P-2" })).toEqual([]);
  });

  it("query 按单号、需求、created_at 时间段过滤", () => {
    const s = open();
    s.saveTicket(ticket("T-1", "2026-10-01T00:00:00.000Z"));
    s.saveTicket(ticket("T-2", "2026-10-05T00:00:00.000Z"));
    expect(s.query({ project_id: "P-1", ticket_id: "T-2" }).map((t) => t.ticket_id)).toEqual([
      "T-2",
    ]);
    expect(
      s.query({ project_id: "P-1", to: "2026-10-01T00:00:00.000Z" }).map((t) => t.ticket_id),
    ).toEqual(["T-1"]);
  });

  it("主管决策记忆按项目保存和读取", () => {
    const s = open();
    s.saveDecision({
      project_id: "P-1",
      content: "API 统一用 REST",
      ts: "2026-10-17T01:00:00.000Z",
    });
    s.saveDecision({ project_id: "P-2", content: "别的项目" });
    expect(s.listDecisions("P-1").map((d) => d.content)).toEqual(["API 统一用 REST"]);
  });

  it("purgeExpired：超过保留期只留摘要和统计，评测集里的单永久保留", () => {
    let now = new Date("2026-10-17T00:00:00.000Z");
    const s = open({ retention_days: 30, now: () => now });
    const old = call(
      { ts: "2026-09-01T00:00:00.000Z", ticket_id: "T-old" },
      "旧提示词",
      "x".repeat(500),
    );
    const kept = call({ ts: "2026-09-01T00:00:00.000Z", ticket_id: "T-eval" }, "评测提示词", "y");
    const fresh = call({ ts: "2026-10-16T00:00:00.000Z", ticket_id: "T-new" }, "新提示词", "z");
    for (const e of [old, kept, fresh]) s.ingest(e);
    s.markForEvalSet("T-eval");
    expect(s.purgeExpired()).toEqual({ purged_calls: 1 });
    expect(s.purgeExpired()).toEqual({ purged_calls: 0 });
    const byId = new Map(s.queryEvents({ types: ["call_completed"] }).map((e) => [e.event_id, e]));
    const p = (id: string) =>
      (byId.get(id) as Extract<BakaEvent, { type: "call_completed" }>).payload;
    expect(p(old.event_id).prompt).toBe("");
    expect(p(old.event_id).output).toBe("x".repeat(200));
    expect(p(old.event_id).tokens.input).toBe(100);
    expect(p(old.event_id).cost).toBe(37);
    expect(p(kept.event_id).prompt).toBe("评测提示词");
    expect(p(fresh.event_id).prompt).toBe("新提示词");
    now = new Date("2026-12-31T00:00:00.000Z");
    expect(s.purgeExpired().purged_calls).toBe(1); // fresh 过期；评测集仍保留
  });

  it("LedgerStore：entry_id 幂等，按 UTC 日期和单号汇总，复投单列", async () => {
    const s = open();
    const base = {
      requirement_id: "R-1",
      ticket_id: "T-1",
      role: "coder" as const,
      cache_hit: false,
      offpeak: false,
    };
    await s.ledger.append({
      ...base,
      entry_id: "e1",
      ts: "2026-10-17T23:59:59.000Z",
      cost_micro_usd: 100,
      is_resubmit: false,
    });
    await s.ledger.append({
      ...base,
      entry_id: "e1",
      ts: "2026-10-17T23:59:59.000Z",
      cost_micro_usd: 100,
      is_resubmit: false,
    });
    await s.ledger.append({
      ...base,
      entry_id: "e2",
      ts: "2026-10-17T10:00:00.000Z",
      cost_micro_usd: 50,
      is_resubmit: true,
    });
    await s.ledger.append({
      ...base,
      entry_id: "e3",
      ts: "2026-10-18T00:00:00.000Z",
      cost_micro_usd: 7,
      is_resubmit: false,
      ticket_id: null,
    });
    expect(await s.ledger.totalsByDay("2026-10-17")).toEqual({
      total_micro_usd: 150,
      resubmit_micro_usd: 50,
      entries: 2,
      by_role: { supervisor: 0, reviewer: 0, sub_agent: 0, coder: 150 },
    });
    expect(await s.ledger.totalsByDay("2026-10-18")).toEqual({
      total_micro_usd: 7,
      resubmit_micro_usd: 0,
      entries: 1,
      by_role: { supervisor: 0, reviewer: 0, sub_agent: 0, coder: 7 },
    });
    expect(await s.ledger.totalsByTicket("T-1")).toEqual({
      total_micro_usd: 150,
      resubmit_micro_usd: 50,
      entries: 2,
      by_role: { supervisor: 0, reviewer: 0, sub_agent: 0, coder: 150 },
    });
    expect(await s.ledger.totalsByDay("2026-01-01")).toEqual({
      total_micro_usd: 0,
      resubmit_micro_usd: 0,
      entries: 0,
      by_role: { supervisor: 0, reviewer: 0, sub_agent: 0, coder: 0 },
    });
    await expect(s.ledger.totalsByDay("2026/10/17")).rejects.toThrow(RangeError);
  });

  it("台账汇总按角色分列", async () => {
    const s = open();
    const e = {
      requirement_id: "R-1",
      ticket_id: "T-9",
      ts: "2026-10-17T01:00:00.000Z",
      is_resubmit: false,
      cache_hit: false,
      offpeak: false,
    };
    await s.ledger.append({ ...e, entry_id: "r1", role: "coder", cost_micro_usd: 10 });
    await s.ledger.append({ ...e, entry_id: "r2", role: "reviewer", cost_micro_usd: 20 });
    await s.ledger.append({ ...e, entry_id: "r3", role: "reviewer", cost_micro_usd: 5 });
    await s.ledger.append({ ...e, entry_id: "r4", role: "sub_agent", cost_micro_usd: 3 });
    const t = await s.ledger.totalsByTicket("T-9");
    expect(t.by_role).toEqual({ supervisor: 0, reviewer: 25, sub_agent: 3, coder: 10 });
    expect(t.total_micro_usd).toBe(38);
  });

  it("diagnosticsSource 适配模块 11 的 DiagnosticsSource", async () => {
    const s = open();
    s.ingest(projectCreated());
    s.saveTicket(ticket());
    s.ingest(call());
    const src = s.diagnosticsSource();
    expect(
      (await src.queryEvents({ project_id: "P-1", ticket_id: "T-1" })).map((e) => e.type),
    ).toEqual(["call_completed"]);
    expect((await src.queryTickets({ project_id: "P-1" })).map((t) => t.ticket_id)).toEqual([
      "T-1",
    ]);
  });

  it("prStore 满足模块 6 的 PrStore：kind 原样存回，缺 kind 拒绝写入，重开库后还在", async () => {
    const path = tmpDb();
    const s1 = openStorage({ path });
    const store: PrStore = s1.prStore<PrRecord>();
    const base = {
      branch: "integration",
      base_branch: "main",
      base_sha: "a".repeat(40),
      head_sha: "b".repeat(40),
      status: "open" as const,
      created_ts: "2026-10-17T00:00:00.000Z",
      updated_ts: "2026-10-17T00:00:00.000Z",
    };
    const integ: PrRecord = { ...base, pr_id: "pr-int-1", kind: "integration", repo_path: "/repo" };
    const ticket: PrRecord = {
      ...base,
      pr_id: "pr-1",
      kind: "ticket",
      ticket_id: "T-1",
      branch: "bc/T-1",
      base_branch: "integration",
      worktree_path: "/wt/T-1",
    };
    await store.put(ticket);
    await store.put(integ);
    await store.put({ ...ticket, status: "merged" });
    await expect(
      store.put({ ...ticket, pr_id: "pr-x", kind: undefined } as unknown as PrRecord),
    ).rejects.toThrow(/缺少 kind/);
    s1.close();

    const s2 = open({ path });
    const again: PrStore = s2.prStore<PrRecord>();
    expect((await again.get("pr-1"))?.kind).toBe("ticket");
    expect((await again.get("pr-1"))?.status).toBe("merged");
    expect((await again.get("pr-int-1"))?.kind).toBe("integration");
    expect(await again.get("pr-x")).toBeUndefined();
    expect((await again.list()).map((r) => [r.pr_id, r.kind])).toEqual([
      ["pr-1", "ticket"],
      ["pr-int-1", "integration"],
    ]);
  });
});
