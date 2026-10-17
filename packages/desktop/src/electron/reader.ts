// 主进程的只读数据读取：用模块 2 的 openStorageReadonly 打开库（T-027）。
// 不拿写入者租约、不跑迁移，协调服务在写的时候也能读；读方法全部走存储的公共 API，不手写 SQL。
import { existsSync } from "node:fs";
import {
  openStorageReadonly,
  StorageVersionError,
  type ReadonlyStorage,
} from "@bakacoding/storage";
import {
  EventSchema,
  TicketStatusSchema,
  type BakaEvent,
  type TicketStatus,
} from "@bakacoding/types";
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
  /** 测试用：替换打开函数。 */
  open?: typeof openStorageReadonly;
}

export interface EventReader {
  snapshot(): DesktopSnapshot;
  /** 读 last_seq 之后的新事件和需求单变化；没有任何变化时返回 null。 */
  poll(): DesktopUpdate | null;
  close(): void;
}

const TITLE_MAX = 80;

function ticketTitle(text: string): string {
  const first = text.split("\n").find((l) => l.trim() !== "") ?? "";
  return first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX - 1)}…` : first;
}

function toStatus(v: unknown): TicketStatus {
  const r = TicketStatusSchema.safeParse(v);
  return r.success ? r.data : "pending";
}

/** 打不开或读失败时给界面看的说明。 */
function describeError(e: unknown): string {
  if (e instanceof StorageVersionError) return e.message;
  const msg = e instanceof Error ? e.message : String(e);
  if (/NODE_MODULE_VERSION|was compiled against a different Node\.js version/.test(msg)) {
    return `better-sqlite3 原生模块和 Electron 版本不匹配，请先运行 pnpm --filter @bakacoding/desktop rebuild:electron（${msg}）`;
  }
  return msg;
}

/** 从事件里认出项目：project_created，以及带 project_id 的群消息。 */
function projectOf(e: BakaEvent): string | undefined {
  if (e.type === "project_created" || e.type === "group_message") return e.payload.project_id;
  return undefined;
}

export function openEventReader(opts: ReaderOptions): EventReader {
  const open = opts.open ?? openStorageReadonly;
  let store: ReadonlyStorage | null = null;
  let status: DbStatus = { path: opts.path, state: "missing" };
  /** 已下发的最大 seq（界面契约里的 last_seq）。 */
  let lastSeq = -1;
  /** 已读过的库内最大 seq（含界面不关心的事件），按 maxSeq() 判断有没有新事件。 */
  let seenSeq = -1;
  let lastTicketsKey = "";
  /** 存储按项目查需求单，没有「列出全部项目」的读方法，项目 id 从事件里收集。 */
  const projects = new Set<string>();

  function reset(): void {
    store?.close();
    store = null;
    lastSeq = -1;
    seenSeq = -1;
    projects.clear();
  }

  function ensureOpen(): ReadonlyStorage | null {
    if (store) return store;
    if (!existsSync(opts.path)) {
      status = { path: opts.path, state: "missing" };
      return null;
    }
    try {
      store = open({
        path: opts.path,
        ...(opts.nativeBinding ? { nativeBinding: opts.nativeBinding } : {}),
      });
      status = { path: opts.path, state: "ok" };
      return store;
    } catch (e) {
      status = { path: opts.path, state: "error", message: describeError(e) };
      store = null;
      return null;
    }
  }

  function readEvents(s: ReadonlyStorage): UiEvent[] {
    const max = s.maxSeq();
    if (max === null || max <= seenSeq) return [];
    // 项目 id 要从全部 project_created / group_message 里收，和下发的类型一致，一次查完。
    const rows = s.queryEvents({ after_seq: seenSeq, types: [...UI_EVENT_TYPES] });
    seenSeq = Math.max(max, ...rows.map((r) => r.seq));
    const out: UiEvent[] = [];
    for (const row of rows) {
      const project = projectOf(row);
      if (project) projects.add(project);
      // 完整提示词不下发给界面，输出照存储给的（过期后是摘要）。
      const e =
        row.type === "call_completed" ? { ...row, payload: { ...row.payload, prompt: "" } } : row;
      const parsed = EventSchema.safeParse(e);
      // 不符合 schema 的行跳过，不让一条坏数据挡住整个界面。
      if (parsed.success) out.push(parsed.data as UiEvent);
      lastSeq = Math.max(lastSeq, row.seq);
    }
    return out;
  }

  function readTickets(s: ReadonlyStorage): TicketView[] {
    const all: TicketView[] = [];
    for (const project_id of projects) {
      for (const t of s.query({ project_id })) {
        all.push({
          ticket_id: t.ticket_id,
          project_id: t.project_id,
          requirement_id: t.requirement_id,
          created_at: t.created_at,
          title: ticketTitle(t.ticket_text),
          status: toStatus(t.status),
          resubmit_count: Math.max(0, t.rounds.length - 1),
        });
      }
    }
    // 各项目内已按 created_at_ms 排好；跨项目再按毫秒时间排一次。
    const ms = (iso: string) => Date.parse(iso);
    return all.sort(
      (a, b) => ms(a.created_at) - ms(b.created_at) || a.ticket_id.localeCompare(b.ticket_id),
    );
  }

  /** 读一次；读失败（库被删、被升级到更新版本等）时关掉连接，标 error，下次轮询重开。 */
  function read(): { events: UiEvent[]; tickets: TicketView[] } | null {
    const s = ensureOpen();
    if (!s) return null;
    try {
      const events = readEvents(s);
      return { events, tickets: readTickets(s) };
    } catch (e) {
      reset();
      status = { path: opts.path, state: "error", message: describeError(e) };
      return null;
    }
  }

  return {
    snapshot() {
      reset();
      const r = read();
      const tickets = r?.tickets ?? [];
      lastTicketsKey = JSON.stringify(tickets);
      return { db: status, events: r?.events ?? [], tickets, last_seq: lastSeq };
    },
    poll() {
      const before = JSON.stringify(status);
      const r = read();
      const statusChanged = JSON.stringify(status) !== before;
      if (!r) return statusChanged ? { db: status, events: [], last_seq: lastSeq } : null;
      // 重新打开（库刚建好或从错误恢复）时补发全部事件和需求单，界面按 event_id 去重。
      const key = JSON.stringify(r.tickets);
      const ticketsChanged = key !== lastTicketsKey || statusChanged;
      lastTicketsKey = key;
      if (r.events.length === 0 && !ticketsChanged && !statusChanged) return null;
      return {
        db: status,
        events: r.events,
        ...(ticketsChanged ? { tickets: r.tickets } : {}),
        last_seq: lastSeq,
      };
    },
    close() {
      store?.close();
      store = null;
    },
  };
}
