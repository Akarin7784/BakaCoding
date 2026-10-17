import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { openStorage, type Storage } from "@bakacoding/storage";
import type { BakaEvent } from "@bakacoding/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DB_PATH_ENV, resolveDbPath } from "./config.js";
import { openEventReader, type EventReader } from "./reader.js";

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
    ]);
    const call = snap.events.find((e) => e.type === "call_completed");
    expect(call?.type === "call_completed" && call.payload.prompt).toBe("");
    expect(call?.type === "call_completed" && call.payload.output).toBe("写好了 due_date");
    expect(snap.events[0]!.requirement_id).toBeNull();
    expect(snap.last_seq).toBe(5);
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
    t("T-late", "2026-10-17T01:00:00.500Z");
    t("T-early", "2026-10-17T01:00:00Z");
    reader = openEventReader({ path: path.join(dir, "store.db") });
    expect(reader.snapshot().tickets.map((x) => x.ticket_id)).toEqual(["T-early", "T-late"]);
  });

  it("库里没有状态或状态不认识时按 pending", () => {
    const s = writer();
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

describe("数据库路径", () => {
  it("--db 参数 > 环境变量 > 默认 .bakacoding/bakacoding.db，相对路径按 cwd 解析", () => {
    const cwd = "/work/proj";
    expect(resolveDbPath([], {}, cwd)).toBe("/work/proj/.bakacoding/bakacoding.db");
    expect(resolveDbPath([], { [DB_PATH_ENV]: "data/x.db" }, cwd)).toBe("/work/proj/data/x.db");
    expect(resolveDbPath(["--db=/abs/a.db"], { [DB_PATH_ENV]: "x.db" }, cwd)).toBe("/abs/a.db");
    expect(resolveDbPath(["electron", ".", "--db", "b.db"], {}, cwd)).toBe("/work/proj/b.db");
  });
});
