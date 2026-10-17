// T-055：需求单结构化字段（tickets.fields，JSON 可空）与 getTicket / listTickets。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openStorage, openStorageReadonly, type TicketInput } from "./index.js";
import { MIGRATIONS, type Migration } from "./schema.sql.js";

let dirs: string[] = [];
let opened: Array<{ close(): void }> = [];
afterEach(() => {
  for (const s of opened) s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  opened = [];
});
function tmpDb(): string {
  const d = mkdtempSync(join(tmpdir(), "bc-storage-055-"));
  dirs.push(d);
  return join(d, "bakacoding.db");
}
const base: TicketInput = {
  ticket_id: "R-1-1",
  project_id: "P-1",
  requirement_id: "R-1",
  created_at: "2026-10-17T06:00:00.000Z",
  ticket_text: "做 A",
  base_commit: "abc1234",
  permission_list: [],
  context_snippets: [],
};
const fields = {
  write_scope: ["src/a/**"],
  interfaces: [{ name: "foo()", kind: "function" }],
  depends_on: ["R-1-0"],
  priority: "normal",
  kind: "feature",
  origin: "split",
  trace: { trace_id: "tr", span_id: "sp", parent_span_id: null },
  attempts: 1,
  high_risk: false,
};

describe("tickets.fields（T-055）", () => {
  it("原样往返，不脱敏；getTicket 不存在返回 undefined", () => {
    const s = openStorage({ path: tmpDb() });
    opened.push(s);
    // 看起来像密钥的结构字段也不改（结构字段原样往返）
    const f = { ...fields, note: "sk-abcdefghijklmnopqrstuvwxyz0123456789" };
    s.saveTicket({ ...base, fields: f, status: "queued" });
    const t = s.getTicket("R-1-1")!;
    expect(t.fields).toEqual(f);
    expect(t).toMatchObject({
      ticket_id: "R-1-1",
      project_id: "P-1",
      status: "queued",
      permission_list: [],
    });
    expect(s.getTicket("R-404")).toBeUndefined();
  });

  it("不带 fields 再保存（如 8 回写权限清单）时保留原值；传 {} 才清空", () => {
    const s = openStorage({ path: tmpDb() });
    opened.push(s);
    s.saveTicket({ ...base, fields });
    s.saveTicket({ ...base, permission_list: [{ glob: "src/a/**", level: "rw" }] });
    expect(s.getTicket("R-1-1")!.fields).toEqual(fields);
    expect(s.getTicket("R-1-1")!.permission_list).toEqual([{ glob: "src/a/**", level: "rw" }]);
    s.saveTicket({ ...base, fields: {} });
    expect(s.getTicket("R-1-1")!.fields).toEqual({});
  });

  it("从没存过 fields 的单读出 null", () => {
    const s = openStorage({ path: tmpDb() });
    opened.push(s);
    s.saveTicket(base);
    expect(s.getTicket("R-1-1")!.fields).toBeNull();
  });

  it.each([
    ["数组", [1]],
    ["null", null],
    ["函数", { f: () => 1 }],
    ["undefined 值", { a: undefined }],
    ["NaN", { a: Number.NaN }],
    ["Date", { a: new Date() }],
    ["bigint", { a: 1n }],
  ])("fields 不能 JSON 往返（%s）时报错且不写入", (_n, bad) => {
    const s = openStorage({ path: tmpDb() });
    opened.push(s);
    expect(() => s.saveTicket({ ...base, fields: bad as never })).toThrow(TypeError);
    expect(s.getTicket("R-1-1")).toBeUndefined();
  });
});

describe("fields 读出容错（T-055 评审）", () => {
  it.each([
    ["损坏的 JSON", "{not json", "不是合法 JSON"],
    ["不是对象（数组）", "[1,2]", "不是对象"],
    ["不是对象（null）", "null", "不是对象"],
  ])("库里 fields 是%s：读成 null、记一条警告，其他单照常读", (_n, raw, msg) => {
    const path = tmpDb();
    const warns: string[] = [];
    const s = openStorage({ path, logger: { warn: (m) => warns.push(m) } });
    opened.push(s);
    s.saveTicket({ ...base, fields });
    s.saveTicket({ ...base, ticket_id: "R-1-2", fields });
    const raw2 = new Database(path);
    raw2.prepare("UPDATE tickets SET fields = ? WHERE ticket_id = 'R-1-1'").run(raw);
    raw2.close();
    expect(s.getTicket("R-1-1")!.fields).toBeNull();
    expect(s.listTickets().map((t) => t.fields)).toEqual([null, fields]);
    expect(warns.length).toBeGreaterThan(0);
    expect(warns[0]).toContain("R-1-1");
    expect(warns[0]).toContain(msg);
    const roWarns: string[] = [];
    const ro = openStorageReadonly({ path, logger: { warn: (m) => roWarns.push(m) } });
    opened.push(ro);
    expect(ro.getTicket("R-1-1")!.fields).toBeNull();
    expect(roWarns).toHaveLength(1);
  });

  it("写入循环引用的 fields 抛 TypeError（不是栈溢出），不写入", () => {
    const s = openStorage({ path: tmpDb() });
    opened.push(s);
    const a: Record<string, unknown> = { x: 1 };
    a.self = a;
    expect(() => s.saveTicket({ ...base, fields: a as never })).toThrow(TypeError);
    const arr: unknown[] = [];
    arr.push(arr);
    expect(() => s.saveTicket({ ...base, fields: { arr } as never })).toThrow(/循环引用/);
    expect(s.getTicket("R-1-1")).toBeUndefined();
    // 同一个对象出现两次但不成环，照常写入
    const shared = { k: "v" };
    s.saveTicket({ ...base, fields: { a: shared, b: shared } });
    expect(s.getTicket("R-1-1")!.fields).toEqual({ a: shared, b: shared });
  });
});

describe("listTickets（T-055）", () => {
  it("按项目、需求、状态过滤，按 created_at、ticket_id 升序", () => {
    const s = openStorage({ path: tmpDb() });
    opened.push(s);
    s.saveTicket({
      ...base,
      ticket_id: "R-1-2",
      created_at: "2026-10-17T06:00:01Z",
      status: "coding",
    });
    s.saveTicket({ ...base, ticket_id: "R-1-1", status: "queued" });
    s.saveTicket({
      ...base,
      ticket_id: "R-1-0",
      created_at: "2026-10-17T06:00:00Z",
      status: "queued",
    });
    s.saveTicket({ ...base, ticket_id: "R-2-1", requirement_id: "R-2", project_id: "P-2" });
    const ids = (f?: Parameters<typeof s.listTickets>[0]) =>
      s.listTickets(f).map((t) => t.ticket_id);
    expect(ids()).toEqual(["R-1-0", "R-1-1", "R-2-1", "R-1-2"]);
    expect(ids({ project_id: "P-1" })).toEqual(["R-1-0", "R-1-1", "R-1-2"]);
    expect(ids({ requirement_id: "R-2" })).toEqual(["R-2-1"]);
    expect(ids({ project_id: "P-1", status: "queued" })).toEqual(["R-1-0", "R-1-1"]);
    expect(ids({ project_id: "P-404" })).toEqual([]);
  });

  it("只读连接也能用 getTicket / listTickets", () => {
    const path = tmpDb();
    const s = openStorage({ path });
    opened.push(s);
    s.saveTicket({ ...base, fields });
    const ro = openStorageReadonly({ path });
    opened.push(ro);
    expect(ro.getTicket("R-1-1")!.fields).toEqual(fields);
    expect(ro.listTickets({ project_id: "P-1" })).toHaveLength(1);
  });
});

describe("v2 → v3 升级", () => {
  it("旧库的单保留，fields 读出 null；之后可以写入", () => {
    const path = tmpDb();
    const raw = new Database(path);
    raw.exec(MIGRATIONS[0] as string);
    (MIGRATIONS[1] as Exclude<Migration, string>)(raw);
    raw.pragma("user_version = 2");
    raw
      .prepare(
        `INSERT INTO tickets (ticket_id, project_id, requirement_id, created_at, created_at_ms, ticket_text, base_commit, permission_list, context_snippets)
         VALUES ('OLD-1', 'P-1', 'R-1', '2026-10-01T00:00:00Z', ?, 'old', 'abc', '[]', '[]')`,
      )
      .run(Date.parse("2026-10-01T00:00:00Z"));
    raw.close();
    const s = openStorage({ path });
    opened.push(s);
    expect(s.getTicket("OLD-1")).toMatchObject({ ticket_text: "old", fields: null });
    s.saveTicket({ ...base, ticket_id: "OLD-1", requirement_id: "R-1", fields });
    expect(s.getTicket("OLD-1")!.fields).toEqual(fields);
  });
});
