// 主进程的只读数据读取：用 better-sqlite3 以只读方式打开模块 2 的库。
// 不走 openStorage：它会抢写入者租约、跑迁移，协调服务在跑时会抛 StorageLeaseError（见 PR 说明）。
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { EventSchema, TicketStatusSchema, type TicketStatus } from "@bakacoding/types";
import {
  UI_EVENT_TYPES,
  type DbStatus,
  type DesktopSnapshot,
  type DesktopUpdate,
  type TicketView,
  type UiEvent,
} from "../shared/api.js";

export interface ReaderOptions {
  path: string;
  /** better-sqlite3 的原生模块路径（Electron ABI 版本，见 rebuild:electron）；不给则用默认。 */
  nativeBinding?: string;
}

export interface EventReader {
  snapshot(): DesktopSnapshot;
  /** 读 last_seq 之后的新事件和需求单变化；没有任何变化时返回 null。 */
  poll(): DesktopUpdate | null;
  close(): void;
}

type Row = Record<string, unknown>;

const TITLE_MAX = 80;

function ticketTitle(text: string): string {
  const first = text.split("\n").find((l) => l.trim() !== "") ?? "";
  return first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX - 1)}…` : first;
}

function toStatus(v: unknown): TicketStatus {
  const r = TicketStatusSchema.safeParse(v);
  return r.success ? r.data : "pending";
}

export function openEventReader(opts: ReaderOptions): EventReader {
  let db: Database.Database | null = null;
  let status: DbStatus = { path: opts.path, state: "missing" };
  let lastSeq = -1;
  let lastTicketsKey = "";

  function ensureOpen(): Database.Database | null {
    if (db) return db;
    if (!existsSync(opts.path)) {
      status = { path: opts.path, state: "missing" };
      return null;
    }
    try {
      db = new Database(opts.path, {
        readonly: true,
        fileMustExist: true,
        ...(opts.nativeBinding ? { nativeBinding: opts.nativeBinding } : {}),
      });
      db.pragma("busy_timeout = 2000");
      status = { path: opts.path, state: "ok" };
      return db;
    } catch (e) {
      status = { path: opts.path, state: "error", message: (e as Error).message };
      db = null;
      return null;
    }
  }

  function hasTable(d: Database.Database, name: string): boolean {
    return !!d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  }

  function hasColumn(d: Database.Database, table: string, column: string): boolean {
    return (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(
      (c) => c.name === column,
    );
  }

  function readEvents(d: Database.Database, afterSeq: number): UiEvent[] {
    if (!hasTable(d, "events")) return [];
    const marks = UI_EVENT_TYPES.map(() => "?").join(", ");
    const rows = d
      .prepare(`SELECT * FROM events WHERE seq > ? AND type IN (${marks}) ORDER BY seq`)
      .all(afterSeq, ...UI_EVENT_TYPES) as Row[];
    const out: UiEvent[] = [];
    for (const row of rows) {
      const payload = JSON.parse(row.payload as string) as Row;
      // call_completed 的完整提示词和输出在 call_log；界面只要输出，提示词不下发。
      if (row.type === "call_completed") {
        const c = hasTable(d, "call_log")
          ? (d
              .prepare("SELECT output, summary FROM call_log WHERE event_id = ?")
              .get(row.event_id) as { output: string | null; summary: string } | undefined)
          : undefined;
        payload.prompt = "";
        payload.output = c?.output ?? c?.summary ?? "";
      }
      const parsed = EventSchema.safeParse({
        event_id: row.event_id,
        seq: row.seq,
        type: row.type,
        ts: row.ts,
        trace_id: row.trace_id,
        span_id: row.span_id,
        parent_span_id: row.parent_span_id,
        requirement_id: row.requirement_id,
        ticket_id: row.ticket_id,
        payload,
      });
      // 不符合 schema 的行跳过，不让一条坏数据挡住整个界面。
      if (parsed.success) out.push(parsed.data as UiEvent);
      lastSeq = Math.max(lastSeq, row.seq as number);
    }
    return out;
  }

  function readTickets(d: Database.Database): TicketView[] {
    if (!hasTable(d, "tickets")) return [];
    const rounds = hasTable(d, "pr_rounds")
      ? "(SELECT COUNT(*) FROM pr_rounds r WHERE r.ticket_id = t.ticket_id)"
      : "0";
    // 存储 v2（T-022）起有毫秒列，按它排序；旧库退回按文本排序。
    const order = hasColumn(d, "tickets", "created_at_ms") ? "t.created_at_ms" : "t.created_at";
    const rows = d
      .prepare(
        `SELECT t.ticket_id, t.project_id, t.requirement_id, t.created_at, t.ticket_text, t.status,
           ${rounds} AS rounds FROM tickets t ORDER BY ${order}, t.ticket_id`,
      )
      .all() as Row[];
    return rows.map((r) => ({
      ticket_id: r.ticket_id as string,
      project_id: r.project_id as string,
      requirement_id: r.requirement_id as string,
      created_at: r.created_at as string,
      title: ticketTitle(r.ticket_text as string),
      status: toStatus(r.status),
      resubmit_count: Math.max(0, (r.rounds as number) - 1),
    }));
  }

  return {
    snapshot() {
      lastSeq = -1;
      const d = ensureOpen();
      if (!d) {
        lastTicketsKey = "[]";
        return { db: status, events: [], tickets: [], last_seq: lastSeq };
      }
      const events = readEvents(d, -1);
      const tickets = readTickets(d);
      lastTicketsKey = JSON.stringify(tickets);
      return { db: status, events, tickets, last_seq: lastSeq };
    },
    poll() {
      const before = status.state;
      const d = ensureOpen();
      if (!d) return before === status.state ? null : { db: status, events: [], last_seq: lastSeq };
      const events = readEvents(d, lastSeq);
      const tickets = readTickets(d);
      const key = JSON.stringify(tickets);
      const ticketsChanged = key !== lastTicketsKey;
      lastTicketsKey = key;
      if (events.length === 0 && !ticketsChanged && before === status.state) return null;
      return { db: status, events, ...(ticketsChanged ? { tickets } : {}), last_seq: lastSeq };
    },
    close() {
      db?.close();
      db = null;
    },
  };
}
