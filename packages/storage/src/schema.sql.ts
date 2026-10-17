// 表结构。只加表、加列，不改不删（升级时按 user_version 依次执行）。
export const MIGRATIONS: string[] = [
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
];
