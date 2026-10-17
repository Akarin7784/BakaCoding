// 模块 2：存储与事件日志。SQLite（WAL），单一写入者租约，幂等键，重启可恢复。
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { redact as redactText } from "@bakacoding/config-budget";
import {
  EventSchema,
  LedgerEntrySchema,
  ROLES,
  type BakaEvent,
  type CiCheck,
  type DiagEventFilter,
  type DiagMergeResult,
  type DiagnosticsSource,
  type EventType,
  type LedgerEntry,
  type LedgerStore,
  type LedgerBreakdown,
  type LedgerTotals,
  type OutcomeLabel,
  type PermissionList,
  type RawFile,
  type Role,
  type RoundRecord,
  type TicketRecord,
  type TicketStatus,
} from "@bakacoding/types";
import { isoToMs, MIGRATIONS } from "./schema.sql.js";

export interface StorageOptions {
  /** 数据库文件路径；测试可用 ":memory:"。 */
  path: string;
  /** 完整提示词和输出的保留天数，取配置 `diagnostics.retention_days`，默认 30。 */
  retention_days?: number;
  /** 落库前的轻脱敏，默认用模块 3 的 `redact(text, "light")`。 */
  redact?: (text: string) => string;
  /** 写入者标识，默认随机 UUID。 */
  owner?: string;
  /** 租约有效期，默认 30 秒；持有期间每 1/3 有效期自动续一次。 */
  lease_ttl_ms?: number;
  /** 测试用：注入时间。 */
  now?: () => Date;
  /**
   * better-sqlite3 原生模块路径（`better_sqlite3.node`）。桌面端在 Electron 里用按 Electron ABI 编译的那份，
   * 见 `packages/desktop/scripts/rebuild-electron.mjs`；不传则用 Node 默认的那份。
   */
  nativeBinding?: string;
  /** 警告输出（T-055：需求单 `fields` 读出损坏时记一条），默认 `console.warn`。 */
  logger?: { warn(message: string): void };
}

/** 另一个写入者持有未过期的租约，或本进程的租约已被别人接管。 */
export class StorageLeaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageLeaseError";
  }
}

/** 只读打开的存储上调用了写方法。 */
export class StorageReadonlyError extends Error {
  constructor(method: string) {
    super(`存储以只读方式打开，不能调用写方法 ${method}`);
    this.name = "StorageReadonlyError";
  }
}

/** 只读打开时库的版本和当前代码不一致。 */
export class StorageVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageVersionError";
  }
}

/** queryEvents 的过滤条件，全部可选；from / to 为 ISO 时间，两端都包含。 */
export interface EventFilter {
  project_id?: string;
  requirement_id?: string;
  ticket_id?: string;
  trace_id?: string;
  types?: EventType[];
  from?: string;
  to?: string;
  /** 只要 seq 大于它的事件（增量读取）。 */
  after_seq?: number;
  limit?: number;
}

/** 新建或更新一张需求单的基本信息（基线 commit 与上下文包）。 */
export interface TicketInput {
  ticket_id: string;
  project_id: string;
  requirement_id: string;
  created_at: string;
  ticket_text: string;
  decomposition_summary?: string;
  status?: TicketStatus;
  outcome?: OutcomeLabel;
  base_commit: string;
  permission_list: PermissionList;
  context_snippets: RawFile[];
  ci_checks?: CiCheck[];
  /**
   * 结构化字段（T-055）：`write_scope`、`interfaces`、`depends_on`、`priority`、`kind`、`origin`、trace 等，
   * 字段由调用方（10）定义，2 只按 JSON 原样存取、不脱敏。必须是能 JSON 往返的普通对象。
   * 不传时保留库里已有的值（8 回写权限清单时不带它，不会把它冲掉）；传 `{}` 才清空。
   */
  fields?: TicketFields;
}

/** 需求单结构化字段：能 JSON 往返的普通对象。 */
export type TicketFields = { [key: string]: JsonValue };
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** getTicket / listTickets 读出的一行（不含 PR 轮次，轮次用 listPrRounds）。 */
export interface StoredTicket {
  ticket_id: string;
  project_id: string;
  requirement_id: string;
  created_at: string;
  ticket_text: string;
  decomposition_summary?: string;
  status?: TicketStatus;
  outcome?: OutcomeLabel;
  base_commit: string;
  permission_list: PermissionList;
  context_snippets: RawFile[];
  ci_checks?: CiCheck[];
  /** 旧记录（T-055 之前写入）或从没存过时为 null */
  fields: TicketFields | null;
}

/** listTickets 的过滤条件，全部可选；结果按 created_at、ticket_id 升序。 */
export interface TicketFilter {
  project_id?: string;
  requirement_id?: string;
  status?: TicketStatus;
}

/** savePrRecord 的入参：一轮 PR 记录。同一单同一轮重复保存会覆盖（幂等）。 */
export interface PrRoundInput extends RoundRecord {
  ticket_id: string;
}

/** listProjects 的一行：`created_at` 为「项目已创建」事件里的 ISO 时间。 */
export interface ProjectRow {
  project_id: string;
  /** 项目名（「项目已创建」事件里的 name，T-055 起返回） */
  name: string;
  created_at: string;
}

export interface Decision {
  decision_id: string;
  project_id: string;
  ts: string;
  content: string;
}

export interface GroupMessageRow {
  event_id: string;
  seq: number;
  ts: string;
  project_id: string;
  requirement_id: string;
  ticket_id: string | null;
  sender: "supervisor" | "sub_agent";
  kind: string;
  content: string;
  flash_calls: string[];
}

export interface BacklogMetric {
  ts: string;
  pending: number;
  capacity: number;
}

export interface PurgeResult {
  /** 本次清掉完整提示词和输出的调用条数。 */
  purged_calls: number;
}

/** 从总线落库失败的一条记录。 */
export interface IngestFailure {
  event_id: string;
  type: string;
  seq: number;
  error: Error;
}

export interface AttachOptions {
  /** 从总线落库失败时调用，默认 `console.error`。失败同时计入 `health()`。 */
  onError?: (failure: IngestFailure) => void;
}

/** 存储当前状态，界面和主管据此发现落库失败（T-022 c）。 */
export interface StorageHealth {
  /** 没有落库失败、租约还在手里、库没关。 */
  ok: boolean;
  /** 租约丢了（续租失败或写入时发现被接管）；之后所有写入都会失败。 */
  lease_lost: boolean;
  closed: boolean;
  /** 从总线落库失败的累计次数。 */
  ingest_failures: number;
  /** 最近一次落库失败。 */
  last_failure?: { event_id: string; type: string; seq: number; message: string; at: string };
}

/** 同一个 seq 已被另一条事件占用（`events.seq` 唯一）。 */
export class StorageSeqConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageSeqConflictError";
  }
}

/** 模块 6 允许的 PR 记录类型。 */
export const PR_RECORD_KINDS = ["ticket", "integration"] as const;

/** 带 scheme 的 URL（`https://`、`ssh://` 等）；SSH 简写 `git@host:o/r.git` 和路径不算。 */
const SCHEME_URL = /^[a-z][a-z0-9+.-]*:\/\//i;
/** 嵌在文字里的带 scheme 的 URL，逐个检查。 */
const EMBEDDED_URL = /[a-z][a-z0-9+.-]{0,31}:\/\/[^\s"'<>]+/gi;
/** 解析失败时的保守兜底（T-058 之前的规则）：`scheme://` 后面紧跟 `xxx@` 就当带凭据。 */
const LEGACY_CREDENTIAL_URL = /^[a-z][a-z0-9+.-]*:\/\/[^/\s@]+@/i;
/** `hasEmbeddedUserinfoPassword` 里找 `scheme:` 的起点：前面不能紧挨着 scheme 字符，每段只匹配一次。 */
const EMBEDDED_SCHEME = /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:/gi;
const USERINFO_STOP = /[\s/\\@]/;

/**
 * 整个字符串里任何位置出现 `scheme:` 后接 `user:pass@`（斜杠、反斜杠可有可无、个数不限）都算，
 * 用来拦 `https:/\user:tok@h`、`https:user:tok@h`、嵌在文字里的 URL 这类 URL 解析器认不全的写法。
 * 线性扫描，不设长度上限（#58 评审：限长的正则会漏掉超长用户名或密码）。
 */
function hasEmbeddedUserinfoPassword(v: string): boolean {
  if (!v.includes("@")) return false;
  const n = v.length;
  // stop[i]：从 i 起第一个空白、斜杠、反斜杠或 @ 的位置。
  const stop = new Int32Array(n + 1);
  stop[n] = n;
  for (let i = n - 1; i >= 0; i--) stop[i] = USERINFO_STOP.test(v[i]!) ? i : stop[i + 1]!;
  for (const m of v.matchAll(EMBEDDED_SCHEME)) {
    let q = m.index + m[0].length;
    while (q < n && (v[q] === "/" || v[q] === "\\")) q++;
    const e = stop[q]!;
    if (v[e] !== "@") continue;
    const c = v.indexOf(":", q);
    if (c > q && c < e) return true;
  }
  return false;
}
/** 用户名本身像 token（任何 scheme 都查，如 `https://ghp_xxx@`、`ssh://ghp_xxx@`）。 */
const TOKEN_LIKE_USER =
  /^(gh[pousr]_|github_pat_|glpat-|xox[abposr]-|sk-|x-access-token$|oauth2$)/i;
/** http(s) 只放行这种普通用户名（GitHub 用户名规则的宽松版）。 */
const PLAIN_WEB_USER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,38}$/;
/** 20 个字符及以上、全是十六进制或全是 base64 字符的用户名，当作没有前缀的 token。 */
const HEX_ONLY = /^[0-9a-f]+$/i;
const BASE64_ONLY = /^[A-Za-z0-9+/=_-]+$/;
/** 查询参数名像凭据（值非空时整条拒写）。 */
const CREDENTIAL_QUERY_KEY =
  /^(access[_-]?token|token|private[_-]?token|auth[_-]?token|id[_-]?token|refresh[_-]?token|api[_-]?key|apikey|key|secret|client[_-]?secret|password|passwd|pwd|auth|sig|signature|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential)$/i;

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 一组 `k=v` 参数里有没有像凭据的键且值非空；键末尾的 `[]` / `[0]` 先去掉。 */
function hasCredentialParam(params: URLSearchParams): boolean {
  for (const [k, val] of params) {
    const key = k.replace(/(\[[^\]]*\])+$/, "");
    if (val !== "" && CREDENTIAL_QUERY_KEY.test(key)) return true;
  }
  return false;
}

/** 单个带 scheme 的 URL 是否带凭据。 */
function isCredentialSingleUrl(v: string): boolean {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return LEGACY_CREDENTIAL_URL.test(v);
  }
  if (u.password !== "") return true;
  if (u.username !== "") {
    const raw = u.username;
    const user = safeDecode(raw);
    if (user.includes(":")) return true;
    if (TOKEN_LIKE_USER.test(user)) return true;
    if (user.length >= 20 && (HEX_ONLY.test(user) || BASE64_ONLY.test(user))) return true;
    const web = u.protocol === "http:" || u.protocol === "https:";
    if (web && !PLAIN_WEB_USER.test(raw)) return true;
  }
  if (hasCredentialParam(u.searchParams)) return true;
  if (u.hash.length > 1) {
    const frag = u.hash.slice(1);
    if (hasCredentialParam(new URLSearchParams(frag))) return true;
    const q = frag.indexOf("?");
    if (q >= 0 && hasCredentialParam(new URLSearchParams(frag.slice(q + 1)))) return true;
  }
  return false;
}

/**
 * T-058：判断一个字符串是不是（或里面有没有）「带凭据的 URL」。宁可误拒，不能漏放。
 * - 先 trim；整个字符串里任何位置出现 `scheme:` 后接 `user:pass@` 都算。
 * - 字符串本身和嵌在里面的每个 `scheme://…` 逐个检查：
 *   - userinfo 里有密码，或解码后的用户名里有 `:`（`%3A`）算；
 *   - 用户名像 token（`ghp_…`、`github_pat_…`、`glpat-…`、`x-access-token`、`oauth2` 等，任何 scheme）算；
 *   - 用户名 20 个字符及以上且全是十六进制或全是 base64 字符算；
 *   - http(s) 的用户名不符合 `^[A-Za-z0-9][A-Za-z0-9._-]{0,38}$` 算；`https://eva@`、`ssh://git@` 放行；
 *   - 查询参数或 `#` 后面的参数里有 `token` / `access_token` / `api_key` / `sig` 等且值非空算，键末尾的 `[]` 先去掉。
 * - SSH 简写（`git@github.com:o/r.git`）和本地路径不算；URL 解析不了的按旧规则保守判断。
 */
function isCredentialUrl(input: string): boolean {
  const v = input.trim();
  // 全文搜索都是线性的：userinfo 检查是线性扫描，嵌入 URL 的 scheme 限长（#58 评审）。
  if (hasEmbeddedUserinfoPassword(v)) return true;
  if (SCHEME_URL.test(v) && isCredentialSingleUrl(v)) return true;
  if (v.includes("://")) {
    for (const m of v.matchAll(EMBEDDED_URL)) {
      if (isCredentialSingleUrl(m[0])) return true;
    }
  }
  return false;
}

function isStructuralPrField(k: string): boolean {
  return PR_STRUCTURAL_FIELDS.has(k) || k.endsWith("_ts") || k.endsWith("_at");
}

/** 返回第一个「带凭据的 URL」所在路径（规则见 `isCredentialUrl`）。 */
function findCredentialUrl(v: unknown, path: string): string | undefined {
  if (typeof v === "string") return isCredentialUrl(v) ? path : undefined;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const r = findCredentialUrl(v[i], `${path}[${i}]`);
      if (r) return r;
    }
  } else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      const r = findCredentialUrl(x, `${path}.${k}`);
      if (r) return r;
    }
  }
  return undefined;
}

/** prStore 原样保留、不做脱敏的结构字段（另加所有 *_ts / *_at 时间字段）；其余字段按自由文本轻脱敏。 */
export const PR_STRUCTURAL_FIELDS: ReadonlySet<string> = new Set([
  "pr_id",
  "kind",
  "ticket_id",
  "branch",
  "base_branch",
  "base_sha",
  "head_sha",
  "status",
  "merged_into",
  "merge_sha",
  "number",
  "created_ts",
  "updated_ts",
  "worktree_path",
  "repo_path",
  "remote",
  "closed_by",
]);

export interface BusLike {
  subscribe(type: "*", handler: (event: BakaEvent) => void | Promise<void>): () => void;
}

/**
 * 模块 6 的 PR 记录（`PrRecord`）。这里只按结构约定 `pr_id` 和 `kind`，不依赖模块 6 的包；
 * `prStore()` 的返回值在结构上满足模块 6 的 `PrStore`。
 */
export interface PrRecordLike {
  pr_id: string;
  kind: string;
}

/** 模块 6 `PrStore` 的结构等价接口。 */
export interface PrRecordStore<T extends PrRecordLike> {
  get(pr_id: string): Promise<T | undefined>;
  put(record: T): Promise<void>;
  list(): Promise<T[]>;
}

export interface Storage {
  /** 写入一条事件（幂等：同一 event_id 只记一次）。attach 时由总线调用。 */
  ingest(event: BakaEvent): void;
  /** 给模块 6 注入的 PR 记录存储；`kind` 单独成列并原样存回，缺 `kind` 的记录拒绝写入。 */
  prStore<T extends PrRecordLike>(): PrRecordStore<T>;
  /** 用 "*" 订阅总线全部事件落库，返回取消订阅函数。 */
  attach(bus: BusLike, options?: AttachOptions): () => void;
  /** 当前状态：落库失败次数、最近一次失败、租约是否丢失。 */
  health(): StorageHealth;
  /** 库里最大 seq + 1，空库为 0；启动时传给总线的 `initialSeq`。 */
  nextSeq(): number;
  /** 库里最大 seq，空库为 null；只读端按它轮询新事件。 */
  maxSeq(): number | null;
  queryEvents(filter?: EventFilter): BakaEvent[];
  /** 登记需求属于哪个项目，用于按项目过滤事件。保存单或群消息时会自动登记。 */
  registerRequirement(requirement_id: string, project_id: string): void;
  saveTicket(ticket: TicketInput): void;
  /** 按单号读一张需求单（T-055），不存在返回 undefined。 */
  getTicket(ticket_id: string): StoredTicket | undefined;
  /** 按项目 / 需求 / 状态列出需求单（T-055），按 created_at、ticket_id 升序。 */
  listTickets(filter?: TicketFilter): StoredTicket[];
  savePrRecord(round: PrRoundInput): void;
  saveMergeResult(ticket_id: string, result: DiagMergeResult): void;
  /** 查询需求单记录（含各轮 PR 记录和合并结果）；from / to 按 created_at 过滤。 */
  query(filter: DiagEventFilter): TicketRecord[];
  saveDecision(d: {
    project_id: string;
    content: string;
    decision_id?: string;
    ts?: string;
  }): Decision;
  listDecisions(project_id: string): Decision[];
  /** 某张需求单的全部 PR 轮次（T-011），按轮次升序；旧记录缺 reviewer 读成 null；单不存在返回空数组。 */
  listPrRounds(ticket_id: string): RoundRecord[];
  /** 所有已创建的项目（T-010），按创建时间先后排序（同一时刻按 project_id）。 */
  listProjects(): ProjectRow[];
  groupMessages(project_id: string, requirement_id?: string): GroupMessageRow[];
  backlogMetrics(
    kind: "review_backlog" | "supervisor_backlog",
    from?: string,
    to?: string,
  ): BacklogMetric[];
  /** 收进评测集：这张单的调用永久保留完整提示词和输出。 */
  markForEvalSet(ticket_id: string): void;
  /** 清掉超过保留期的完整提示词和输出，只留摘要和统计；评测集里的单不动。 */
  purgeExpired(): PurgeResult;
  /** 台账存储，启动时注入模块 3。 */
  readonly ledger: LedgerStore;
  /** 诊断数据源，启动时注入模块 11。 */
  diagnosticsSource(): DiagnosticsSource;
  /** 释放租约并关闭数据库。 */
  close(): void;
}

export interface ReadonlyStorageOptions {
  path: string;
  /** 同 `StorageOptions.nativeBinding`。 */
  nativeBinding?: string;
  /** 同 `StorageOptions.logger`。 */
  logger?: { warn(message: string): void };
}

/** 只读打开返回的类型：只有读方法；prStore 只有 get / list。 */
export type ReadonlyStorage = Pick<
  Storage,
  | "health"
  | "nextSeq"
  | "maxSeq"
  | "queryEvents"
  | "query"
  | "getTicket"
  | "listTickets"
  | "listPrRounds"
  | "listDecisions"
  | "listProjects"
  | "groupMessages"
  | "backlogMetrics"
  | "diagnosticsSource"
  | "close"
> & {
  prStore<T extends PrRecordLike>(): Pick<PrRecordStore<T>, "get" | "list">;
  readonly ledger: Pick<LedgerStore, "totalsByDay" | "totalsByTicket">;
};

const ROUNDS_SQL = "SELECT record FROM pr_rounds WHERE ticket_id = ? ORDER BY round";
function parseRound(x: { record: string }): RoundRecord {
  const r = JSON.parse(x.record) as RoundRecord;
  // T-010 之前的旧记录没有 reviewer，统一读成 null。
  return { ...r, reviewer: r.reviewer ?? null };
}

const SUMMARY_CHARS = 200;
const DAY_MS = 86_400_000;

type Row = Record<string, unknown>;

export function openStorage(options: StorageOptions): Storage {
  return open(options, false);
}

/**
 * 只读打开（T-026）：不拿租约、不跑迁移，库文件必须已存在；写入方正在跑时也能打开。
 * 库版本低于当前代码时报 `StorageVersionError`，提示先用写入方打开一次完成升级。
 * 返回的对象在类型上只有读方法；运行时调到写方法也会抛 `StorageReadonlyError`。
 */
export function openStorageReadonly(options: ReadonlyStorageOptions): ReadonlyStorage {
  return open(
    {
      path: options.path,
      ...(options.nativeBinding !== undefined && { nativeBinding: options.nativeBinding }),
      ...(options.logger !== undefined && { logger: options.logger }),
    },
    true,
  );
}

function open(options: StorageOptions, ro: boolean): Storage {
  const now = options.now ?? (() => new Date());
  const owner = options.owner ?? randomUUID();
  const ttl = options.lease_ttl_ms ?? 30_000;
  const retentionDays = options.retention_days ?? 30;
  const light = options.redact ?? ((t: string) => redactText(t, "light").text);
  const logger = options.logger ?? { warn: (m: string) => console.warn(m) };

  const dbOpts: Database.Options = {};
  if (options.nativeBinding !== undefined) dbOpts.nativeBinding = options.nativeBinding;
  if (ro) {
    dbOpts.readonly = true;
    dbOpts.fileMustExist = true;
  }
  const db = new Database(options.path, dbOpts);
  db.pragma("busy_timeout = 5000");
  if (ro) {
    try {
      checkReadonlyVersion(db, options.path);
    } catch (e) {
      db.close();
      throw e;
    }
  } else {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = ON");
    migrate(db);
  }
  const toMs = (ts: string, field: string): number => {
    const ms = isoToMs(ts);
    if (ms === null) throw new RangeError(`${field} 不是合法的 ISO 时间：${ts}`);
    return ms;
  };

  // ---------- 租约 ----------
  const acquire = db.transaction(() => {
    const t = now().getTime();
    const row = db.prepare("SELECT owner, expires_at FROM lease WHERE id = 1").get() as
      { owner: string; expires_at: number } | undefined;
    if (row && row.owner !== owner && row.expires_at > t) {
      throw new StorageLeaseError(
        `数据库正被另一个写入者 ${row.owner} 使用，租约到 ${new Date(row.expires_at).toISOString()}`,
      );
    }
    db.prepare(
      "INSERT INTO lease (id, owner, expires_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at",
    ).run(owner, t + ttl);
  });
  if (!ro) {
    try {
      acquire.immediate();
    } catch (e) {
      db.close();
      throw e;
    }
  }
  const renewStmt = db.prepare("UPDATE lease SET expires_at = ? WHERE id = 1 AND owner = ?");
  let leaseLost = false;
  let ingestFailures = 0;
  let lastFailure: StorageHealth["last_failure"];
  /** 每次写入前续租并确认租约仍在自己手里。 */
  function holdLease(): void {
    const r = renewStmt.run(now().getTime() + ttl, owner);
    if (r.changes === 0) {
      leaseLost = true;
      throw new StorageLeaseError("租约已被另一个写入者接管，本进程不能再写入");
    }
  }
  const timer = ro
    ? undefined
    : setInterval(
        () => {
          try {
            holdLease();
          } catch (e) {
            leaseLost = true;
            console.error("[storage] 续租失败", e);
          }
        },
        Math.max(1, Math.floor(ttl / 3)),
      );
  timer?.unref();
  let closed = false;

  function write<A extends unknown[], R>(name: string, fn: (...args: A) => R): (...args: A) => R {
    if (ro) {
      return () => {
        throw new StorageReadonlyError(name);
      };
    }
    const tx = db.transaction((...args: A) => {
      holdLease();
      return fn(...args);
    });
    return (...args: A) => {
      if (closed) throw new Error("存储已关闭");
      // IMMEDIATE：事务一开始就拿写锁，两个进程同时写时由 busy_timeout 排队，不会中途报 SQLITE_BUSY
      return tx.immediate(...args);
    };
  }

  function maxSeq(): number | null {
    return (db.prepare("SELECT MAX(seq) AS m FROM events").get() as { m: number | null }).m;
  }

  // ---------- 脱敏 ----------
  const r = (s: string): string => light(s);
  function deepRedact<T>(v: T): T {
    if (typeof v === "string") return r(v) as T;
    if (Array.isArray(v)) return v.map(deepRedact) as T;
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepRedact(x)])) as T;
    }
    return v;
  }

  // ---------- 语句 ----------
  const st = {
    insertEvent: db.prepare(
      `INSERT INTO events (event_id, seq, type, ts, ts_ms, trace_id, span_id, parent_span_id, requirement_id, ticket_id, project_id, payload)
       VALUES (@event_id, @seq, @type, @ts, @ts_ms, @trace_id, @span_id, @parent_span_id, @requirement_id, @ticket_id, @project_id, @payload)
       ON CONFLICT(event_id) DO NOTHING`,
    ),
    insertCall: db.prepare(
      `INSERT OR IGNORE INTO call_log (event_id, ts, ts_ms, requirement_id, ticket_id, role, provider, model, effort, prompt, output,
        prompt_chars, output_chars, summary, input_tokens, output_tokens, cache_hit_input_tokens, cache_hit, latency_ms, cost, is_resubmit, rate_limited_retry)
       VALUES (@event_id, @ts, @ts_ms, @requirement_id, @ticket_id, @role, @provider, @model, @effort, @prompt, @output,
        @prompt_chars, @output_chars, @summary, @input_tokens, @output_tokens, @cache_hit_input_tokens, @cache_hit, @latency_ms, @cost, @is_resubmit, @rate_limited_retry)`,
    ),
    insertProject: db.prepare(
      "INSERT OR IGNORE INTO projects (project_id, name, language, has_github_remote, created_at) VALUES (?, ?, ?, ?, ?)",
    ),
    insertGroup: db.prepare(
      "INSERT OR IGNORE INTO groups (project_id, created_at, created_by_event) VALUES (?, ?, ?)",
    ),
    // 群消息只在需求还没登记项目时登记，不覆盖已有归属（T-022 f）
    insertRequirementIfAbsent: db.prepare(
      "INSERT OR IGNORE INTO requirements (requirement_id, project_id) VALUES (?, ?)",
    ),
    seqOwner: db.prepare("SELECT event_id FROM events WHERE seq = ?"),
    upsertRequirement: db.prepare(
      "INSERT INTO requirements (requirement_id, project_id) VALUES (?, ?) ON CONFLICT(requirement_id) DO UPDATE SET project_id = excluded.project_id",
    ),
    insertGroupMessage: db.prepare(
      `INSERT OR IGNORE INTO group_messages (event_id, seq, ts, project_id, requirement_id, ticket_id, sender, kind, content, flash_calls)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    insertBacklog: db.prepare(
      "INSERT OR IGNORE INTO backlog_metrics (event_id, ts, ts_ms, kind, pending, capacity) VALUES (?, ?, ?, ?, ?, ?)",
    ),
    projectOfRequirement: db.prepare(
      "SELECT project_id FROM requirements WHERE requirement_id = ?",
    ),
    callById: db.prepare(
      "SELECT prompt, output, summary, purged_at FROM call_log WHERE event_id = ?",
    ),
  };

  // ---------- 事件落库 ----------
  const ingest = write("ingest", (input: BakaEvent) => {
    const e = EventSchema.parse(input);
    const ts_ms = toMs(e.ts, "ts");
    const seqRow = st.seqOwner.get(e.seq) as { event_id: string } | undefined;
    if (seqRow && seqRow.event_id !== e.event_id) {
      throw new StorageSeqConflictError(
        `seq ${e.seq} 已被事件 ${seqRow.event_id} 占用，事件 ${e.event_id} 不能写入`,
      );
    }
    let project_id: string | null = null;
    let payload: Row = deepRedact(e.payload as Row);

    switch (e.type) {
      case "project_created": {
        const p = e.payload;
        project_id = p.project_id;
        st.insertProject.run(
          p.project_id,
          r(p.name),
          p.language,
          p.has_github_remote ? 1 : 0,
          e.ts,
        );
        // 收到「项目已创建」后建群记录
        st.insertGroup.run(p.project_id, e.ts, e.event_id);
        break;
      }
      case "group_message": {
        const p = e.payload;
        project_id = p.project_id;
        st.insertRequirementIfAbsent.run(e.requirement_id, p.project_id);
        st.insertGroupMessage.run(
          e.event_id,
          e.seq,
          e.ts,
          p.project_id,
          e.requirement_id,
          e.ticket_id,
          p.sender,
          p.kind,
          r(p.content),
          JSON.stringify(p.flash_calls),
        );
        break;
      }
      case "call_completed": {
        const p = e.payload;
        const prompt = r(p.prompt);
        const output = r(p.output);
        st.insertCall.run({
          event_id: e.event_id,
          ts: e.ts,
          ts_ms,
          requirement_id: e.requirement_id,
          ticket_id: e.ticket_id,
          role: p.role,
          provider: p.provider,
          model: p.model,
          effort: p.effort,
          prompt,
          output,
          prompt_chars: p.prompt.length,
          output_chars: p.output.length,
          summary: output.slice(0, SUMMARY_CHARS),
          input_tokens: p.tokens.input,
          output_tokens: p.tokens.output,
          cache_hit_input_tokens: p.tokens.cache_hit_input,
          cache_hit: p.cache_hit ? 1 : 0,
          latency_ms: p.latency_ms,
          cost: p.cost,
          is_resubmit: p.is_resubmit ? 1 : 0,
          rate_limited_retry: p.rate_limited_retry,
        });
        // 提示词和输出只放调用日志，事件表里不重复存，过期清理只动一处
        const rest: Record<string, unknown> = { ...payload };
        delete rest.prompt;
        delete rest.output;
        payload = rest;
        break;
      }
      case "review_backlog":
      case "supervisor_backlog":
        st.insertBacklog.run(
          e.event_id,
          e.ts,
          ts_ms,
          e.type,
          e.payload.pending,
          e.payload.capacity,
        );
        break;
      default:
        break;
    }
    if (project_id === null && e.requirement_id !== null) {
      const row = st.projectOfRequirement.get(e.requirement_id) as
        { project_id: string } | undefined;
      project_id = row?.project_id ?? null;
    }
    st.insertEvent.run({
      event_id: e.event_id,
      seq: e.seq,
      type: e.type,
      ts: e.ts,
      ts_ms,
      trace_id: e.trace_id,
      span_id: e.span_id,
      parent_span_id: e.parent_span_id,
      requirement_id: e.requirement_id,
      ticket_id: e.ticket_id,
      project_id,
      payload: JSON.stringify(payload),
    });
  });

  function rowToEvent(row: Row): BakaEvent {
    const payload = JSON.parse(row.payload as string) as Row;
    if (row.type === "call_completed") {
      const c = st.callById.get(row.event_id) as
        | {
            prompt: string | null;
            output: string | null;
            summary: string;
            purged_at: string | null;
          }
        | undefined;
      // 过期后只剩摘要：prompt 为空串，output 为输出摘要
      payload.prompt = c?.prompt ?? "";
      payload.output = c?.output ?? c?.summary ?? "";
    }
    return {
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
    } as BakaEvent;
  }

  function queryEvents(f: EventFilter = {}): BakaEvent[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (f.project_id !== undefined) {
      where.push("COALESCE(e.project_id, rq.project_id) = ?");
      args.push(f.project_id);
    }
    for (const k of ["requirement_id", "ticket_id", "trace_id"] as const) {
      if (f[k] !== undefined) {
        where.push(`e.${k} = ?`);
        args.push(f[k]);
      }
    }
    if (f.types?.length) {
      where.push(`e.type IN (${f.types.map(() => "?").join(", ")})`);
      args.push(...f.types);
    }
    if (f.from !== undefined) {
      where.push("e.ts_ms >= ?");
      args.push(toMs(f.from, "from"));
    }
    if (f.to !== undefined) {
      where.push("e.ts_ms <= ?");
      args.push(toMs(f.to, "to"));
    }
    if (f.after_seq !== undefined) {
      where.push("e.seq > ?");
      args.push(f.after_seq);
    }
    if (f.limit !== undefined && (!Number.isInteger(f.limit) || f.limit <= 0)) {
      throw new RangeError(`limit 须为正整数，收到 ${f.limit}`);
    }
    if (f.limit !== undefined) args.push(f.limit);
    const sql = `SELECT e.* FROM events e LEFT JOIN requirements rq ON rq.requirement_id = e.requirement_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY e.seq ${f.limit !== undefined ? "LIMIT ?" : ""}`;
    return (db.prepare(sql).all(...args) as Row[]).map(rowToEvent);
  }

  // ---------- 需求单 / PR 记录 ----------
  const saveTicket = write("saveTicket", (t: TicketInput) => {
    st.upsertRequirement.run(t.requirement_id, t.project_id);
    db.prepare(
      `INSERT INTO tickets (ticket_id, project_id, requirement_id, created_at, created_at_ms, ticket_text, decomposition_summary, status, outcome,
        base_commit, permission_list, context_snippets, ci_checks, fields)
       VALUES (@ticket_id, @project_id, @requirement_id, @created_at, @created_at_ms, @ticket_text, @decomposition_summary, @status, @outcome,
        @base_commit, @permission_list, @context_snippets, @ci_checks, @fields)
       ON CONFLICT(ticket_id) DO UPDATE SET project_id = excluded.project_id, requirement_id = excluded.requirement_id,
        created_at = excluded.created_at, created_at_ms = excluded.created_at_ms, ticket_text = excluded.ticket_text, decomposition_summary = excluded.decomposition_summary,
        status = excluded.status, outcome = excluded.outcome, base_commit = excluded.base_commit,
        permission_list = excluded.permission_list, context_snippets = excluded.context_snippets, ci_checks = excluded.ci_checks,
        fields = COALESCE(excluded.fields, tickets.fields)`,
    ).run({
      ticket_id: t.ticket_id,
      project_id: t.project_id,
      requirement_id: t.requirement_id,
      created_at: t.created_at,
      created_at_ms: toMs(t.created_at, "created_at"),
      ticket_text: r(t.ticket_text),
      decomposition_summary:
        t.decomposition_summary === undefined ? null : r(t.decomposition_summary),
      status: t.status ?? null,
      outcome: t.outcome ?? null,
      base_commit: t.base_commit,
      permission_list: JSON.stringify(t.permission_list),
      context_snippets: JSON.stringify(deepRedact(t.context_snippets)),
      ci_checks: t.ci_checks === undefined ? null : JSON.stringify(deepRedact(t.ci_checks)),
      fields: t.fields === undefined ? null : encodeFields(t.ticket_id, t.fields),
    });
  });

  /** 已经警告过 fields 损坏的单号：同一个连接里同一单号只警告一次（T-057）。 */
  const warnedFields = new Set<string>();
  function warnFieldsOnce(ticket_id: string, message: string): void {
    if (warnedFields.has(ticket_id)) return;
    warnedFields.add(ticket_id);
    try {
      logger.warn(message);
    } catch {
      /* logger 自己出错也不能让读取抛错 */
    }
  }

  /**
   * 读 `tickets.fields`：损坏的 JSON 或不是普通对象时读成 null 并记警告，不让一行坏数据拖垮整个读取。
   * 正常读到时把单号从「已警告」集合里移掉，修好后再坏还会再报一次。
   */
  function decodeFields(ticket_id: string, raw: unknown): TicketFields | null {
    if (raw == null) {
      warnedFields.delete(ticket_id);
      return null;
    }
    let v: unknown;
    try {
      v = JSON.parse(raw as string);
    } catch {
      warnFieldsOnce(
        ticket_id,
        `[storage] 需求单 ${ticket_id} 的 fields 不是合法 JSON，按 null 读出`,
      );
      return null;
    }
    if (v === null || typeof v !== "object" || Array.isArray(v)) {
      warnFieldsOnce(ticket_id, `[storage] 需求单 ${ticket_id} 的 fields 不是对象，按 null 读出`);
      return null;
    }
    warnedFields.delete(ticket_id);
    return v as TicketFields;
  }

  function rowToTicket(row: Row): StoredTicket {
    const t: StoredTicket = {
      ticket_id: row.ticket_id as string,
      project_id: row.project_id as string,
      requirement_id: row.requirement_id as string,
      created_at: row.created_at as string,
      ticket_text: row.ticket_text as string,
      base_commit: row.base_commit as string,
      permission_list: JSON.parse(row.permission_list as string) as PermissionList,
      context_snippets: JSON.parse(row.context_snippets as string) as RawFile[],
      fields: decodeFields(row.ticket_id as string, row.fields),
    };
    if (row.decomposition_summary != null)
      t.decomposition_summary = row.decomposition_summary as string;
    if (row.status != null) t.status = row.status as TicketStatus;
    if (row.outcome != null) t.outcome = row.outcome as OutcomeLabel;
    if (row.ci_checks != null) t.ci_checks = JSON.parse(row.ci_checks as string) as CiCheck[];
    return t;
  }

  function getTicket(ticket_id: string): StoredTicket | undefined {
    const row = db.prepare("SELECT * FROM tickets WHERE ticket_id = ?").get(ticket_id) as
      Row | undefined;
    return row ? rowToTicket(row) : undefined;
  }

  function listTickets(f: TicketFilter = {}): StoredTicket[] {
    const where: string[] = [];
    const args: unknown[] = [];
    for (const k of ["project_id", "requirement_id", "status"] as const) {
      if (f[k] !== undefined) {
        where.push(`${k} = ?`);
        args.push(f[k]);
      }
    }
    return (
      db
        .prepare(
          `SELECT * FROM tickets ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at_ms, ticket_id`,
        )
        .all(...args) as Row[]
    ).map(rowToTicket);
  }

  const savePrRecord = write("savePrRecord", (input: PrRoundInput) => {
    const { ticket_id, reviewer, ...rest } = input;
    if (reviewer !== undefined && reviewer !== null && typeof reviewer !== "string") {
      throw new TypeError(
        `PR 记录 ${ticket_id} 第 ${input.round} 轮的 reviewer 只能是字符串或 null`,
      );
    }
    // reviewer 是结构字段：原样保存，不进轻脱敏（成员 id / "supervisor" / null）。
    const round = { ...(deepRedact(rest) as typeof rest), reviewer: reviewer ?? null };
    db.prepare(
      `INSERT INTO pr_rounds (ticket_id, round, record, saved_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(ticket_id, round) DO UPDATE SET record = excluded.record, saved_at = excluded.saved_at`,
    ).run(ticket_id, round.round, JSON.stringify(round), now().toISOString());
  });

  const putPrRecord = write("prStore().put", (record: PrRecordLike) => {
    if (typeof record.pr_id !== "string" || record.pr_id === "") {
      throw new TypeError("PR 记录缺少 pr_id");
    }
    if (typeof record.kind !== "string" || record.kind === "") {
      throw new TypeError(`PR 记录 ${record.pr_id} 缺少 kind，不能写入`);
    }
    if (!(PR_RECORD_KINDS as readonly string[]).includes(record.kind)) {
      throw new TypeError(
        `PR 记录 ${record.pr_id} 的 kind 只能是 ${PR_RECORD_KINDS.join(" / ")}，收到 ${record.kind}`,
      );
    }
    // 结构字段（分支、sha、路径、remote、时间等）既不检查也不改写，6 靠它们做 merge / diff / sync；
    // 唯一例外：URL 里带凭据（user:pass@、像 token 的用户名、查询参数里的 token 等，见 isCredentialUrl）时整条拒写。
    // 其余字段视为自由文本做轻脱敏（现在还没有，以后加 title、body 时生效）。
    const stored: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      if (isStructuralPrField(k)) {
        const bad = findCredentialUrl(v, k);
        if (bad)
          throw new TypeError(`PR 记录 ${record.pr_id} 的字段 ${bad} 是带凭据的 URL，拒绝写入`);
        stored[k] = v;
      } else {
        stored[k] = deepRedact(v);
      }
    }
    db.prepare(
      `INSERT INTO pr_records (pr_id, kind, record, saved_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(pr_id) DO UPDATE SET kind = excluded.kind, record = excluded.record, saved_at = excluded.saved_at`,
    ).run(record.pr_id, record.kind, JSON.stringify(stored), now().toISOString());
  });

  function readPrRow<T extends PrRecordLike>(row: { kind: string; record: string }): T {
    // 以 kind 列为准，防止记录正文里缺了 kind 被误判成别的类型
    return { ...(JSON.parse(row.record) as T), kind: row.kind };
  }

  function prStore<T extends PrRecordLike>(): PrRecordStore<T> {
    return {
      get(pr_id) {
        const row = db.prepare("SELECT kind, record FROM pr_records WHERE pr_id = ?").get(pr_id) as
          { kind: string; record: string } | undefined;
        return Promise.resolve(row ? readPrRow<T>(row) : undefined);
      },
      put(record) {
        try {
          putPrRecord(record);
          return Promise.resolve();
        } catch (err) {
          return Promise.reject(err instanceof Error ? err : new Error(String(err)));
        }
      },
      list() {
        const rows = db.prepare("SELECT kind, record FROM pr_records ORDER BY rowid").all() as {
          kind: string;
          record: string;
        }[];
        return Promise.resolve(rows.map((r) => readPrRow<T>(r)));
      },
    };
  }

  const saveMergeResult = write("saveMergeResult", (ticket_id: string, result: DiagMergeResult) => {
    db.prepare(
      `INSERT INTO merge_results (ticket_id, result, saved_at) VALUES (?, ?, ?)
       ON CONFLICT(ticket_id) DO UPDATE SET result = excluded.result, saved_at = excluded.saved_at`,
    ).run(ticket_id, JSON.stringify(result), now().toISOString());
  });

  function query(f: DiagEventFilter): TicketRecord[] {
    const where = ["t.project_id = ?"];
    const args: unknown[] = [f.project_id];
    if (f.ticket_id !== undefined) {
      where.push("t.ticket_id = ?");
      args.push(f.ticket_id);
    }
    if (f.requirement_id !== undefined) {
      where.push("t.requirement_id = ?");
      args.push(f.requirement_id);
    }
    if (f.from !== undefined) {
      where.push("t.created_at_ms >= ?");
      args.push(toMs(f.from, "from"));
    }
    if (f.to !== undefined) {
      where.push("t.created_at_ms <= ?");
      args.push(toMs(f.to, "to"));
    }
    const rows = db
      .prepare(
        `SELECT t.*, m.result AS merge_result, (ev.ticket_id IS NOT NULL) AS in_eval FROM tickets t
         LEFT JOIN merge_results m ON m.ticket_id = t.ticket_id
         LEFT JOIN eval_set ev ON ev.ticket_id = t.ticket_id
         WHERE ${where.join(" AND ")} ORDER BY t.created_at_ms, t.ticket_id`,
      )
      .all(...args) as Row[];
    const roundsStmt = db.prepare(ROUNDS_SQL);
    return rows.map((row) => {
      const rec: TicketRecord = {
        project_id: row.project_id as string,
        ticket_id: row.ticket_id as string,
        requirement_id: row.requirement_id as string,
        created_at: row.created_at as string,
        ticket_text: row.ticket_text as string,
        base_commit: row.base_commit as string,
        permission_list: JSON.parse(row.permission_list as string) as PermissionList,
        rounds: (roundsStmt.all(row.ticket_id) as { record: string }[]).map(parseRound),
        context_snippets: JSON.parse(row.context_snippets as string) as RawFile[],
        marked_for_eval_set: row.in_eval === 1,
      };
      if (row.decomposition_summary != null)
        rec.decomposition_summary = row.decomposition_summary as string;
      if (row.status != null) rec.status = row.status as TicketStatus;
      if (row.outcome != null) rec.outcome = row.outcome as OutcomeLabel;
      if (row.merge_result != null)
        rec.merge = JSON.parse(row.merge_result as string) as DiagMergeResult;
      if (row.ci_checks != null) rec.ci_checks = JSON.parse(row.ci_checks as string) as CiCheck[];
      return rec;
    });
  }

  // ---------- 决策记忆 / 群消息 / 待办指标 ----------
  const saveDecision = write(
    "saveDecision",
    (d: { project_id: string; content: string; decision_id?: string; ts?: string }): Decision => {
      const out: Decision = {
        decision_id: d.decision_id ?? randomUUID(),
        project_id: d.project_id,
        ts: d.ts ?? now().toISOString(),
        content: r(d.content),
      };
      db.prepare(
        "INSERT OR IGNORE INTO decisions (decision_id, project_id, ts, ts_ms, content) VALUES (?, ?, ?, ?, ?)",
      ).run(out.decision_id, out.project_id, out.ts, toMs(out.ts, "ts"), out.content);
      return out;
    },
  );

  // ---------- 保留期 ----------
  const markForEvalSet = write("markForEvalSet", (ticket_id: string) => {
    db.prepare("INSERT OR IGNORE INTO eval_set (ticket_id, marked_at) VALUES (?, ?)").run(
      ticket_id,
      now().toISOString(),
    );
  });

  const purgeExpired = write("purgeExpired", (): PurgeResult => {
    const t = now();
    const cutoff = t.getTime() - retentionDays * DAY_MS;
    const res = db
      .prepare(
        `UPDATE call_log SET prompt = NULL, output = NULL, purged_at = ?
         WHERE purged_at IS NULL AND ts_ms < ?
           AND (ticket_id IS NULL OR ticket_id NOT IN (SELECT ticket_id FROM eval_set))`,
      )
      .run(t.toISOString(), cutoff);
    return { purged_calls: res.changes };
  });

  // ---------- 台账 ----------
  const ledgerAppend = write("ledger.append", (entry: LedgerEntry) => {
    const e = LedgerEntrySchema.parse(entry);
    db.prepare(
      `INSERT OR IGNORE INTO ledger (entry_id, ts, day, requirement_id, ticket_id, role, cost_micro_usd, is_resubmit, cache_hit, offpeak)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      e.entry_id,
      e.ts,
      new Date(e.ts).toISOString().slice(0, 10),
      e.requirement_id,
      e.ticket_id,
      e.role,
      e.cost_micro_usd,
      e.is_resubmit ? 1 : 0,
      e.cache_hit ? 1 : 0,
      e.offpeak ? 1 : 0,
    );
  });
  const totalsSql = `SELECT COALESCE(SUM(cost_micro_usd), 0) AS total_micro_usd,
      COALESCE(SUM(CASE WHEN is_resubmit = 1 THEN cost_micro_usd ELSE 0 END), 0) AS resubmit_micro_usd,
      COUNT(*) AS entries FROM ledger`;
  const ledgerTotals = (where: string, arg: string): LedgerBreakdown => {
    const t = db.prepare(`${totalsSql} WHERE ${where} = ?`).get(arg) as LedgerTotals;
    const by_role = Object.fromEntries(ROLES.map((r) => [r, 0])) as LedgerBreakdown["by_role"];
    const rows = db
      .prepare(`SELECT role, SUM(cost_micro_usd) AS c FROM ledger WHERE ${where} = ? GROUP BY role`)
      .all(arg) as { role: Role; c: number }[];
    for (const r of rows) by_role[r.role] = r.c;
    return { ...t, by_role };
  };
  const ledger: LedgerStore = {
    async append(entry) {
      ledgerAppend(entry);
    },
    async totalsByDay(day) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day))
        throw new RangeError(`day 须为 YYYY-MM-DD（UTC），收到 ${day}`);
      return ledgerTotals("day", day);
    },
    async totalsByTicket(ticket_id) {
      return ledgerTotals("ticket_id", ticket_id);
    },
  };

  return {
    ingest,
    attach(bus, opts = {}) {
      if (ro) throw new StorageReadonlyError("attach");
      const onError =
        opts.onError ??
        ((f: IngestFailure) =>
          console.error(`[storage] 事件落库失败 ${f.type} seq=${f.seq} ${f.event_id}`, f.error));
      return bus.subscribe("*", (e) => {
        try {
          ingest(e);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          ingestFailures++;
          lastFailure = {
            event_id: e.event_id,
            type: e.type,
            seq: e.seq,
            message: error.message,
            at: now().toISOString(),
          };
          try {
            onError({ event_id: e.event_id, type: e.type, seq: e.seq, error });
          } catch (cbErr) {
            console.error("[storage] onError 回调出错", cbErr);
          }
        }
      });
    },
    health() {
      const h: StorageHealth = {
        ok: !leaseLost && !closed && ingestFailures === 0,
        lease_lost: leaseLost,
        closed,
        ingest_failures: ingestFailures,
      };
      if (lastFailure) h.last_failure = { ...lastFailure };
      return h;
    },
    nextSeq() {
      const m = maxSeq();
      return m === null ? 0 : m + 1;
    },
    maxSeq,
    queryEvents,
    registerRequirement: write(
      "registerRequirement",
      (requirement_id: string, project_id: string) => {
        st.upsertRequirement.run(requirement_id, project_id);
      },
    ),
    saveTicket,
    getTicket,
    listTickets,
    savePrRecord,
    prStore,
    saveMergeResult,
    query,
    saveDecision,
    listPrRounds(ticket_id) {
      return (db.prepare(ROUNDS_SQL).all(ticket_id) as { record: string }[]).map(parseRound);
    },
    listProjects() {
      return db
        .prepare(
          "SELECT project_id, name, created_at FROM projects ORDER BY created_at, project_id",
        )
        .all() as ProjectRow[];
    },
    listDecisions(project_id) {
      return db
        .prepare(
          "SELECT decision_id, project_id, ts, content FROM decisions WHERE project_id = ? ORDER BY ts_ms, rowid",
        )
        .all(project_id) as Decision[];
    },
    groupMessages(project_id, requirement_id) {
      const rows = (
        requirement_id === undefined
          ? db
              .prepare("SELECT * FROM group_messages WHERE project_id = ? ORDER BY seq")
              .all(project_id)
          : db
              .prepare(
                "SELECT * FROM group_messages WHERE project_id = ? AND requirement_id = ? ORDER BY seq",
              )
              .all(project_id, requirement_id)
      ) as Row[];
      return rows.map(
        (x) => ({ ...x, flash_calls: JSON.parse(x.flash_calls as string) }) as GroupMessageRow,
      );
    },
    backlogMetrics(kind, from, to) {
      const fromMs = from === undefined ? null : toMs(from, "from");
      const toMsV = to === undefined ? null : toMs(to, "to");
      return db
        .prepare(
          `SELECT ts, pending, capacity FROM backlog_metrics WHERE kind = ?
           AND (? IS NULL OR ts_ms >= ?) AND (? IS NULL OR ts_ms <= ?) ORDER BY ts_ms, rowid`,
        )
        .all(kind, fromMs, fromMs, toMsV, toMsV) as BacklogMetric[];
    },
    markForEvalSet,
    purgeExpired,
    ledger,
    diagnosticsSource(): DiagnosticsSource {
      return {
        async queryEvents(f) {
          return queryEvents({
            project_id: f.project_id,
            ...(f.ticket_id !== undefined && { ticket_id: f.ticket_id }),
            ...(f.requirement_id !== undefined && { requirement_id: f.requirement_id }),
            ...(f.from !== undefined && { from: f.from }),
            ...(f.to !== undefined && { to: f.to }),
          });
        },
        async queryTickets(f) {
          return query(f);
        },
      };
    },
    close() {
      if (closed) return;
      if (timer) clearInterval(timer);
      try {
        if (!ro) db.prepare("DELETE FROM lease WHERE id = 1 AND owner = ?").run(owner);
      } finally {
        closed = true;
        db.close();
      }
    },
  };
}

function migrate(db: Database.Database): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    const step = MIGRATIONS[v]!;
    db.transaction(() => {
      // 事务里再读一次版本：两个进程同时打开时，后拿到写锁的那个不重复升级
      if ((db.pragma("user_version", { simple: true }) as number) !== v) return;
      if (typeof step === "string") db.exec(step);
      else step(db);
      db.pragma(`user_version = ${v + 1}`);
    }).immediate();
  }
}

function checkReadonlyVersion(db: Database.Database, path: string): void {
  const v = db.pragma("user_version", { simple: true }) as number;
  const want = MIGRATIONS.length;
  if (v < want) {
    throw new StorageVersionError(
      `数据库 ${path} 的版本是 v${v}，当前代码需要 v${want}。只读方式不做升级，请先用写入方（BakaCoding 主进程）打开一次完成升级`,
    );
  }
  if (v > want) {
    throw new StorageVersionError(
      `数据库 ${path} 的版本是 v${v}，比当前代码支持的 v${want} 新，请升级 BakaCoding 后再打开`,
    );
  }
}

/** 结构化字段只收能 JSON 往返的普通对象：顶层不是对象、含函数 / undefined / 非有限数 / 类实例时报错。 */
function encodeFields(ticket_id: string, fields: unknown): string {
  const bad = (why: string): never => {
    throw new TypeError(`需求单 ${ticket_id} 的 fields ${why}`);
  };
  const seen = new Set<object>();
  const check = (v: unknown, path: string): void => {
    if (v === null || typeof v === "string" || typeof v === "boolean") return;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) bad(`${path} 不是有限数`);
      return;
    }
    if (typeof v === "object") {
      if (seen.has(v)) bad(`${path} 有循环引用`);
      seen.add(v);
      if (Array.isArray(v)) {
        v.forEach((x, i) => check(x, `${path}[${i}]`));
      } else {
        const proto = Object.getPrototypeOf(v) as unknown;
        if (proto !== Object.prototype && proto !== null) bad(`${path} 不是普通对象`);
        for (const [k, x] of Object.entries(v as Record<string, unknown>)) check(x, `${path}.${k}`);
      }
      seen.delete(v);
      return;
    }
    bad(`${path} 不能 JSON 往返（${typeof v}）`);
  };
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) bad("必须是普通对象");
  check(fields, "fields");
  return JSON.stringify(fields);
}
