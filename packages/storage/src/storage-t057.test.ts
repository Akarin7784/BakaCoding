// T-057：同一单号的 fields 损坏只警告一次（每个连接各自计）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openStorage, openStorageReadonly, type TicketInput } from "./index.js";

let dirs: string[] = [];
let opened: Array<{ close(): void }> = [];
afterEach(() => {
  for (const s of opened) s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  opened = [];
});
function tmpDb(): string {
  const d = mkdtempSync(join(tmpdir(), "bc-storage-057-"));
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
  fields: { write_scope: ["src/**"] },
};
function corrupt(path: string, ticket_id: string, raw: string): void {
  const db = new Database(path);
  db.prepare("UPDATE tickets SET fields = ? WHERE ticket_id = ?").run(raw, ticket_id);
  db.close();
}

describe("fields 损坏只警告一次（T-057）", () => {
  it("同一单号反复 getTicket / listTickets 只记一条；不同单号各记一条", () => {
    const path = tmpDb();
    const warns: string[] = [];
    const s = openStorage({ path, logger: { warn: (m) => warns.push(m) } });
    opened.push(s);
    s.saveTicket(base);
    s.saveTicket({ ...base, ticket_id: "R-1-2" });
    s.saveTicket({ ...base, ticket_id: "R-1-3" });
    corrupt(path, "R-1-1", "{bad");
    corrupt(path, "R-1-2", "[1,2]");
    for (let i = 0; i < 3; i++) {
      expect(s.getTicket("R-1-1")!.fields).toBeNull();
      expect(s.listTickets().map((t) => t.fields)).toEqual([
        null,
        null,
        { write_scope: ["src/**"] },
      ]);
    }
    expect(warns).toHaveLength(2);
    expect(warns.some((w) => w.includes("R-1-1") && w.includes("不是合法 JSON"))).toBe(true);
    expect(warns.some((w) => w.includes("R-1-2") && w.includes("不是对象"))).toBe(true);
  });

  it("同一单号损坏方式变了也不再重复警告；每个连接各自警告一次", () => {
    const path = tmpDb();
    const warns: string[] = [];
    const s = openStorage({ path, logger: { warn: (m) => warns.push(m) } });
    opened.push(s);
    s.saveTicket(base);
    corrupt(path, "R-1-1", "{bad");
    s.getTicket("R-1-1");
    corrupt(path, "R-1-1", "42");
    s.getTicket("R-1-1");
    expect(warns).toHaveLength(1);
    const roWarns: string[] = [];
    const ro = openStorageReadonly({ path, logger: { warn: (m) => roWarns.push(m) } });
    opened.push(ro);
    ro.getTicket("R-1-1");
    ro.listTickets();
    expect(roWarns).toHaveLength(1);
  });

  it("修好后读到正常值会清掉记录，再坏还会再警告（T-058 顺手补）", () => {
    const path = tmpDb();
    const warns: string[] = [];
    const s = openStorage({ path, logger: { warn: (m) => warns.push(m) } });
    opened.push(s);
    s.saveTicket(base);
    corrupt(path, "R-1-1", "{bad");
    s.getTicket("R-1-1");
    corrupt(path, "R-1-1", JSON.stringify({ write_scope: ["a/**"] }));
    expect(s.getTicket("R-1-1")!.fields).toEqual({ write_scope: ["a/**"] });
    corrupt(path, "R-1-1", "{bad again");
    s.getTicket("R-1-1");
    expect(warns).toHaveLength(2);
  });

  it("logger.warn 抛错时读取照常返回，不抛错（T-058 顺手补）", () => {
    const path = tmpDb();
    const s = openStorage({
      path,
      logger: {
        warn: () => {
          throw new Error("logger 坏了");
        },
      },
    });
    opened.push(s);
    s.saveTicket(base);
    corrupt(path, "R-1-1", "{bad");
    expect(s.getTicket("R-1-1")!.fields).toBeNull();
    expect(s.listTickets()).toHaveLength(1);
  });
});
