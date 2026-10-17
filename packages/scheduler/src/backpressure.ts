import type { Config } from "@bakacoding/config-budget";
import type { BackpressureReason } from "./types.js";

export interface BacklogInput {
  review: { pending: number; capacity: number };
  supervisor: { pending: number; capacity: number } | null;
  merge_queued: number;
  daily_exhausted: boolean;
}

export interface BackpressureDecision {
  paused: boolean;
  concurrency: number;
  reasons: BackpressureReason[];
}

/**
 * 反压（PD §9）：
 * - 评审积压 > 容量 × halve_at：编码并发减半；> 容量 × pause_at：暂停派新单。
 * - 积压回落到容量以下后，每 recover_interval_min 分钟加 recover_step 个槽位，直到回到 concurrency_max。
 * - 主管待办 > pipeline.supervisor_backlog_limit：暂停派新单。
 * - 排队中 + 评审中的 PR > backpressure.pending_pr_limit：暂停派新单（T-035）。
 * - 当日预算用完：暂停派新单，在途的单照常跑（T-035）。
 */
export class BackpressureController {
  private level: number;
  private lastStepAt: number | undefined;

  constructor(
    private readonly config: {
      pipeline: Pick<Config["pipeline"], "concurrency_max" | "supervisor_backlog_limit">;
      backpressure: Config["backpressure"];
    },
  ) {
    this.level = config.pipeline.concurrency_max;
  }

  decide(input: BacklogInput, now: number): BackpressureDecision {
    const { pipeline, backpressure: bp } = this.config;
    const max = pipeline.concurrency_max;
    const { pending, capacity } = input.review;
    const reasons: BackpressureReason[] = [];

    let target = max;
    if (pending > capacity * bp.pause_at) {
      target = 0;
      reasons.push("review_backlog_pause");
    } else if (pending > capacity * bp.halve_at) {
      target = Math.max(1, Math.floor(max / 2));
      reasons.push("review_backlog_halve");
    }

    if (target < this.level) {
      this.level = target;
      this.lastStepAt = undefined;
    } else if (this.level < max) {
      if (pending < capacity) {
        // 回落到容量以下后开始计时，每个间隔加一档
        const interval = bp.recover_interval_min * 60_000;
        if (this.lastStepAt === undefined) this.lastStepAt = now;
        const steps = Math.floor((now - this.lastStepAt) / interval);
        if (steps > 0) {
          this.level = Math.min(max, this.level + steps * bp.recover_step);
          this.lastStepAt += steps * interval;
        }
      } else {
        this.lastStepAt = undefined;
      }
      if (this.level < max && reasons.length === 0) reasons.push("review_backlog_recovering");
    }

    if (input.supervisor && input.supervisor.pending > pipeline.supervisor_backlog_limit)
      reasons.push("supervisor_backlog");
    if (input.merge_queued + pending > bp.pending_pr_limit) reasons.push("pending_pr_limit");
    if (input.daily_exhausted) reasons.push("daily_budget");

    const paused =
      reasons.some((r) => r !== "review_backlog_halve" && r !== "review_backlog_recovering") ||
      this.level === 0;
    return { paused, concurrency: paused ? 0 : this.level, reasons };
  }
}
