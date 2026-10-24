import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  openStorage,
  openStorageReadonly,
  StorageLeaseError,
  type Storage,
} from "@bakacoding/storage";
import type { BakaEvent } from "@bakacoding/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DB_PATH_ENV, resolveDbPath } from "./config.js";
import { openEventReader, ticketTitle, type EventReader } from "./reader.js";

let dir: string;
let storage: Storage | null;
let reader: EventReader | null;
let seq = 0;

const common = (requirement_id: string | null, ticket_id: string | null = null) => {
  seq += 1;
  return {
    event_id: `evt-${seq}`,
    seq,
    ts: `2026-10-17T01:00:${String(seq).padStart(2, "0")}.000Z`,
    trace_id: `trace-${requirement_id ?? "project"}`,
    span_id: `span-${seq}`,
    parent_span_id: null,
    requirement_id,
    ticket_id,
  };
};

const projectCreated = (): BakaEvent => ({
  ...common(null),
  type: "project_created",
  payload: {
    project_id: "P-1",
    name: "baka-todo",
    language: "TypeScript",
    has_github_remote: false,
  },
});
const groupMessage = (content: string, ticket = "T-1"): BakaEvent => ({
  ...common("R-1", ticket),
  type: "group_message",
  payload: {
    project_id: "P-1",
    sender: "sub_agent",
    kind: "report",
    content,
    flash_calls: ["evt-3"],
  },
});
const callCompleted = (): BakaEvent => ({
  ...common("R-1", "T-1"),
  type: "call_completed",
  payload: {
    role: "coder",
    provider: "deepseek",
    model: "deepseek-v4.1-flash",
    effort: "low",
    prompt: "完整提示词，不应下发给界面",
    output: "写好了 due_date",
    tokens: { input: 100, output: 10, cache_hit_input: 60 },
    cache_hit: true,
    latency_ms: 900,
    cost: 12,
    is_resubmit: false,
    rate_limited_retry: 0,
  },
});
const escalated = (): BakaEvent => ({
  ...common("R-1", "T-1"),
  type: "escalated",
  payload: { reason: "review_limit", resubmit_counts: { review: 3, conflict: 0 } },
});
const ticketWarning = (): BakaEvent =>
  ({
    ...common("R-1", "T-1"),
    type: "ticket_warning",
    payload: { project_id: "P-1", code: "write_scope_defaulted", detail: "手工单没给 write_scope" },
  }) as BakaEvent;
const backlog = (): BakaEvent => ({
  ...common("R-1"),
  type: "review_backlog",
  payload: { pending: 1, capacity: 4 },
});

const diff = { base_sha: "a".repeat(40), head_sha: "b".repeat(40), files: [] };

function saveTicket(s: Storage, status: "coding" | "resubmitting" | "escalated" | undefined) {
  s.saveTicket({
    ticket_id: "T-1",
    project_id: "P-1",
    requirement_id: "R-1",
    created_at: "2026-10-17T01:00:00.000Z",
    ticket_text: "\n给 Todo 加 due_date 字段\n详细说明……",
    ...(status ? { status } : {}),
    base_commit: "a".repeat(40),
    permission_list: [],
    context_snippets: [],
  });
}

beforeEach(() => {
  seq = 0;
  dir = mkdtempSync(path.join(tmpdir(), "bc-desktop-"));
  storage = null;
  reader = null;
});
afterEach(() => {
  reader?.close();
  storage?.close();
  rmSync(dir, { recursive: true, force: true });
});

function writer(): Storage {
  // openStorage 不建目录
  storage = openStorage({ path: path.join(dir, "store.db") });
  return storage;
}

describe("主进程只读读取（临时 SQLite，用模块 2 的 API 写入）", () => {
  it("快照：只下发界面关心的事件，call_completed 不带提示词；需求单带标题、状态、复投次数", () => {
    const s = writer();
    for (const e of [
      projectCreated(),
      groupMessage("T-1 已提交"),
      callCompleted(),
      backlog(),
      escalated(),
      ticketWarning(),
    ])
      s.ingest(e);
    saveTicket(s, "resubmitting");
    s.savePrRecord({ ticket_id: "T-1", round: 1, diff, verdict: "fail", fail_reasons: ["缺测试"] });
    s.savePrRecord({ ticket_id: "T-1", round: 2, diff, verdict: "pass", fail_reasons: [] });

    // 写入者还开着（持有租约）时也能读
    reader = openEventReader({ path: path.join(dir, "store.db") });
    const snap = reader.snapshot();
    expect(snap.db.state).toBe("ok");
    expect(snap.events.map((e) => e.type)).toEqual([
      "project_created",
      "group_message",
      "call_completed",
      "escalated",
      "ticket_warning",
    ]);
    const warn = snap.events.find((e) => e.type === "ticket_warning");
    expect(warn?.ticket_id).toBe("T-1");
    expect(warn?.type === "ticket_warning" && warn.payload.code).toBe("write_scope_defaulted");
    const call = snap.events.find((e) => e.type === "call_completed");
    expect(call?.type === "call_completed" && call.payload.prompt).toBe("");
    expect(call?.type === "call_completed" && call.payload.output).toBe("写好了 due_date");
    expect(snap.events[0]!.requirement_id).toBeNull();
    expect(snap.last_seq).toBe(6);
    expect(snap.tickets).toEqual([
      {
        ticket_id: "T-1",
        project_id: "P-1",
        requirement_id: "R-1",
        created_at: "2026-10-17T01:00:00.000Z",
        title: "给 Todo 加 due_date 字段",
        status: "resubmitting",
        resubmit_count: 1,
      },
    ]);
  });

  it("增量：轮询只给新事件；需求单变化时给完整列表；没变化返回 null", () => {
    const s = writer();
    s.ingest(projectCreated());
    saveTicket(s, "coding");
    reader = openEventReader({ path: path.join(dir, "store.db") });
    reader.snapshot();
    expect(reader.poll()).toBeNull();

    s.ingest(groupMessage("第二条"));
    const u1 = reader.poll();
    expect(u1?.events.map((e) => e.event_id)).toEqual(["evt-2"]);
    expect(u1?.tickets).toBeUndefined();

    saveTicket(s, "escalated");
    const u2 = reader.poll();
    expect(u2?.events).toEqual([]);
    expect(u2?.tickets?.[0]?.status).toBe("escalated");
    expect(reader.poll()).toBeNull();
  });

  it("需求单按毫秒时间排序（ISO 文本带不带毫秒都对）", () => {
    const s = writer();
    const t = (ticket_id: string, created_at: string) =>
      s.saveTicket({
        ticket_id,
        project_id: "P-1",
        requirement_id: "R-1",
        created_at,
        ticket_text: ticket_id,
        base_commit: "a".repeat(40),
        permission_list: [],
        context_snippets: [],
      });
    s.ingest(projectCreated());
    t("T-late", "2026-10-17T01:00:00.500Z");
    t("T-early", "2026-10-17T01:00:00Z");
    reader = openEventReader({ path: path.join(dir, "store.db") });
    expect(reader.snapshot().tickets.map((x) => x.ticket_id)).toEqual(["T-early", "T-late"]);
  });

  it("库里没有状态或状态不认识时按 pending", () => {
    const s = writer();
    s.ingest(projectCreated());
    saveTicket(s, undefined);
    reader = openEventReader({ path: path.join(dir, "store.db") });
    expect(reader.snapshot().tickets[0]!.status).toBe("pending");
  });

  it("库文件还不存在：快照为空并标 missing；建库后轮询报 ok 并补发全部事件", () => {
    const p = path.join(dir, "late.db");
    reader = openEventReader({ path: p });
    const snap = reader.snapshot();
    expect(snap.db).toEqual({ path: p, state: "missing" });
    expect(snap.events).toEqual([]);
    expect(reader.poll()).toBeNull();

    storage = openStorage({ path: p });
    storage.ingest(projectCreated());
    const u = reader.poll();
    expect(u?.db.state).toBe("ok");
    expect(u?.events.map((e) => e.type)).toEqual(["project_created"]);
  });

  it("只读：不抢写入者租约，写入者照常写；读连接本身不能写", () => {
    const s = writer();
    s.ingest(projectCreated());
    const p = path.join(dir, "store.db");
    const peek = () => {
      const d = new Database(p, { readonly: true });
      try {
        return d.prepare("SELECT owner FROM lease").get() as { owner: string };
      } finally {
        d.close();
      }
    };
    const before = peek();
    reader = openEventReader({ path: p });
    reader.snapshot();
    reader.poll();
    expect(peek().owner).toBe(before.owner);
    expect(() => s.ingest(groupMessage("写入者仍能写"))).not.toThrow();
    const ro = new Database(p, { readonly: true });
    expect(() => ro.prepare("DELETE FROM events").run()).toThrow(/readonly/i);
    ro.close();
  });
});

describe("走模块 2 的只读 API（openStorageReadonly）", () => {
  it("写入者 openStorage 持有租约时边写边读：按 maxSeq 增量，界面不关心的事件不下发也不重复读", () => {
    const s = writer();
    s.ingest(projectCreated());
    reader = openEventReader({ path: path.join(dir, "store.db") });
    expect(reader.snapshot().last_seq).toBe(1);

    s.ingest(backlog());
    expect(reader.poll()).toBeNull();
    expect(s.health().lease_lost).toBe(false);

    s.ingest(groupMessage("新消息"));
    s.ingest(callCompleted());
    const u = reader.poll();
    expect(u?.events.map((e) => e.event_id)).toEqual(["evt-3", "evt-4"]);
    expect(u?.last_seq).toBe(4);
    const call = u?.events.find((e) => e.type === "call_completed");
    expect(call?.type === "call_completed" && call.payload.prompt).toBe("");
    expect(reader.poll()).toBeNull();
    // 写入者的租约一直在，第二个写入者仍然被挡住
    expect(() => openStorage({ path: path.join(dir, "store.db") })).toThrow(StorageLeaseError);
  });

  it("把底层原生模块的路径传给存储", () => {
    const calls: unknown[] = [];
    const s = writer();
    s.ingest(projectCreated());
    reader = openEventReader({
      path: path.join(dir, "store.db"),
      nativeBinding: "/fake/native/better_sqlite3.node",
      open: (o) => {
        calls.push(o);
        return openStorageReadonly({ path: o.path });
      },
    });
    expect(reader.snapshot().db.state).toBe("ok");
    expect(calls).toEqual([
      { path: path.join(dir, "store.db"), nativeBinding: "/fake/native/better_sqlite3.node" },
    ]);
  });

  it("库版本比代码旧：界面显示可读的版本说明；写入者升级后轮询自动接上", () => {
    const p = path.join(dir, "store.db");
    const s = writer();
    s.ingest(projectCreated());
    s.close();
    storage = null;
    const raw = new Database(p);
    const want = raw.pragma("user_version", { simple: true }) as number;
    raw.pragma("user_version = 1");
    raw.close();

    reader = openEventReader({ path: p });
    const snap = reader.snapshot();
    expect(snap.db.state).toBe("error");
    expect(snap.db.state === "error" && snap.db.message).toMatch(
      new RegExp(`版本是 v1，当前代码需要 v${want}.*写入方`),
    );
    expect(snap.events).toEqual([]);
    expect(reader.poll()).toBeNull();

    const fix = new Database(p);
    fix.pragma(`user_version = ${want}`);
    fix.close();
    const u = reader.poll();
    expect(u?.db.state).toBe("ok");
    expect(u?.events.map((e) => e.type)).toEqual(["project_created"]);
  });

  it("原生模块 ABI 不匹配：提示先跑 rebuild:electron", () => {
    const s = writer();
    s.ingest(projectCreated());
    reader = openEventReader({
      path: path.join(dir, "store.db"),
      open: () => {
        throw new Error(
          "The module was compiled against a different Node.js version using NODE_MODULE_VERSION 115. This version of Node.js requires NODE_MODULE_VERSION 145.",
        );
      },
    });
    const db = reader.snapshot().db;
    expect(db.state === "error" && db.message).toMatch(/rebuild:electron/);
  });

  it("需求单只列出事件里出现过的项目（存储没有列出全部项目的读方法）", () => {
    const s = writer();
    saveTicket(s, "coding");
    reader = openEventReader({ path: path.join(dir, "store.db") });
    expect(reader.snapshot().tickets).toEqual([]);
    s.ingest(projectCreated());
    expect(reader.poll()?.tickets?.map((t) => t.ticket_id)).toEqual(["T-1"]);
  });
});

describe("数据库路径", () => {
  it("--db 参数 > 环境变量 > 默认 .bakacoding/bakacoding.db，相对路径按 cwd 解析", () => {
    const cwd = "/work/proj";
    expect(resolveDbPath([], {}, cwd)).toBe("/work/proj/.bakacoding/bakacoding.db");
    expect(resolveDbPath([], { [DB_PATH_ENV]: "data/x.db" }, cwd)).toBe("/work/proj/data/x.db");
    expect(resolveDbPath(["--db=/abs/a.db"], { [DB_PATH_ENV]: "x.db" }, cwd)).toBe("/abs/a.db");
    expect(resolveDbPath(["electron", ".", "--db", "b.db"], {}, cwd)).toBe("/work/proj/b.db");
  });
});

describe("项目列表与标题（T-033）", () => {
  it("项目列表来自存储 listProjects()：每个已创建项目的需求单都列出，标题去掉 CRLF 的 \\r", () => {
    const s = writer();
    s.ingest(projectCreated());
    s.ingest({
      ...common(null),
      type: "project_created",
      payload: {
        project_id: "P-2",
        name: "baka-notes",
        language: "TypeScript",
        has_github_remote: true,
      },
    });
    const ticket = (
      ticket_id: string,
      project_id: string,
      ticket_text: string,
      created_at: string,
    ) =>
      s.saveTicket({
        ticket_id,
        project_id,
        requirement_id: "R-1",
        created_at,
        ticket_text,
        base_commit: "a".repeat(40),
        permission_list: [],
        context_snippets: [],
      });
    ticket("T-1", "P-1", "\r\n给 Todo 加 due_date 字段\r\n详细说明", "2026-10-17T01:00:00.000Z");
    ticket("T-2", "P-2", "笔记支持标签\r\n", "2026-10-17T01:00:01.000Z");
    expect(s.listProjects().map((p) => p.project_id)).toEqual(["P-1", "P-2"]);

    reader = openEventReader({ path: path.join(dir, "store.db") });
    const tickets = reader.snapshot().tickets;
    expect(tickets.map((t) => [t.ticket_id, t.project_id, t.title])).toEqual([
      ["T-1", "P-1", "给 Todo 加 due_date 字段"],
      ["T-2", "P-2", "笔记支持标签"],
    ]);
  });

  it("ticketTitle：\\r\\n、单独 \\r、行尾空白都不进标题；超长截断", () => {
    expect(ticketTitle("标题\r\n正文")).toBe("标题");
    expect(ticketTitle("\r\n\r\n  标题  \r\n")).toBe("  标题");
    expect(ticketTitle("旧 Mac 换行\r正文")).toBe("旧 Mac 换行");
    expect(ticketTitle("只有一行\r")).toBe("只有一行");
    expect(ticketTitle("")).toBe("");
    const long = "长".repeat(100);
    expect(ticketTitle(long)).toBe(`${"长".repeat(79)}…`);
  });
});

describe("UI-05a：ticket_status_changed 进白名单", () => {
  const statusChanged = (from: "coding" | null, to: "in_review"): BakaEvent =>
    ({
      ...common("R-1", "T-1"),
      type: "ticket_status_changed",
      payload: { project_id: "P-1", from, to },
    }) as BakaEvent;

  it("快照和增量都按白名单读出 ticket_status_changed，from 可为 null", () => {
    const s = writer();
    s.ingest(projectCreated());
    s.ingest(statusChanged(null, "in_review"));
    reader = openEventReader({ path: path.join(dir, "store.db") });
    const snap = reader.snapshot();
    const ev = snap.events.find((e) => e.type === "ticket_status_changed");
    // ticket_id / requirement_id 在公共信封上
    expect([ev?.ticket_id, ev?.requirement_id]).toEqual(["T-1", "R-1"]);
    expect(ev?.type === "ticket_status_changed" && ev.payload).toEqual({
      project_id: "P-1",
      from: null,
      to: "in_review",
    });
    s.ingest(statusChanged("coding", "in_review"));
    const u = reader.poll();
    expect(u?.events.map((e) => e.type)).toEqual(["ticket_status_changed"]);
    const e2 = u?.events[0];
    expect(e2?.type === "ticket_status_changed" && e2.payload.from).toBe("coding");
  });
});
