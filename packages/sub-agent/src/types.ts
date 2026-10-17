import type { BudgetState } from "@bakacoding/config-budget";
import type { CoderPool } from "@bakacoding/coder-pool";
import type { PrProvider } from "@bakacoding/pr";
import type { ReviewInput } from "@bakacoding/review-pool";
import type {
  Effort,
  EventOf,
  PermissionList,
  ReviewResult,
  RoundRecord,
  TicketStatus,
} from "@bakacoding/types";

export type MaybePromise<T> = T | Promise<T>;

/** 两类复投计数（PD §4：运行时状态，记在 PR 记录里，不写进需求单）。 */
export interface ResubmitCounts {
  /** 评审不过 + 编码池 gave_up / turn_limit / 提交失败（同一个计数，上限 pipeline.resubmit_limits.review） */
  review: number;
  /** 合并冲突（由 9 计数并传入，8 只透传） */
  conflict: number;
}

/**
 * 8 用到的需求单字段（types 里还没有 Ticket 类型）。trace 三个字段取自主管拆单时给本单开的 span，
 * 与 9 的 `SchedulerTicket` 一致。
 */
export interface SubAgentTicket {
  ticket_id: string;
  project_id: string;
  requirement_id: string;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  /** 需求单原文（目标、背景、改动范围、完成标准、接口声明等） */
  ticket_text: string;
  /** 本单 worktree 的基线 commit（建 r0 worktree 用，也报给 9 的 submit） */
  base_commit: string;
  /** Flash 的权限清单（三级）；T-037 原样使用，按单设计权限留给后续单 */
  permission_list: PermissionList;
  /** 项目架构约束；不给就按 project_id 从 deps.architectureConstraints 取 */
  architecture_constraints?: readonly string[];
}

/** 9 的写状态接口（与 T-035 `TicketStatusStore` 同形）。 */
export interface TicketStatusStore {
  setStatus(ticket_id: string, status: TicketStatus): MaybePromise<void>;
}

/** PR 轮次记录：写用 2 的 `savePrRecord`，读用于续编轮次号（可选）。 */
export interface RoundStore {
  save(round: RoundRecord & { ticket_id: string }): MaybePromise<void>;
  /** 读已保存的轮次（顺序不限）；不给就只按本进程内存续编 */
  list?(ticket_id: string): MaybePromise<readonly { round: number }[]>;
}

/** 4 的 worktree 接口（与 T-035 `SchedulerWorktrees.create` 同形）。 */
export interface SubAgentWorktrees {
  create(
    ticket_id: string,
    base_commit: string,
    round: number,
  ): MaybePromise<{ path: string; branch: string }>;
}

/** 9 的 `submit`（T-035）：评审通过后把 PR 交进合并队列。 */
export type MergeQueueSubmit = (input: {
  ticket_id: string;
  pr_id: string;
  worktree_path: string;
  round?: number;
  review_resubmits?: number;
  base_commit?: string;
}) => MaybePromise<void>;

/** 发布入参：seq / event_id / ts 由总线补（与模块 0 PublishInput 兼容）。 */
export type SubAgentPublishInput<K extends "escalated" | "group_message"> = Omit<
  EventOf<K>,
  "seq" | "event_id" | "ts"
> & { event_id?: string; ts?: string };

export type SubAgentPublish = (
  event: SubAgentPublishInput<"escalated"> | SubAgentPublishInput<"group_message">,
) => unknown;

/** 8 读到的配置子集；模块 3 的 Config 在结构上满足它。 */
export interface SubAgentConfig {
  roles: { coder: { effort: Effort; resubmit_effort: readonly Effort[] } };
  pipeline: { resubmit_limits: { review: number } };
}

export interface SubAgentDeps {
  getConfig: () => SubAgentConfig;
  coder: Pick<CoderPool, "runTicket">;
  review: (input: ReviewInput) => Promise<ReviewResult>;
  /** 6：开 PR、提交 worktree、读 diff（写进轮次记录） */
  pr: Pick<PrProvider, "open" | "commitWorktree" | "diff">;
  /** 3 的 budgetState(ticket_id)：编码池报 budget_exceeded 时据此区分当日预算和本单预算 */
  budgetState: (ticket_id: string) => MaybePromise<Pick<BudgetState, "daily_exhausted" | "ticket">>;
  rounds: RoundStore;
  /**
   * 写 TicketStatus。归属（#40 评审）：8 只在 `handle` / handle 模式的 `resume` 里写 `merge_queued` 及之前的状态
   * （coding / resubmitting / in_review / pending / escalated，`merge_queued` 在调 submit 之前写）；
   * 进合并队列之后的状态（含冲突复投、重审期间）全部由 9 写，8 不写。
   */
  tickets: TicketStatusStore;
  /**
   * 评审复投计数的历史来源（跨重启）：返回本单已发生的评审复投次数（含编码池失败那几次）。
   * 用 `eventLogResubmitHistory(storage)` 从 2 的事件日志数：8 每计一次评审复投恰好发一条
   * `group_message(kind: "resubmit", sender: "sub_agent")`。冲突复投数由 9 计并传入。
   */
  resubmitHistory: (ticket_id: string) => MaybePromise<{ review: number }>;
  /** 4 的 worktree 根目录（`<repo>/.bakacoding/worktrees`）：传进来的 worktree 路径必须在它下面 */
  worktreeRoot: string;
  /** 不给 options.worktree 时用它建 r0 worktree */
  worktrees?: SubAgentWorktrees;
  /** 9 的 submit：handle / resume 评审通过后调用。冲突复投和重审的结果由 9 自己放回队列，不调它 */
  submit: MergeQueueSubmit;
  publish: SubAgentPublish;
  architectureConstraints?: (project_id: string) => MaybePromise<readonly string[]>;
  /** 写编码提示词（需求单部分）；默认用 promptTemplate("sub_agent") + 需求单原文 */
  buildPrompt?: (ticket: SubAgentTicket) => MaybePromise<string>;
  /** 3 的 promptTemplate("sub_agent")（3 尚未提供，暂注入）；不给就只用需求单原文 */
  promptTemplate?: (role: "sub_agent") => MaybePromise<string>;
  /** 给 7 的精简摘要；默认用编码池 summary + 自报改动文件 */
  summarize?: (input: {
    ticket: SubAgentTicket;
    summary: string;
    changed_files: readonly string[];
  }) => MaybePromise<string>;
  /** 识别评审时模型报的预算耗尽；默认看 error.code === "BUDGET_EXCEEDED" */
  isBudgetExceeded?: (error: unknown) => boolean;
  /**
   * 冲突复投时求新 worktree 的基线 sha（如 `git rev-parse HEAD`，在编码前调用）。不给就用 9 传来的 `base_commit`；
   * 9 传的是分支名时 submit 的 base_commit 会认不出，建议注入或让 9 直接传 sha。
   */
  resolveBase?: (worktree_path: string) => MaybePromise<string>;
  /**
   * 2 的 PR 记录（`storage.prStore()` 的 `get`，结构同 6 的 `PrRecord`）。`reReview` 以它为准确认 9 给的 PR
   * 就是本单当前 PR（`kind: ticket`、单号一致、状态 open / conflict），并从中取 worktree、分支和基线，
   * 所以重启后（本进程没跑过这张单）也能重审（T-039）。不给就只认本进程跑过的单（T-037 行为）。
   */
  prRecords?: { get(pr_id: string): MaybePromise<StoredPrRecord | undefined> };
  /** 9 冲突复投 / 重审 / 续跑传入的 ticket 只有 SchedulerTicket 字段，用它补全；不给就查本进程登记过的单 */
  loadTicket?: (ticket_id: string) => MaybePromise<SubAgentTicket | undefined>;
  logger?: { warn(message: string): void };
}

/** 8 从 2 读的 PR 记录字段（6 的 `TicketPrRecord` 的子集；集成记录没有 ticket_id / worktree_path）。 */
export interface StoredPrRecord {
  pr_id: string;
  kind: string;
  ticket_id?: string;
  worktree_path?: string;
  branch: string;
  base_sha: string;
  status: string;
}

/** 当日预算用完时的续跑凭据：9 第二天原样交回 `resume`。 */
export interface ResumeToken {
  ticket_id: string;
  worktree_path: string;
  branch: string;
  pr_id: string | null;
  resubmit_counts: ResubmitCounts;
  /** 暂停时所在阶段：coding 重新编码（保留已有改动），review 直接重评审 */
  phase: "coding" | "review";
  /** 暂停那一轮原本要带的 feedback（续跑时接在「预算暂停后续跑」说明之后） */
  feedback?: string;
  /** 暂停那一轮是不是复投（决定 is_resubmit 和 status） */
  is_resubmit: boolean;
  /** 暂停在 review 阶段时，上一次编码池的总结和 diff 里的改动文件（写精简摘要用） */
  last?: { summary: string; changed_files: string[] };
  /** 这一轮 worktree 的基线 commit（submit 报给 9，避免 9 误判基线前进） */
  base_commit: string;
  /** 这一轮 worktree 的轮次 n（路径 …/<ticket_id>-r<n>；submit 的 round 报它） */
  worktree_round: number;
  /** 暂停时所在入口：handle（续跑通过后调 submit、写状态）/ conflict / rereview（只返回结果，不写状态） */
  mode?: "handle" | "conflict" | "rereview";
}

/**
 * 8 发的上报原因。`review_limit` / `coder_failed` / `budget_exceeded` 是正常超限；handle 里遇到未分类的异常时
 * 也上报（不让单子卡在 coding）：6 / 9 的调用出错记 `github_manual`，评审或写轮次出错记 `review_limit`，
 * 编码池抛错记 `coder_failed`，读预算出错记 `budget_exceeded`，`detail` 写 `<阶段>_error: <name>: <message>`。
 */
export type SubAgentEscalationReason =
  "review_limit" | "coder_failed" | "budget_exceeded" | "github_manual" | "internal_error";

export type SubAgentOutcome =
  /** 评审通过，已调 9 的 submit（冲突复投 / 重审不调） */
  | {
      kind: "merge_queued";
      pr_id: string;
      round: number;
      resubmit_counts: ResubmitCounts;
      reviewer: string | null;
    }
  /** 已发 escalated（reason 同事件） */
  | {
      kind: "escalated";
      reason: SubAgentEscalationReason;
      detail?: string;
      pr_id: string | null;
      resubmit_counts: ResubmitCounts;
    }
  /** 当日预算用完：不上报、不计复投；9 等预算重置后用 token 调 resume */
  | { kind: "requeue_budget"; resume: ResumeToken };

export interface HandleOptions {
  /** 9 已建好的 worktree；不给就由 8 用 deps.worktrees 从 base_commit 建 r0。路径须在 worktreeRoot 下 */
  worktree?: { path: string; branch: string };
  /** 重启后接着跑：沿用已开的 PR（不再 open） */
  pr_id?: string;
  /** 给定 worktree 的轮次 n；不给就从路径末尾 `-r<n>` 解析，解析不出按 0 */
  worktree_round?: number;
  /**
   * 取消（T-039，9 的 stop() 用）：原样传给 5 的 runTicket 和 7 的 review。中止后 8 抛 `signal.reason`
   * （没有则抛名为 AbortError 的错误），不上报、不写状态、不计复投，单子停在原状态等重新派。
   */
  signal?: AbortSignal;
}

/** resume 的选项（T-039）。 */
export interface ResumeOptions {
  /** 同 HandleOptions.signal */
  signal?: AbortSignal;
}

// ---- 与 T-035（模块 9，尚未合入）对齐的入口：同形的结构类型，8 不依赖 9 的包 ----

export interface SchedulerTicketLike {
  ticket_id: string;
  requirement_id: string;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
}

export interface ConflictResubmitRequest {
  ticket: SchedulerTicketLike;
  round: number;
  worktree_path: string;
  branch: string;
  base_commit: string;
  conflicted_files: string[];
  previous_pr_id: string;
  resubmit_counts: ResubmitCounts;
}

export interface ReReviewRequest {
  ticket: SchedulerTicketLike;
  pr_id: string;
  merged_since: Array<{ ticket_id: string; sha: string; files: string[] }>;
  /** T-035 后续提交新增：基线不明时为 true，带目标分支 HEAD（8 目前只透传进摘要） */
  base_unknown?: boolean;
  target_head?: string;
}

/**
 * 给 9 的结果（T-035 `SubAgentOutcome`）：`pr_id` 为评审通过、可回合并队列；`escalated` 为 8 已发上报。
 * T-037 另加 `requeue_budget`（当日预算用完），9 需要补这一支。
 */
export type SchedulerFacingOutcome =
  | { pr_id: string; review_resubmits?: number }
  | { escalated: true; pr_id?: string }
  | { requeue_budget: true; resume: ResumeToken };

export interface SubAgent {
  /** 主流程：编码 → 提交 → 开 PR → 评审 → 复投 / 上报 / 进合并队列 */
  handle(ticket: SubAgentTicket, options?: HandleOptions): Promise<SubAgentOutcome>;
  /**
   * 当日预算重置后续跑（同一 worktree，保留已有改动，不计复投）。ticket 可以只带 ticket_id（9 只有 SchedulerTicket）：
   * 先查本进程登记过的单，再用 deps.loadTicket 补全，都没有就报错。评审通过一律调 9 的 submit。
   */
  resume(
    ticket: SubAgentTicket | { ticket_id: string },
    token: ResumeToken,
    options?: ResumeOptions,
  ): Promise<SubAgentOutcome>;
  /** 9 的冲突复投入口：新 worktree、新 PR，冲突文件作 feedback；冲突计数由 9 给 */
  resubmitConflict(req: ConflictResubmitRequest): Promise<SchedulerFacingOutcome>;
  /** 9 的重审入口（基线前进且涉及本单接口或依赖）：同一 PR 再评一次，不计复投 */
  reReview(req: ReReviewRequest): Promise<SchedulerFacingOutcome>;
  /** 本进程登记过的单所属项目（给 7 的 storageRoundSource 用，T-011 的 listPrRounds 合入前） */
  projectOf(ticket_id: string): string | undefined;
}
