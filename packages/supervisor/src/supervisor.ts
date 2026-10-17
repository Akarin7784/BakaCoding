// T-040：模块 10 主管——chat / split / 手动单 / loadTicket / 项目导入告知。
import { randomBytes, randomUUID } from "node:crypto";
import type { SchedulerTicket } from "@bakacoding/scheduler";
import type { StoredTicket } from "@bakacoding/storage";
import type { SubAgentTicket } from "@bakacoding/sub-agent";
import { untrustedNotice, wrapUntrusted, type CallCtx, type Trace } from "@bakacoding/types";
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
  type ManualTicketInput,
  type SplitRequest,
  type SplitResult,
  type Supervisor,
  type SupervisorDeps,
  type SupervisorTicket,
  type TicketValidationError,
  type UserMessage,
} from "./types.js";
import { decodeFields, encodeFields, type StoredFields } from "./fields.js";
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
  async function persistAndDispatch(tickets: SupervisorTicket[], summary: string | undefined) {
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
        fields: encodeFields(t),
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
    parts.push(wrapUntrusted(req.text, "requirement", n));
    return parts.join("\n\n");
  }

  async function split(req: SplitRequest): Promise<SplitResult> {
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
    const base = buildSplitPrompt(template, req, project, decisions, files, knownIds, n);

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
          depends_on: [...new Set((t.depends_on ?? []).map((d) => idOf.get(d) ?? d))],
          priority: t.priority ?? "normal",
          ...(t.kind === "dependency" ? { kind: "dependency" as const } : {}),
          permission_list: [],
          origin: "split",
        };
      });
      await persistAndDispatch(tickets, out.summary);
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
    await persistAndDispatch([ticket], undefined);
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

  function start(): () => void {
    return deps.subscribe("project_created", (e) => {
      const p = e.payload;
      void Promise.resolve(
        deps.notifyUser({
          text: `项目「${p.name}」已导入（${p.project_id}），语言：${p.language}，GitHub 远程：${p.has_github_remote ? "有" : "无"}。提需求时说明是哪个项目即可。`,
          project_id: p.project_id,
        }),
      ).catch((err: unknown) => logger.warn("通知用户项目已导入失败", err));
    });
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

  return { chat, split, start, createManualTicket, loadTicket };
}
