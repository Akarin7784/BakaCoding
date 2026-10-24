// T-090：按项目汇总台账（totalsByProject）与 v5 迁移（ledger(requirement_id) 索引）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { LedgerEntry } from "@bakacoding/types";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS } from "./schema.sql.js";
import { openStorage, openStorageReadonly, type Storage } from "./index.js";

let dirs: string[] = [];
let opened: { close(): void }[] = [];
afterEach(() => {
  for (const s of opened.reverse()) s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  opened = [];
});
function tmpDb(): string {
  const d = mkdtempSync(join(tmpdir(), "bc-storage-090-"));
  dirs.push(d);
  return join(d, "bakacoding.db");
}
function openW(path = tmpDb()): Storage {
  const s = openStorage({ path });
  opened.push(s);
  return s;
}
function entry(
  id: string,
  req: string,
  cost: number,
  extra: Partial<LedgerEntry> = {},
): LedgerEntry {
  return {
    entry_id: id,
    ts: "2026-10-20T03:00:00.000Z",
    requirement_id: req,
    ticket_id: null,
    role: "coder",
    cost_micro_usd: cost,
    is_resubmit: false,
    cache_hit: false,
    offpeak: false,
    ...extra,
  };
}
const ZERO = {
  total_micro_usd: 0,
  resubmit_micro_usd: 0,
  entries: 0,
  by_role: { coder: 0, sub_agent: 0, reviewer: 0, supervisor: 0 },
};

describe("T-090 totalsByProject", () => {
  it("按 requirements 关联项目、跨天累计、四个角色都列", async () => {
    const s = openW();
    s.registerRequirement("R-1", "P-1");
    s.registerRequirement("R-2", "P-1");
    s.registerRequirement("R-3", "P-2");
    await s.ledger.append(entry("e1", "R-1", 100));
    await s.ledger.append(
      entry("e2", "R-2", 30, {
        ts: "2026-09-01T00:00:00.000Z",
        role: "reviewer",
        is_resubmit: true,
      }),
    );
    await s.ledger.append(entry("e3", "R-3", 7));
    await s.ledger.append(entry("e1", "R-1", 100)); // 幂等
    expect(await s.ledger.totalsByProject("P-1")).toEqual({
      total_micro_usd: 130,
      resubmit_micro_usd: 30,
      entries: 2,
      by_role: { coder: 100, sub_agent: 0, reviewer: 30, supervisor: 0 },
    });
    expect((await s.ledger.totalsByProject("P-2")).total_micro_usd).toBe(7);
  });

  it("没登记过的需求不计入任何项目；未知项目返回全 0", async () => {
    const s = openW();
    s.registerRequirement("R-1", "P-1");
    await s.ledger.append(entry("e1", "R-1", 5));
    await s.ledger.append(entry("e2", "R-orphan", 999));
    expect((await s.ledger.totalsByProject("P-1")).total_micro_usd).toBe(5);
    expect(await s.ledger.totalsByProject("P-none")).toEqual(ZERO);
    expect(await s.ledger.totalsByProject("R-orphan")).toEqual(ZERO);
  });

  it("project_id 为空或不是字符串报 invalid_project_id，消息不带值", async () => {
    const s = openW();
    for (const bad of ["", 42, null, undefined]) {
      const err = await s.ledger.totalsByProject(bad as string).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TypeError);
      expect((err as { code?: string }).code).toBe("invalid_project_id");
      expect((err as Error).message).not.toContain("42");
    }
  });

  it("只读连接也能用", async () => {
    const path = tmpDb();
    const w = openW(path);
    w.registerRequirement("R-1", "P-1");
    await w.ledger.append(entry("e1", "R-1", 11));
    const ro = openStorageReadonly({ path });
    opened.push(ro);
    expect((await ro.ledger.totalsByProject("P-1")).total_micro_usd).toBe(11);
  });

  it("v4 旧库升级到 v5：旧台账保留、加上 ledger(requirement_id) 索引", async () => {
    const path = tmpDb();
    const raw = new Database(path);
    for (const step of MIGRATIONS.slice(0, 4)) {
      if (typeof step === "string") raw.exec(step);
      else step(raw);
    }
    raw.pragma("user_version = 4");
    raw
      .prepare(
        `INSERT INTO ledger (entry_id, ts, day, requirement_id, ticket_id, role, cost_micro_usd, is_resubmit, cache_hit, offpeak)
         VALUES ('old', '2026-10-01T00:00:00.000Z', '2026-10-01', 'R-1', NULL, 'coder', 42, 0, 0, 0)`,
      )
      .run();
    raw
      .prepare("INSERT INTO requirements (requirement_id, project_id) VALUES ('R-1', 'P-1')")
      .run();
    raw.close();
    const s = openW(path);
    expect((await s.ledger.totalsByProject("P-1")).total_micro_usd).toBe(42);
    s.close();
    opened.pop();
    const check = new Database(path, { readonly: true });
    expect(check.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    const idx = check
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ledger'")
      .all() as { name: string }[];
    check.close();
    expect(idx.map((r) => r.name)).toContain("ledger_requirement");
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(5);
  });
});
