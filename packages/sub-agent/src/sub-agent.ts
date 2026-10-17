import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { defaultIsBudgetExceeded } from "@bakacoding/coder-pool";
import { CommitPatchError, NoChangesError } from "@bakacoding/pr";
import { permissionFor, type ScopeBus, type ScopeRequestOptions } from "@bakacoding/workspace";
import {
  DEPENDENCY_MANIFEST_GLOBS,
  type BakaEvent,
  type CallCtx,
  type DiffFile,
  type Effort,
  type EventOf,
  type PermissionList,
  type ReviewReason,
  type ReviewResult,
  type TicketStatus,
} from "@bakacoding/types";
import type {
  ConflictResubmitRequest,
  HandleOptions,
  ReReviewRequest,
  ResubmitCounts,
  ResumeToken,
  SchedulerFacingOutcome,
  SubAgent,
  SubAgentConfig,
  SubAgentDeps,
  SubAgentEscalationReason,
  SubAgentOutcome,
  SubAgentTicket,
} from "./types.js";
import {
  appendGrantedScope,
  clampPermissionList,
  generatePermissionList,
  globWithinScope,
  isUnsafeGlob,
  memoryTicketPermissions,
  safeScope,
  type GeneratedPermissions,
} from "./permissions.js";
import { registerRecorder } from "./internal.js";

/** 每单最多攒多少条没带给编码池的接口变更说明（多了丢最早的） */
const MAX_INTERFACE_NOTES = 20;
/** 每条接口变更说明里合并说明（summary）的最大长度 */
const MAX_NOTE_SUMMARY = 2000;

/**
 * 越界写申请里不接受的通配 / glob 语法字符（T-053）：模块 4 申请的是具体文件路径，8 把它原样当 glob 批进权限清单，
 * 字面名带这些字符（如 `docs/**`、`**`）会被批成一片范围，所以一律拒绝。
 */
const SCOPE_REQUEST_WILDCARD = /[*?[\]{}()!+@]/;

/**
 * 依赖清单 / 锁文件的文件名模式：`DEPENDENCY_MANIFEST_GLOBS` 里不带目录的那些（`package.json`、`*.lock` 等），
 * 统一转小写（T-065：文件名不区分大小写，只在依赖文件判定这里做，模块 4 的 glob 语义不变）。
 */
const DEPENDENCY_BASENAME_RULES = DEPENDENCY_MANIFEST_GLOBS.filter((g) => !g.includes("/")).map(
  (glob) => ({ glob: glob.toLowerCase(), level: "rw" as const }),
);

/**
 * 是否是依赖清单 / 锁文件（T-041c 起导出，组合根重启补判用）：一律按文件名（basename）匹配
 * `DEPENDENCY_MANIFEST_GLOBS` 的文件名模式，所以任意子目录里的 `package.json`、`pnpm-lock.yaml` 等都算；
 * 文件名不区分大小写（T-065：`Package.json`、`PNPM-LOCK.YAML` 也算），但仍要整个文件名匹配，
 * `docs/package.json.md`、`docs/Package.json.md` 这类只是名字像的不算。匹配规则同模块 4（先把文件名转小写）。
 */
export function isDependencyFile(path: string): boolean {
  const name = path.split("/").filter(Boolean).at(-1);
  if (!name) return false;
  return permissionFor(DEPENDENCY_BASENAME_RULES, name.toLowerCase()) === "rw";
}

/**
 * diff 里的一个文件算不算高风险（T-041c，T-065 收窄）：新路径 `path` 是依赖清单 / 锁文件，或者有旧路径
 * `old_path`（6 对改名的文件填上）且旧路径是依赖文件——例如把 `package.json` 改名成 `x.json`。
 * 删除的文件 `path` 就是原路径，照常按 `path` 判。普通文件改名（`a.ts` → `b.ts`）不再算。
 * 8 评审前判高风险、组合根重启接管时补判（N4）都用它。
 */
export function isHighRiskDiffFile(file: Pick<DiffFile, "path" | "status" | "old_path">): boolean {
  return (
    isDependencyFile(file.path) || (file.old_path !== undefined && isDependencyFile(file.old_path))
  );
}

/**
 * 高风险的理由（T-041c，`pendingHighRisk` / T-062 界面用）：
 * - `dependency_kind`：主管把单标成依赖类（`kind: "dependency"`）；
 * - `dependency_file`：diff 改了依赖清单 / 锁文件（含删除的；改名的看新旧路径，见 `isHighRiskDiffFile`）；
 * - `diff_unavailable`：取不到 diff（重启补判或扣住时取 diff 出错），按高风险处理；
 * - `unverified`：9 标了高风险，但现在的 diff 看不出依赖改动（例如 8 交出前重取 diff 失败）。
 */
export type HighRiskReason =
  "dependency_kind" | "dependency_file" | "diff_unavailable" | "unverified";

/** `highRiskEvidence` 最多列出的文件数，其余计入 `files_more`。 */
export const HIGH_RISK_FILES_MAX = 20;

/**
 * 整理一张高风险单的理由和命中的文件（T-041c）：纯函数，不取 diff。`files` 传 null 表示取不到 diff。
 * 命中的文件按 diff 的顺序最多列 `HIGH_RISK_FILES_MAX` 个，其余只计数。
 */
export function highRiskEvidence(input: {
  kind?: string | undefined;
  files: readonly Pick<DiffFile, "path" | "status" | "old_path">[] | null;
}): { reasons: HighRiskReason[]; files: string[]; files_more: number } {
  const reasons: HighRiskReason[] = [];
  if (input.kind === "dependency") reasons.push("dependency_kind");
  const hit = input.files ? input.files.filter(isHighRiskDiffFile).map((f) => f.path) : [];
  if (hit.length) reasons.push("dependency_file");
  if (input.files === null) reasons.push("diff_unavailable");
  else if (!reasons.length) reasons.push("unverified");
  return {
    reasons,
    files: hit.slice(0, HIGH_RISK_FILES_MAX),
    files_more: Math.max(0, hit.length - HIGH_RISK_FILES_MAX),
  };
}

/** 清单里最后一条匹配 path 的条目是不是显式 deny（未匹配不算显式）。 */
function explicitlyDenied(list: PermissionList, path: string): boolean {
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i]!;
    if (permissionFor([{ glob: e.glob, level: "rw" }], path) === "rw") return e.level === "deny";
  }
  return false;
}

/** 一条 interface_changed 写给受影响单的说明（作为不可信反馈交给编码池，5 负责包装）。 */
function interfaceNote(ev: EventOf<"interface_changed">): string {
  const e = ev.payload;
  const ifaces = e.changed_interfaces.map((c) => `${c.file}#${c.symbol}`).join("、");
  const summary =
    e.summary.length > MAX_NOTE_SUMMARY
      ? `${e.summary.slice(0, MAX_NOTE_SUMMARY)}…（已截断）`
      : e.summary;
  return `${ev.ticket_id} 的 PR ${e.pr_id} 已合入集成分支（新基线 ${e.base_commit}），可能影响本单。改动的接口：${ifaces || "（未列出）"}。合并说明：${summary || "（无）"}`;
}

function notesSection(notes: readonly string[]): string {
  return `接口变更通知（合并队列在本单编码期间合入了别的单，请确认本单与之兼容）：\n${notes.map((n) => `- ${n}`).join("\n")}`;
}

/** 续跑时接在 feedback 最前面的说明（PD：当日预算用完暂停，第二天同一 worktree 续跑）。 */
export const BUDGET_RESUME_NOTE =
  "预算暂停后续跑：上次因当日预算用完中断，worktree 里保留了上次的部分改动，请在此基础上继续完成本单。";

/** 编码池结束但没能交出可提交改动时，写进 escalated.detail / 群消息的状态。 */
export type CoderFailureStatus = "gave_up" | "turn_limit" | "done_no_changes" | "commit_failed";

/** handle 里出异常时所在的阶段，决定上报原因（见 SubAgentEscalationReason）。 */
export type SubAgentStage =
  | "permissions"
  | "coding"
  | "open"
  | "commit"
  | "diff"
  | "budget"
  | "review"
  | "round_save"
  | "submit";

const STAGE_REASON: Record<SubAgentStage, SubAgentEscalationReason> = {
  permissions: "internal_error",
  coding: "coder_failed",
  open: "github_manual",
  commit: "github_manual",
  diff: "github_manual",
  submit: "github_manual",
  budget: "internal_error",
  review: "internal_error",
  round_save: "internal_error",
};

/**
 * 第 k 次复投（k = 评审复投 + 冲突复投；首跑 k = 0）的编码档位：
 * 首跑用 `roles.coder.effort`，第 k 次复投用 `resubmit_effort[k-1]`，超出数组长度取最后一项。
 */
export function effortFor(config: SubAgentConfig, counts: ResubmitCounts): Effort {
  const k = counts.review + counts.conflict;
  const { effort, resubmit_effort } = config.roles.coder;
  if (k <= 0 || resubmit_effort.length === 0) return effort;
  return resubmit_effort[Math.min(k, resubmit_effort.length) - 1] ?? effort;
}

/** 评审理由原样转成下一轮 runTicket 的 feedback（JSON，字段不改不删）。 */
export function reasonsToFeedback(reasons: readonly ReviewReason[]): string {
  return JSON.stringify(reasons, null, 2);
}

/** 冲突复投的 feedback：冲突文件清单。 */
export function conflictFeedback(base_commit: string, files: readonly string[]): string {
  const list = files.length ? files.map((f) => `- ${f}`).join("\n") : "- （6 未给出冲突文件）";
  return `合并冲突：本单 PR 与集成分支冲突，已基于最新基线 ${base_commit} 新建 worktree，请在新基线上重做本单。冲突文件：\n${list}`;
}

/** 2 的事件日志里 8 用到的读方法（`Storage` / `ReadonlyStorage` 在结构上满足它）。 */
export interface EventLogQuery {
  queryEvents(filter: { ticket_id?: string; types?: BakaEvent["type"][] }): readonly BakaEvent[];
}

/**
 * 从 2 的事件日志数本单的评审复投次数（跨重启）：8 每计一次评审复投（评审不过或编码池没交出改动）恰好发一条
 * `group_message(kind: "resubmit", sender: "sub_agent")`，其他时候不发这个 kind。
 */
export function eventLogResubmitHistory(
  storage: EventLogQuery,
): (ticket_id: string) => { review: number } {
  return (ticket_id) => ({
    review: storage
      .queryEvents({ ticket_id, types: ["group_message"] })
      .filter(
        (e) =>
          e.type === "group_message" &&
          e.ticket_id === ticket_id &&
          e.payload.kind === "resubmit" &&
          e.payload.sender === "sub_agent",
      ).length,
  });
}

function formatReason(r: ReviewReason): string {
  const loc = r.file ? ` (${r.file}${r.line ? `:${r.line}` : ""})` : "";
  return `${r.category}${loc}: ${r.detail}`;
}

function errorDetail(stage: SubAgentStage, e: unknown): string {
  const err = e as { name?: unknown; message?: unknown; code?: unknown; status?: unknown };
  const name = typeof err?.name === "string" ? err.name : "Error";
  const code =
    typeof err?.code === "string" || typeof err?.code === "number"
      ? ` [${String(err.code)}]`
      : typeof err?.status === "number"
        ? ` [${err.status}]`
        : "";
  const msg = typeof err?.message === "string" ? err.message : String(e);
  return `${stage}_error: ${name}${code}: ${msg}`.slice(0, 500);
}

/** 按真实路径解析（处理符号链接）；路径还不存在时解析最深的已存在祖先，再接上剩余部分。 */
function realOrResolved(p: string): string {
  const abs = resolve(p);
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return join(realpathSync.native(cur), ...rest);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs;
      rest.unshift(basename(cur));
      cur = parent;
    }
  }
}

/** 中止时抛的错误：优先 signal.reason，没有就抛名为 AbortError 的错误（与 5、7 一致）。 */
function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const e = new Error("已取消");
  e.name = "AbortError";
  return e;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

function roundFromPath(p: string): number {
  const m = /-r(\d+)\/?$/.exec(p);
  return m ? Number(m[1]) : 0;
}

/** 编码完成的总结和 diff 里的改动文件（以 6 的 diff 为准，不用编码池自报的 changed_files）。 */
interface LastRun {
  summary: string;
  changed_files: string[];
}

interface RunState {
  ticket: SubAgentTicket;
  worktree_path: string;
  branch: string;
  /** 这一轮 worktree 的基线 commit 与轮次 n */
  base_commit: string;
  worktree_round: number;
  pr_id: string | null;
  counts: ResubmitCounts;
  phase: "coding" | "review";
  feedback?: string;
  is_resubmit: boolean;
  last?: LastRun;
  /** 入口：handle 写 merge_queued 及之前的状态；conflict / rereview 不写状态（归 9） */
  mode: "handle" | "conflict" | "rereview";
  /** 评审通过时是否调 9 的 submit（handle 和所有 resume） */
  submit: boolean;
  /** 编码开始时发的派单说明（只发一次） */
  announce?: string;
  stage: SubAgentStage;
  /** 取消信号（T-039）：原样传给 runTicket / review；中止后抛 signal.reason，不上报 */
  signal?: AbortSignal;
  /** 已从待带队列取出、要带给下一次 runTicket 的接口变更说明（T-038；预算暂停时进 ResumeToken） */
  interface_notes?: string[];
}

export function createSubAgent(deps: SubAgentDeps): SubAgent {
  const logger = deps.logger ?? console;
  const isBudgetExceeded = deps.isBudgetExceeded ?? defaultIsBudgetExceeded;
  const registry = new Map<string, SubAgentTicket>();
  /** 每单最近一次运行的状态（reReview 沿用编码摘要和计数；当前 PR 以 deps.prRecords 为准，T-039） */
  const active = new Map<string, RunState>();
  const lastRound = new Map<string, number>();
  const root = realOrResolved(deps.worktreeRoot);
  const permissionStore = deps.permissions ?? memoryTicketPermissions();
  /** 每单写回需求单记录的串行链（批准写回与生成不交错；读之前先等它） */
  const permissionWrites = new Map<string, Promise<void>>();
  /** 本进程写回过的已批准范围（读回时不按写入范围裁掉；跨重启靠 deps.grantedScopes） */
  const grantedHere = new Map<string, Set<string>>();
  /** 正在 runTicket 的单：4 的登记表按 ticket_id 释放，同一单绝不能同时有两个 runTicket（T-048） */
  const coding = new Set<string>();
  /** 收到但还没带给编码池的接口变更说明（T-038，v1 只在内存里） */
  const pendingNotes = new Map<string, string[]>();
  /** 每单收到的接口变更通知计数：评审开始后又涨了，就在交出去之前再评审一次 */
  const noteSeq = new Map<string, number>();

  function register(t: SubAgentTicket): void {
    if (!t.ticket_id || !t.project_id) throw new Error("需求单必须带 ticket_id 和 project_id");
    registry.set(t.ticket_id, t);
  }

  function isFull(t: object): t is SubAgentTicket {
    const x = t as Partial<SubAgentTicket>;
    return (
      typeof x.ticket_id === "string" &&
      typeof x.project_id === "string" &&
      typeof x.ticket_text === "string" &&
      typeof x.base_commit === "string" &&
      Array.isArray(x.permission_list)
    );
  }

  /** 9 只给 SchedulerTicket（或只有 ticket_id）：先查本进程登记，再 loadTicket，最后才用传进来的完整单。 */
  async function lookup(t: { ticket_id: string }): Promise<SubAgentTicket> {
    const hit =
      registry.get(t.ticket_id) ??
      (await deps.loadTicket?.(t.ticket_id)) ??
      (isFull(t) ? t : undefined);
    if (!hit)
      throw new Error(
        `8 找不到需求单 ${t.ticket_id}：本进程没有登记过，deps.loadTicket 也没给出（续跑、冲突复投、重审都需要完整的需求单）`,
      );
    register(hit);
    return hit;
  }

  function assertWorktree(path: string): void {
    const rel = relative(root, realOrResolved(path));
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel))
      throw new Error(`worktree 路径不在 4 的 worktree 根目录 ${deps.worktreeRoot} 下：${path}`);
  }

  async function history(ticket_id: string): Promise<number> {
    return Math.max(0, (await deps.resubmitHistory(ticket_id)).review);
  }

  function ctx(t: SubAgentTicket, is_resubmit: boolean): CallCtx {
    return {
      role: "sub_agent",
      requirement_id: t.requirement_id,
      ticket_id: t.ticket_id,
      is_resubmit,
      trace: { trace_id: t.trace_id, span_id: t.span_id, parent_span_id: t.parent_span_id },
    };
  }

  function common(t: SubAgentTicket) {
    return {
      trace_id: t.trace_id,
      span_id: t.span_id,
      parent_span_id: t.parent_span_id,
      requirement_id: t.requirement_id,
      ticket_id: t.ticket_id,
    };
  }

  async function say(
    t: SubAgentTicket,
    kind: "dispatch" | "report" | "review_verdict" | "resubmit" | "escalation",
    content: string,
  ): Promise<void> {
    await deps.publish({
      ...common(t),
      type: "group_message",
      payload: { project_id: t.project_id, sender: "sub_agent", kind, content, flash_calls: [] },
    });
  }

  /** 只有 handle 模式写状态（merge_queued 及之前）；之后的状态归 9。 */
  async function setStatus(s: RunState, status: TicketStatus): Promise<void> {
    if (s.mode !== "handle") return;
    await deps.tickets.setStatus(s.ticket.ticket_id, status);
  }

  async function constraints(t: SubAgentTicket): Promise<string[]> {
    if (t.architecture_constraints) return [...t.architecture_constraints];
    return [...((await deps.architectureConstraints?.(t.project_id)) ?? [])];
  }

  async function prompt(t: SubAgentTicket): Promise<string> {
    if (deps.buildPrompt) return deps.buildPrompt(t);
    const tpl = (await deps.promptTemplate?.("sub_agent"))?.trim();
    const body = `## 需求单 ${t.ticket_id}\n${t.ticket_text}`;
    return tpl ? `${tpl}\n\n${body}` : body;
  }

  async function nextRound(ticket_id: string): Promise<number> {
    let prev = lastRound.get(ticket_id);
    if (prev === undefined) {
      prev = 0;
      if (deps.rounds.list) {
        try {
          for (const r of await deps.rounds.list(ticket_id)) prev = Math.max(prev, r.round);
        } catch (e) {
          logger.warn(
            `[bakacoding/sub-agent] 读 ${ticket_id} 的轮次记录失败，轮次从内存续编：${String(e)}`,
          );
        }
      }
    }
    const n = prev + 1;
    lastRound.set(ticket_id, n);
    return n;
  }

  function logClamp(t: SubAgentTicket, r: GeneratedPermissions, when: string): void {
    if (r.ignored_scope.length > 0)
      logger.warn(
        `[bakacoding/sub-agent] ${t.ticket_id} 写入范围里有不安全的条目（含 .. / . / 绝对路径等），按不匹配任何东西处理：${r.ignored_scope.join(", ")}`,
      );
    if (r.cut.length === 0) return;
    const scope = t.write_scope?.length ? t.write_scope.join(", ") : "**";
    logger.warn(
      `[bakacoding/sub-agent] ${t.ticket_id} ${when}权限清单里有 ${r.cut.length} 条权限超出写入范围 [${scope}] 或不安全，已裁剪（范围外的 rw 降为只读，不安全的 rw 丢掉、ro 改为 deny）：${r.cut.map((c) => `${c.entry.glob}（${c.reason}）`).join(", ")}`,
    );
  }

  async function grantedFor(t: SubAgentTicket): Promise<string[]> {
    const durable = (await deps.grantedScopes?.(t.ticket_id)) ?? [];
    return [...durable, ...(grantedHere.get(t.ticket_id) ?? [])];
  }

  /**
   * 读需求单记录；还是空的（拆单时写 []）就按需求单生成、裁掉超出写入范围的写权限（记日志）、写进记录。
   * 非空时也按「写入范围 ∪ 已批准范围」重新裁剪（#47：记录可能是修复前生成的、或被别处写过），有改动就写回记录。
   */
  async function readOrGenerate(t: SubAgentTicket): Promise<PermissionList> {
    const stored = await permissionStore.get(t);
    if (stored && stored.length > 0) {
      const r = clampPermissionList(stored, t.write_scope, await grantedFor(t));
      logClamp(t, r, "需求单记录里的");
      if (r.cut.length > 0) await permissionStore.set(t, r.permission_list);
      return r.permission_list;
    }
    const r = generatePermissionList(t);
    logClamp(t, r, "");
    await permissionStore.set(t, r.permission_list);
    return r.permission_list;
  }

  /** 排进本单的写回链：前一个写回出错不影响后一个（错误由调用方拿到）。 */
  function chain<T>(t: SubAgentTicket, job: () => Promise<T>): Promise<T> {
    const prev = permissionWrites.get(t.ticket_id) ?? Promise.resolve();
    const run = prev.then(job);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    permissionWrites.set(t.ticket_id, tail);
    void tail.then(() => {
      if (permissionWrites.get(t.ticket_id) === tail) permissionWrites.delete(t.ticket_id);
    });
    return run;
  }

  /**
   * 本单权威权限清单（T-048）：先等本单还没写完的批准写回，再从 2 的需求单记录读（空就生成并写入）。
   * 非空就原样用（可能含写回的已批准范围）。
   */
  function permissionsFor(t: SubAgentTicket): Promise<PermissionList> {
    return chain(t, () => readOrGenerate(t));
  }

  /** 批准的范围以 rw 追加并写回需求单记录。 */
  function writeBackGrant(t: SubAgentTicket, granted: readonly string[]): Promise<PermissionList> {
    const unsafe = granted.filter(isUnsafeGlob);
    if (unsafe.length > 0)
      logger.warn(
        `[bakacoding/sub-agent] ${t.ticket_id} 批准的写入范围里有不安全的 glob，不写回：${unsafe.join(", ")}`,
      );
    granted = granted.filter((g) => !isUnsafeGlob(g));
    let mine = grantedHere.get(t.ticket_id);
    if (!mine) grantedHere.set(t.ticket_id, (mine = new Set()));
    for (const g of granted) mine.add(g);
    return chain(t, async () => {
      const next = appendGrantedScope(await readOrGenerate(t), granted);
      await permissionStore.set(t, next);
      return next;
    });
  }

  /** 本单的有效写入范围：没写按 `**`；不安全的条目不匹配任何东西。 */
  function scopeOf(t: SubAgentTicket): string[] {
    return t.write_scope && t.write_scope.length > 0 ? safeScope(t.write_scope) : ["**"];
  }

  /**
   * 审批本单的越界写申请（T-038，8 是唯一答复方）：
   * 0. 有任一条带通配字符（`* ? [ ] { } ( ) ! + @`，T-053）→ 拒绝，不交 9、不写回；
   * 1. 有不安全的路径（`isUnsafeGlob`）→ 拒绝，不交 9、不写回；
   * 2. 被本单权限清单显式 deny 的 → 拒绝；
   * 3. 全部落在「写入范围 ∪ 已批准范围」里 → 直接批；否则把范围外的部分交 `deps.scheduler.extendScope`，成功才批。
   * 批准时先发 `write_scope_granted`，发成功后再写回需求单记录（`writeBackGrant`）；拒绝发 `write_scope_denied`。
   */
  async function decideScopeRequest(
    t: SubAgentTicket,
    req: { trace_id: string; span_id: string; request_id: string; requested_scope: string[] },
  ): Promise<void> {
    const { request_id } = req;
    const requested = [...new Set(req.requested_scope)];
    const head = {
      trace_id: req.trace_id,
      span_id: randomUUID(),
      parent_span_id: req.span_id,
      requirement_id: t.requirement_id,
      ticket_id: t.ticket_id,
    };
    const deny = async (reason: string): Promise<void> => {
      await deps.publish({
        ...head,
        type: "write_scope_denied",
        payload: { request_id, requested_scope: requested, reason },
      });
    };
    try {
      // 最先检查（T-053）：申请的应是具体路径，任一条带通配字符整条拒绝，不交 9、不写回
      const wild = requested.filter((g) => SCOPE_REQUEST_WILDCARD.test(g));
      if (wild.length > 0)
        return await deny(`申请的是具体路径，不接受通配字符：${wild.join(", ")}`);
      const unsafe = requested.filter(isUnsafeGlob);
      if (requested.length === 0 || unsafe.length > 0)
        return await deny(
          `申请的路径不安全（含 .. / . 段、绝对路径等），不批：${unsafe.join(", ") || "（空）"}`,
        );
      const list = await permissionsFor(t);
      const denied = requested.filter((g) => explicitlyDenied(list, g));
      if (denied.length > 0) return await deny(`本单权限清单显式拒绝：${denied.join(", ")}`);
      const allowed = [...scopeOf(t), ...(await grantedFor(t))];
      const outside = requested.filter((g) => !globWithinScope(g, allowed));
      if (outside.length > 0) {
        if (!deps.scheduler)
          return await deny(
            `申请超出本单写入范围，且没有接 9 的 extendScope：${outside.join(", ")}`,
          );
        const r = await deps.scheduler.extendScope(t.ticket_id, outside);
        if (!r.ok) return await deny(r.reason);
      }
    } catch (err) {
      logger.warn(
        `[bakacoding/sub-agent] ${t.ticket_id} 审批越界写申请出错，按拒绝处理：${String(err)}`,
      );
      return deny(`审批出错：${String(err)}`.slice(0, 500));
    }
    // 先发事件（4 据此放行，2 的事件日志据此跨重启保留批准范围），再写回需求单记录
    await deps.publish({
      ...head,
      type: "write_scope_granted",
      payload: { request_id, granted_scope: requested },
    });
    await writeBackGrant(t, requested).catch((err: unknown) =>
      logger.warn(
        `[bakacoding/sub-agent] ${t.ticket_id} 批准的写入范围 ${requested.join(", ")} 写回需求单记录失败（重启前靠内存、重启后靠事件日志）：${String(err)}`,
      ),
    );
  }

  /**
   * 给 runTicket 的 `scope_requests`（不注入 deps.scopeRequests 就不带）。bus 包一层：4 发的申请原样发到总线，
   * 然后由 8 审批并答复（T-038）；订阅原样转给总线。
   */
  function scopeRequestsFor(t: SubAgentTicket): ScopeRequestOptions | undefined {
    const sr = deps.scopeRequests;
    if (!sr) return undefined;
    const bus: ScopeBus = {
      async publish(input) {
        const r = await sr.bus.publish(input);
        if (input.ticket_id !== t.ticket_id) {
          logger.warn(
            `[bakacoding/sub-agent] ${t.ticket_id} 的工具发来别的单（${input.ticket_id}）的越界写申请，不答复`,
          );
          return r;
        }
        await decideScopeRequest(t, {
          trace_id: input.trace_id,
          span_id: input.span_id,
          request_id: input.payload.request_id,
          requested_scope: input.payload.requested_scope,
        }).catch((err: unknown) =>
          logger.warn(`[bakacoding/sub-agent] ${t.ticket_id} 答复越界写申请失败：${String(err)}`),
        );
        return r;
      },
      subscribe: sr.bus.subscribe.bind(sr.bus) as ScopeBus["subscribe"],
    };
    return {
      bus,
      ctx: {
        requirement_id: t.requirement_id,
        trace: { trace_id: t.trace_id, span_id: t.span_id },
      },
      ...(sr.timeout_ms !== undefined ? { timeout_ms: sr.timeout_ms } : {}),
    };
  }

  /** 取出本单待带的接口变更说明（取走即清空）。 */
  function takeNotes(ticket_id: string): string[] {
    const n = pendingNotes.get(ticket_id) ?? [];
    pendingNotes.delete(ticket_id);
    return n;
  }

  /** 没带出去的说明放回队首（runTicket 抛错时）。 */
  function restoreNotes(ticket_id: string, notes: readonly string[] | undefined): void {
    if (!notes?.length) return;
    const merged = [...notes, ...(pendingNotes.get(ticket_id) ?? [])].slice(-MAX_INTERFACE_NOTES);
    pendingNotes.set(ticket_id, merged);
  }

  function remember(s: RunState): void {
    active.set(s.ticket.ticket_id, { ...s, counts: { ...s.counts } });
  }

  async function escalate(
    s: RunState,
    reason: SubAgentEscalationReason,
    detail?: string,
  ): Promise<SubAgentOutcome> {
    remember(s);
    await setStatus(s, "escalated");
    const resubmit_counts = { ...s.counts };
    await deps.publish({
      ...common(s.ticket),
      type: "escalated",
      payload: { reason, resubmit_counts, ...(detail !== undefined ? { detail } : {}) },
    });
    await say(
      s.ticket,
      "escalation",
      `${s.ticket.ticket_id} 上报主管：${reason}${detail ? `（${detail}）` : ""}；评审复投 ${resubmit_counts.review} 次，冲突复投 ${resubmit_counts.conflict} 次。`,
    );
    return { kind: "escalated", reason, detail, pr_id: s.pr_id, resubmit_counts };
  }

  /** 计一次评审复投：恰好发一条 kind=resubmit 的群消息（eventLogResubmitHistory 靠它跨重启计数）。 */
  async function countResubmit(s: RunState, feedback: string, why: string): Promise<void> {
    s.counts.review++;
    s.feedback = feedback;
    s.is_resubmit = true;
    s.phase = "coding";
    const effort = effortFor(deps.getConfig(), s.counts);
    await say(
      s.ticket,
      "resubmit",
      `${s.ticket.ticket_id} ${why}，原地复投（评审复投 ${s.counts.review} 次，冲突复投 ${s.counts.conflict} 次，档位 ${effort}）。`,
    );
  }

  /** 编码池或评审报预算耗尽：当日预算用完 → 暂停待续跑（不上报、不计复投）；否则按本单预算上报。 */
  async function budgetStop(s: RunState): Promise<SubAgentOutcome> {
    s.stage = "budget";
    const st = await deps.budgetState(s.ticket.ticket_id);
    const ticketExhausted = st.ticket?.exhausted === true;
    if (st.daily_exhausted && !ticketExhausted) {
      remember(s);
      await setStatus(s, "pending");
      await say(
        s.ticket,
        "report",
        `${s.ticket.ticket_id} 当日预算已用完，${s.phase === "coding" ? "编码" : "评审"}暂停，等预算重置后在同一 worktree 续跑（不计复投）。`,
      );
      const resume: ResumeToken = {
        ticket_id: s.ticket.ticket_id,
        worktree_path: s.worktree_path,
        branch: s.branch,
        base_commit: s.base_commit,
        worktree_round: s.worktree_round,
        pr_id: s.pr_id,
        resubmit_counts: { ...s.counts },
        phase: s.phase,
        is_resubmit: s.is_resubmit,
        mode: s.mode,
        ...(s.feedback !== undefined ? { feedback: s.feedback } : {}),
        ...(s.last ? { last: s.last } : {}),
        ...(s.interface_notes?.length ? { interface_notes: [...s.interface_notes] } : {}),
      };
      return { kind: "requeue_budget", resume };
    }
    const t = st.ticket;
    const detail = t
      ? `本单已花 ${t.spent_micro_usd} 微美元，剩余 ${t.remaining_micro_usd}`
      : "编码池报预算耗尽";
    return escalate(s, "budget_exceeded", detail);
  }

  async function loop(s: RunState): Promise<SubAgentOutcome> {
    const limit = deps.getConfig().pipeline.resubmit_limits.review;
    for (;;) {
      throwIfAborted(s.signal);
      remember(s);
      if (s.phase === "coding") {
        const effort = effortFor(deps.getConfig(), s.counts);
        await setStatus(s, s.is_resubmit ? "resubmitting" : "coding");
        if (s.announce !== undefined) {
          await say(s.ticket, "dispatch", `${s.announce}（档位 ${effort}）。`);
          s.announce = undefined;
        }
        // 每次调编码池前都从需求单记录读权限清单（首跑、评审复投、冲突复投、续跑）
        s.stage = "permissions";
        const ticket_id = s.ticket.ticket_id;
        if (coding.has(ticket_id))
          throw new Error(
            `${ticket_id} 已有一个 runTicket 在跑：4 的权限登记表按 ticket_id 释放，同一单不能同时编码两次`,
          );
        coding.add(ticket_id);
        let res: Awaited<ReturnType<SubAgentDeps["coder"]["runTicket"]>>;
        // 接口变更说明（T-038）：作为不可信反馈接在 feedback 后面（5 按 T-043 包装）；s.feedback 本身不变
        const notes = [...(s.interface_notes ?? []), ...takeNotes(ticket_id)].slice(
          -MAX_INTERFACE_NOTES,
        );
        s.interface_notes = notes.length ? notes : undefined;
        const feedback = notes.length
          ? s.feedback !== undefined
            ? `${s.feedback}\n\n${notesSection(notes)}`
            : notesSection(notes)
          : s.feedback;
        try {
          const permission_list = await permissionsFor(s.ticket);
          const scope_requests = scopeRequestsFor(s.ticket);
          s.stage = "coding";
          res = await deps.coder.runTicket({
            ticket: { ticket_id, project_id: s.ticket.project_id },
            prompt: await prompt(s.ticket),
            worktree_path: s.worktree_path,
            permission_list,
            effort,
            ...(feedback !== undefined ? { feedback } : {}),
            ctx: ctx(s.ticket, s.is_resubmit),
            ...(s.signal ? { signal: s.signal } : {}),
            ...(scope_requests ? { scope_requests } : {}),
          });
        } catch (e) {
          restoreNotes(ticket_id, s.interface_notes);
          s.interface_notes = undefined;
          throw e;
        } finally {
          coding.delete(ticket_id);
        }
        throwIfAborted(s.signal);
        // 预算暂停：说明还没真正用上，留在 RunState 里进续跑凭据；否则已带给编码池
        if (res.status === "budget_exceeded") return budgetStop(s);
        s.interface_notes = undefined;

        let failure: { status: CoderFailureStatus; feedback: string } | undefined;
        if (res.status === "done") {
          try {
            // 6 的 commitWorktree 要求先有一条未结束的 PR 记录：第一次提交前开 PR，之后复用同一个 pr_id
            if (s.pr_id === null) {
              s.stage = "open";
              s.pr_id = await deps.pr.open(s.ticket.ticket_id, s.worktree_path, s.branch);
            }
            s.stage = "commit";
            await deps.pr.commitWorktree(s.ticket.ticket_id, s.worktree_path);
          } catch (e) {
            if (e instanceof NoChangesError) {
              failure = {
                status: "done_no_changes",
                feedback: `上一轮报告已完成，但 worktree 里没有任何改动可提交。上一轮的总结：${res.summary}`,
              };
            } else if (e instanceof CommitPatchError) {
              failure = { status: "commit_failed", feedback: e.message };
            } else throw e;
          }
        } else {
          failure = { status: res.status, feedback: res.summary };
        }

        if (failure) {
          await say(
            s.ticket,
            "report",
            `${s.ticket.ticket_id} 编码未交出可提交的改动：${failure.status}。${res.summary}`,
          );
          if (s.counts.review >= limit) return escalate(s, "coder_failed", failure.status);
          await countResubmit(s, failure.feedback, `编码未交出改动（${failure.status}）`);
          continue;
        }
        // 改动文件以 6 的 diff 为准（编码池的 changed_files 只是自报）
        s.stage = "diff";
        const files = (await deps.pr.diff(s.pr_id!)).files.map((f) => f.path);
        s.last = { summary: res.summary, changed_files: files };
        await say(
          s.ticket,
          "report",
          `${s.ticket.ticket_id} 编码完成并已提交：${res.summary}${files.length ? `（改动：${files.join("、")}）` : ""}`,
        );
        s.phase = "review";
      }

      // ---- 评审 ----
      const pr_id = s.pr_id;
      if (pr_id === null) throw new Error(`${s.ticket.ticket_id} 进入评审时还没有 PR`);
      await setStatus(s, "in_review");
      s.stage = "diff";
      if (!s.last) {
        // 重审 / 重启后接着评：没有本进程的编码结果，从 diff 取改动文件
        const files = (await deps.pr.diff(pr_id)).files.map((f) => f.path);
        s.last = { summary: "", changed_files: files };
      }
      const seqAtReview = noteSeq.get(s.ticket.ticket_id) ?? 0;
      const baseSummary = deps.summarize
        ? await deps.summarize({
            ticket: s.ticket,
            summary: s.last.summary,
            changed_files: s.last.changed_files,
          })
        : defaultSummary(s.last);
      // 编码之后才收到的接口变更说明也给评审看（摘要整体由 7 包进不可信区块）
      const lateNotes = pendingNotes.get(s.ticket.ticket_id) ?? [];
      const summary = lateNotes.length
        ? `${baseSummary}\n\n${notesSection(lateNotes)}`
        : baseSummary;
      // 本轮 diff 在评审前取一次，绑定当时的 head（diff.head_sha）；评审不改代码，评审后写轮次记录沿用同一份
      s.stage = "diff";
      const diff = await deps.pr.diff(pr_id);
      // 依赖类单标高风险（T-038）：主管标了 kind: "dependency"，或 diff 改了依赖清单 / 锁文件；
      // 改名的文件看新旧路径（isHighRiskDiffFile，T-065）
      let high_risk = s.ticket.kind === "dependency" || diff.files.some(isHighRiskDiffFile);
      let result: ReviewResult;
      s.stage = "permissions";
      const permission_list = await permissionsFor(s.ticket);
      s.stage = "review";
      try {
        result = await deps.review({
          ticket: {
            ticket_id: s.ticket.ticket_id,
            ticket_text: s.ticket.ticket_text,
            architecture_constraints: await constraints(s.ticket),
          },
          pr_id,
          permission_list,
          summary,
          ctx: ctx(s.ticket, s.is_resubmit),
          ...(s.signal ? { signal: s.signal } : {}),
          ...(high_risk ? { high_risk: true } : {}),
        });
      } catch (e) {
        throwIfAborted(s.signal);
        if (isBudgetExceeded(e)) return budgetStop(s);
        throw e;
      }
      throwIfAborted(s.signal);
      s.stage = "round_save";
      const round = await nextRound(s.ticket.ticket_id);
      await deps.rounds.save({
        ticket_id: s.ticket.ticket_id,
        round,
        diff,
        verdict: result.verdict,
        fail_reasons: result.reasons.map(formatReason),
        ...(s.feedback !== undefined ? { review_comments: s.feedback } : {}),
        // 原样保存：成员 id、"supervisor" 或 null（CI 失败没调模型）
        reviewer: result.reviewer,
      });
      await say(
        s.ticket,
        "review_verdict",
        result.verdict === "pass"
          ? `${s.ticket.ticket_id} 第 ${round} 轮评审通过（评审：${result.reviewer ?? "无，未调模型"}）。`
          : `${s.ticket.ticket_id} 第 ${round} 轮评审不过（评审：${result.reviewer ?? "无，CI 失败"}）：\n${result.reasons.map((r) => `- ${formatReason(r)}`).join("\n")}`,
      );

      if (result.verdict === "pass") {
        // 评审期间收到了影响本单的接口变更、本单还没交给 9：交出去之前再评审一次，不计复投（T-038）
        if ((noteSeq.get(s.ticket.ticket_id) ?? 0) !== seqAtReview) {
          await say(
            s.ticket,
            "report",
            `${s.ticket.ticket_id} 评审期间收到接口变更通知，交出前再评审一次（不计复投）。`,
          );
          continue;
        }
        // 交给 9 之前终判高风险（T-041c）：PR 的 head 已不是评审前那次 diff 的 head，按新 diff 重判；
        // 取不到 diff（不知道合进去的是什么）一律按高风险
        if (!high_risk) high_risk = await headStillJudged(s.ticket, pr_id, diff.head_sha);
        remember(s);
        if (s.submit) {
          // 先写 merge_queued 再交给 9：交出去之后的状态归 9，8 不再写
          await setStatus(s, "merge_queued");
          s.stage = "submit";
          await deps.submit({
            ticket_id: s.ticket.ticket_id,
            pr_id,
            worktree_path: s.worktree_path,
            round: s.worktree_round,
            review_resubmits: s.counts.review,
            base_commit: s.base_commit,
            ...(high_risk ? { high_risk: true } : {}),
          });
        }
        return {
          kind: "merge_queued",
          pr_id,
          round,
          resubmit_counts: { ...s.counts },
          reviewer: result.reviewer,
          ...(high_risk ? { high_risk: true } : {}),
        };
      }
      if (s.counts.review >= limit) return escalate(s, "review_limit");
      await countResubmit(s, reasonsToFeedback(result.reasons), "评审不过");
    }
  }

  /**
   * 评审通过、交给 9 之前确认 PR 的 head 还是评审前取 diff 时的那个（T-041c）。
   * 返回终判的 high_risk：head 没变沿用评审前的判定（false）；变了按新 diff 重判；重新取 diff 失败按高风险。
   */
  async function headStillJudged(
    ticket: SubAgentTicket,
    pr_id: string,
    reviewed_head: string,
  ): Promise<boolean> {
    let latest: Awaited<ReturnType<typeof deps.pr.diff>>;
    try {
      latest = await deps.pr.diff(pr_id);
    } catch (e) {
      logger.warn(
        `[bakacoding/sub-agent] ${ticket.ticket_id} 交出前重新取 PR ${pr_id} 的 diff 失败，按高风险处理：${String(e)}`,
      );
      return true;
    }
    if (latest.head_sha === reviewed_head) return false;
    logger.warn(
      `[bakacoding/sub-agent] ${ticket.ticket_id} 的 PR ${pr_id} 在评审期间 head 变了（${reviewed_head} → ${latest.head_sha}），按新 diff 重判高风险`,
    );
    return ticket.kind === "dependency" || latest.files.some(isHighRiskDiffFile);
  }

  /** handle 模式：未分类的异常也上报，不让单子卡在 coding；其他模式交给 9 处理。 */
  async function run(s: RunState): Promise<SubAgentOutcome> {
    try {
      return await loop(s);
    } catch (e) {
      // 取消：原样抛 signal.reason，不上报、不写状态（T-039）
      if (s.signal?.aborted) throw abortReason(s.signal);
      if (s.mode !== "handle") throw e;
      logger.warn(
        `[bakacoding/sub-agent] ${s.ticket.ticket_id} 在 ${s.stage} 阶段出错，上报：${String(e)}`,
      );
      return escalate(s, STAGE_REASON[s.stage], errorDetail(s.stage, e));
    }
  }

  /**
   * 重审要接着用的运行状态。注入了 `prRecords` 时以 2 的 PR 记录为准（T-039）：确认是本单当前 PR，
   * worktree / 分支 / 基线取记录里的；本进程跑过同一个 PR 时再沿用内存里的编码摘要和计数。
   * 没注入时只认本进程跑过的单（T-037 行为）。
   */
  async function reReviewState(ticket: SubAgentTicket, pr_id: string): Promise<RunState> {
    const a = active.get(ticket.ticket_id);
    const mem = a && a.pr_id === pr_id ? a : undefined;
    if (!deps.prRecords) {
      if (!mem) throw new Error(`${ticket.ticket_id} 的当前 PR 不是 ${pr_id}，无法重审`);
      return mem;
    }
    const rec = await deps.prRecords.get(pr_id);
    if (!rec) throw new Error(`2 里没有 PR 记录 ${pr_id}，无法重审 ${ticket.ticket_id}`);
    if (rec.kind !== "ticket" || rec.ticket_id !== ticket.ticket_id || !rec.worktree_path)
      throw new Error(`PR ${pr_id} 不属于 ${ticket.ticket_id}，无法重审`);
    if (rec.status !== "open" && rec.status !== "conflict")
      throw new Error(
        `${ticket.ticket_id} 的 PR ${pr_id} 已是 ${rec.status}，不是当前 PR，无法重审`,
      );
    assertWorktree(rec.worktree_path);
    if (mem) return { ...mem, worktree_path: rec.worktree_path, branch: rec.branch };
    // 重启后：本进程没跑过这张单。评审复投数从事件日志恢复；冲突复投数取 worktree 轮次 n（每次冲突复投建 r<n+1>）
    const worktree_round = roundFromPath(rec.worktree_path);
    return {
      ticket,
      worktree_path: rec.worktree_path,
      branch: rec.branch,
      base_commit: rec.base_sha,
      worktree_round,
      pr_id,
      counts: { review: await history(ticket.ticket_id), conflict: worktree_round },
      phase: "review",
      is_resubmit: true,
      mode: "rereview",
      submit: false,
      stage: "review",
    };
  }

  function toScheduler(o: SubAgentOutcome): SchedulerFacingOutcome {
    if (o.kind === "merge_queued")
      return { pr_id: o.pr_id, review_resubmits: o.resubmit_counts.review };
    if (o.kind === "escalated")
      return o.pr_id ? { escalated: true, pr_id: o.pr_id } : { escalated: true };
    return { requeue_budget: true, resume: o.resume };
  }

  function onInterfaceChanged(e: EventOf<"interface_changed">): void {
    const note = interfaceNote(e);
    for (const id of new Set(e.payload.affected_ticket_ids)) {
      if (id === e.ticket_id) continue;
      const list = [...(pendingNotes.get(id) ?? []), note].slice(-MAX_INTERFACE_NOTES);
      pendingNotes.set(id, list);
      noteSeq.set(id, (noteSeq.get(id) ?? 0) + 1);
    }
  }

  const agent: SubAgent = {
    async handle(ticket, options: HandleOptions = {}) {
      throwIfAborted(options.signal);
      register(ticket);
      let wt = options.worktree;
      let worktree_round = options.worktree_round;
      if (!wt) {
        if (!deps.worktrees) throw new Error("没有传 worktree，也没有注入 deps.worktrees");
        wt = await deps.worktrees.create(ticket.ticket_id, ticket.base_commit, 0);
        worktree_round ??= 0;
      }
      assertWorktree(wt.path);
      // 重启后接着跑：评审复投计数从事件日志恢复，超限照样上报
      const review = await history(ticket.ticket_id);
      return run({
        ticket,
        worktree_path: wt.path,
        branch: wt.branch,
        base_commit: ticket.base_commit,
        worktree_round: worktree_round ?? roundFromPath(wt.path),
        pr_id: options.pr_id ?? null,
        counts: { review, conflict: 0 },
        phase: "coding",
        is_resubmit: review > 0,
        mode: "handle",
        submit: true,
        announce:
          review > 0
            ? `${ticket.ticket_id} 重启后接着编码（已评审复投 ${review} 次）`
            : `${ticket.ticket_id} 派给 Flash 编码`,
        stage: "coding",
        ...(options.signal ? { signal: options.signal } : {}),
      });
    },

    async resume(minimal, token, options = {}) {
      throwIfAborted(options.signal);
      const ticket = await lookup(minimal);
      if (token.ticket_id !== ticket.ticket_id)
        throw new Error(`续跑凭据属于 ${token.ticket_id}，不是 ${ticket.ticket_id}`);
      assertWorktree(token.worktree_path);
      const review = Math.max(token.resubmit_counts.review, await history(ticket.ticket_id));
      return run({
        ticket,
        worktree_path: token.worktree_path,
        branch: token.branch,
        base_commit: token.base_commit,
        worktree_round: token.worktree_round,
        pr_id: token.pr_id,
        counts: { review, conflict: token.resubmit_counts.conflict },
        phase: token.phase,
        feedback:
          token.phase === "coding"
            ? token.feedback
              ? `${BUDGET_RESUME_NOTE}\n\n${token.feedback}`
              : BUDGET_RESUME_NOTE
            : token.feedback,
        is_resubmit: token.is_resubmit,
        ...(token.last ? { last: token.last } : {}),
        ...(token.interface_notes?.length ? { interface_notes: [...token.interface_notes] } : {}),
        mode: token.mode ?? "handle",
        // 9 的 resume 约定：续跑评审通过一律由 8 调 submit（含冲突复投途中暂停的单）
        submit: true,
        announce: `${ticket.ticket_id} 预算重置，续跑`,
        stage: token.phase === "coding" ? "coding" : "review",
        ...(options.signal ? { signal: options.signal } : {}),
      });
    },

    async resubmitConflict(req: ConflictResubmitRequest) {
      const ticket = await lookup(req.ticket);
      assertWorktree(req.worktree_path);
      const base_commit = deps.resolveBase
        ? await deps.resolveBase(req.worktree_path)
        : req.base_commit;
      const review = Math.max(req.resubmit_counts.review, await history(ticket.ticket_id));
      const o = await run({
        ticket,
        worktree_path: req.worktree_path,
        branch: req.branch,
        base_commit,
        worktree_round: req.round,
        pr_id: null, // 新 worktree、新分支：开新 PR，旧 PR 由 9 关闭
        counts: { review, conflict: req.resubmit_counts.conflict },
        phase: "coding",
        feedback: conflictFeedback(req.base_commit, req.conflicted_files),
        is_resubmit: true,
        mode: "conflict",
        submit: false,
        announce: `${ticket.ticket_id} 合并冲突，基于新基线重新编码（冲突复投 ${req.resubmit_counts.conflict} 次）`,
        stage: "coding",
      });
      return toScheduler(o);
    },

    async reReview(req: ReReviewRequest) {
      const ticket = await lookup(req.ticket);
      const a = await reReviewState(ticket, req.pr_id);
      const o = await run({
        ...a,
        counts: { ...a.counts },
        phase: "review",
        feedback: undefined,
        is_resubmit: true, // 交回原评审成员
        mode: "rereview",
        submit: false,
        announce: undefined,
        stage: "review",
        signal: undefined, // 不沿用 handle 时的取消信号
      });
      return toScheduler(o);
    },

    onInterfaceChanged,

    attach(bus) {
      return bus.subscribe("interface_changed", (e) => {
        try {
          onInterfaceChanged(e);
        } catch (err) {
          logger.warn(`[bakacoding/sub-agent] 处理 interface_changed 出错：${String(err)}`);
        }
      });
    },
  };
  // recordGrantedScope 只留内部用（T-038）：生产路径只在审批通过、发完 write_scope_granted 之后调 writeBackGrant
  registerRecorder(agent, async (minimal, granted_scope) =>
    writeBackGrant(await lookup(minimal), granted_scope),
  );
  return agent;
}

function defaultSummary(last: LastRun): string {
  const files = last.changed_files.length ? last.changed_files.join("、") : "（diff 里没有文件）";
  return `${last.summary || "（没有编码摘要）"}\n\n改动文件（来自 6 的 diff）：${files}`;
}
