// T-040：模块 10 主管——chat / split / 手动单 / loadTicket / 项目导入告知。T-041a：重启接管 takeOver。
import { randomBytes, randomUUID } from "node:crypto";
import { HighRiskDecisionError, type SchedulerTicket } from "@bakacoding/scheduler";
import type { StoredTicket } from "@bakacoding/storage";
import { highRiskEvidence, type HighRiskReason, type SubAgentTicket } from "@bakacoding/sub-agent";
import type { TicketFields } from "@bakacoding/storage";
import {
  untrustedNotice,
  wrapUntrusted,
  type CallCtx,
  type EventOf,
  type TicketStatus,
  type Trace,
} from "@bakacoding/types";
import { isUnsafeGlob } from "@bakacoding/workspace";
import {
  ChatOutputSchema,
  OUTPUT_SPEC,
  parseOutput,
  SplitOutputSchema,
  type SplitOutput,
} from "./output.js";
import {
  SPLIT_MAX_ATTEMPTS,
  type ChatReply,
  type EscalationAction,
  type ManualTicketInput,
  type SplitRequest,
  type SplitResult,
  type Supervisor,
  type BackpressurePausedInput,
  type HighRiskDecisionResult,
  type HighRiskHeldInput,
  type PendingHighRisk,
  type SupervisorDeps,
  type SupervisorTicket,
  type TakeOverReport,
  type TicketValidationError,
  type UserMessage,
} from "./types.js";
import {
  decodeFields,
  encodeFields,
  MAX_REQUIREMENT_TEXT,
  readMarkers,
  readResplit,
  truncateRequirement,
  type FieldsExtra,
  type Markers,
  type StoredFields,
} from "./fields.js";
import { directoryChecker, findCycle, topoOrder, validateWriteScope } from "./validate.js";

/** 拆单 3 次都不合法（包内用，chat 据此回 split_failed）。 */
class SplitInvalidError extends Error {
  override name = "SplitInvalidError";
  constructor(readonly errors: TicketValidationError[]) {
    super(`拆单 ${SPLIT_MAX_ATTEMPTS} 次都没有通过校验：${formatErrors(errors)}`);
  }
}

function formatErrors(errors: readonly TicketValidationError[]): string {
  return errors
    .slice(0, 20)
    .map(
      (e) =>
        `[${e.code}]${e.ticket ? ` 单 ${e.ticket}` : ""}${e.entry ? ` 条目 ${e.entry}` : ""}：${e.message}`,
    )
    .join("\n");
}

/** 去掉项目名 / id 之后判断剩下的是不是一条独立的消息：去掉标点、空白和常见虚词后至少 2 个字符。 */
const FILLER = /项目|就是|是|就|用|吧|的|那个|这个|呢|啊|哦|嗯|好|选/g;
function meaningful(text: string): boolean {
  return text.replace(/[\p{P}\p{S}\s]/gu, "").replace(FILLER, "").length >= 2;
}

/**
 * 项目名 / id 在原文里的匹配：纯 ASCII 的按词边界匹配（`ui` 不匹配 `rebuild`），含非 ASCII 字符的（如中文名）按子串匹配。
 * 忽略大小写；少于 2 个字符的不匹配。
 */
function tokenRegExp(token: string): RegExp | undefined {
  if (token.length < 2) return undefined;
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7f]+$/.test(token)
    ? new RegExp(`(?<![A-Za-z0-9_])${esc}(?![A-Za-z0-9_])`, "gi")
    : new RegExp(esc, "gi");
}

function mentionsToken(text: string, token: string): boolean {
  const re = tokenRegExp(token);
  return re ? re.test(text) : false;
}

/** 从用户原文里去掉认领用的项目名和 project_id，再去掉首尾标点空白。 */
function stripProject(text: string, project: { project_id: string; name: string }): string {
  let out = text;
  for (const token of [project.project_id, project.name]) {
    const re = tokenRegExp(token);
    if (re) out = out.replace(re, " ");
  }
  return out.replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, "").replace(/\s{2,}/g, " ");
}

/** 认领暂存需求 + 处理同一条消息里的新内容：文字拼接，单号合并；新内容还要追问项目时以追问为准。 */
function mergeReplies(first: ChatReply, second: ChatReply): ChatReply {
  const ticket_ids = [...(first.ticket_ids ?? []), ...(second.ticket_ids ?? [])];
  return {
    ...first,
    text: `${first.text}\n\n${second.text}`,
    kind: second.kind === "ask_project" ? "ask_project" : first.kind,
    ...(ticket_ids.length ? { ticket_ids } : {}),
  };
}

const MAX_FILES_IN_PROMPT = 500;
const MAX_FEEDBACK_DETAIL = 2000;

/** 重启接管：这些状态的单重新 enqueue（派单时组合根按 PR 记录沿用已开的 PR，不重复开）。 */
const TAKEOVER_ENQUEUE: ReadonlySet<TicketStatus> = new Set<TicketStatus>([
  "pending",
  "coding",
  "in_review",
  "resubmitting",
]);
/** 重启接管：这些状态的单已在合并队列里，经 9 的 adopt 直接恢复成 merge_queued（不派单）。 */
const TAKEOVER_ADOPT: ReadonlySet<TicketStatus> = new Set<TicketStatus>([
  "merge_queued",
  "conflict",
  "re_reviewing",
]);

type EscalationReason = EventOf<"escalated">["payload"]["reason"];

/** 失败单重拆（T-041b，提案 §3）：评审超限、编码池失败、冲突超限。 */
const RESPLIT_REASONS: ReadonlySet<EscalationReason> = new Set<EscalationReason>([
  "review_limit",
  "coder_failed",
  "conflict_limit",
]);
/**
 * 只通知、不写 escalation_handled 的原因：`merged_but` 的单仍是 merged，`scope_lock_failed` 的单还在跑；
 * 写了标记会挡住这张单以后真正的上报（Q10 的「处理过只通知」）。
 */
const NOTIFY_ONLY_REASONS: ReadonlySet<EscalationReason> = new Set<EscalationReason>([
  "merged_but",
  "scope_lock_failed",
]);
/** 高风险理由的中文（通知用；T-062 界面另配文案） */
const HR_REASON_TEXT: Record<HighRiskReason, string> = {
  dependency_kind: "依赖类单",
  dependency_file: "改动了依赖清单 / 锁文件或有改名的文件",
  diff_unavailable: "取不到 diff，按高风险处理",
  unverified: "评审交出时没能确认最新 diff，按高风险处理",
};
const HR_REASON_TEXT_JOIN = (rs: readonly HighRiskReason[]) =>
  rs.map((r) => HR_REASON_TEXT[r]).join("；");
const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 关旧 PR 失败后的重试间隔（30 秒、2 分钟、10 分钟），之后交用户。包内常量，不进 index.ts。 */
export const PR_CLOSE_RETRY_MS: readonly number[] = [30_000, 120_000, 600_000];
/** 每次 takeOver 最多补跑的上报处理张数（Q-E），其余进 held、下次再补。包内常量，不进 index.ts。 */
export const TAKEOVER_REPLAY_LIMIT = 5;

const REASON_TEXT: Record<EscalationReason, string> = {
  review_limit: "评审不过超过复投上限",
  conflict_limit: "合并冲突超过复投上限",
  scope_lock_failed: "扩大写入范围时加锁失败",
  resplit_limit: "重拆次数到上限",
  github_manual: "GitHub 需要人工处理",
  coder_failed: "编码代理多次没交出可用的改动",
  budget_exceeded: "本单预算用完",
  internal_error: "内部出错",
  merged_but: "已合入集成分支，但之后的收尾出错",
  high_risk_rejected: "高风险 PR 被拒绝",
};

/** 反压暂停原因的中文（T-041c，通知用户用；9 的 BackpressureReason）。 */
const BACKPRESSURE_TEXT: Record<string, string> = {
  review_backlog_pause: "评审积压",
  review_backlog_halve: "评审积压（并发减半）",
  review_backlog_recovering: "评审积压回落中",
  supervisor_backlog: "主管待办积压",
  pending_pr_limit: "待合并 PR 超过上限",
  daily_budget: "当日预算用完",
};

interface ProjectInfo {
  project_id: string;
  name: string;
}

export function createSupervisor(deps: SupervisorDeps): Supervisor {
  const newId = deps.newId ?? randomUUID;
  const clock = deps.clock ?? (() => new Date());
  const logger = deps.logger ?? {
    warn: (m: string, d?: unknown) => console.warn(`[supervisor] ${m}`, d ?? ""),
  };
  /** 追问项目时暂存的需求（1:1 历史 v1 不持久化，只在本进程） */
  let pending: { text: string; kind: "requirement" | "decision" } | undefined;
  /** 本进程已交给 9 的单（拆单 / 手动单 / 接管）：takeOver 不再重复 enqueue（9 对重复登记报错） */
  const enqueuedIds = new Set<string>();
  /** 本进程接管时判过 fields_invalid 的单：再次 takeOver 不再重复发警告 */
  const skippedInvalid = new Set<string>();

  const nowIso = () => clock().toISOString();
  const shortId = () =>
    newId()
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 12) || "x";
  const nonce = () => randomBytes(8).toString("hex");

  function projects(): ProjectInfo[] {
    return deps.storage.listProjects().map((r) => ({
      project_id: r.project_id,
      name: r.name || r.project_id,
    }));
  }

  /** 用户原文里字面提到的项目（项目名或 project_id，忽略大小写）；恰好一个才算 */
  function mentioned(text: string, list: ProjectInfo[]): ProjectInfo | undefined {
    const hits = mentionedAll(text, list);
    return hits.length === 1 ? hits[0] : undefined;
  }

  /** 原文里字面提到的全部项目（项目名或 id，忽略大小写） */
  function mentionedAll(text: string, list: ProjectInfo[]): ProjectInfo[] {
    return list.filter((p) => mentionsToken(text, p.project_id) || mentionsToken(text, p.name));
  }

  async function callModel(prompt: string, requirement_id: string, trace: Trace): Promise<string> {
    const cfg = deps.getConfig().roles.supervisor;
    const ctx: CallCtx = {
      role: "supervisor",
      requirement_id,
      ticket_id: null,
      is_resubmit: false,
      trace,
    };
    const r = await deps.call("supervisor", cfg.provider, cfg.model, cfg.effort, prompt, ctx);
    return r.output;
  }

  /** 已有单：用来解析 depends_on、续编单号、沿用需求的 trace */
  function existing(project_id: string) {
    return deps.storage.listTickets({ project_id });
  }

  function nextIndex(
    rows: readonly { ticket_id: string; requirement_id: string }[],
    requirement_id: string,
  ) {
    let max = 0;
    const prefix = `${requirement_id}-`;
    for (const r of rows) {
      if (r.requirement_id !== requirement_id || !r.ticket_id.startsWith(prefix)) continue;
      const n = Number(r.ticket_id.slice(prefix.length));
      if (Number.isInteger(n) && n > max) max = n;
    }
    return max + 1;
  }

  function requirementTrace(rows: readonly StoredTicket[], requirement_id: string): Trace {
    let prev: Trace | undefined;
    for (const r of rows) {
      if (r.requirement_id !== requirement_id) continue;
      const f = decodeFields(r.fields);
      if (f.ok) {
        prev = f.fields.trace;
        break;
      }
    }
    if (prev)
      return {
        trace_id: prev.trace_id,
        span_id: prev.parent_span_id ?? newId(),
        parent_span_id: null,
      };
    return { trace_id: newId(), span_id: newId(), parent_span_id: null };
  }

  /** 落库 → 入队（依赖在前）→ 每张单一条派单群消息 */
  async function persistAndDispatch(
    tickets: SupervisorTicket[],
    summary: string | undefined,
    extra: FieldsExtra = {},
  ) {
    const first = tickets[0]!;
    deps.storage.registerRequirement(first.requirement_id, first.project_id);
    const created_at = nowIso();
    for (const t of tickets) {
      deps.storage.saveTicket({
        ticket_id: t.ticket_id,
        project_id: t.project_id,
        requirement_id: t.requirement_id,
        created_at,
        ticket_text: t.ticket_text,
        ...(summary !== undefined ? { decomposition_summary: summary } : {}),
        status: "pending",
        base_commit: t.base_commit,
        permission_list: [],
        context_snippets: [],
        fields: encodeFields(t, extra),
      });
    }
    for (const t of tickets) {
      const st: SchedulerTicket = {
        ticket_id: t.ticket_id,
        requirement_id: t.requirement_id,
        trace_id: t.trace_id,
        span_id: t.span_id,
        parent_span_id: t.parent_span_id,
        depends_on: t.depends_on,
        write_scope: t.write_scope,
        interfaces: t.interfaces,
        priority: t.priority,
      };
      enqueuedIds.add(t.ticket_id);
      await deps.enqueue(st);
    }
    for (const t of tickets) {
      const deps_text = t.depends_on.length ? `\n依赖：${t.depends_on.join("、")}` : "";
      await deps.publish({
        type: "group_message",
        event_id: newId(),
        ts: nowIso(),
        trace_id: t.trace_id,
        span_id: newId(),
        parent_span_id: t.span_id,
        requirement_id: t.requirement_id,
        ticket_id: t.ticket_id,
        payload: {
          project_id: t.project_id,
          sender: "supervisor",
          kind: "dispatch",
          content: `派单 ${t.ticket_id}\n写入范围：${t.write_scope.join("、")}${deps_text}\n\n${t.ticket_text}`,
          flash_calls: [],
        },
      });
    }
  }

  /** 接口声明里的文件路径也按 glob 安全规则查 */
  function checkInterfaces(
    key: string,
    interfaces: { file: string }[] | undefined,
    errors: TicketValidationError[],
  ) {
    if (interfaces === undefined) {
      errors.push({
        code: "interfaces_missing",
        ticket: key,
        message: "interfaces 必填；没有对外接口写 []",
      });
      return;
    }
    for (const i of interfaces) {
      if (isUnsafeGlob(i.file) || i.file.endsWith("/"))
        errors.push({
          code: "interface_unsafe",
          ticket: key,
          entry: i.file,
          message: "接口声明的文件路径不安全",
        });
    }
  }

  function validateSplit(
    out: SplitOutput,
    known: ReadonlySet<string>,
    isDirectory: ((p: string) => boolean) | undefined,
  ): TicketValidationError[] {
    const errors: TicketValidationError[] = [];
    const keys = new Set<string>();
    for (const t of out.tickets) {
      if (keys.has(t.key))
        errors.push({ code: "output_invalid", ticket: t.key, message: "key 在本批次内重复" });
      keys.add(t.key);
    }
    const edges = new Map<string, string[]>();
    for (const t of out.tickets) {
      const ws = validateWriteScope(t.write_scope, {
        origin: "split",
        ...(isDirectory ? { isDirectory } : {}),
      });
      if (!ws.ok) for (const e of ws.errors) errors.push({ ...e, ticket: t.key });
      checkInterfaces(t.key, t.interfaces, errors);
      for (const d of t.depends_on ?? []) {
        if (!keys.has(d) && !known.has(d))
          errors.push({
            code: "depends_on_unknown",
            ticket: t.key,
            entry: d,
            message: "依赖的单不在本批次，也不是本项目已有单号",
          });
      }
      edges.set(
        t.key,
        (t.depends_on ?? []).filter((d) => keys.has(d)),
      );
    }
    const cyc = findCycle(edges);
    if (cyc) errors.push({ code: "depends_on_cycle", ticket: cyc, message: "depends_on 成环" });
    return errors;
  }

  function buildSplitPrompt(
    template: string,
    req: SplitRequest,
    project: ProjectInfo,
    decisions: readonly { content: string }[],
    files: readonly string[] | undefined,
    knownIds: readonly string[],
    n: string,
    original?: string,
  ): string {
    const parts = [template.trim(), OUTPUT_SPEC.split, untrustedNotice(n)];
    parts.push(wrapUntrusted(`项目：${project.name}（${project.project_id}）`, "project", n));
    parts.push(
      wrapUntrusted(
        decisions.length ? decisions.map((d) => `- ${d.content}`).join("\n") : "（暂无）",
        "decision_memory",
        n,
      ),
    );
    if (knownIds.length) parts.push(wrapUntrusted(knownIds.join("\n"), "existing_tickets", n));
    if (files && files.length) {
      const shown = files.slice(0, MAX_FILES_IN_PROMPT);
      const more =
        files.length > shown.length
          ? `\n…（另有 ${files.length - shown.length} 个文件未列出）`
          : "";
      parts.push(wrapUntrusted(shown.join("\n") + more, "file_list", n));
    }
    if (req.feedback?.length) {
      parts.push(
        wrapUntrusted(
          req.feedback
            .map(
              (f) =>
                `- ${f.ticket_id}：${f.reason}${f.detail ? `：${f.detail.slice(0, MAX_FEEDBACK_DETAIL)}` : ""}`,
            )
            .join("\n"),
          "escalation_feedback",
          n,
        ),
      );
    }
    if (original !== undefined) parts.push(wrapUntrusted(original, "original_requirement", n));
    parts.push(wrapUntrusted(req.text, "requirement", n));
    return parts.join("\n\n");
  }

  /** 重拆（T-041b）时 split 的额外信息；不在公开的 SplitRequest 里。 */
  interface ResplitInfo {
    /** 新单的 fields.resplit */
    resplit: number;
    /** 被取代的旧单 */
    replaced: string;
    /** 旧单的需求原文（已截断），原样带给新单 */
    requirement_text: string;
    /** 旧单自己的依赖：新单一律继承 */
    inherit_depends_on: readonly string[];
  }

  function split(req: SplitRequest): Promise<SplitResult> {
    return splitImpl(req, undefined);
  }

  async function splitImpl(req: SplitRequest, re: ResplitInfo | undefined): Promise<SplitResult> {
    const list = projects();
    const project = list.find((p) => p.project_id === req.project_id);
    if (!project) throw new Error(`项目不存在：${req.project_id}`);
    const requirement_id = req.requirement_id ?? `req-${shortId()}`;
    const rows = existing(req.project_id);
    const knownIds = rows.map((r) => r.ticket_id);
    const known = new Set(knownIds);
    const root = requirementTrace(rows, requirement_id);
    const base_commit = req.base_commit ?? (await deps.targetHead(req.project_id));
    const [template, decisions, files] = await Promise.all([
      deps.promptTemplate("supervisor"),
      deps.storage.listDecisions(req.project_id),
      deps.listFiles ? deps.listFiles(req.project_id, base_commit) : undefined,
    ]);
    const isDirectory = directoryChecker(files);
    const n = nonce();
    const base = buildSplitPrompt(
      template,
      req,
      project,
      decisions,
      files,
      knownIds,
      n,
      re?.requirement_text,
    );

    let lastErrors: TicketValidationError[] = [];
    for (let attempt = 1; attempt <= SPLIT_MAX_ATTEMPTS; attempt++) {
      const prompt =
        attempt === 1
          ? base
          : `${base}\n\n## 上一次输出没有通过校验（第 ${attempt - 1} 次），整批退回\n请按输出格式重新输出完整的 JSON。错误如下：\n${wrapUntrusted(formatErrors(lastErrors), "validation_errors", n)}`;
      const output = await callModel(prompt, requirement_id, root);
      const parsed = parseOutput(SplitOutputSchema, output);
      if (!parsed.ok) {
        lastErrors = [{ code: "output_invalid", message: parsed.message }];
        continue;
      }
      const errors = validateSplit(parsed.value, known, isDirectory);
      if (errors.length) {
        lastErrors = errors;
        continue;
      }
      // 合法：分配单号，按依赖顺序落库、入队、派单
      const out = parsed.value;
      let idx = nextIndex(rows, requirement_id);
      const idOf = new Map<string, string>();
      for (const t of out.tickets) idOf.set(t.key, `${requirement_id}-${idx++}`);
      const edges = new Map(
        out.tickets.map((t) => [t.key, (t.depends_on ?? []).filter((d) => idOf.has(d))]),
      );
      const byKey = new Map(out.tickets.map((t) => [t.key, t]));
      const tickets: SupervisorTicket[] = topoOrder(edges).map((key) => {
        const t = byKey.get(key)!;
        const ws = validateWriteScope(t.write_scope, { origin: "split" });
        return {
          ticket_id: idOf.get(key)!,
          project_id: req.project_id,
          requirement_id,
          trace_id: root.trace_id,
          span_id: newId(),
          parent_span_id: root.span_id,
          ticket_text: t.ticket_text,
          base_commit,
          write_scope: ws.ok ? ws.scope : [],
          interfaces: t.interfaces ?? [],
          depends_on: [
            ...new Set([
              ...(t.depends_on ?? [])
                .map((d) => idOf.get(d) ?? d)
                // 重拆：新单不能再依赖被取代的旧单（它已上报），改为继承旧单自己的依赖
                .filter((d) => d !== re?.replaced),
              ...(re?.inherit_depends_on ?? []),
            ]),
          ],
          priority: t.priority ?? "normal",
          ...(t.kind === "dependency" ? { kind: "dependency" as const } : {}),
          permission_list: [],
          origin: "split",
        };
      });
      const req_text = re ? undefined : truncateRequirement(req.text);
      await persistAndDispatch(
        tickets,
        out.summary,
        re
          ? {
              requirement_text: re.requirement_text,
              resplit: re.resplit,
              resplit_of: [re.replaced],
            }
          : { requirement_text: req_text!.text },
      );
      if (req_text?.truncated) await warnTruncated(tickets, req_text.length);
      return {
        requirement_id,
        trace_id: root.trace_id,
        summary: out.summary,
        tickets,
        attempts: attempt,
      };
    }
    throw new SplitInvalidError(lastErrors);
  }

  async function createManualTicket(input: ManualTicketInput): Promise<SupervisorTicket> {
    if (input.origin !== "manual" && input.origin !== "test")
      throw new Error(`手动单的 origin 只能是 manual 或 test：${String(input.origin)}`);
    const list = projects();
    if (!list.some((p) => p.project_id === input.project_id))
      throw new Error(`项目不存在：${input.project_id}`);
    if (!input.ticket_text?.trim()) throw new Error("ticket_text 不能为空");
    const errors: TicketValidationError[] = [];
    const ws = validateWriteScope(input.write_scope, { origin: input.origin });
    if (!ws.ok) errors.push(...ws.errors);
    checkInterfaces("manual", input.interfaces ?? [], errors);
    const rows = existing(input.project_id);
    const known = new Set(rows.map((r) => r.ticket_id));
    for (const d of input.depends_on ?? [])
      if (!known.has(d))
        errors.push({
          code: "depends_on_unknown",
          entry: d,
          message: "依赖的单不是本项目已有单号",
        });
    if (errors.length || !ws.ok)
      throw new Error(`手动单不合法：\n${formatErrors(errors)}`, { cause: errors });

    const requirement_id = input.requirement_id ?? `req-${shortId()}`;
    const root = requirementTrace(rows, requirement_id);
    const ticket: SupervisorTicket = {
      ticket_id: `${requirement_id}-${nextIndex(rows, requirement_id)}`,
      project_id: input.project_id,
      requirement_id,
      trace_id: root.trace_id,
      span_id: newId(),
      parent_span_id: root.span_id,
      ticket_text: input.ticket_text,
      base_commit: input.base_commit ?? (await deps.targetHead(input.project_id)),
      write_scope: ws.scope,
      interfaces: input.interfaces ?? [],
      depends_on: [...new Set(input.depends_on ?? [])],
      priority: input.priority ?? "normal",
      permission_list: [],
      origin: input.origin,
    };
    const req_text = truncateRequirement(input.ticket_text);
    await persistAndDispatch([ticket], undefined, { requirement_text: req_text.text });
    if (req_text.truncated) await warnTruncated([ticket], req_text.length);
    if (ws.defaulted) {
      await deps.publish({
        type: "ticket_warning",
        event_id: newId(),
        ts: nowIso(),
        trace_id: ticket.trace_id,
        span_id: newId(),
        parent_span_id: ticket.span_id,
        requirement_id,
        ticket_id: ticket.ticket_id,
        payload: {
          project_id: ticket.project_id,
          code: "write_scope_defaulted",
          detail:
            input.write_scope && input.write_scope.length
              ? `${input.origin} 单给了整仓范围（${input.write_scope.join("、")}），按 ** 处理，与所有单互斥`
              : `${input.origin} 单没给写入范围，按 ** 处理，与所有单互斥`,
        },
      });
    }
    return ticket;
  }

  /** 需求原文超过上限：每批只发一条 ticket_warning(requirement_truncated)，挂在第一张单上（Q-F）。 */
  async function warnTruncated(tickets: readonly SupervisorTicket[], length: number) {
    const first = tickets[0]!;
    try {
      await deps.publish({
        type: "ticket_warning",
        event_id: newId(),
        ts: nowIso(),
        trace_id: first.trace_id,
        span_id: newId(),
        parent_span_id: first.span_id,
        requirement_id: first.requirement_id,
        ticket_id: first.ticket_id,
        payload: {
          project_id: first.project_id,
          code: "requirement_truncated",
          detail:
            `需求原文 ${length} 字符，存进需求单时截到 ${MAX_REQUIREMENT_TEXT} 字符，重拆只能看到截断后的原文；本批单号：${tickets.map((t) => t.ticket_id).join("、")}`.slice(
              0,
              500,
            ),
        },
      });
    } catch (err) {
      logger.warn(`单 ${first.ticket_id} 发 ticket_warning(requirement_truncated) 失败`, err);
    }
  }

  /**
   * 从 2 还原单子。`fields` 为 null（旧数据、库里损坏）、不合格式，或写入范围按本单来源（split / manual / test）复查不过时：
   * 发 `ticket_warning(fields_invalid)`、记警告并返回 undefined。不按整仓 `**` 兜底续跑（那等于把写权限放宽到整个仓库），
   * 交给调用方按「单不存在」处理（8 会报错、9 转上报）。
   */
  async function loadTicket(ticket_id: string): Promise<SubAgentTicket | undefined> {
    const row = deps.storage.getTicket(ticket_id);
    if (!row) return undefined;
    const f = decodeFields(row.fields);
    let reason: string | undefined;
    if (!f.ok) reason = f.reason;
    else {
      const ws = validateWriteScope(f.fields.write_scope, { origin: f.fields.origin });
      if (!ws.ok)
        reason = `写入范围复查不过（${ws.errors.map((e) => `${e.code}${e.entry ? ` ${e.entry}` : ""}`).join("；")}）`;
    }
    if (reason !== undefined) {
      logger.warn(`单 ${ticket_id} ${reason}，不能续跑，需要重拆或人工处理`);
      const trace = f.ok
        ? f.fields.trace
        : { trace_id: row.requirement_id, span_id: newId(), parent_span_id: null };
      try {
        await deps.publish({
          type: "ticket_warning",
          event_id: newId(),
          ts: nowIso(),
          trace_id: trace.trace_id,
          span_id: newId(),
          parent_span_id: trace.span_id,
          requirement_id: row.requirement_id,
          ticket_id: row.ticket_id,
          payload: {
            project_id: row.project_id,
            code: "fields_invalid",
            detail: `${reason}，不能续跑，需要重拆或人工处理`.slice(0, 500),
          },
        });
      } catch (err) {
        logger.warn(`单 ${ticket_id} 发 ticket_warning(fields_invalid) 失败`, err);
      }
      return undefined;
    }
    const { trace, write_scope, kind } = (f as { ok: true; fields: StoredFields }).fields;
    return {
      ticket_id: row.ticket_id,
      project_id: row.project_id,
      requirement_id: row.requirement_id,
      trace_id: trace.trace_id,
      span_id: trace.span_id,
      parent_span_id: trace.parent_span_id,
      ticket_text: row.ticket_text,
      base_commit: row.base_commit,
      permission_list: row.permission_list,
      write_scope,
      ...(kind === "dependency" ? { kind: "dependency" as const } : {}),
    };
  }

  // ---------- T-041b 上报处理与重拆 ----------

  const timers = deps.timers ?? {
    setTimeout: (fn: () => void, ms: number) => {
      const h = setTimeout(fn, ms);
      (h as { unref?: () => void }).unref?.();
      return h;
    },
    clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  /** 关旧 PR 的重试定时器；start() 的退订函数清掉 */
  const retryTimers = new Set<unknown>();
  let stopped = false;
  /** 上报处理串行执行（进程内排队，提案 §7） */
  let chain: Promise<unknown> = Promise.resolve();
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = chain.then(fn, fn);
    chain = p.catch(() => undefined);
    return p;
  }
  /** 本进程已处理过（或已排上重试）的上报单：takeOver 不再补跑 */
  const handledHere = new Set<string>();
  /** N4：已在 1:1 里通知过「没有接回」的单（每张只通知一次） */
  const heldNotified = new Set<string>();

  async function notify(text: string, where: { project_id?: string; requirement_id?: string }) {
    try {
      await deps.notifyUser({
        text,
        ...(where.project_id ? { project_id: where.project_id } : {}),
        ...(where.requirement_id ? { requirement_id: where.requirement_id } : {}),
      });
    } catch (err) {
      logger.warn("通知用户失败", err);
    }
  }

  /** 读回整行，把 patch 并进库里原始的 fields（不经 encodeFields，以免冲掉标记等字段）再写回。 */
  function patchFields(ticket_id: string, patch: Record<string, unknown>) {
    const row = deps.storage.getTicket(ticket_id);
    if (!row) throw new Error(`需求单 ${ticket_id} 不存在`);
    const raw =
      row.fields && typeof row.fields === "object" ? (row.fields as Record<string, unknown>) : {};
    const { fields: _fields, ...rest } = row;
    void _fields;
    deps.storage.saveTicket({ ...rest, fields: { ...raw, ...patch } as TicketFields });
  }

  function writeHandled(ticket_id: string, h: NonNullable<Markers["escalation_handled"]>) {
    patchFields(ticket_id, { escalation_handled: h });
  }

  function traceOf(row: StoredTicket): Trace {
    const f = decodeFields(row.fields);
    return f.ok
      ? f.fields.trace
      : { trace_id: row.requirement_id, span_id: newId(), parent_span_id: null };
  }

  /** 同一需求里已重拆的次数：各单 fields.resplit 的最大值（0 = 还没重拆过）。 */
  function resplitsDone(requirement_id: string): number {
    let max = 0;
    for (const r of deps.storage.listTickets({ requirement_id }))
      max = Math.max(max, readResplit(r.fields).resplit);
    return max;
  }

  /** 有没有单的 resplit_of 指向它（重拆出的新单已落库）。 */
  function successorsOf(ticket_id: string, rows = deps.storage.listTickets()): string[] {
    return rows
      .filter((r) => readResplit(r.fields).resplit_of.includes(ticket_id))
      .map((r) => r.ticket_id);
  }

  /**
   * 处理一条 escalated（T-041b）。按原因分流，先把 escalation_handled 写进 2（Q10），再关旧 PR、重拆或交用户。
   * 调用方负责串行（serial）。
   */
  async function handleEscalated(e: EventOf<"escalated">): Promise<EscalationAction> {
    const { reason, detail } = e.payload;
    if (reason === "resplit_limit") return "ignored"; // 自己发的
    const id = e.ticket_id;
    const reasonText = `${REASON_TEXT[reason]}（${reason}）`;
    const detailText = detail ? `\n详情：${detail.slice(0, MAX_FEEDBACK_DETAIL)}` : "";
    if (id === null) {
      await notify(`有一个 PR 需要人工处理：${reasonText}${detailText}`, {
        requirement_id: e.requirement_id,
      });
      return "notify_user";
    }
    pendingHR.delete(id); // 上报了就不再等高风险裁决（T-041c）
    handledHere.add(id);
    const row = deps.storage.getTicket(id);
    if (NOTIFY_ONLY_REASONS.has(reason) || !row) {
      const tail =
        reason === "merged_but"
          ? "代码已经进了集成分支，不重拆。"
          : reason === "scope_lock_failed"
            ? "这次扩大写入范围的申请被拒，单子还在继续做。"
            : "库里找不到这张单。";
      await notify(`单 ${id}：${reasonText}。${tail}${detailText}`, {
        ...(row ? { project_id: row.project_id } : {}),
        requirement_id: e.requirement_id,
      });
      return "notify_user";
    }
    const where = { project_id: row.project_id, requirement_id: row.requirement_id };
    const prev = readMarkers(row.fields).escalation_handled;
    if (prev) {
      await notify(
        `单 ${id} 再次上报：${reasonText}。这张单之前已经处理过（${prev.action}），这次只告知，不再重拆。${detailText}`,
        where,
      );
      return "notify_user";
    }

    let action: EscalationAction = "notify_user";
    let why = "";
    if (RESPLIT_REASONS.has(reason)) {
      const f = decodeFields(row.fields);
      if (!f.ok || f.fields.requirement_text === undefined) {
        why = "这张单是旧单（没有需求原文或结构化字段不合格式），不能自动重拆，需要人工处理。";
      } else {
        const limit = deps.getConfig().pipeline.resplit_limit;
        // 已重拆次数 ≥ 上限时不再重拆（Q-C）
        action = resplitsDone(row.requirement_id) >= limit ? "resplit_limit" : "resplit";
      }
    } else if (reason === "high_risk_rejected") {
      const close = readMarkers(row.fields).high_risk_close?.state;
      why =
        close === "unconfirmed"
          ? "这张单的高风险 PR 已按你的决定拒绝，单子不会再合入；但关 PR 还没成功（如 GitHub 限流），会自动重试，重试用完会再通知你。不重拆；需要的话请重新提需求或手动建单。"
          : close === "none"
            ? "这张单的高风险 PR 已按你的决定拒绝（没有找到要关的 PR），不重拆；需要的话请重新提需求或手动建单。"
            : "这张单的高风险 PR 已按你的决定拒绝并关闭，不重拆；需要的话请重新提需求或手动建单。";
    } else {
      why = "这类上报不重拆，交给你决定。";
    }
    // 先落库再动手（Q10）：之后崩溃，重启时据此判断做到哪一步
    writeHandled(id, { action, at: nowIso(), reason });

    if (action === "resplit")
      return closeThenResplit(id, { reason, ...(detail ? { detail } : {}) }, 0);
    if (action === "resplit_limit") {
      const trace = traceOf(row);
      try {
        await deps.publish({
          type: "escalated",
          event_id: newId(),
          ts: nowIso(),
          trace_id: trace.trace_id,
          span_id: newId(),
          parent_span_id: trace.span_id,
          requirement_id: row.requirement_id,
          ticket_id: id,
          payload: {
            reason: "resplit_limit",
            detail: `需求 ${row.requirement_id} 已重拆 ${deps.getConfig().pipeline.resplit_limit} 次，单 ${id} 又因 ${reason} 上报`,
          },
        });
      } catch (err) {
        logger.warn(`单 ${id} 发 escalated(resplit_limit) 失败`, err);
      }
      await notify(
        `单 ${id}：${reasonText}。需求 ${row.requirement_id} 的重拆次数已到上限，需要人工介入。${detailText}`,
        where,
      );
      return "resplit_limit";
    }
    await notify(`单 ${id}：${reasonText}。${why}${detailText}`, where);
    return "notify_user";
  }

  interface EscalationInfo {
    reason: EscalationReason | undefined;
    detail?: string;
  }

  /**
   * 重拆的第一步：确认旧 PR 已关或不存在（N1）。确认之前不建新单；失败发 ticket_warning(pr_close_failed)
   * 并按 30 秒、2 分钟、10 分钟重试，仍失败交用户、单子停在这一步（重启后从这一步接着做）。
   */
  async function closeThenResplit(
    id: string,
    info: EscalationInfo,
    attempt: number,
  ): Promise<EscalationAction> {
    const row = deps.storage.getTicket(id);
    if (!row) return "notify_user";
    const where = { project_id: row.project_id, requirement_id: row.requirement_id };
    let result: "closed" | "none" | "merged";
    if (!deps.closeTicketPr) {
      logger.warn(`单 ${id} 重拆：没注入 closeTicketPr，不关旧 PR`);
      result = "none";
    } else {
      try {
        result = await deps.closeTicketPr(id, `由重拆取代（${info.reason ?? "escalated"}）`);
      } catch (err) {
        await closeFailed(row, info, attempt, err);
        return "resplit";
      }
    }
    patchFields(id, { pr_close_done: { at: nowIso(), result } });
    if (result === "merged") {
      await notify(
        `单 ${id} 上报了（${info.reason ?? "原因未知"}），但它的 PR 其实已经合入，不重拆，请确认集成分支上的改动。`,
        where,
      );
      return "notify_user";
    }
    return resplit(id, info);
  }

  async function closeFailed(
    row: StoredTicket,
    info: EscalationInfo,
    attempt: number,
    err: unknown,
  ) {
    const id = row.ticket_id;
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`单 ${id} 重拆前关旧 PR 失败（第 ${attempt + 1} 次）`, err);
    const where = { project_id: row.project_id, requirement_id: row.requirement_id };
    if (attempt === 0) {
      const trace = traceOf(row);
      try {
        await deps.publish({
          type: "ticket_warning",
          event_id: newId(),
          ts: nowIso(),
          trace_id: trace.trace_id,
          span_id: newId(),
          parent_span_id: trace.span_id,
          requirement_id: row.requirement_id,
          ticket_id: id,
          payload: {
            project_id: row.project_id,
            code: "pr_close_failed",
            detail: `重拆前关旧 PR 失败，确认旧 PR 已关或不存在之前不重拆，稍后重试：${msg}`.slice(
              0,
              500,
            ),
          },
        });
      } catch (e2) {
        logger.warn(`单 ${id} 发 ticket_warning(pr_close_failed) 失败`, e2);
      }
    }
    const delay = PR_CLOSE_RETRY_MS[attempt];
    if (delay === undefined) {
      await notify(
        `单 ${id} 要重拆，但关旧 PR 重试 ${PR_CLOSE_RETRY_MS.length} 次仍失败（${msg.slice(0, 500)}）。确认旧 PR 已关之前不会建新单，请到 GitHub 上处理后重启或人工重拆。`,
        where,
      );
      return;
    }
    if (stopped) return;
    const h = timers.setTimeout(() => {
      retryTimers.delete(h);
      if (stopped) return;
      void serial(() => closeThenResplit(id, info, attempt + 1)).catch((e3: unknown) =>
        logger.warn(`单 ${id} 重试关旧 PR 出错`, e3),
      );
    }, delay);
    retryTimers.add(h);
  }

  /** 重拆的第二步：旧 PR 已确认关掉（或不存在），只重拆这张失败单。 */
  async function resplit(id: string, info: EscalationInfo): Promise<EscalationAction> {
    const row = deps.storage.getTicket(id)!;
    const where = { project_id: row.project_id, requirement_id: row.requirement_id };
    const f = decodeFields(row.fields);
    const fail = async (msg: string) => {
      try {
        const h = readMarkers(deps.storage.getTicket(id)?.fields ?? null).escalation_handled;
        if (h) writeHandled(id, { ...h, error: msg.slice(0, 500) });
      } catch (err) {
        logger.warn(`单 ${id} 记重拆失败原因出错`, err);
      }
      await notify(`单 ${id} 重拆失败：${msg.slice(0, 1000)}。需要人工处理。`, where);
      return "notify_user" as const;
    };
    if (!f.ok || f.fields.requirement_text === undefined)
      return fail("结构化字段不合格式或没有需求原文");
    let r: SplitResult;
    try {
      r = await splitImpl(
        {
          project_id: row.project_id,
          text: row.ticket_text,
          requirement_id: row.requirement_id,
          feedback: [
            {
              ticket_id: id,
              reason: info.reason ?? "internal_error",
              ...(info.detail ? { detail: info.detail } : {}),
            },
          ],
        },
        {
          resplit: resplitsDone(row.requirement_id) + 1,
          replaced: id,
          requirement_text: f.fields.requirement_text,
          inherit_depends_on: f.fields.depends_on,
        },
      );
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    const ids = r.tickets.map((t) => t.ticket_id);
    // 下游单：9 里换依赖（R2），2 里改 fields.depends_on（重启后据此接回）
    if (deps.replaceDependency) {
      try {
        await deps.replaceDependency(id, ids);
      } catch (err) {
        logger.warn(`单 ${id} 重拆后 9 换依赖失败`, err);
      }
    }
    replaceStoredDependency(id, ids);
    await notify(
      `单 ${id}（${info.reason ?? "上报"}）已重拆成 ${ids.join("、")}，旧单不再处理；依赖它的单改为依赖新单。`,
      where,
    );
    return "resplit";
  }

  /** 2 里所有没合入的单：fields.depends_on 里的旧单号换成新单号。 */
  function replaceStoredDependency(old_id: string, ids: readonly string[]) {
    for (const r of deps.storage.listTickets()) {
      if (r.ticket_id === old_id || ids.includes(r.ticket_id) || r.status === "merged") continue;
      const f = decodeFields(r.fields);
      if (!f.ok || !f.fields.depends_on.includes(old_id)) continue;
      const next: string[] = [];
      for (const d of f.fields.depends_on)
        for (const x of d === old_id ? ids : [d])
          if (x !== r.ticket_id && !next.includes(x)) next.push(x);
      try {
        patchFields(r.ticket_id, { depends_on: next });
      } catch (err) {
        logger.warn(`单 ${r.ticket_id} 改写依赖失败`, err);
      }
    }
  }

  /**
   * 重启接管（T-041a；T-041b 补上报处理与下游挂起）：
   * 1. 已上报的单：没有 escalation_handled 的补跑一次上报处理（原因取 deps.lastEscalation）；已标记重拆但旧 PR
   *    没确认关掉的从关 PR 这一步接着做；已关 PR、新单却没落库（中途崩溃）的只通知用户、不自动再拆（Q-D）。
   *    每次最多补跑 TAKEOVER_REPLAY_LIMIT 张，其余进 held、通知用户、下次再补（Q-E）。
   * 2. 重新读一遍 listTickets：依赖里被重拆取代的单换成新单（并写回 2），已合入的去掉。
   * 3. 依赖（含间接）已上报又没被取代、或依赖 fields_invalid 的单进 held，不接回，每张只通知一次（N4）。
   * 4. merge_queued / conflict / re_reviewing 经 deps.adopt 接回；pending / coding / in_review / resubmitting
   *    enqueue（同 T-041a）。fields_invalid 的单不接回、只靠 loadTicket 的一条警告（Q7）。merged 跳过。
   */
  async function takeOver(): Promise<TakeOverReport> {
    const report: TakeOverReport = {
      enqueued: [],
      adopted: [],
      skipped_invalid: [],
      awaiting_adopt: [],
      escalated: [],
      escalations: [],
      held: [],
      merged: [],
      failed: [],
    };
    const holdOnce = async (row: StoredTicket, blocked_by: string[], text: string) => {
      report.held.push({ ticket_id: row.ticket_id, blocked_by });
      if (heldNotified.has(row.ticket_id)) return;
      heldNotified.add(row.ticket_id);
      await notify(text, { project_id: row.project_id, requirement_id: row.requirement_id });
    };

    // ---- 1. 补跑上报处理 ----
    let replayed = 0;
    for (const row of deps.storage.listTickets()) {
      if ((row.status ?? "pending") !== "escalated") continue;
      const id = row.ticket_id;
      report.escalated.push(id);
      if (handledHere.has(id)) continue;
      const m = readMarkers(row.fields);
      const h = m.escalation_handled;
      if (h) {
        if (h.action !== "resplit" || h.error !== undefined) continue;
        if (m.pr_close_done) {
          if (m.pr_close_done.result === "merged" || successorsOf(id).length) continue;
          // Q-D：旧 PR 已关、新单没落库（中途崩溃）：只通知，不自动再拆
          handledHere.add(id);
          report.escalations.push({ ticket_id: id, action: "notify_user" });
          await notify(
            `单 ${id} 重拆到一半中断了（旧 PR 已关，新单没建出来）。不自动再拆，需要人工重拆或处理。`,
            { project_id: row.project_id, requirement_id: row.requirement_id },
          );
          continue;
        }
      }
      if (replayed >= TAKEOVER_REPLAY_LIMIT) {
        await holdOnce(
          row,
          [],
          `单 ${id} 已上报，重启时上报处理排在后面（每次启动最多补处理 ${TAKEOVER_REPLAY_LIMIT} 张），这次没处理，下次启动再补。`,
        );
        continue;
      }
      replayed++;
      handledHere.add(id);
      try {
        const ev = deps.lastEscalation ? await deps.lastEscalation(id) : undefined;
        const action = await serial(async () => {
          if (h) {
            // 已标记重拆、旧 PR 没确认关掉：从关 PR 这一步接着做
            const info: EscalationInfo = {
              reason: h.reason,
              ...(ev && ev.payload.reason === h.reason && ev.payload.detail
                ? { detail: ev.payload.detail }
                : {}),
            };
            return closeThenResplit(id, info, 0);
          }
          if (ev) return handleEscalated(ev);
          writeHandled(id, { action: "notify_user", at: nowIso() });
          await notify(`单 ${id} 已上报，但查不到上报原因，交给你处理。`, {
            project_id: row.project_id,
            requirement_id: row.requirement_id,
          });
          return "notify_user" as const;
        });
        report.escalations.push({ ticket_id: id, action });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        logger.warn(`重启接管：单 ${id} 补跑上报处理失败`, err);
        report.failed.push({ ticket_id: id, error: error.slice(0, 500) });
      }
    }

    // ---- 2. 重新读：依赖换成重拆出的新单 ----
    const rows = deps.storage.listTickets();
    const statusOf = new Map(rows.map((r) => [r.ticket_id, r.status ?? "pending"]));
    const successors = new Map<string, string[]>();
    for (const r of rows)
      for (const old of readResplit(r.fields).resplit_of) {
        const list = successors.get(old) ?? [];
        list.push(r.ticket_id);
        successors.set(old, list);
      }
    /** 被取代的单递归换成新单（防环） */
    const substitute = (ids: readonly string[], self: string): string[] => {
      const out: string[] = [];
      const visit = (d: string, seen: Set<string>) => {
        const next = successors.get(d);
        if (next && !seen.has(d)) {
          seen.add(d);
          for (const n of next) visit(n, seen);
          return;
        }
        if (d !== self && !out.includes(d)) out.push(d);
      };
      for (const d of ids) visit(d, new Set());
      return out;
    };

    const toAdopt: StoredTicket[] = [];
    const toEnqueue: StoredTicket[] = [];
    for (const row of rows) {
      const id = row.ticket_id;
      if (enqueuedIds.has(id) || skippedInvalid.has(id)) continue;
      const status: TicketStatus = row.status ?? "pending";
      if (status === "merged") report.merged.push(id);
      else if (TAKEOVER_ADOPT.has(status)) toAdopt.push(row);
      else if (TAKEOVER_ENQUEUE.has(status)) toEnqueue.push(row);
    }

    const prepared = new Map<string, SchedulerTicket & { kind?: "dependency" }>();
    for (const row of [...toAdopt, ...toEnqueue]) {
      const loaded = await loadTicket(row.ticket_id);
      const f = decodeFields(row.fields);
      if (!loaded || !f.ok) {
        skippedInvalid.add(row.ticket_id);
        report.skipped_invalid.push(row.ticket_id);
        continue;
      }
      const deps0 = substitute(f.fields.depends_on, row.ticket_id);
      if (deps0.join("\n") !== f.fields.depends_on.join("\n")) {
        try {
          patchFields(row.ticket_id, { depends_on: deps0 });
        } catch (err) {
          logger.warn(`单 ${row.ticket_id} 写回替换后的依赖失败`, err);
        }
      }
      prepared.set(row.ticket_id, {
        ticket_id: loaded.ticket_id,
        requirement_id: loaded.requirement_id,
        trace_id: loaded.trace_id,
        span_id: loaded.span_id,
        parent_span_id: loaded.parent_span_id,
        // 9 重启后不认识已合入的单，留着会一直 waiting
        depends_on: deps0.filter((d) => statusOf.get(d) !== "merged"),
        write_scope: f.fields.write_scope,
        interfaces: f.fields.interfaces,
        priority: f.fields.priority,
        ...(loaded.kind ? { kind: loaded.kind } : {}),
      });
    }

    // ---- 3. 下游挂起（N4） ----
    const blockedMemo = new Map<string, string[]>();
    const blockedBy = (id: string, seen: Set<string>): string[] => {
      const memo = blockedMemo.get(id);
      if (memo) return memo;
      const st = prepared.get(id);
      if (!st || seen.has(id)) return [];
      seen.add(id);
      const out: string[] = [];
      for (const d of st.depends_on ?? []) {
        const s = statusOf.get(d);
        if (s === "escalated" || skippedInvalid.has(d)) out.push(d);
        else if (blockedBy(d, seen).length) out.push(d);
      }
      blockedMemo.set(id, out);
      return out;
    };
    const held = new Set<string>();
    for (const row of [...toAdopt, ...toEnqueue]) {
      if (!prepared.has(row.ticket_id)) continue;
      const by = blockedBy(row.ticket_id, new Set());
      if (!by.length) continue;
      held.add(row.ticket_id);
      await holdOnce(
        row,
        by,
        `单 ${row.ticket_id} 依赖的 ${by.join("、")} 已上报（没被重拆取代）或结构化字段无效，重启后没有接回，需要重拆或人工处理。`,
      );
    }

    // ---- 4. 接回 9：先 adopt 再 enqueue ----
    const hand = async (
      row: StoredTicket,
      fn: (t: SchedulerTicket & { kind?: "dependency" }) => unknown,
      done: string[],
      what: string,
    ) => {
      const st = prepared.get(row.ticket_id);
      if (!st || held.has(row.ticket_id)) return;
      const id = row.ticket_id;
      enqueuedIds.add(id);
      try {
        await fn(st);
        done.push(id);
      } catch (err) {
        enqueuedIds.delete(id);
        const error = err instanceof Error ? err.message : String(err);
        logger.warn(`重启接管：单 ${id} ${what} 失败`, err);
        report.failed.push({ ticket_id: id, error: error.slice(0, 500) });
      }
    };

    const adopt = deps.adopt;
    for (const row of toAdopt) {
      if (!prepared.has(row.ticket_id) || held.has(row.ticket_id)) continue;
      if (!adopt) {
        logger.warn(`重启接管：单 ${row.ticket_id} 已在合并队列里，没注入 adopt，本次没有接回`);
        report.awaiting_adopt.push(row.ticket_id);
        continue;
      }
      // T-064 B2：adopt 可能返回 "merged"（停机期间用户已在 GitHub 合入）
      const st = prepared.get(row.ticket_id)!;
      const id = row.ticket_id;
      enqueuedIds.add(id);
      try {
        const result = await adopt(st);
        if (result === "merged") report.merged.push(id);
        else report.adopted.push(id);
      } catch (err) {
        enqueuedIds.delete(id);
        const error = err instanceof Error ? err.message : String(err);
        logger.warn(`重启接管：单 ${id} adopt 失败`, err);
        report.failed.push({ ticket_id: id, error: error.slice(0, 500) });
      }
    }
    for (const row of toEnqueue) {
      await hand(
        row,
        // enqueue 只要 SchedulerTicket 的字段
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        ({ kind: _kind, ...t }) => deps.enqueue(t),
        report.enqueued,
        "enqueue",
      );
    }
    return report;
  }

  function start(): () => void {
    stopped = false;
    const offProject = deps.subscribe("project_created", (e) => {
      const p = e.payload;
      void Promise.resolve(
        deps.notifyUser({
          text: `项目「${p.name}」已导入（${p.project_id}），语言：${p.language}，GitHub 远程：${p.has_github_remote ? "有" : "无"}。提需求时说明是哪个项目即可。`,
          project_id: p.project_id,
        }),
      ).catch((err: unknown) => logger.warn("通知用户项目已导入失败", err));
    });
    const offEscalated = deps.subscribe("escalated", (e) =>
      serial(() => handleEscalated(e)).then(
        () => undefined,
        (err: unknown) => logger.warn(`处理上报（${e.ticket_id ?? "无单号"}）出错`, err),
      ),
    );
    return () => {
      stopped = true;
      offProject();
      offEscalated();
      for (const h of retryTimers) timers.clearTimeout(h);
      retryTimers.clear();
    };
  }

  async function splitForChat(
    text: string,
    project: ProjectInfo,
    note: string,
    requirement_id: string,
  ): Promise<ChatReply> {
    try {
      const r = await split({ project_id: project.project_id, text, requirement_id });
      return {
        kind: "dispatched",
        text: `${note}已拆成 ${r.tickets.length} 张单：${r.tickets.map((t) => t.ticket_id).join("、")}。\n${r.summary}`,
        project_id: project.project_id,
        requirement_id: r.requirement_id,
        ticket_ids: r.tickets.map((t) => t.ticket_id),
      };
    } catch (e) {
      const msg = e instanceof SplitInvalidError ? e.message : `拆单出错：${(e as Error).message}`;
      return {
        kind: "split_failed",
        text: `${note}${msg}`,
        project_id: project.project_id,
        requirement_id,
      };
    }
  }

  async function act(
    kind: "requirement" | "decision",
    text: string,
    decision: string | null | undefined,
    project: ProjectInfo,
    note: string,
    requirement_id: string,
  ): Promise<ChatReply> {
    if (kind === "decision") {
      const content = (decision ?? text).trim();
      deps.storage.saveDecision({ project_id: project.project_id, content });
      return {
        kind: "decision_saved",
        text: `${note}已记下这条项目决策：${content}`,
        project_id: project.project_id,
      };
    }
    return splitForChat(text, project, note, requirement_id);
  }

  function askProject(list: ProjectInfo[]): ChatReply {
    if (list.length === 0)
      return { kind: "ask_project", text: "还没有导入任何项目，请先在界面上导入项目。" };
    return {
      kind: "ask_project",
      text: `是哪个项目？现有项目：${list.map((p) => `「${p.name}」`).join("、")}。`,
    };
  }

  async function chat(msg: UserMessage): Promise<ChatReply> {
    const list = projects();
    const explicit = msg.project_id ? list.find((p) => p.project_id === msg.project_id) : undefined;
    // 有暂存需求时：界面传的 project_id 优先；否则原文里恰好提到一个项目才认领，
    // 提到多个项目或一个都没提到就再问一次（暂存的需求保留，什么都不丢）
    let named = explicit;
    if (pending && !explicit) {
      const hits = mentionedAll(msg.text, list);
      if (hits.length > 1) {
        return {
          ...askProject(list),
          text: `这条回复里提到了不止一个项目（${hits.map((h) => `「${h.name}」`).join("、")}），刚才那条需求要放到哪个项目？只回一个项目名即可。`,
        };
      }
      if (hits.length === 0) {
        // 没认出项目（如「第一个吧」）：暂存的需求保留，再问一次
        const ask = askProject(list);
        return list.length === 0
          ? ask
          : { ...ask, text: `没认出是哪个项目。刚才那条需求要放到哪个项目？${ask.text}` };
      }
      named = hits[0];
    }

    // 上一条在等项目：只用这条里的项目名（或界面传的 project_id）认领暂存的需求，
    // 其余内容当一条新消息处理，不丢掉用户顺带提的新需求
    if (pending && named) {
      const p = pending;
      pending = undefined;
      const first = await act(
        p.kind,
        p.text,
        p.kind === "decision" ? p.text : null,
        named,
        explicit ? "" : `按项目「${named.name}」处理。`,
        `req-${shortId()}`,
      );
      const rest = stripProject(msg.text, named);
      if (!meaningful(rest)) return first;
      const second = await handle(
        { ...msg, text: rest, ...(explicit ? { project_id: explicit.project_id } : {}) },
        list,
      );
      return mergeReplies(first, second);
    }
    pending = undefined;
    return handle(msg, list);
  }

  async function handle(msg: UserMessage, list: ProjectInfo[]): Promise<ChatReply> {
    const explicit = msg.project_id ? list.find((p) => p.project_id === msg.project_id) : undefined;
    const named = explicit ?? mentioned(msg.text, list);
    const requirement_id = `req-${shortId()}`;
    const n = nonce();
    const template = await deps.promptTemplate("supervisor");
    const prompt = [
      template.trim(),
      OUTPUT_SPEC.chat,
      untrustedNotice(n),
      wrapUntrusted(
        list.map((p) => `- ${p.name}（${p.project_id}）`).join("\n") || "（暂无项目）",
        "projects",
        n,
      ),
      wrapUntrusted(msg.text, "user_message", n),
    ].join("\n\n");
    const trace: Trace = { trace_id: newId(), span_id: newId(), parent_span_id: null };
    const output = await callModel(prompt, requirement_id, trace);
    const parsed = parseOutput(ChatOutputSchema, output);
    if (!parsed.ok) {
      logger.warn("主管对话输出不合格式", parsed.message);
      return { kind: "answer", text: "抱歉，我这次没有理解清楚，请换个说法再说一次。" };
    }
    const out = parsed.value;
    if (out.intent === "answer") return { kind: "answer", text: out.reply };
    if (out.intent === "decision" && !out.decision?.trim())
      return { kind: "answer", text: out.reply };

    let project = named;
    let note = "";
    if (!project && list.length === 1) {
      project = list[0]!;
      note = `按项目「${project.name}」处理。`;
    } else if (project && !explicit) {
      note = `按项目「${project.name}」处理。`;
    }
    if (!project) {
      pending = {
        kind: out.intent,
        text: out.intent === "decision" ? out.decision!.trim() : msg.text,
      };
      return askProject(list);
    }
    return act(out.intent, msg.text, out.decision, project, note, requirement_id);
  }

  // ---------- 高风险 PR 裁决（T-041c） ----------

  /** 等用户裁决的高风险单：单号 → 扣住时记下的信息（Map 在内存；pendingHighRisk() 还会读 2 去掉已到终态的） */
  const pendingHR = new Map<string, PendingHighRisk & { requirement_id: string }>();
  /** 已通知过的「单号 + PR」（同一 PR 在本进程只通知一次） */
  const heldNotifiedHR = new Set<string>();
  /** 裁决串行执行（和上报处理的 serial 分开：拒绝时 9 发的 escalated 要排进 serial） */
  let decideChain: Promise<unknown> = Promise.resolve();

  function pendingHighRisk(): PendingHighRisk[] {
    const out: PendingHighRisk[] = [];
    for (const [ticket_id, v] of [...pendingHR]) {
      const st = deps.storage.getTicket(ticket_id)?.status;
      if (st === "merged" || st === "escalated") {
        pendingHR.delete(ticket_id);
        continue;
      }
      const { requirement_id: _r, ...view } = v;
      void _r;
      out.push({ ...view, reasons: [...v.reasons], files: v.files.map((f) => ({ ...f })) });
    }
    return out;
  }

  async function highRiskHeld(info: HighRiskHeldInput): Promise<void> {
    const row = deps.storage.getTicket(info.ticket_id);
    const f = row ? decodeFields(row.fields) : undefined;
    const ev = highRiskEvidence({
      kind: f?.ok ? (f.fields.kind ?? undefined) : undefined,
      files: info.diff_files ?? null,
    });
    pendingHR.set(info.ticket_id, {
      ticket_id: info.ticket_id,
      project_id: row?.project_id ?? "",
      pr_id: info.pr_id,
      ...(info.pr_url ? { pr_url: info.pr_url } : {}),
      ...ev,
      held_at: nowIso(),
      requirement_id: info.requirement_id,
    });
    const key = `${info.ticket_id}\u0000${info.pr_id}`;
    if (heldNotifiedHR.has(key)) return;
    heldNotifiedHR.add(key);
    const id = info.ticket_id;
    const pr = info.pr_url ? `${info.pr_id}（${info.pr_url}）` : info.pr_id;
    const lead =
      info.cause === "adopt"
        ? `重启后，单 ${id} 的高风险 PR ${pr} 重新扣在合并队列里：放行不跨重启保存，如果重启前你已经放行，需要再放行一次。`
        : info.cause === "resubmit"
          ? `单 ${id} 放行后因合并冲突重做，换了新 PR ${pr}，新的改动你还没看过，已重新扣在合并队列里。`
          : `单 ${id} 的 PR ${pr} 属于高风险 PR（${HR_REASON_TEXT_JOIN(ev.reasons)}），已扣在合并队列里。`;
    const files = ev.files.length
      ? `涉及文件：${ev.files.map((f) => (f.old_path !== undefined ? `${f.path}（原 ${f.old_path}）` : f.path)).join("、")}${ev.files_more ? ` 等，另有 ${ev.files_more} 个` : ""}。`
      : "";
    await notify(
      `${lead}${files}等你放行或拒绝；不处理就一直扣着，不会合入。（v1 界面里还没有放行 / 拒绝的按钮，入口在后续版本提供。）`,
      {
        ...(row ? { project_id: row.project_id } : {}),
        requirement_id: info.requirement_id,
      },
    );
  }

  function decideHighRisk(
    ticket_id: string,
    pr_id: string,
    decision: "release" | "reject",
    detail?: string,
  ): Promise<HighRiskDecisionResult> {
    const p = decideChain.then(() => decideOnce(ticket_id, pr_id, decision, detail));
    decideChain = p.catch(() => undefined);
    return p;
  }

  async function decideOnce(
    ticket_id: string,
    pr_id: string,
    decision: "release" | "reject",
    detail?: string,
  ): Promise<HighRiskDecisionResult> {
    const gate = deps.highRisk;
    if (!gate)
      throw new HighRiskDecisionError("unavailable", ticket_id, "没有接上调度器的高风险闸门");
    // 10 记着的当前 PR 和传入的不一致：直接 stale_pr（9 也按 pr_id 校验）
    const known = pendingHR.get(ticket_id);
    if (known && known.pr_id !== pr_id)
      throw new HighRiskDecisionError(
        "stale_pr",
        ticket_id,
        `单 ${ticket_id} 的 PR 已更新（现在是 ${known.pr_id}，不是 ${pr_id}），请重新查看`,
      );
    if (decision === "release") {
      const result = await gate.release(ticket_id, pr_id);
      pendingHR.delete(ticket_id);
      return { decision, result };
    }
    const why = detail?.trim() || "用户拒绝";
    await gate.check(ticket_id, pr_id);
    // N5：走 041b 的关 PR 路径（组合根的 closeTicketPrs：先 sync、kind: "ticket"、PrAlreadyMergedError → merged）
    let state: "closed" | "none" | "merged" | "unconfirmed";
    let closeErr: unknown;
    if (!deps.closeTicketPr) {
      logger.warn(`单 ${ticket_id} 拒绝高风险 PR：没注入 closeTicketPr，不关 PR`);
      state = "none";
    } else {
      try {
        state = await deps.closeTicketPr(
          ticket_id,
          `高风险 PR 被用户拒绝：${why}`.slice(0, 500),
          pr_id,
        );
      } catch (err) {
        state = "unconfirmed";
        closeErr = err;
      }
    }
    if (state === "merged")
      // 保留的规则：PR 其实已合入就不拒绝、不上报，单子留在 9 里（9 的 sync 会把它记成合入）
      throw new HighRiskDecisionError(
        "already_merged",
        ticket_id,
        `单 ${ticket_id} 的 PR ${pr_id} 已经合入，不能拒绝`,
      );
    // 先记关 PR 的结果，再让 9 上报：上报处理读它写通知
    const errText = closeErr === undefined ? undefined : errMessage(closeErr).slice(0, 500);
    patchFields(ticket_id, {
      high_risk_close: {
        at: nowIso(),
        pr_id,
        state,
        ...(errText !== undefined ? { error: errText } : {}),
      },
    });
    try {
      // 9 自己再按 pr_id 校验一次（check 与 reject 之间 PR 可能换了）
      await gate.reject(ticket_id, pr_id, why);
    } catch (err) {
      await rejectNotApplied(ticket_id, pr_id, state, err);
      throw err;
    }
    pendingHR.delete(ticket_id);
    if (state === "unconfirmed") await rejectCloseFailed(ticket_id, pr_id, why, 0, closeErr);
    return { decision, pr_close: state };
  }

  /**
   * 关 PR 之后 9 的 reject 抛错（T-041c）：最常见是 check 与 reject 之间 PR 换了（stale_pr）。PR 已关（或关失败）、
   * 但裁决没生效——不静默：发 ticket_warning(high_risk_reject_not_applied)、通知用户，错误照抛给调用方。
   * 不重试关 PR、不改待裁决清单（9 那边新 PR 照常扣着，等用户重新裁决）。
   */
  async function rejectNotApplied(
    id: string,
    pr_id: string,
    state: "closed" | "none" | "unconfirmed",
    err: unknown,
  ): Promise<void> {
    const code = err instanceof HighRiskDecisionError ? err.code : "error";
    const msg = errMessage(err);
    logger.warn(`单 ${id} 拒绝高风险 PR ${pr_id}：关 PR 之后 9 的拒绝没生效（${code}）`, err);
    const closed =
      state === "closed"
        ? `PR ${pr_id} 已关、裁决未生效`
        : state === "none"
          ? `没有找到要关的 PR、裁决未生效`
          : `PR ${pr_id} 关闭未确认、裁决未生效`;
    const row = deps.storage.getTicket(id);
    if (!row) return;
    const where = { project_id: row.project_id, requirement_id: row.requirement_id };
    const trace = traceOf(row);
    try {
      await deps.publish({
        type: "ticket_warning",
        event_id: newId(),
        ts: nowIso(),
        trace_id: trace.trace_id,
        span_id: newId(),
        parent_span_id: trace.span_id,
        requirement_id: row.requirement_id,
        ticket_id: id,
        payload: {
          project_id: row.project_id,
          code: "high_risk_reject_not_applied",
          detail: `${closed}（${code}）：${msg}`.slice(0, 500),
        },
      });
    } catch (e2) {
      logger.warn(`单 ${id} 发 ticket_warning(high_risk_reject_not_applied) 失败`, e2);
    }
    const why =
      code === "stale_pr"
        ? "这期间单子的 PR 已经换了新的，新 PR 仍扣在合并队列里，请重新查看后再裁决。"
        : `原因：${msg.slice(0, 500)}。请重新查看后再裁决。`;
    await notify(`单 ${id} 的高风险裁决（拒绝）：${closed}。${why}`, where);
  }

  /** 拒绝后关 PR 失败（T-041c，N5）：首次发 ticket_warning(pr_close_failed)，按 041b 的间隔重试，用完交用户。 */
  async function rejectCloseFailed(
    id: string,
    pr_id: string,
    why: string,
    attempt: number,
    err: unknown,
  ): Promise<void> {
    const row = deps.storage.getTicket(id);
    if (!row) return;
    const msg = errMessage(err);
    logger.warn(`单 ${id} 拒绝高风险 PR 后关 PR 失败（第 ${attempt + 1} 次）`, err);
    const where = { project_id: row.project_id, requirement_id: row.requirement_id };
    if (attempt === 0) {
      const trace = traceOf(row);
      try {
        await deps.publish({
          type: "ticket_warning",
          event_id: newId(),
          ts: nowIso(),
          trace_id: trace.trace_id,
          span_id: newId(),
          parent_span_id: trace.span_id,
          requirement_id: row.requirement_id,
          ticket_id: id,
          payload: {
            project_id: row.project_id,
            code: "pr_close_failed",
            detail: `高风险 PR ${pr_id} 已拒绝，但关 PR 失败，稍后重试：${msg}`.slice(0, 500),
          },
        });
      } catch (e2) {
        logger.warn(`单 ${id} 发 ticket_warning(pr_close_failed) 失败`, e2);
      }
    }
    const delay = PR_CLOSE_RETRY_MS[attempt];
    if (delay === undefined) {
      await notify(
        `单 ${id} 的高风险 PR ${pr_id} 已拒绝，但关 PR 重试 ${PR_CLOSE_RETRY_MS.length} 次仍失败（${msg.slice(0, 500)}）。单子不会再合入；请到 GitHub 上手动关掉这个 PR。`,
        where,
      );
      return;
    }
    if (stopped) return;
    const h = timers.setTimeout(() => {
      retryTimers.delete(h);
      if (stopped) return;
      void retryRejectClose(id, pr_id, why, attempt + 1).catch((e3: unknown) =>
        logger.warn(`单 ${id} 重试关高风险 PR 出错`, e3),
      );
    }, delay);
    retryTimers.add(h);
  }

  async function retryRejectClose(id: string, pr_id: string, why: string, attempt: number) {
    let state: "closed" | "none" | "merged";
    try {
      state = await deps.closeTicketPr!(
        id,
        `高风险 PR 被用户拒绝：${why}`.slice(0, 500),
        pr_id,
      );
    } catch (err) {
      return rejectCloseFailed(id, pr_id, why, attempt, err);
    }
    patchFields(id, { high_risk_close: { at: nowIso(), pr_id, state } });
    if (state === "merged") {
      const row = deps.storage.getTicket(id);
      await notify(
        `单 ${id} 的高风险 PR ${pr_id} 你已拒绝，但重试关 PR 时发现它已经合入了集成分支，请确认集成分支上的改动。`,
        row ? { project_id: row.project_id, requirement_id: row.requirement_id } : {},
      );
    }
  }

  async function backpressurePaused(state: BackpressurePausedInput): Promise<void> {
    const reasons = state.reasons.map((r) => BACKPRESSURE_TEXT[r] ?? r).join("、") || "反压";
    const p = state.pending_prs;
    const held =
      p.high_risk_held > 0 || state.reasons.includes("pending_pr_limit")
        ? `，其中 ${p.high_risk_held} 张是等你裁决的高风险 PR${p.high_risk_held > 0 ? "（放行或拒绝后会腾出名额）" : ""}`
        : "";
    await notify(
      `已暂停派新单：${reasons}。待合并的 PR 共 ${p.total} 张（上限 ${p.limit}）${held}。在途的单照常编码、合并，恢复后自动继续派单。`,
      {},
    );
  }

  return {
    chat,
    split,
    start,
    createManualTicket,
    loadTicket,
    takeOver,
    decideHighRisk,
    highRiskHeld,
    pendingHighRisk,
    backpressurePaused,
  };
}
