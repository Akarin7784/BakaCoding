// T-010 存储层补充：PR 轮次 reviewer 结构字段、listProjects()。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { BakaEvent } from "@bakacoding/types";
import { openStorage, openStorageReadonly, type Storage } from "./index.js";

let dirs: string[] = [];
let opened: Array<{ close(): void }> = [];
afterEach(() => {
  for (const s of opened) s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  opened = [];
});
function tmpDb(): string {
  const d = mkdtempSync(join(tmpdir(), "bc-storage-010-"));
  dirs.push(d);
  return join(d, "bakacoding.db");
}
function open(path = tmpDb()): Storage {
  const s = openStorage({ path });
  opened.push(s);
  return s;
}
let n = 0;
function projectCreated(project_id: string, ts: string): BakaEvent {
  n += 1;
  return {
    event_id: `ev-${n}`,
    seq: n,
    ts,
    trace_id: "tr-1",
    span_id: `sp-${n}`,
    parent_span_id: null,
    requirement_id: null,
    ticket_id: null,
    type: "project_created",
    payload: { project_id, name: project_id, language: "typescript", has_github_remote: false },
  } as BakaEvent;
}
const ticket = {
  ticket_id: "T-1",
  project_id: "P-1",
  requirement_id: "R-1",
  created_at: "2026-10-17T06:00:00.000Z",
  ticket_text: "t",
  base_commit: "abc1234",
  permission_list: [{ glob: "src/**", level: "rw" as const }],
  context_snippets: [],
};
const diff = { base_sha: "a".repeat(40), head_sha: "b".repeat(40), files: [] };
const KEY = "sk-" + "c".repeat(40);

describe("PR 轮次 reviewer 字段", () => {
  it("成员 id / supervisor / null 原样往返，不脱敏；不传读出 null", () => {
    const s = open();
    s.saveTicket(ticket);
    s.savePrRecord({
      ticket_id: "T-1",
      round: 1,
      diff,
      verdict: "fail",
      fail_reasons: [KEY],
      reviewer: "member-glm",
    });
    s.savePrRecord({
      ticket_id: "T-1",
      round: 2,
      diff,
      verdict: "fail",
      fail_reasons: [],
      reviewer: "supervisor",
    });
    s.savePrRecord({
      ticket_id: "T-1",
      round: 3,
      diff,
      verdict: "pass",
      fail_reasons: [],
      reviewer: null,
    });
    s.savePrRecord({ ticket_id: "T-1", round: 4, diff, verdict: "pass", fail_reasons: [] });
    const rounds = s.query({ project_id: "P-1" })[0]!.rounds;
    expect(rounds.map((r) => r.reviewer)).toEqual(["member-glm", "supervisor", null, null]);
    expect(rounds[0]!.fail_reasons[0]).not.toContain(KEY);
  });

  it("旧记录（库里没有 reviewer 键）读出 null；只读连接同样", () => {
    const path = tmpDb();
    const s = open(path);
    s.saveTicket(ticket);
    s.savePrRecord({ ticket_id: "T-1", round: 1, diff, verdict: "pass", fail_reasons: [] });
    const raw = new Database(path);
    raw
      .prepare("UPDATE pr_rounds SET record = ? WHERE ticket_id = 'T-1'")
      .run(JSON.stringify({ round: 1, diff, verdict: "pass", fail_reasons: [] }));
    raw.close();
    expect(s.query({ project_id: "P-1" })[0]!.rounds[0]!.reviewer).toBeNull();
    const ro = openStorageReadonly({ path });
    opened.push(ro);
    expect(ro.query({ project_id: "P-1" })[0]!.rounds[0]!.reviewer).toBeNull();
  });

  it("reviewer 不是字符串或 null 时拒绝写入", () => {
    const s = open();
    s.saveTicket(ticket);
    expect(() =>
      s.savePrRecord({
        ticket_id: "T-1",
        round: 1,
        diff,
        verdict: "pass",
        fail_reasons: [],
        reviewer: 1 as never,
      }),
    ).toThrow(TypeError);
  });
});

describe("listProjects()", () => {
  it("按创建时间排序，写入方和只读连接都有", () => {
    const path = tmpDb();
    const s = open(path);
    expect(s.listProjects()).toEqual([]);
    s.ingest(projectCreated("P-b", "2026-10-17T08:00:00.000Z"));
    s.ingest(projectCreated("P-a", "2026-10-17T09:00:00.000Z"));
    s.ingest(projectCreated("P-c", "2026-10-17T07:00:00.000Z"));
    const want = [
      { project_id: "P-c", name: "P-c", created_at: "2026-10-17T07:00:00.000Z" },
      { project_id: "P-b", name: "P-b", created_at: "2026-10-17T08:00:00.000Z" },
      { project_id: "P-a", name: "P-a", created_at: "2026-10-17T09:00:00.000Z" },
    ];
    expect(s.listProjects()).toEqual(want);
    const ro = openStorageReadonly({ path });
    opened.push(ro);
    expect(ro.listProjects()).toEqual(want);
  });
});
