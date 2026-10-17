// T-040：对真实的 2（openStorage，SQLite）跑一遍：落库、关库重开后 loadTicket / 续编单号 / 沿用 trace。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStorage, type Storage } from "@bakacoding/storage";
import { afterEach, describe, expect, it } from "vitest";
import { createSupervisor, type SupervisorDeps } from "./index.js";

let dirs: string[] = [];
let opened: Storage[] = [];
afterEach(() => {
  for (const s of opened) {
    try {
      s.close();
    } catch {
      // 已关
    }
  }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  opened = [];
});

function tmpDb(): string {
  const d = mkdtempSync(join(tmpdir(), "bc-supervisor-"));
  dirs.push(d);
  return join(d, "bakacoding.db");
}
function open(path: string): Storage {
  const s = openStorage({ path, logger: { warn: () => {} } });
  opened.push(s);
  return s;
}

const ticket = (over: Record<string, unknown> = {}) => ({
  key: "t1",
  ticket_text: "目标：做 A\n接口声明：无",
  write_scope: ["lib/a/**"],
  interfaces: [{ file: "lib/a/index.ts", symbol: "a" }],
  depends_on: [],
  priority: "normal",
  kind: null,
  ...over,
});

function supervisorOn(storage: Storage, outputs: string[], warns: string[] = []) {
  let id = 0;
  const enqueued: string[] = [];
  const deps: SupervisorDeps = {
    call: async () => {
      const output = outputs.shift();
      if (output === undefined) throw new Error("没有更多桩输出");
      return {
        output,
        tokens: { input: 1, output: 1, cache_hit_input: 0 },
        cache_hit: false,
        latency_ms: 1,
        cost: 0,
        rate_limited_retry: 0,
      };
    },
    getConfig: () => ({
      roles: { supervisor: { provider: "deepseek", model: "deepseek-flash", effort: "max" } },
    }),
    promptTemplate: async () => "桩模板",
    storage,
    enqueue: (t) => {
      enqueued.push(t.ticket_id);
    },
    publish: (e) => {
      storage.ingest({ ...e, seq: storage.nextSeq() } as Parameters<Storage["ingest"]>[0]);
    },
    subscribe: () => () => {},
    targetHead: () => "abc1234",
    notifyUser: () => {},
    newId: () => `${Date.now().toString(36)}x${++id}`,
    logger: { warn: (m) => warns.push(m) },
  };
  return { sup: createSupervisor(deps), enqueued };
}

function seedProject(s: Storage) {
  s.ingest({
    type: "project_created",
    event_id: "ev-project",
    seq: s.nextSeq(),
    ts: "2026-10-17T00:00:00.000Z",
    trace_id: "t",
    span_id: "s",
    parent_span_id: null,
    requirement_id: null,
    ticket_id: null,
    payload: {
      project_id: "demo-1234",
      name: "demo",
      language: "typescript",
      has_github_remote: false,
    },
  });
}

describe("对真实存储（openStorage）", () => {
  it("拆单落库；关库重开后 loadTicket 还原、重拆续编单号并沿用 trace", async () => {
    const path = tmpDb();
    const s1 = open(path);
    seedProject(s1);
    const a = supervisorOn(s1, [
      JSON.stringify({
        summary: "两张",
        tickets: [
          ticket(),
          ticket({
            key: "t2",
            write_scope: ["package.json"],
            depends_on: ["t1"],
            kind: "dependency",
          }),
        ],
      }),
    ]);
    const r1 = await a.sup.split({
      project_id: "demo-1234",
      text: "做 A",
      requirement_id: "req-1",
    });
    expect(r1.tickets.map((t) => t.ticket_id)).toEqual(["req-1-1", "req-1-2"]);
    // 派单群消息经 ingest 落库
    expect(s1.groupMessages("demo-1234", "req-1").map((m) => m.kind)).toEqual([
      "dispatch",
      "dispatch",
    ]);
    s1.close();

    // 重启：新进程、新主管实例
    const s2 = open(path);
    const warns: string[] = [];
    const b = supervisorOn(
      s2,
      [JSON.stringify({ summary: "重拆", tickets: [ticket({ depends_on: ["req-1-2"] })] })],
      warns,
    );
    expect(await b.sup.loadTicket("req-1-2")).toEqual({
      ticket_id: "req-1-2",
      project_id: "demo-1234",
      requirement_id: "req-1",
      trace_id: r1.trace_id,
      span_id: r1.tickets[1]!.span_id,
      parent_span_id: r1.tickets[1]!.parent_span_id,
      ticket_text: r1.tickets[1]!.ticket_text,
      base_commit: "abc1234",
      permission_list: [],
      write_scope: ["package.json"],
      kind: "dependency",
    });
    expect(s2.listTickets({ requirement_id: "req-1" }).map((t) => t.status)).toEqual([
      "pending",
      "pending",
    ]);
    const r2 = await b.sup.split({
      project_id: "demo-1234",
      text: "重拆",
      requirement_id: "req-1",
    });
    expect(r2.tickets[0]!.ticket_id).toBe("req-1-3");
    expect(r2.tickets[0]!.depends_on).toEqual(["req-1-2"]);
    expect(r2.trace_id).toBe(r1.trace_id);
    expect(r2.tickets[0]!.parent_span_id).toBe(r1.tickets[0]!.parent_span_id);
    expect(warns).toEqual([]);
  });

  it("没有结构化字段的旧单：loadTicket 返回 undefined 并记原因，不影响其他单", async () => {
    const path = tmpDb();
    const s = open(path);
    seedProject(s);
    s.saveTicket({
      ticket_id: "old-1",
      project_id: "demo-1234",
      requirement_id: "req-old",
      created_at: "2026-10-01T00:00:00.000Z",
      ticket_text: "T-055 之前的单",
      base_commit: "abc1234",
      permission_list: [],
      context_snippets: [],
    });
    s.saveTicket({
      ticket_id: "odd-1",
      project_id: "demo-1234",
      requirement_id: "req-old",
      created_at: "2026-10-01T00:00:01.000Z",
      ticket_text: "格式不对",
      base_commit: "abc1234",
      permission_list: [],
      context_snippets: [],
      fields: { write_scope: "lib/**" },
    });
    const warns: string[] = [];
    const { sup } = supervisorOn(s, [], warns);
    expect(await sup.loadTicket("old-1")).toBeUndefined();
    expect(await sup.loadTicket("odd-1")).toBeUndefined();
    expect(await sup.loadTicket("nope")).toBeUndefined();
    expect(warns).toHaveLength(2);
    expect(warns[0]).toContain("没有结构化字段");
  });
});

describe("T-041a 重启接管 takeOver（真实存储）", () => {
  it("本进程已交给 9 的单不重复 enqueue；enqueue 出错记进 failed、不影响其余单；已合入的依赖去掉", async () => {
    const path = tmpDb();
    const s = open(path);
    seedProject(s);
    const warns: string[] = [];
    const first = supervisorOn(s, [], warns);
    const a = await first.sup.createManualTicket({
      project_id: "demo-1234",
      ticket_text: "做 A",
      origin: "manual",
      write_scope: ["lib/a/**"],
      interfaces: [],
    });
    const b = await first.sup.createManualTicket({
      project_id: "demo-1234",
      ticket_text: "做 B",
      origin: "manual",
      write_scope: ["lib/b/**"],
      interfaces: [],
      depends_on: [a.ticket_id],
    });
    // 同一进程：两张都已入队，接管什么都不做
    expect((await first.sup.takeOver()).enqueued).toEqual([]);
    expect(first.enqueued).toEqual([a.ticket_id, b.ticket_id]);

    // 「重启」：A 已合入，B 停在 coding
    s.saveTicket({ ...s.getTicket(a.ticket_id)!, status: "merged" });
    s.saveTicket({ ...s.getTicket(b.ticket_id)!, status: "coding" });
    const got: Array<{ id: string; deps: string[] | undefined }> = [];
    let fail = true;
    const { sup } = supervisorWithEnqueue(s, (t) => {
      if (fail) {
        fail = false;
        throw new Error("9 不接");
      }
      got.push({ id: t.ticket_id, deps: t.depends_on });
    });
    const r1 = await sup.takeOver();
    expect(r1.merged).toEqual([a.ticket_id]);
    expect(r1.enqueued).toEqual([]);
    expect(r1.failed).toEqual([{ ticket_id: b.ticket_id, error: "9 不接" }]);
    const r2 = await sup.takeOver();
    expect(r2.enqueued).toEqual([b.ticket_id]);
    expect(got).toEqual([{ id: b.ticket_id, deps: [] }]);
    expect((await sup.takeOver()).enqueued).toEqual([]);
  });
});

function supervisorWithEnqueue(storage: Storage, enqueue: SupervisorDeps["enqueue"]) {
  let id = 0;
  return {
    sup: createSupervisor({
      call: async () => {
        throw new Error("不调模型");
      },
      getConfig: () => ({
        roles: { supervisor: { provider: "deepseek", model: "deepseek-flash", effort: "max" } },
      }),
      promptTemplate: async () => "桩模板",
      storage,
      enqueue,
      publish: (e) => {
        storage.ingest({ ...e, seq: storage.nextSeq() } as Parameters<Storage["ingest"]>[0]);
      },
      subscribe: () => () => {},
      targetHead: () => "abc1234",
      notifyUser: () => {},
      newId: () => `${Date.now().toString(36)}y${++id}`,
      logger: { warn: () => {} },
    }),
  };
}
