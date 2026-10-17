// T-011 存储层补充：listPrRounds(ticket_id)。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openStorage, openStorageReadonly } from "./index.js";

let dirs: string[] = [];
let opened: Array<{ close(): void }> = [];
afterEach(() => {
  for (const s of opened) s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  opened = [];
});
function tmpDb(): string {
  const d = mkdtempSync(join(tmpdir(), "bc-storage-011-"));
  dirs.push(d);
  return join(d, "bakacoding.db");
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

describe("listPrRounds", () => {
  it("按轮次升序返回全部轮次；写入顺序乱也一样；单不存在返回空数组", () => {
    const path = tmpDb();
    const s = openStorage({ path });
    opened.push(s);
    s.saveTicket(ticket);
    for (const round of [3, 1, 2]) {
      s.savePrRecord({
        ticket_id: "T-1",
        round,
        diff,
        verdict: round === 3 ? "pass" : "fail",
        fail_reasons: [],
        reviewer: "member-glm",
      });
    }
    expect(s.listPrRounds("T-1").map((r) => r.round)).toEqual([1, 2, 3]);
    expect(s.listPrRounds("T-1")[2]!.verdict).toBe("pass");
    expect(s.listPrRounds("T-404")).toEqual([]);
    expect(s.listPrRounds("T-1")).toEqual(s.query({ project_id: "P-1" })[0]!.rounds);
  });

  it("只读连接同样可用；旧记录缺 reviewer 读成 null", () => {
    const path = tmpDb();
    const s = openStorage({ path });
    opened.push(s);
    s.saveTicket(ticket);
    s.savePrRecord({ ticket_id: "T-1", round: 1, diff, verdict: "pass", fail_reasons: [] });
    const raw = new Database(path);
    raw
      .prepare("UPDATE pr_rounds SET record = ? WHERE ticket_id = 'T-1'")
      .run(JSON.stringify({ round: 1, diff, verdict: "pass", fail_reasons: [] }));
    raw.close();
    expect(s.listPrRounds("T-1")[0]!.reviewer).toBeNull();
    const ro = openStorageReadonly({ path });
    opened.push(ro);
    expect(ro.listPrRounds("T-1").map((r) => [r.round, r.reviewer])).toEqual([[1, null]]);
  });
});
