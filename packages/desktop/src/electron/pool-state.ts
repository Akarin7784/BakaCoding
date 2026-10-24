// UI-06b：`pool:state` 的主进程侧——原样转 9 的 backpressureState()，不自己算、不改 9 的接口。
// 只读 / 未接线（没有调度器）固定 ok:false；抛错只给固定文案，不带路径和原始报错。
import type { BackpressureState } from "@bakacoding/scheduler";
import type { DesktopPoolStateResult } from "../shared/api.js";

export const POOL_STATE_UNAVAILABLE = "编码池状态暂不可用（后端只读或未接线）";
export const POOL_STATE_FAILED = "读取编码池状态失败";

/** 按 9 的 BackpressureState 字段逐个挑出来下发（多出来的字段不过 IPC）。 */
function pick(s: BackpressureState): BackpressureState {
  return {
    paused: s.paused,
    concurrency: s.concurrency,
    reasons: [...s.reasons],
    review_backlog: { pending: s.review_backlog.pending, capacity: s.review_backlog.capacity },
    supervisor_backlog: s.supervisor_backlog
      ? { pending: s.supervisor_backlog.pending, capacity: s.supervisor_backlog.capacity }
      : null,
    pending_prs: {
      merge_queued: s.pending_prs.merge_queued,
      in_review: s.pending_prs.in_review,
      total: s.pending_prs.total,
      limit: s.pending_prs.limit,
      high_risk_held: s.pending_prs.high_risk_held,
    },
    daily_budget_exhausted: s.daily_budget_exhausted,
  };
}

export async function readPoolState(
  backpressureState: (() => Promise<BackpressureState>) | undefined,
): Promise<DesktopPoolStateResult> {
  if (!backpressureState) return { ok: false, reason: POOL_STATE_UNAVAILABLE };
  try {
    return { ok: true, state: pick(await backpressureState()) };
  } catch {
    return { ok: false, reason: POOL_STATE_FAILED };
  }
}
