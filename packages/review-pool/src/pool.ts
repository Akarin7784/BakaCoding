import { randomBytes } from "node:crypto";
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
  /** 已出队（拿到成员、出错或被中止），drain 不再处理 */
  settled: boolean;
}

/** signal 中止时抛的错误：优先 signal.reason，没有就抛名为 AbortError 的错误。 */
export function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const e = new Error("评审已中止");
  e.name = "AbortError";
  return e;
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw abortReason(signal);
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
  // 本池的不可信区块标签 nonce：创建时随机生成，池内不变；只出现在拼入的输入部分
  const nonce = randomBytes(8).toString("hex");
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
        // 按快照顺序处理；pick 期间被中止的等待者已出队，跳过
        for (const w of [...waiters]) {
          if (w.settled) continue;
          let m: Member | undefined;
          try {
            m = await w.pick();
          } catch (e) {
            if (w.settled) continue;
            dequeue(w);
            w.reject(e);
            continue;
          }
          if (m && !w.settled) {
            dequeue(w);
            inflight.set(m.id, busy(m.id) + 1);
            w.resolve(m);
          }
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

  /** 出队；队列空了就清掉轮询定时器。 */
  function dequeue(w: Waiter) {
    w.settled = true;
    const i = waiters.indexOf(w);
    if (i >= 0) waiters.splice(i, 1);
    if (waiters.length === 0 && pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = undefined;
    }
  }

  function acquire(pick: () => Promise<Member | undefined>, signal?: AbortSignal): Promise<Member> {
    return new Promise<Member>((resolve, reject) => {
      if (signal?.aborted) return reject(abortReason(signal));
      const onAbort = () => {
        if (w.settled) return;
        dequeue(w);
        reject(abortReason(signal!));
      };
      const w: Waiter = {
        pick,
        resolve: (m) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(m);
        },
        reject: (e) => {
          signal?.removeEventListener("abort", onAbort);
          reject(e);
        },
        settled: false,
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      waiters.push(w);
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
    const { signal } = input;
    const args = ["reviewer", member.provider, member.model, member.effort, prompt, ctx] as const;
    let output: string;
    try {
      // signal 原样传给 1（T-044）；没给就不传第 7 个参数
      ({ output } = await (signal ? deps.call(...args, { signal }) : deps.call(...args)));
    } catch (e) {
      // 调用中途取消：1 抛 AbortError；统一改抛 signal.reason
      throwIfAborted(signal);
      throw e;
    }
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
          detail: `CI 检查 ${c.name} 结果为 ${c.conclusion}，请按日志修复后重新提交${c.url ? `：${c.url}` : ""}`,
        })),
        reviewer: null,
      };
    }

    const diff = await deps.pr.diff(input.pr_id);
    const prompt = buildPrompt(await deps.promptTemplate("reviewer"), input, diff, nonce);

    const { signal } = input;
    let held: Member | undefined = await acquire(picker(input.ticket, input.ctx), signal);
    try {
      let member: Member = held;
      // signal 传给 1 的 call()；1 没理会、取消后才返回时同样丢弃结果、不写分配记录
      let out = await runModel(member, input, prompt);
      throwIfAborted(signal);
      if (!out) {
        // 7-6：换一个成员重试一次（只有一个成员就同一个再试）
        release(member);
        held = undefined;
        member = held = await acquire(picker(input.ticket, input.ctx, member.id), signal);
        out = await runModel(member, input, prompt);
        throwIfAborted(signal);
      }
      await assignments.set(input.ticket.ticket_id, member.id);
      if (!out)
        return {
          verdict: "fail",
          reasons: [{ category: "bug", detail: UNPARSEABLE_DETAIL }],
          reviewer: member.id,
        };
      return ReviewResultSchema.parse({
        verdict: out.verdict,
        reasons: out.reasons,
        reviewer: member.id,
      });
    } finally {
      if (held) release(held);
    }
  }

  return {
    async review(input) {
      // 进入前已中止：直接抛，不查 CI、不调模型、不计入 pending
      throwIfAborted(input.signal);
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
