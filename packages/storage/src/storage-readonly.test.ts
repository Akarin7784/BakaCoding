// T-026：只读打开。
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { BakaEvent } from "@bakacoding/types";
import { MIGRATIONS } from "./schema.sql.js";
import {
  openStorage,
  openStorageReadonly,
  StorageReadonlyError,
  StorageVersionError,
  type ReadonlyStorage,
  type Storage,
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
  const d = mkdtempSync(join(tmpdir(), "bc-storage-026-"));
  dirs.push(d);
  return join(d, "bakacoding.db");
}
function writer(path: string): Storage {
  const s = openStorage({ path, owner: "writer-1" });
  opened.push(s);
  return s;
}
function reader(path: string): ReadonlyStorage {
  const s = openStorageReadonly({ path });
  opened.push(s);
  return s;
}
const backlog = (seq: number): BakaEvent =>
  ({
    event_id: `ev-${seq}`,
    seq,
    ts: "2026-10-17T06:00:00.000Z",
    trace_id: "tr",
    span_id: `sp-${seq}`,
    parent_span_id: null,
    requirement_id: "R-1",
    ticket_id: "T-1",
    type: "review_backlog",
    payload: { pending: seq, capacity: 2 },
  }) as BakaEvent;
const lease = (path: string) => {
  const d = new Database(path, { readonly: true });
  const r = d.prepare("SELECT owner, expires_at FROM lease WHERE id = 1").get();
  d.close();
  return r;
};

describe("T-026 只读打开", () => {
  it("写入方在跑时也能打开，读到写入方后来写的数据", async () => {
    const path = tmpDb();
    const w = writer(path);
    w.ingest(backlog(0));
    const r = reader(path);
    expect(r.maxSeq()).toBe(0);
    w.ingest(backlog(1));
    expect(r.maxSeq()).toBe(1);
    expect(r.nextSeq()).toBe(2);
    expect(r.queryEvents().map((e) => e.event_id)).toEqual(["ev-0", "ev-1"]);
    expect(r.backlogMetrics("review_backlog").map((m) => m.pending)).toEqual([0, 1]);

    w.saveDecision({ project_id: "p1", content: "用只读", ts: "2026-10-17T06:00:00.000Z" });
    expect(r.listDecisions("p1").map((d) => d.content)).toEqual(["用只读"]);

    await w.prStore().put({
      pr_id: "pr-1",
      kind: "ticket",
      branch: "bc/T-1",
      base_sha: "a".repeat(40),
      head_sha: "b".repeat(40),
    });
    expect((await r.prStore().get("pr-1"))?.branch).toBe("bc/T-1");
    expect(await r.prStore().list()).toHaveLength(1);

    await w.ledger.append({
      entry_id: "l1",
      ts: "2026-10-17T06:00:00.000Z",
      requirement_id: "R-1",
      ticket_id: "T-1",
      role: "coder",
      cost_micro_usd: 9,
      is_resubmit: false,
      cache_hit: false,
      offpeak: false,
    });
    expect((await r.ledger.totalsByTicket("T-1")).total_micro_usd).toBe(9);

    const src = r.diagnosticsSource();
    const evs = await src.queryEvents({ project_id: "p1" });
    expect(Array.isArray(evs)).toBe(true);
  });

  it("空库 maxSeq 为 null", () => {
    const path = tmpDb();
    writer(path);
    expect(reader(path).maxSeq()).toBeNull();
  });

  it("不拿租约：只读端开关前后租约不变，写入方照常写", () => {
    const path = tmpDb();
    const w = writer(path);
    const before = lease(path);
    const r = reader(path);
    r.close();
    expect(lease(path)).toEqual(before);
    expect(() => w.ingest(backlog(0))).not.toThrow();
    expect(w.health().lease_lost).toBe(false);
  });

  it("写方法一律抛 StorageReadonlyError，库不被改动", async () => {
    const path = tmpDb();
    writer(path);
    const r = reader(path) as unknown as Storage;
    expect(() => r.ingest(backlog(0))).toThrow(StorageReadonlyError);
    expect(() => r.ingest(backlog(0))).toThrow(/ingest/);
    expect(() => r.registerRequirement("R-1", "p1")).toThrow(StorageReadonlyError);
    expect(() => r.saveDecision({ project_id: "p1", content: "x" })).toThrow(StorageReadonlyError);
    expect(() => r.markForEvalSet("T-1")).toThrow(StorageReadonlyError);
    expect(() => r.purgeExpired()).toThrow(StorageReadonlyError);
    expect(() => r.attach({ subscribe: () => () => undefined })).toThrow(StorageReadonlyError);
    await expect(
      r.prStore().put({ pr_id: "p", kind: "ticket", branch: "b", base_sha: "a", head_sha: "b" }),
    ).rejects.toThrow(StorageReadonlyError);
    await expect(
      r.ledger.append({
        entry_id: "l",
        ts: "2026-10-17T06:00:00.000Z",
        requirement_id: "R-1",
        ticket_id: null,
        role: "coder",
        cost_micro_usd: 1,
        is_resubmit: false,
        cache_hit: false,
        offpeak: false,
      }),
    ).rejects.toThrow(StorageReadonlyError);
    expect(r.maxSeq()).toBeNull();
  });

  it("不跑迁移：旧版本的库报错并提示先用写入方打开，库仍是旧版本", () => {
    const path = tmpDb();
    const raw = new Database(path);
    raw.exec(MIGRATIONS[0] as string);
    raw.pragma("user_version = 1");
    raw.close();
    expect(() => openStorageReadonly({ path })).toThrow(StorageVersionError);
    expect(() => openStorageReadonly({ path })).toThrow(
      new RegExp(`v1.*需要 v${MIGRATIONS.length}.*先用写入方`),
    );
    const d = new Database(path, { readonly: true });
    expect(d.pragma("user_version", { simple: true })).toBe(1);
    d.close();
  });

  it("库版本比代码新时报错", () => {
    const path = tmpDb();
    writer(path).close();
    opened = [];
    const raw = new Database(path);
    raw.pragma(`user_version = ${MIGRATIONS.length + 1}`);
    raw.close();
    expect(() => openStorageReadonly({ path })).toThrow(/比当前代码支持的.*新/);
  });

  it("库文件不存在时报错，不新建文件", () => {
    const path = tmpDb();
    expect(() => openStorageReadonly({ path })).toThrow();
    expect(existsSync(path)).toBe(false);
  });
});
