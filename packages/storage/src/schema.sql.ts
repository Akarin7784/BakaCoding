import type Database from "better-sqlite3";

/** 一步升级：一段 SQL，或需要在 JS 里回填数据时用函数。在同一个事务里执行。 */
export type Migration = string | ((db: Database.Database) => void);

/** 把 ISO 时间转成 UTC 毫秒数；解析不了返回 null。 */
export function isoToMs(ts: string): number | null {
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
}

// 时间列存一份毫秒数（*_ms），比较和排序都用它：ISO 文本带不带毫秒按文本比会排错（T-022 a）。
const TS_MS_COLUMNS: [table: string, text_col: string, ms_col: string][] = [
  ["events", "ts", "ts_ms"],
  ["call_log", "ts", "ts_ms"],
  ["backlog_metrics", "ts", "ts_ms"],
  ["tickets", "created_at", "created_at_ms"],
  ["decisions", "ts", "ts_ms"],
];

// 表结构。只加表、加列、加索引，不改不删数据（升级时按 user_version 依次执行）。
export const MIGRATIONS: Migration[] = [
  /* v1 */ `
  CREATE TABLE lease (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    owner TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE events (
    event_id TEXT PRIMARY KEY,
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    ts TEXT NOT NULL,
    trace_id TEXT NOT NULL,
    span_id TEXT NOT NULL,
    parent_span_id TEXT,
    requirement_id TEXT,
    ticket_id TEXT,
    project_id TEXT,
    payload TEXT NOT NULL
  );
  CREATE INDEX events_seq ON events(seq);
  CREATE INDEX events_requirement ON events(requirement_id);
  CREATE INDEX events_ticket ON events(ticket_id);
  CREATE INDEX events_trace ON events(trace_id);
  CREATE INDEX events_ts ON events(ts);

  CREATE TABLE call_log (
    event_id TEXT PRIMARY KEY,
    ts TEXT NOT NULL,
    requirement_id TEXT NOT NULL,
    ticket_id TEXT,
    role TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    effort TEXT NOT NULL,
    prompt TEXT,
    output TEXT,
    prompt_chars INTEGER NOT NULL,
    output_chars INTEGER NOT NULL,
    summary TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cache_hit_input_tokens INTEGER NOT NULL,
    cache_hit INTEGER NOT NULL,
    latency_ms INTEGER NOT NULL,
    cost INTEGER NOT NULL,
    is_resubmit INTEGER NOT NULL,
    rate_limited_retry INTEGER NOT NULL,
    purged_at TEXT
  );
  CREATE INDEX call_log_ts ON call_log(ts);
  CREATE INDEX call_log_ticket ON call_log(ticket_id);

  CREATE TABLE projects (
    project_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    language TEXT NOT NULL,
    has_github_remote INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE groups (
    project_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    created_by_event TEXT NOT NULL
  );

  CREATE TABLE requirements (
    requirement_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL
  );

  CREATE TABLE group_messages (
    event_id TEXT PRIMARY KEY,
    seq INTEGER NOT NULL,
    ts TEXT NOT NULL,
    project_id TEXT NOT NULL,
    requirement_id TEXT NOT NULL,
    ticket_id TEXT,
    sender TEXT NOT NULL,
    kind TEXT NOT NULL,
    content TEXT NOT NULL,
    flash_calls TEXT NOT NULL
  );
  CREATE INDEX group_messages_project ON group_messages(project_id, seq);

  CREATE TABLE backlog_metrics (
    event_id TEXT PRIMARY KEY,
    ts TEXT NOT NULL,
    kind TEXT NOT NULL,
    pending INTEGER NOT NULL,
    capacity INTEGER NOT NULL
  );
  CREATE INDEX backlog_metrics_kind_ts ON backlog_metrics(kind, ts);

  CREATE TABLE tickets (
    ticket_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    requirement_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    ticket_text TEXT NOT NULL,
    decomposition_summary TEXT,
    status TEXT,
    outcome TEXT,
    base_commit TEXT NOT NULL,
    permission_list TEXT NOT NULL,
    context_snippets TEXT NOT NULL,
    ci_checks TEXT
  );
  CREATE INDEX tickets_project ON tickets(project_id);
  CREATE INDEX tickets_requirement ON tickets(requirement_id);

  CREATE TABLE pr_rounds (
    ticket_id TEXT NOT NULL,
    round INTEGER NOT NULL,
    record TEXT NOT NULL,
    saved_at TEXT NOT NULL,
    PRIMARY KEY (ticket_id, round)
  );

  CREATE TABLE pr_records (
    pr_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    record TEXT NOT NULL,
    saved_at TEXT NOT NULL
  );

  CREATE TABLE merge_results (
    ticket_id TEXT PRIMARY KEY,
    result TEXT NOT NULL,
    saved_at TEXT NOT NULL
  );

  CREATE TABLE decisions (
    decision_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    content TEXT NOT NULL
  );
  CREATE INDEX decisions_project ON decisions(project_id, ts);

  CREATE TABLE eval_set (
    ticket_id TEXT PRIMARY KEY,
    marked_at TEXT NOT NULL
  );

  CREATE TABLE ledger (
    entry_id TEXT PRIMARY KEY,
    ts TEXT NOT NULL,
    day TEXT NOT NULL,
    requirement_id TEXT NOT NULL,
    ticket_id TEXT,
    role TEXT NOT NULL,
    cost_micro_usd INTEGER NOT NULL,
    is_resubmit INTEGER NOT NULL,
    cache_hit INTEGER NOT NULL,
    offpeak INTEGER NOT NULL
  );
  CREATE INDEX ledger_day ON ledger(day);
  CREATE INDEX ledger_ticket ON ledger(ticket_id);
  `,
  /* v2（T-022）：毫秒时间列并回填；events.seq 唯一 */
  (db) => {
    for (const [table, textCol, msCol] of TS_MS_COLUMNS) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${msCol} INTEGER`);
      const rows = db.prepare(`SELECT rowid AS id, ${textCol} AS t FROM ${table}`).all() as {
        id: number;
        t: string;
      }[];
      const upd = db.prepare(`UPDATE ${table} SET ${msCol} = ? WHERE rowid = ?`);
      for (const r of rows) upd.run(isoToMs(r.t), r.id);
      db.exec(`CREATE INDEX ${table}_${msCol} ON ${table}(${msCol})`);
    }
    // 旧库里如果已经有重复 seq，这里会失败，升级中止、库保持 v1，不会悄悄丢数据
    db.exec("DROP INDEX IF EXISTS events_seq");
    db.exec("CREATE UNIQUE INDEX events_seq_unique ON events(seq)");
  },
];
