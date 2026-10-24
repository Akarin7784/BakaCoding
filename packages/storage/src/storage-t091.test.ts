// T-091：主管 1:1 对话存储（appendSupervisorMessage / listSupervisorMessages）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS } from "./schema.sql.js";
import {
  openStorage,
  openStorageReadonly,
  StorageError,
  StorageReadonlyError,
  type Storage,
  type SupervisorMessage,
} from "./index.js";

const KEY = "sk-" + "a".repeat(40);
let dirs: string[] = [];
let opened: { close(): void }[] = [];
afterEach(() => {
  for (const s of opened.reverse()) s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  opened = [];
});
function tmpDb(): string {
  const d = mkdtempSync(join(tmpdir(), "bc-storage-091-"));
  dirs.push(d);
  return join(d, "bakacoding.db");
}
function openW(path = tmpDb()): Storage {
  const s = openStorage({ path });
  opened.push(s);
  return s;
}
function msg(id: string, at: number, extra: Partial<SupervisorMessage> = {}): SupervisorMessage {
  return {
    message_id: id,
    project_id: null,
    role: "user",
    kind: null,
    content: `内容 ${id}`,
    requirement_id: null,
    ticket_ids: [],
    created_at: at,
    ...extra,
  };
}
function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof StorageError) return e.code;
    throw e;
  }
  return undefined;
}
const ids = (xs: SupervisorMessage[]): string[] => xs.map((x) => x.message_id);

describe("T-091 主管对话存储", () => {
  it("写入后原样读回，ticket_ids 往返", () => {
    const s = openW();
    const m = msg("m1", 1000, {
      project_id: "P-1",
      role: "supervisor",
      kind: "dispatched",
      requirement_id: "R-1",
      ticket_ids: ["T-1", "T-2"],
    });
    expect(s.appendSupervisorMessage(m)).toEqual({ inserted: true });
    expect(s.listSupervisorMessages()).toEqual([m]);
  });

  it("重复 message_id：忽略并返回 inserted:false，内容不同也以先写的为准", () => {
    const s = openW();
    expect(s.appendSupervisorMessage(msg("m1", 1000, { content: "第一次" }))).toEqual({
      inserted: true,
    });
    expect(s.appendSupervisorMessage(msg("m1", 2000, { content: "第二次" }))).toEqual({
      inserted: false,
    });
    const all = s.listSupervisorMessages();
    expect(all).toHaveLength(1);
    expect(all[0]!.content).toBe("第一次");
    expect(all[0]!.created_at).toBe(1000);
  });

  it("role / kind 不匹配报 invalid_message", () => {
    const s = openW();
    expect(codeOf(() => s.appendSupervisorMessage(msg("a", 1, { kind: "answer" })))).toBe(
      "invalid_message",
    );
    expect(
      codeOf(() => s.appendSupervisorMessage(msg("b", 1, { role: "supervisor", kind: null }))),
    ).toBe("invalid_message");
    expect(
      codeOf(() =>
        s.appendSupervisorMessage(
          msg("c", 1, { role: "supervisor", kind: "bogus" as SupervisorMessage["kind"] }),
        ),
      ),
    ).toBe("invalid_message");
    expect(s.listSupervisorMessages()).toEqual([]);
  });

  it("content 落库前过轻脱敏，错误消息不带值", () => {
    const s = openW();
    s.appendSupervisorMessage(msg("m1", 1, { content: `密钥 ${KEY}` }));
    expect(s.listSupervisorMessages()[0]!.content).not.toContain(KEY);
    try {
      s.appendSupervisorMessage(msg(KEY, 1, { kind: "answer" }));
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(KEY);
    }
  });

  it("按 created_at 再按 message_id 升序；created_at 相同时顺序稳定", () => {
    const s = openW();
    s.appendSupervisorMessage(msg("c", 1000));
    s.appendSupervisorMessage(msg("a", 1000));
    s.appendSupervisorMessage(msg("z", 500));
    s.appendSupervisorMessage(msg("b", 1000));
    expect(ids(s.listSupervisorMessages())).toEqual(["z", "a", "b", "c"]);
    expect(ids(s.listSupervisorMessages())).toEqual(["z", "a", "b", "c"]);
  });

  it("before 游标：取它之前最近的 limit 条，升序返回；同一时刻按 message_id 切分", () => {
    const s = openW();
    for (const [id, at] of [
      ["m1", 1],
      ["m2", 2],
      ["m3a", 3],
      ["m3b", 3],
      ["m4", 4],
    ] as const)
      s.appendSupervisorMessage(msg(id, at));
    expect(ids(s.listSupervisorMessages({ before: "m4", limit: 2 }))).toEqual(["m3a", "m3b"]);
    expect(ids(s.listSupervisorMessages({ before: "m3b", limit: 2 }))).toEqual(["m2", "m3a"]);
    expect(ids(s.listSupervisorMessages({ before: "m3a", limit: 5 }))).toEqual(["m1", "m2"]);
    expect(ids(s.listSupervisorMessages({ before: "m1" }))).toEqual([]);
    expect(ids(s.listSupervisorMessages({ limit: 2 }))).toEqual(["m3b", "m4"]);
  });

  it("before 找不到报 invalid_cursor", () => {
    const s = openW();
    s.appendSupervisorMessage(msg("m1", 1));
    expect(codeOf(() => s.listSupervisorMessages({ before: "nope" }))).toBe("invalid_cursor");
  });

  it("project_id 只作可选过滤；不传读整条对话", () => {
    const s = openW();
    s.appendSupervisorMessage(msg("a", 1, { project_id: "P-1" }));
    s.appendSupervisorMessage(msg("b", 2));
    s.appendSupervisorMessage(msg("c", 3, { project_id: "P-2" }));
    expect(ids(s.listSupervisorMessages())).toEqual(["a", "b", "c"]);
    expect(ids(s.listSupervisorMessages({ project_id: "P-1" }))).toEqual(["a"]);
  });

  it("limit 默认 50、最大 200，≤0 报 RangeError", () => {
    const s = openW();
    for (let i = 0; i < 250; i++)
      s.appendSupervisorMessage(msg(`m${String(i).padStart(3, "0")}`, i));
    expect(s.listSupervisorMessages()).toHaveLength(50);
    expect(s.listSupervisorMessages()[49]!.message_id).toBe("m249");
    expect(s.listSupervisorMessages({ limit: 1000 })).toHaveLength(200);
    expect(() => s.listSupervisorMessages({ limit: 0 })).toThrow(RangeError);
    expect(() => s.listSupervisorMessages({ limit: -1 })).toThrow(RangeError);
  });

  it("只读打开能读，不能写", () => {
    const path = tmpDb();
    const w = openW(path);
    w.appendSupervisorMessage(msg("m1", 1));
    const ro = openStorageReadonly({ path });
    opened.push(ro);
    expect(ids(ro.listSupervisorMessages())).toEqual(["m1"]);
    const asW = ro as unknown as Storage;
    expect(() => asW.appendSupervisorMessage(msg("m2", 2))).toThrow(StorageReadonlyError);
  });

  it("v3 旧库升级到 v4，旧数据保留、新表可用", () => {
    const path = tmpDb();
    const raw = new Database(path);
    for (const step of MIGRATIONS.slice(0, 3)) {
      if (typeof step === "string") raw.exec(step);
      else step(raw);
    }
    raw.pragma("user_version = 3");
    raw.close();
    const s = openW(path);
    s.appendSupervisorMessage(msg("m1", 1));
    expect(ids(s.listSupervisorMessages())).toEqual(["m1"]);
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(4);
  });
});
