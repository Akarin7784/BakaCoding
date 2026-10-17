import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { defaultIsBudgetExceeded } from "@bakacoding/coder-pool";
import { CommitPatchError, NoChangesError } from "@bakacoding/pr";
import type {
  BakaEvent,
  CallCtx,
  Effort,
  ReviewReason,
  ReviewResult,
  TicketStatus,
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

/** 续跑时接在 feedback 最前面的说明（PD：当日预算用完暂停，第二天同一 worktree 续跑）。 */
export const BUDGET_RESUME_NOTE =
  "预算暂停后续跑：上次因当日预算用完中断，worktree 里保留了上次的部分改动，请在此基础上继续完成本单。";

/** 编码池结束但没能交出可提交改动时，写进 escalated.detail / 群消息的状态。 */
export type CoderFailureStatus = "gave_up" | "turn_limit" | "done_no_changes" | "commit_failed";

/** handle 里出异常时所在的阶段，决定上报原因（见 SubAgentEscalationReason）。 */
export type SubAgentStage =
  "coding" | "open" | "commit" | "diff" | "budget" | "review" | "round_save" | "submit";

const STAGE_REASON: Record<SubAgentStage, SubAgentEscalationReason> = {
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
}

export function createSubAgent(deps: SubAgentDeps): SubAgent {
  const logger = deps.logger ?? console;
  const isBudgetExceeded = deps.isBudgetExceeded ?? defaultIsBudgetExceeded;
  const registry = new Map<string, SubAgentTicket>();
  /** 每单最近一次运行的状态（reReview 用；重启后从存储读当前 PR 留给 T-039） */
  const active = new Map<string, RunState>();
  const lastRound = new Map<string, number>();
  const root = realOrResolved(deps.worktreeRoot);

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
      remember(s);
      if (s.phase === "coding") {
        const effort = effortFor(deps.getConfig(), s.counts);
        await setStatus(s, s.is_resubmit ? "resubmitting" : "coding");
        if (s.announce !== undefined) {
          await say(s.ticket, "dispatch", `${s.announce}（档位 ${effort}）。`);
          s.announce = undefined;
        }
        s.stage = "coding";
        const res = await deps.coder.runTicket({
          ticket: { ticket_id: s.ticket.ticket_id, project_id: s.ticket.project_id },
          prompt: await prompt(s.ticket),
          worktree_path: s.worktree_path,
          permission_list: s.ticket.permission_list,
          effort,
          ...(s.feedback !== undefined ? { feedback: s.feedback } : {}),
          ctx: ctx(s.ticket, s.is_resubmit),
        });
        if (res.status === "budget_exceeded") return budgetStop(s);

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
      const summary = deps.summarize
        ? await deps.summarize({
            ticket: s.ticket,
            summary: s.last.summary,
            changed_files: s.last.changed_files,
          })
        : defaultSummary(s.last);
      let result: ReviewResult;
      s.stage = "review";
      try {
        result = await deps.review({
          ticket: {
            ticket_id: s.ticket.ticket_id,
            ticket_text: s.ticket.ticket_text,
            architecture_constraints: await constraints(s.ticket),
          },
          pr_id,
          permission_list: s.ticket.permission_list,
          summary,
          ctx: ctx(s.ticket, s.is_resubmit),
        });
      } catch (e) {
        if (isBudgetExceeded(e)) return budgetStop(s);
        throw e;
      }
      s.stage = "diff";
      const diff = await deps.pr.diff(pr_id);
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
          });
        }
        return {
          kind: "merge_queued",
          pr_id,
          round,
          resubmit_counts: { ...s.counts },
          reviewer: result.reviewer,
        };
      }
      if (s.counts.review >= limit) return escalate(s, "review_limit");
      await countResubmit(s, reasonsToFeedback(result.reasons), "评审不过");
    }
  }

  /** handle 模式：未分类的异常也上报，不让单子卡在 coding；其他模式交给 9 处理。 */
  async function run(s: RunState): Promise<SubAgentOutcome> {
    try {
      return await loop(s);
    } catch (e) {
      if (s.mode !== "handle") throw e;
      logger.warn(
        `[bakacoding/sub-agent] ${s.ticket.ticket_id} 在 ${s.stage} 阶段出错，上报：${String(e)}`,
      );
      return escalate(s, STAGE_REASON[s.stage], errorDetail(s.stage, e));
    }
  }

  function toScheduler(o: SubAgentOutcome): SchedulerFacingOutcome {
    if (o.kind === "merge_queued")
      return { pr_id: o.pr_id, review_resubmits: o.resubmit_counts.review };
    if (o.kind === "escalated")
      return o.pr_id ? { escalated: true, pr_id: o.pr_id } : { escalated: true };
    return { requeue_budget: true, resume: o.resume };
  }

  return {
    async handle(ticket, options: HandleOptions = {}) {
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
      });
    },

    async resume(minimal, token) {
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
        mode: token.mode ?? "handle",
        // 9 的 resume 约定：续跑评审通过一律由 8 调 submit（含冲突复投途中暂停的单）
        submit: true,
        announce: `${ticket.ticket_id} 预算重置，续跑`,
        stage: token.phase === "coding" ? "coding" : "review",
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
      const a = active.get(ticket.ticket_id);
      if (!a || a.pr_id !== req.pr_id)
        throw new Error(`${ticket.ticket_id} 的当前 PR 不是 ${req.pr_id}，无法重审`);
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
      });
      return toScheduler(o);
    },

    projectOf(ticket_id) {
      return registry.get(ticket_id)?.project_id;
    },
  };
}

function defaultSummary(last: LastRun): string {
  const files = last.changed_files.length ? last.changed_files.join("、") : "（diff 里没有文件）";
  return `${last.summary || "（没有编码摘要）"}\n\n改动文件（来自 6 的 diff）：${files}`;
}
