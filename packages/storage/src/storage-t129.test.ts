// T-129：openStorage 迁移失败时也要关掉数据库句柄，否则 Windows 上库文件一直被占用、临时目录删不掉。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MIGRATIONS } from "./schema.sql.js";
import { openStorage } from "./index.js";

let dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
function tmpDb(): string {
  const d = mkdtempSync(join(tmpdir(), "bc-storage-129-"));
  dirs.push(d);
  return join(d, "bakacoding.db");
}

/** 造一个 v1 旧库：events.seq 有重复，升级到 v2（seq 唯一索引）时必然失败。 */
function legacyDbWithDuplicateSeq(path: string): void {
  const raw = new Database(path);
  raw.exec(MIGRATIONS[0] as string);
  raw.pragma("user_version = 1");
  const ins = raw.prepare(
    `INSERT INTO events (event_id, seq, type, ts, trace_id, span_id, parent_span_id, requirement_id, ticket_id, project_id, payload)
     VALUES (?, 0, 'review_backlog', '2026-10-17T06:00:00Z', 'tr', 'sp', NULL, 'R-1', NULL, NULL, '{"pending":1,"capacity":1}')`,
  );
  ins.run("dup-1");
  ins.run("dup-2");
  raw.close();
}

describe("T-129 迁移失败释放数据库句柄", () => {
  it("升级中止抛错后句柄已释放：库文件和临时目录能马上删掉", () => {
    const path = tmpDb();
    legacyDbWithDuplicateSeq(path);

    expect(() => openStorage({ path })).toThrow(/升级到 v2 已中止.*重复的 seq（0×2）/);

    // 句柄没释放时 Windows 上这里会报 EPERM / EBUSY
    expect(() => rmSync(dirname(path), { recursive: true, force: true })).not.toThrow();
  });

  it("句柄释放后仍可用只读连接打开同一个旧库（数据没丢、版本停在 v1）", () => {
    const path = tmpDb();
    legacyDbWithDuplicateSeq(path);

    expect(() => openStorage({ path })).toThrow(/升级到 v2 已中止/);

    const raw = new Database(path, { readonly: true });
    try {
      expect(raw.pragma("user_version", { simple: true })).toBe(1);
      expect((raw.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n).toBe(2);
    } finally {
      raw.close();
    }
  });

  it("T-138：迁移失败时调用了 db.close，句柄已关闭（Linux 上也能拦住回退）", () => {
    const path = tmpDb();
    legacyDbWithDuplicateSeq(path);
    const closed: Database.Database[] = [];
    const orig = Database.prototype.close;
    vi.spyOn(Database.prototype, "close").mockImplementation(function (this: Database.Database) {
      closed.push(this);
      return orig.call(this);
    });

    expect(() => openStorage({ path })).toThrow(/升级到 v2 已中止/);

    expect(closed).toHaveLength(1);
    expect(closed[0]!.open).toBe(false);
  });
});
