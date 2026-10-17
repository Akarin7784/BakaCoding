import type { BakaEvent, Diff, DiffFile } from "@bakacoding/types";
import { FullRedactor, safeZipPath } from "./redaction.js";
import {
  DIAG_SCHEMA,
  type CostSummary,
  type DiagEventFilter,
  type DiagManifest,
  type DiagPackage,
  type DiagStats,
  type DiagTicket,
  type ExportDeps,
  type ExportOptions,
  type ExportScope,
  type RawFile,
  type TicketRecord,
} from "./schema.js";

/** zip 内固定的结构化文件名。 */
export const PACKAGE_FILES = {
  manifest: "manifest.json",
  events: "events.jsonl",
  tickets: "tickets.jsonl",
  costs: "costs.jsonl",
  redaction_report: "redaction_report.json",
} as const;

function validateOptions(opts: ExportOptions): void {
  if (!opts.project_id) throw new Error("project_id 必填：一个包只放一个项目");
  const s = opts.scope;
  if (s.kind === "ticket" && !s.ticket_id) throw new Error("scope.ticket_id 必填");
  if (s.kind === "requirement" && !s.requirement_id) throw new Error("scope.requirement_id 必填");
  if (s.kind === "time_range") {
    const from = Date.parse(s.from);
    const to = Date.parse(s.to);
    if (Number.isNaN(from) || Number.isNaN(to))
      throw new Error("time_range 的 from/to 须为 ISO 时间");
    if (from > to) throw new Error("time_range 的 from 不能晚于 to");
  }
}

function scopeFilter(project_id: string, scope: ExportScope): DiagEventFilter {
  switch (scope.kind) {
    case "ticket":
      return { project_id, ticket_id: scope.ticket_id };
    case "requirement":
      return { project_id, requirement_id: scope.requirement_id };
    case "time_range":
      return { project_id, from: scope.from, to: scope.to };
  }
}

function inRange(ts: string, scope: ExportScope): boolean {
  if (scope.kind !== "time_range") return true;
  const t = Date.parse(ts);
  return t >= Date.parse(scope.from) && t <= Date.parse(scope.to);
}

function eventInScope(e: BakaEvent, project_id: string, scope: ExportScope): boolean {
  const p = e.payload as { project_id?: unknown };
  if (typeof p.project_id === "string" && p.project_id !== project_id) return false;
  if (scope.kind === "ticket") return e.ticket_id === scope.ticket_id;
  if (scope.kind === "requirement") return e.requirement_id === scope.requirement_id;
  return inRange(e.ts, scope);
}

function ticketInScope(t: TicketRecord, project_id: string, scope: ExportScope): boolean {
  if (t.project_id !== project_id) return false;
  if (scope.kind === "ticket") return t.ticket_id === scope.ticket_id;
  if (scope.kind === "requirement") return t.requirement_id === scope.requirement_id;
  return inRange(t.created_at, scope);
}

/** 把 Diff 拼成 git 风格的 unified diff 文本（patch 已带 diff --git 头时原样用）。 */
export function diffToUnified(diff: Diff): string {
  return diff.files.map(fileToUnified).join("");
}

function fileToUnified(f: DiffFile): string {
  const body = f.patch.endsWith("\n") || f.patch === "" ? f.patch : `${f.patch}\n`;
  if (body.startsWith("diff --git ")) return body;
  const a = f.status === "added" ? "/dev/null" : `a/${f.path}`;
  const b = f.status === "deleted" ? "/dev/null" : `b/${f.path}`;
  return `diff --git a/${f.path} b/${f.path}\n--- ${a}\n+++ ${b}\n${body}`;
}

function costsFromEvents(events: BakaEvent[]): Map<string | null, CostSummary> {
  const m = new Map<string | null, CostSummary>();
  for (const e of events) {
    if (e.type !== "call_completed") continue;
    const cur = m.get(e.ticket_id) ?? {
      ticket_id: e.ticket_id,
      total_micro_usd: 0,
      resubmit_micro_usd: 0,
      entries: 0,
    };
    cur.total_micro_usd += e.payload.cost;
    if (e.payload.is_resubmit) cur.resubmit_micro_usd += e.payload.cost;
    cur.entries += 1;
    m.set(e.ticket_id, cur);
  }
  return m;
}

function computeStats(tickets: TicketRecord[]): DiagStats {
  const stats: DiagStats = {
    tickets: tickets.length,
    outcomes: {},
    rounds: 0,
    first_round_pass: 0,
    review_pass_rejected_by_user: 0,
  };
  for (const t of tickets) {
    stats.rounds += t.rounds.length;
    if (t.outcome) stats.outcomes[t.outcome] = (stats.outcomes[t.outcome] ?? 0) + 1;
    const sorted = [...t.rounds].sort((x, y) => x.round - y.round);
    if (sorted[0]?.verdict === "pass") stats.first_round_pass += 1;
    if (t.outcome === "rejected_by_user" && sorted.at(-1)?.verdict === "pass") {
      stats.review_pass_rejected_by_user += 1;
    }
  }
  return stats;
}

class RawFiles {
  readonly files: RawFile[] = [];
  private readonly used = new Set<string>(Object.values(PACKAGE_FILES));
  constructor(private readonly r: FullRedactor) {}

  /** 整条路径（含单号）先脱敏再规整为安全的 zip 内路径；内容也做完整脱敏。返回 zip 内路径。 */
  add(prefix: string, rel: string, content: string): string {
    const base = safeZipPath(this.r.text(`${prefix}/${rel}`));
    let name = base;
    for (let i = 2; this.used.has(name); i++) name = `${base}~${i}`;
    this.used.add(name);
    this.files.push({ path: name, content: this.r.text(content) });
    return name;
  }
}

/**
 * 组装内存中的诊断包：取数、按范围过滤、完整脱敏、统计。所有字符串（含原始文件和路径）都过 redact(…, "full")。
 */
export async function buildPackage(opts: ExportOptions, deps: ExportDeps): Promise<DiagPackage> {
  validateOptions(opts);
  const { project_id, scope } = opts;
  const include_full_repo = opts.include_full_repo === true;
  const filter = scopeFilter(project_id, scope);

  const events = (await deps.source.queryEvents(filter))
    .filter((e) => eventInScope(e, project_id, scope))
    .sort((a, b) => a.seq - b.seq);
  const records = (await deps.source.queryTickets(filter))
    .filter((t) => ticketInScope(t, project_id, scope))
    .sort((a, b) => a.ticket_id.localeCompare(b.ticket_id));

  const r = new FullRedactor();
  const raw = new RawFiles(r);
  const costs = costsFromEvents(events);

  const tickets: DiagTicket[] = records.map((t) => {
    const tid = t.ticket_id;
    const rounds = [...t.rounds]
      .sort((a, b) => a.round - b.round)
      .map((rd) => {
        const diff_file = raw.add(`raw/${tid}`, `r${rd.round}.diff`, diffToUnified(rd.diff));
        // tickets.jsonl 里只留 diff 元数据，patch 正文在 diff_file。
        const diff: Diff = {
          ...rd.diff,
          files: rd.diff.files.map((f) => ({ ...f, patch: "" })),
        };
        return { ...rd, diff, diff_file };
      });
    const context_files = t.context_snippets.map((f) =>
      raw.add(`raw/${tid}/context`, f.path, f.content),
    );
    const evalTask = deps.eval_tasks?.[tid];
    const ticket: DiagTicket = {
      ticket_id: tid,
      requirement_id: t.requirement_id,
      created_at: t.created_at,
      ticket_text: t.ticket_text,
      decomposition_summary: t.decomposition_summary,
      status: t.status,
      outcome: t.outcome,
      base_commit: t.base_commit,
      permission_list: t.permission_list,
      rounds,
      resubmit_count: Math.max(0, rounds.length - 1),
      merge: t.merge,
      ci_checks: t.ci_checks,
      context_files,
      cost: costs.get(tid) ?? {
        ticket_id: tid,
        total_micro_usd: 0,
        resubmit_micro_usd: 0,
        entries: 0,
      },
      marked_for_eval_set: t.marked_for_eval_set,
      eval_task: evalTask,
    };
    return r.deep(ticket);
  });

  if (include_full_repo) {
    if (!deps.source.repoFiles)
      throw new Error("include_full_repo 为 true，但数据源没有 repoFiles");
    for (const f of await deps.source.repoFiles(project_id)) raw.add("repo", f.path, f.content);
  }

  const redactedEvents = events.map((e) => r.deep(e));
  const redactedCosts = [...costs.values()].map((c) => r.deep(c));
  const created_at = (deps.now?.() ?? new Date()).toISOString();
  const manifest: DiagManifest = r.deep({
    schema: DIAG_SCHEMA,
    project_id,
    repo: deps.repo,
    scope,
    include_full_repo,
    created_at,
    redaction: "full" as const,
    files: [...Object.values(PACKAGE_FILES), ...raw.files.map((f) => f.path)],
    stats: computeStats(records),
  });

  return {
    manifest,
    events: redactedEvents,
    tickets,
    costs: redactedCosts,
    redaction_report: r.report(),
    raw_files: raw.files,
  };
}
