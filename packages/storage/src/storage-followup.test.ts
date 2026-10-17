// T-022 存储层跟进：a 毫秒时间列、b seq 唯一、c 落库失败可见、d IMMEDIATE 事务、e prStore 脱敏与 kind 校验、f 需求归属与 limit。
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createEventBus } from "@bakacoding/event-bus";
import type { PrRecord } from "@bakacoding/pr";
import type { BakaEvent } from "@bakacoding/types";
import { MIGRATIONS } from "./schema.sql.js";
import {
  openStorage,
  StorageLeaseError,
  StorageSeqConflictError,
  type IngestFailure,
  type Storage,
} from "./index.js";

const KEY = "sk-" + "b".repeat(40);
let dirs: string[] = [];
let opened: Storage[] = [];
afterEach(() => {
  for (const s of opened) s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  opened = [];
});
function tmpDb(): string {
  const d = mkdtempSync(join(tmpdir(), "bc-storage-022-"));
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
const backlog = (ts: string, pending = 1) => ev("review_backlog", { pending, capacity: 2 }, { ts });
const call = (ts: string) =>
  ev(
    "call_completed",
    {
      role: "coder",
      provider: "deepseek",
      model: "deepseek-flash",
      effort: "low",
      prompt: "p",
      output: "o",
      tokens: { input: 1, output: 1, cache_hit_input: 0 },
      cache_hit: false,
      latency_ms: 1,
      cost: 1,
      is_resubmit: false,
      rate_limited_retry: 0,
    },
    { ts },
  );
const groupMsg = (project_id: string) =>
  ev("group_message", {
    project_id,
    sender: "supervisor",
    kind: "dispatch",
    content: "派单",
    flash_calls: [],
  });

describe("T-022 a：时间按毫秒数比较", () => {
  it("带毫秒和不带毫秒的时间范围两端都不漏，按时间排序正确", () => {
    const s = open();
    const noMs = backlog("2026-10-17T06:00:00Z", 1);
    const half = backlog("2026-10-17T06:00:00.500Z", 2);
    const before = backlog("2026-10-17T05:59:59.999Z", 3);
    for (const e of [noMs, half, before]) s.ingest(e);
    // 按文本比，"…06:00:00Z" > "…06:00:00.000Z"，to 端会漏掉它
    const exact = s.queryEvents({
      from: "2026-10-17T06:00:00.000Z",
      to: "2026-10-17T06:00:00.000Z",
    });
    expect(exact.map((e) => e.event_id)).toEqual([noMs.event_id]);
    const range = s.queryEvents({ from: "2026-10-17T06:00:00Z", to: "2026-10-17T06:00:00.5Z" });
    expect(range.map((e) => e.event_id)).toEqual([noMs.event_id, half.event_id]);
    expect(s.backlogMetrics("review_backlog").map((m) => m.pending)).toEqual([3, 1, 2]);
    expect(
      s.backlogMetrics("review_backlog", "2026-10-17T06:00:00.000Z", "2026-10-17T06:00:00Z"),
    ).toHaveLength(1);
  });

  it("不合法的时间参数直接报错", () => {
    const s = open();
    expect(() => s.queryEvents({ from: "昨天" })).toThrow(RangeError);
  });

  it("清理截止点按毫秒算：不带毫秒的旧调用不会因为文本比较被漏掉", () => {
    // 截止点 = now - 30 天 = 2026-09-17T06:00:00.500Z
    const s = open({ now: () => new Date("2026-10-17T06:00:00.500Z") });
    const old = call("2026-09-17T06:00:00Z");
    const fresh = call("2026-09-17T06:00:00.600Z");
    s.ingest(old);
    s.ingest(fresh);
    expect(s.purgeExpired().purged_calls).toBe(1);
    const got = s.queryEvents({ types: ["call_completed"] });
    expect(got.find((e) => e.event_id === old.event_id)!.payload).toMatchObject({ prompt: "" });
    expect(got.find((e) => e.event_id === fresh.event_id)!.payload).toMatchObject({ prompt: "p" });
  });

  it("需求单按 created_at 毫秒过滤和排序", () => {
    const s = open();
    const base = {
      project_id: "P-1",
      requirement_id: "R-1",
      ticket_text: "t",
      base_commit: "abc",
      permission_list: [],
      context_snippets: [],
    };
    s.saveTicket({ ...base, ticket_id: "T-b", created_at: "2026-10-17T06:00:00.500Z" });
    s.saveTicket({ ...base, ticket_id: "T-a", created_at: "2026-10-17T06:00:00Z" });
    expect(s.query({ project_id: "P-1" }).map((t) => t.ticket_id)).toEqual(["T-a", "T-b"]);
    expect(
      s.query({ project_id: "P-1", to: "2026-10-17T06:00:00.000Z" }).map((t) => t.ticket_id),
    ).toEqual(["T-a"]);
  });

  it("v1 旧库升级时回填毫秒列，升级后时间查询照常", () => {
    const path = tmpDb();
    const raw = new Database(path);
    raw.exec(MIGRATIONS[0] as string);
    raw.pragma("user_version = 1");
    raw
      .prepare(
        `INSERT INTO events (event_id, seq, type, ts, trace_id, span_id, parent_span_id, requirement_id, ticket_id, project_id, payload)
         VALUES ('old-1', 0, 'review_backlog', '2026-10-17T06:00:00Z', 'tr', 'sp', NULL, 'R-1', NULL, NULL, '{"pending":1,"capacity":1}')`,
      )
      .run();
    raw.close();
    const s = openStorage({ path });
    opened.push(s);
    expect(s.queryEvents({ to: "2026-10-17T06:00:00.000Z" }).map((e) => e.event_id)).toEqual([
      "old-1",
    ]);
    expect(s.nextSeq()).toBe(1);
  });
});

describe("T-022 b：events.seq 唯一", () => {
  it("不同事件占同一个 seq 报 StorageSeqConflictError，同一事件重放仍然幂等", () => {
    const s = open();
    const a = backlog("2026-10-17T06:00:00Z");
    s.ingest(a);
    s.ingest(a);
    expect(() => s.ingest({ ...backlog("2026-10-17T06:00:01Z"), seq: a.seq })).toThrow(
      StorageSeqConflictError,
    );
    expect(s.queryEvents()).toHaveLength(1);
  });

  it("库里有唯一索引兜底", () => {
    const path = tmpDb();
    const s = openStorage({ path });
    s.close();
    const raw = new Database(path, { readonly: true });
    const idx = raw.prepare("PRAGMA index_list(events)").all() as {
      name: string;
      unique: number;
    }[];
    raw.close();
    expect(idx.find((i) => i.name === "events_seq_unique")?.unique).toBe(1);
  });
});

describe("T-022 c：从总线落库失败能被看到", () => {
  it("落库失败交给 onError 并计入 health()", async () => {
    const s = open();
    s.ingest({ ...backlog("2026-10-17T06:00:00Z"), seq: 0 });
    const failures: IngestFailure[] = [];
    // 故意让总线从 0 开始编号，和库里已有的 seq 0 撞上
    const bus = createEventBus({ initialSeq: 0 });
    s.attach(bus, { onError: (f) => failures.push(f) });
    expect(s.health().ok).toBe(true);
    await bus.publish({
      type: "review_backlog",
      trace_id: "tr",
      span_id: "sp",
      parent_span_id: null,
      requirement_id: "R-1",
      ticket_id: null,
      payload: { pending: 1, capacity: 1 },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(failures).toHaveLength(1);
    expect(failures[0]!.error).toBeInstanceOf(StorageSeqConflictError);
    const h = s.health();
    expect(h.ok).toBe(false);
    expect(h.ingest_failures).toBe(1);
    expect(h.last_failure).toMatchObject({ type: "review_backlog", seq: 0 });
  });

  it("租约被接管后写入失败，health() 标出 lease_lost", () => {
    const path = tmpDb();
    let t = Date.parse("2026-10-17T06:00:00Z");
    const s1 = openStorage({ path, owner: "a", lease_ttl_ms: 1000, now: () => new Date(t) });
    opened.push(s1);
    t += 5000; // s1 的租约过期，s2 接管
    const s2 = openStorage({ path, owner: "b", lease_ttl_ms: 1000, now: () => new Date(t) });
    opened.push(s2);
    expect(() => s1.ingest(backlog("2026-10-17T06:00:05Z"))).toThrow(StorageLeaseError);
    expect(s1.health()).toMatchObject({ ok: false, lease_lost: true });
    expect(s2.health().ok).toBe(true);
  });
});

describe("T-022 d：拿租约和写入用 IMMEDIATE 事务", () => {
  it("另一个连接正在写时，打开存储排队等锁，不报 SQLITE_BUSY", async () => {
    const path = tmpDb();
    openStorage({ path, owner: "init" }).close();
    const sqlitePath = createRequire(import.meta.url).resolve("better-sqlite3");
    const worker = new Worker(
      `
      const { parentPort, workerData } = require("node:worker_threads");
      const Database = require(workerData.sqlitePath);
      const db = new Database(workerData.path);
      db.exec("BEGIN IMMEDIATE");
      db.prepare("INSERT INTO eval_set (ticket_id, marked_at) VALUES ('T-w', 'x')").run();
      parentPort.postMessage("locked");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
      db.exec("COMMIT");
      db.close();
      parentPort.postMessage("released");
      `,
      { eval: true, workerData: { path, sqlitePath } },
    );
    const done = new Promise<void>((resolve, reject) => {
      worker.on("message", (m) => m === "released" && resolve());
      worker.on("error", reject);
    });
    await new Promise<void>((resolve) => worker.once("message", () => resolve()));
    const s = openStorage({ path, owner: "main" });
    opened.push(s);
    s.ingest(backlog("2026-10-17T06:00:00Z"));
    await done;
    await worker.terminate();
    expect(s.queryEvents()).toHaveLength(1);
  });
});

describe("T-022 e：prStore 轻脱敏并校验 kind", () => {
  const base = {
    pr_id: "pr-1",
    kind: "ticket" as const,
    ticket_id: "T-1",
    branch: "bc/T-1",
    base_branch: "integration",
    base_sha: "a".repeat(40),
    head_sha: "b".repeat(40),
    status: "open" as const,
    worktree_path: `/wt/${KEY}`,
    created_ts: "2026-10-17T00:00:00.000Z",
    updated_ts: "2026-10-17T00:00:00.000Z",
  };

  it("结构字段原样保留，其余自由文本做轻脱敏", async () => {
    const s = open();
    const store = s.prStore<PrRecord & { note?: string }>();
    await store.put({ ...base, note: `复投说明，别泄露 ${KEY}` });
    const got = await store.get("pr-1");
    expect(got?.worktree_path).toBe(base.worktree_path);
    expect(got?.note).toBeDefined();
    expect(got?.note).not.toContain(KEY);
  });

  it("带 remote 的单张记录和集成记录写进去读出来完全相等", async () => {
    const s = open();
    const store = s.prStore<PrRecord & { remote?: { number: number; url: string } }>();
    const t = {
      ...base,
      worktree_path: "/home/u/.bakacoding/wt/T-1",
      merged_into: "integration",
      remote: { number: 42, url: "https://github.com/o/r/pull/42" },
    };
    const i = {
      pr_id: "pr-int-1",
      kind: "integration" as const,
      branch: "integration",
      base_branch: "main",
      base_sha: "c".repeat(40),
      head_sha: "d".repeat(40),
      status: "open" as const,
      repo_path: "/home/u/proj",
      created_ts: "2026-10-17T00:00:00.000Z",
      updated_ts: "2026-10-17T00:00:00.000Z",
      remote: { number: 7, url: "https://github.com/o/r/pull/7" },
    };
    await store.put(t);
    await store.put(i);
    expect(await store.get("pr-1")).toEqual(t);
    expect(await store.get("pr-int-1")).toEqual(i);
    expect(await store.list()).toEqual([t, i]);
  });

  it("kind 只能是 ticket 或 integration", async () => {
    const s = open();
    const store = s.prStore<PrRecord>();
    await expect(store.put({ ...base, kind: "draft" } as unknown as PrRecord)).rejects.toThrow(
      /kind 只能是/,
    );
    expect(await store.list()).toEqual([]);
  });
});

describe("T-022 f：需求归属不被群消息覆盖，limit 校验", () => {
  it("需求已登记项目后，后来的 group_message 不改它的归属", () => {
    const s = open();
    s.registerRequirement("R-1", "P-1");
    s.ingest(groupMsg("P-2"));
    s.ingest(backlog("2026-10-17T06:00:00Z"));
    expect(s.queryEvents({ project_id: "P-1", types: ["review_backlog"] })).toHaveLength(1);
    expect(s.queryEvents({ project_id: "P-2", types: ["review_backlog"] })).toHaveLength(0);
  });

  it("需求还没登记时，第一条 group_message 登记它；后面的群消息也不覆盖", () => {
    const s = open();
    s.ingest(groupMsg("P-1"));
    s.ingest(groupMsg("P-2"));
    s.ingest(backlog("2026-10-17T06:00:00Z"));
    expect(s.queryEvents({ project_id: "P-1", types: ["review_backlog"] })).toHaveLength(1);
  });

  it("limit 小于等于 0 或不是整数时报错，正整数照常截断", () => {
    const s = open();
    s.ingest(backlog("2026-10-17T06:00:00Z"));
    s.ingest(backlog("2026-10-17T06:00:01Z"));
    expect(() => s.queryEvents({ limit: 0 })).toThrow(RangeError);
    expect(() => s.queryEvents({ limit: -1 })).toThrow(RangeError);
    expect(() => s.queryEvents({ limit: 1.5 })).toThrow(RangeError);
    expect(s.queryEvents({ limit: 1 })).toHaveLength(1);
  });
});
