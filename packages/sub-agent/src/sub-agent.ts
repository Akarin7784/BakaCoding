import { defaultIsBudgetExceeded } from "@bakacoding/coder-pool";
import { CommitPatchError, NoChangesError } from "@bakacoding/pr";
import type { CallCtx, Effort, ReviewReason, ReviewResult, TicketStatus } from "@bakacoding/types";
import type {
  ConflictResubmitRequest,
  HandleOptions,
  ReReviewRequest,
  ResubmitCounts,
  SchedulerFacingOutcome,
  SchedulerTicketLike,
  SubAgent,
  SubAgentConfig,
  SubAgentDeps,
  SubAgentOutcome,
  SubAgentTicket,
} from "./types.js";

/** 续跑时接在 feedback 最前面的说明（PD：当日预算用完暂停，第二天同一 worktree 续跑）。 */
export const BUDGET_RESUME_NOTE =
  "预算暂停后续跑：上次因当日预算用完中断，worktree 里保留了上次的部分改动，请在此基础上继续完成本单。";

/** 编码池结束但没能交出可提交改动时，写进 escalated.detail / 群消息的状态。 */
export type CoderFailureStatus = "gave_up" | "turn_limit" | "done_no_changes" | "commit_failed";

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

function formatReason(r: ReviewReason): string {
  const loc = r.file ? ` (${r.file}${r.line ? `:${r.line}` : ""})` : "";
  return `${r.category}${loc}: ${r.detail}`;
}

interface RunState {
  ticket: SubAgentTicket;
  worktree_path: string;
  branch: string;
  pr_id: string | null;
  counts: ResubmitCounts;
  phase: "coding" | "review";
  feedback?: string;
  is_resubmit: boolean;
  /** 最近一次编码池结果，review 阶段写摘要用 */
  last?: { summary: string; changed_files: string[] };
  /** handle / resume 通过后调 9 的 submit；conflict / rereview 只返回结果 */
  mode: "handle" | "conflict" | "rereview";
}

export function createSubAgent(deps: SubAgentDeps): SubAgent {
  const logger = deps.logger ?? console;
  const isBudgetExceeded = deps.isBudgetExceeded ?? defaultIsBudgetExceeded;
  const registry = new Map<string, SubAgentTicket>();
  /** 每单最近一次运行的 worktree / PR / 计数 / 摘要（reReview 用） */
  const active = new Map<string, Omit<RunState, "phase" | "feedback" | "is_resubmit" | "mode">>();
  const lastRound = new Map<string, number>();

  function register(t: SubAgentTicket): void {
    if (!t.ticket_id || !t.project_id) throw new Error("需求单必须带 ticket_id 和 project_id");
    registry.set(t.ticket_id, t);
  }

  async function lookup(t: SchedulerTicketLike): Promise<SubAgentTicket> {
    const hit = registry.get(t.ticket_id) ?? (await deps.loadTicket?.(t.ticket_id));
    if (!hit) throw new Error(`8 没有登记过需求单 ${t.ticket_id}，无法复投或重审`);
    registry.set(hit.ticket_id, hit);
    return hit;
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

  async function setStatus(t: SubAgentTicket, s: TicketStatus): Promise<void> {
    await deps.tickets.setStatus(t.ticket_id, s);
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
    active.set(s.ticket.ticket_id, {
      ticket: s.ticket,
      worktree_path: s.worktree_path,
      branch: s.branch,
      pr_id: s.pr_id,
      counts: { ...s.counts },
      last: s.last,
    });
  }

  async function escalate(
    s: RunState,
    reason: "review_limit" | "coder_failed" | "budget_exceeded",
    detail?: string,
  ): Promise<SubAgentOutcome> {
    remember(s);
    await setStatus(s.ticket, "escalated");
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

  /** 编码池或评审报预算耗尽：当日预算用完 → 暂停待续跑（不上报、不计复投）；否则按本单预算上报。 */
  async function budgetStop(s: RunState): Promise<SubAgentOutcome> {
    const st = await deps.budgetState(s.ticket.ticket_id);
    const ticketExhausted = st.ticket?.exhausted === true;
    if (st.daily_exhausted && !ticketExhausted) {
      remember(s);
      await setStatus(s.ticket, "pending");
      await say(
        s.ticket,
        "report",
        `${s.ticket.ticket_id} 当日预算已用完，${s.phase === "coding" ? "编码" : "评审"}暂停，等预算重置后在同一 worktree 续跑（不计复投）。`,
      );
      return {
        kind: "requeue_budget",
        resume: {
          ticket_id: s.ticket.ticket_id,
          worktree_path: s.worktree_path,
          branch: s.branch,
          pr_id: s.pr_id,
          resubmit_counts: { ...s.counts },
          phase: s.phase,
          is_resubmit: s.is_resubmit,
          ...(s.feedback !== undefined ? { feedback: s.feedback } : {}),
          ...(s.last ? { last: s.last } : {}),
        },
      };
    }
    const t = st.ticket;
    const detail = t
      ? `本单已花 ${t.spent_micro_usd} 微美元，剩余 ${t.remaining_micro_usd}`
      : "编码池报预算耗尽";
    return escalate(s, "budget_exceeded", detail);
  }

  async function run(s: RunState): Promise<SubAgentOutcome> {
    const limit = deps.getConfig().pipeline.resubmit_limits.review;
    for (;;) {
      remember(s);
      if (s.phase === "coding") {
        const effort = effortFor(deps.getConfig(), s.counts);
        await setStatus(s.ticket, s.is_resubmit ? "resubmitting" : "coding");
        await say(
          s.ticket,
          s.is_resubmit ? "resubmit" : "dispatch",
          s.is_resubmit
            ? `${s.ticket.ticket_id} 复投编码（评审复投 ${s.counts.review} 次，冲突复投 ${s.counts.conflict} 次，档位 ${effort}）。`
            : `${s.ticket.ticket_id} 派给 Flash 编码（档位 ${effort}）。`,
        );
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
        s.last = { summary: res.summary, changed_files: [...res.changed_files] };

        let failure: { status: CoderFailureStatus; feedback: string } | undefined;
        if (res.status === "done") {
          try {
            // 6 的 commitWorktree 要求先有一条未结束的 PR 记录：第一次提交前开 PR，之后复用同一个 pr_id
            if (s.pr_id === null)
              s.pr_id = await deps.pr.open(s.ticket.ticket_id, s.worktree_path, s.branch);
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
          s.counts.review++;
          s.feedback = failure.feedback;
          s.is_resubmit = true;
          continue;
        }
        await say(
          s.ticket,
          "report",
          `${s.ticket.ticket_id} 编码完成并已提交：${res.summary}${res.changed_files.length ? `（改动：${res.changed_files.join("、")}）` : ""}`,
        );
        s.phase = "review";
      }

      // ---- 评审 ----
      const pr_id = s.pr_id;
      if (pr_id === null) throw new Error(`${s.ticket.ticket_id} 进入评审时还没有 PR`);
      await setStatus(s.ticket, "in_review");
      const summary = deps.summarize
        ? await deps.summarize({
            ticket: s.ticket,
            summary: s.last?.summary ?? "",
            changed_files: s.last?.changed_files ?? [],
          })
        : defaultSummary(s.last);
      let result: ReviewResult;
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
      const round = await nextRound(s.ticket.ticket_id);
      await deps.rounds.save({
        ticket_id: s.ticket.ticket_id,
        round,
        diff: await deps.pr.diff(pr_id),
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
        if (s.mode === "handle") {
          await deps.submit({
            ticket_id: s.ticket.ticket_id,
            pr_id,
            worktree_path: s.worktree_path,
            round,
            review_resubmits: s.counts.review,
            base_commit: s.ticket.base_commit,
          });
          await setStatus(s.ticket, "merge_queued");
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
      s.counts.review++;
      s.feedback = reasonsToFeedback(result.reasons);
      s.is_resubmit = true;
      s.phase = "coding";
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
      if (!wt) {
        if (!deps.worktrees) throw new Error("没有传 worktree，也没有注入 deps.worktrees");
        wt = await deps.worktrees.create(ticket.ticket_id, ticket.base_commit, 0);
      }
      return run({
        ticket,
        worktree_path: wt.path,
        branch: wt.branch,
        pr_id: null,
        counts: { review: 0, conflict: 0 },
        phase: "coding",
        is_resubmit: false,
        mode: "handle",
      });
    },

    async resume(ticket, token) {
      register(ticket);
      if (token.ticket_id !== ticket.ticket_id)
        throw new Error(`续跑凭据属于 ${token.ticket_id}，不是 ${ticket.ticket_id}`);
      const last = token.last;
      return run({
        ticket,
        worktree_path: token.worktree_path,
        branch: token.branch,
        pr_id: token.pr_id,
        counts: { ...token.resubmit_counts },
        phase: token.phase,
        feedback:
          token.phase === "coding"
            ? token.feedback
              ? `${BUDGET_RESUME_NOTE}\n\n${token.feedback}`
              : BUDGET_RESUME_NOTE
            : token.feedback,
        is_resubmit: token.is_resubmit,
        ...(last ? { last } : {}),
        mode: "handle",
      });
    },

    async resubmitConflict(req: ConflictResubmitRequest) {
      const ticket = await lookup(req.ticket);
      const o = await run({
        ticket,
        worktree_path: req.worktree_path,
        branch: req.branch,
        pr_id: null, // 新 worktree、新分支：开新 PR，旧 PR 由 9 关闭
        counts: { ...req.resubmit_counts },
        phase: "coding",
        feedback: conflictFeedback(req.base_commit, req.conflicted_files),
        is_resubmit: true,
        mode: "conflict",
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
        is_resubmit: true, // 交回原评审成员
        mode: "rereview",
      });
      return toScheduler(o);
    },

    projectOf(ticket_id) {
      return registry.get(ticket_id)?.project_id;
    },
  };
}

function defaultSummary(last: RunState["last"]): string {
  if (!last) return "（没有编码摘要）";
  const files = last.changed_files.length ? last.changed_files.join("、") : "（编码代理未报告）";
  return `${last.summary}\n\n改动文件（编码代理自报，以 diff 为准）：${files}`;
}
