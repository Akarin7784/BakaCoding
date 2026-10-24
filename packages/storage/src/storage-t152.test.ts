// T-152：supervisor_messages 加可空列 in_reply_to（库版本 v7）。
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
  type Storage,
  type SupervisorMessage,
} from "./index.js";

let dirs: string[] = [];
let opened: { close(): void }[] = [];
afterEach(() => {
  for (const s of opened.reverse()) s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  opened = [];
});
function tmpDb(): string {
  const d = mkdtempSync(join(tmpdir(), "bc-storage-152-"));
  dirs.push(d);
  return join(d, "bakacoding.db");
}
function openW(path = tmpDb()): Storage {
  const s = openStorage({ path });
  opened.push(s);
  return s;
}
const user: SupervisorMessage = {
  message_id: "u-1",
  project_id: null,
  role: "user",
  kind: null,
  content: "拆一下",
  requirement_id: null,
  ticket_ids: [],
  created_at: 1000,
};
const reply: SupervisorMessage = {
  message_id: "m-reply",
  project_id: "P-1",
  role: "supervisor",
  kind: "split_failed",
  content: "没拆成",
  requirement_id: "R-1",
  ticket_ids: [],
  created_at: 1001,
  in_reply_to: "u-1",
};
/** 建一个只升到 v6 的旧库，里面有一条 T-152 之前的消息。 */
function v6Db(): string {
  const path = tmpDb();
  const raw = new Database(path);
  for (const step of MIGRATIONS.slice(0, 6)) {
    if (typeof step === "string") raw.exec(step);
    else step(raw);
  }
  raw.pragma("user_version = 6");
  raw
    .prepare(
      `INSERT INTO supervisor_messages
       (message_id, project_id, role, kind, content, requirement_id, ticket_ids, created_at)
       VALUES ('old-r', NULL, 'supervisor', 'answer', '旧回复', NULL, '[]', 500)`,
    )
    .run();
  raw.close();
  return path;
}

describe("T-152 in_reply_to", () => {
  it("v6 旧库升级到 v7：原有记录读出 in_reply_to 为 null", () => {
    const path = v6Db();
    const s = openW(path);
    expect(s.listSupervisorMessages()).toEqual([
      {
        message_id: "old-r",
        project_id: null,
        role: "supervisor",
        kind: "answer",
        content: "旧回复",
        requirement_id: null,
        ticket_ids: [],
        created_at: 500,
        in_reply_to: null,
      },
    ]);
    s.close();
    opened.pop();
    const check = new Database(path, { readonly: true });
    expect(check.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    const cols = check.prepare("PRAGMA table_info(supervisor_messages)").all() as {
      name: string;
      notnull: number;
    }[];
    check.close();
    expect(cols.find((c) => c.name === "in_reply_to")).toMatchObject({ notnull: 0 });
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(7);
  });

  it("迁移跑两次不出错：重开已是新版本的库，数据和版本不变", () => {
    const path = v6Db();
    const a = openW(path);
    a.appendSupervisorMessage(reply);
    a.close();
    opened.pop();
    const b = openW(path);
    expect(b.listSupervisorMessages().map((m) => [m.message_id, m.in_reply_to])).toEqual([
      ["old-r", null],
      ["m-reply", "u-1"],
    ]);
    b.close();
    opened.pop();
    const check = new Database(path, { readonly: true });
    expect(check.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    check.close();
  });

  it("写入的 in_reply_to 原样读回；不传按 null；只读连接也读得到", () => {
    const path = tmpDb();
    const s = openW(path);
    expect(s.appendSupervisorMessage(user)).toEqual({ inserted: true });
    expect(s.appendSupervisorMessage(reply)).toEqual({ inserted: true });
    const got = s.listSupervisorMessages();
    expect(got).toEqual([{ ...user, in_reply_to: null }, reply]);
    const ro = openStorageReadonly({ path });
    opened.push(ro);
    expect(ro.listSupervisorMessages().map((m) => m.in_reply_to)).toEqual([null, "u-1"]);
  });

  it("幂等重试先写为准：同 id 再写不同的 in_reply_to 不覆盖", () => {
    const s = openW();
    s.appendSupervisorMessage(reply);
    expect(s.appendSupervisorMessage({ ...reply, in_reply_to: "u-other" })).toEqual({
      inserted: false,
    });
    expect(s.listSupervisorMessages()[0]!.in_reply_to).toBe("u-1");
  });

  it("in_reply_to 为空串或非字符串报 invalid_message，消息不带值", () => {
    const s = openW();
    for (const bad of ["", 7, {}]) {
      try {
        s.appendSupervisorMessage({ ...reply, in_reply_to: bad as never });
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(StorageError);
        expect((e as StorageError).code).toBe("invalid_message");
        expect((e as Error).message).not.toContain("7");
      }
    }
    expect(s.listSupervisorMessages()).toEqual([]);
  });
});
