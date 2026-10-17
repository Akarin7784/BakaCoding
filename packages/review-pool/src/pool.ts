import {
  ReviewBacklogSchema,
  ReviewResultSchema,
  type CallCtx,
  type Effort,
  type ReviewReason,
  type ReviewResult,
} from "@bakacoding/types";
import { InMemoryAssignmentStore } from "./memory.js";
import { buildPrompt, parseModelOutput } from "./prompt.js";
import type {
  AssignmentStore,
  ReviewInput,
  ReviewPoolConfig,
  ReviewPoolDeps,
  ReviewTicket,
} from "./types.js";

/** 成员数为 0 时主管兼任评审用的成员 id。 */
export const SUPERVISOR_MEMBER_ID = "supervisor";
/** 失败的 CI 结论：有任一条就直接判不过（ci_failed），不调模型。 */
export const FAILED_CHECK_CONCLUSIONS = ["failure", "timed_out"] as const;
export const UNPARSEABLE_DETAIL = "评审输出无法解析";

interface Member {
  id: string;
  provider: string;
  model: string;
  effort: Effort;
}

interface Waiter {
  pick: () => Promise<Member | undefined>;
  resolve: (m: Member) => void;
  reject: (e: unknown) => void;
}

export interface ReviewPool {
  review(input: ReviewInput): Promise<ReviewResult>;
  backlog(): { pending: number; capacity: number };
}

/** 当前配置下的评审成员；0 个时主管兼任（effort 固定 max）。 */
function membersOf(cfg: ReviewPoolConfig): Member[] {
  const ms = cfg.roles.review_board.members;
  if (ms.length > 0) return ms.map((m) => ({ ...m }));
  const s = cfg.roles.supervisor;
  return [{ id: SUPERVISOR_MEMBER_ID, provider: s.provider, model: s.model, effort: "max" }];
}

function capacityOf(cfg: ReviewPoolConfig): number {
  return membersOf(cfg).length * cfg.backpressure.reviews_per_member;
}

export function createReviewPool(deps: ReviewPoolDeps): ReviewPool {
  const assignments: AssignmentStore = deps.assignments ?? new InMemoryAssignmentStore();
  const logger = deps.logger ?? console;
  const pollMs = deps.pollIntervalMs ?? 1000;
  const inflight = new Map<string, number>();
  const waiters: Waiter[] = [];
  let pending = 0;
  let lastEmitted: { pending: number; capacity: number } | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let draining = false;
  let redrain = false;

  const busy = (id: string) => inflight.get(id) ?? 0;

  async function limited(m: Member, cfg: ReviewPoolConfig): Promise<boolean> {
    if (!cfg.roles.review_board.skip_rate_limited || !deps.isRateLimited) return false;
    return Boolean(await deps.isRateLimited({ provider: m.provider, model: m.model }));
  }

  /** least_busy：未限流、未满的成员里正在评审数最少的，平手按配置顺序。 */
  async function leastBusy(cfg: ReviewPoolConfig, exclude?: string): Promise<Member | undefined> {
    const all = membersOf(cfg);
    const pool = exclude && all.length > 1 ? all.filter((m) => m.id !== exclude) : all;
    let best: Member | undefined;
    for (const m of pool) {
      if (busy(m.id) >= cfg.backpressure.reviews_per_member) continue;
      if (await limited(m, cfg)) continue;
      if (!best || busy(m.id) < busy(best.id)) best = m;
    }
    return best;
  }

  /**
   * 复投且开了粘性：上一轮的成员还在配置里且没被限流 → 只等它（满了就排队等它的槽位）；
   * 否则换人，按负载分配。
   */
  function picker(ticket: ReviewTicket, ctx: CallCtx, exclude?: string) {
    return async (): Promise<Member | undefined> => {
      const cfg = deps.getConfig();
      if (!exclude && ctx.is_resubmit && cfg.roles.review_board.sticky_on_resubmit) {
        const prev = await assignments.get(ticket.ticket_id);
        const m = prev ? membersOf(cfg).find((x) => x.id === prev) : undefined;
        if (m && !(await limited(m, cfg))) {
          return busy(m.id) < cfg.backpressure.reviews_per_member ? m : undefined;
        }
      }
      return leastBusy(cfg, exclude);
    };
  }

  async function drain(): Promise<void> {
    if (draining) {
      redrain = true;
      return;
    }
    draining = true;
    try {
      do {
        redrain = false;
        for (let i = 0; i < waiters.length;) {
          const w = waiters[i]!;
          let m: Member | undefined;
          try {
            m = await w.pick();
          } catch (e) {
            waiters.splice(i, 1);
            w.reject(e);
            continue;
          }
          if (m) {
            waiters.splice(i, 1);
            inflight.set(m.id, busy(m.id) + 1);
            w.resolve(m);
          } else i++;
        }
      } while (redrain);
    } finally {
      draining = false;
    }
    schedulePoll();
  }

  /** 有人排队时定时重查（限流恢复不会触发 release）。 */
  function schedulePoll() {
    if (waiters.length === 0 || pollTimer) return;
    pollTimer = setTimeout(() => {
      pollTimer = undefined;
      void drain();
    }, pollMs);
  }

  function acquire(pick: () => Promise<Member | undefined>): Promise<Member> {
    return new Promise<Member>((resolve, reject) => {
      waiters.push({ pick, resolve, reject });
      void drain();
    });
  }

  function release(m: Member) {
    const n = busy(m.id) - 1;
    if (n > 0) inflight.set(m.id, n);
    else inflight.delete(m.id);
    void drain();
  }

  async function emitBacklog(ctx: CallCtx) {
    const capacity = capacityOf(deps.getConfig());
    if (lastEmitted && lastEmitted.pending === pending && lastEmitted.capacity === capacity) return;
    lastEmitted = { pending, capacity };
    try {
      const event = ReviewBacklogSchema.omit({ seq: true, event_id: true, ts: true }).parse({
        type: "review_backlog",
        requirement_id: ctx.requirement_id,
        ticket_id: ctx.ticket_id,
        trace_id: ctx.trace.trace_id,
        span_id: ctx.trace.span_id,
        parent_span_id: ctx.trace.parent_span_id,
        payload: { pending, capacity },
      });
      await deps.publish(event);
    } catch (e) {
      logger.warn(`[bakacoding/review-pool] review_backlog 发布失败：${String(e)}`);
    }
  }

  async function runModel(member: Member, input: ReviewInput, prompt: string) {
    const ctx: CallCtx = { ...input.ctx, role: "reviewer" };
    const { output } = await deps.call(
      "reviewer",
      member.provider,
      member.model,
      member.effort,
      prompt,
      ctx,
    );
    return parseModelOutput(output);
  }

  async function reviewInner(input: ReviewInput): Promise<ReviewResult> {
    // 7-3：先看 CI；有失败的 check 直接判不过，不调模型；在跑或没配 CI 不等
    const checks = await deps.pr.checks(input.pr_id);
    const failed = checks.filter(
      (c) =>
        c.conclusion !== null &&
        (FAILED_CHECK_CONCLUSIONS as readonly string[]).includes(c.conclusion),
    );
    if (failed.length > 0) {
      return {
        verdict: "fail",
        reasons: failed.map((c): ReviewReason => ({
          category: "ci_failed",
          detail: `${c.name}: ${c.conclusion}${c.url ? `（${c.url}）` : ""}`,
        })),
      };
    }

    const diff = await deps.pr.diff(input.pr_id);
    const prompt = buildPrompt(await deps.promptTemplate("reviewer"), input, diff);

    let held: Member | undefined = await acquire(picker(input.ticket, input.ctx));
    try {
      let member: Member = held;
      let out = await runModel(member, input, prompt);
      if (!out) {
        // 7-6：换一个成员重试一次（只有一个成员就同一个再试）
        release(member);
        held = undefined;
        member = held = await acquire(picker(input.ticket, input.ctx, member.id));
        out = await runModel(member, input, prompt);
      }
      await assignments.set(input.ticket.ticket_id, member.id);
      if (!out)
        return { verdict: "fail", reasons: [{ category: "bug", detail: UNPARSEABLE_DETAIL }] };
      return ReviewResultSchema.parse({ verdict: out.verdict, reasons: out.reasons });
    } finally {
      if (held) release(held);
    }
  }

  return {
    async review(input) {
      pending++;
      await emitBacklog(input.ctx);
      try {
        return await reviewInner(input);
      } finally {
        pending--;
        await emitBacklog(input.ctx);
      }
    },
    backlog() {
      return { pending, capacity: capacityOf(deps.getConfig()) };
    },
  };
}
