import type { BudgetState, Config } from "@bakacoding/config-budget";
import type { EventContextFn, PrProvider, SyncChange } from "@bakacoding/pr";
import type { EventOf, EventType, TicketStatus } from "@bakacoding/types";

export type MaybePromise<T> = T | Promise<T>;

/** interface_changed 里的一项：文件 + 符号。 */
export type ChangedInterface =
  EventOf<"interface_changed">["payload"]["changed_interfaces"][number];

/**
 * 9 只用到的需求单字段（types 里还没有 Ticket 类型）。公共字段（trace）取自主管拆单时给本单开的 span，
 * 9 发的事件都用它。
 */
export interface SchedulerTicket {
  ticket_id: string;
  requirement_id: string;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  /** 依赖的单号：全部合入后本单才出队；任一依赖已上报（含间接依赖），本单挂起 */
  depends_on?: string[];
  /** 写入范围（glob），用来算 interface_changed 的受影响单 */
  write_scope?: string[];
  /** 接口声明（必填项，文件 + 符号）；合并后与改动文件取交集作为 changed_interfaces */
  interfaces?: ChangedInterface[];
}

/** 事件发布入参：seq 由总线分配；9 总是自己填 event_id 和 ts。 */
export type PublishInput<K extends EventType = EventType> = Omit<
  EventOf<K>,
  "seq" | "event_id" | "ts"
> & { event_id: string; ts: string };

/** 只用到的总线能力（与模块 0 的 EventBus 兼容）。 */
export interface SchedulerBus {
  publish(input: PublishInput<"escalated"> | PublishInput<"interface_changed">): unknown;
  subscribe(
    type: "review_backlog",
    handler: (e: EventOf<"review_backlog">) => void | Promise<void>,
  ): () => void;
  subscribe(
    type: "supervisor_backlog",
    handler: (e: EventOf<"supervisor_backlog">) => void | Promise<void>,
  ): () => void;
}

/** 9 用到的 6 的接口。 */
export type SchedulerPr = Pick<PrProvider, "merge" | "close" | "sync" | "diff">;

/** 4 的 worktree 接口（未接 4 的 WorktreeManager 前注入）。 */
export interface SchedulerWorktrees {
  /** 对应 4 的 createWorktree(ticket_id, base_commit, resubmit_index)，路径 …/<ticket_id>-r<n> */
  create(
    ticket_id: string,
    base_commit: string,
    round: number,
  ): MaybePromise<{ path: string; branch: string }>;
  /** 对应 4 的 cleanup(path) */
  cleanup(path: string): MaybePromise<unknown>;
}

/** 冲突复投请求：9 已建好新一轮 worktree，交给 8 重新编码、评审、开新 PR。 */
export interface ConflictResubmitRequest {
  ticket: SchedulerTicket;
  /** 新一轮轮次 n+1 */
  round: number;
  worktree_path: string;
  branch: string;
  /** 新 worktree 的基线（集成分支名） */
  base_commit: string;
  conflicted_files: string[];
  /** 旧 PR，9 在新 PR 开出后关闭 */
  previous_pr_id: string;
  resubmit_counts: { review: number; conflict: number };
}

/** 基线前进且涉及本单接口或依赖：交给 8 重新评审，不计复投。 */
export interface ReReviewRequest {
  ticket: SchedulerTicket;
  pr_id: string;
  /** 本单基线之后合入的单 */
  merged_since: Array<{ ticket_id: string; sha: string; files: string[] }>;
}

/**
 * 8 的结果：`pr_id` 为（新）PR 已开出且评审通过，可以回到合并队列；`escalated` 为 8 已自己发了上报。
 * `review_resubmits` 为 8 累计的评审复投次数（9 只记录，不改）。
 */
export type SubAgentOutcome =
  { pr_id: string; review_resubmits?: number } | { escalated: true; pr_id?: string };

/** 8 的接口（8 未实现前注入 mock）。 */
export interface SchedulerSubAgent {
  resubmitConflict(req: ConflictResubmitRequest): Promise<SubAgentOutcome>;
  reReview(req: ReReviewRequest): Promise<SubAgentOutcome>;
}

/** 9 维护的需求单状态写到 2（适配 storage.saveTicket 的 status 字段）。 */
export interface TicketStatusStore {
  setStatus(ticket_id: string, status: TicketStatus): MaybePromise<void>;
}

export interface MergeResultRecord {
  conflict: boolean;
  base_changed: boolean;
  re_reviewed: boolean;
  merged: boolean;
  reason?: "target_dirty" | "merge_blocked" | "rate_limit";
}

export interface SchedulerClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface SchedulerDeps {
  bus: SchedulerBus;
  /** 启动时调用：把 9 的 eventContext 注入 6（通常包一层 createPrProvider） */
  createPr(opts: { eventContext: EventContextFn }): MaybePromise<SchedulerPr>;
  config: {
    pipeline: Pick<
      Config["pipeline"],
      "concurrency_max" | "resubmit_limits" | "supervisor_backlog_limit"
    >;
    backpressure: Config["backpressure"];
  };
  /** 3 的 budgetState()，只看 daily_exhausted */
  budgetState(): MaybePromise<Pick<BudgetState, "daily_exhausted">>;
  tickets: TicketStatusStore;
  /** 2 的 saveMergeResult（诊断包用），可选 */
  saveMergeResult?(
    ticket_id: string,
    result: { conflicted: boolean; base_changed: boolean; re_reviewed: boolean; merged: boolean },
  ): MaybePromise<void>;
  worktrees: SchedulerWorktrees;
  subAgent: SchedulerSubAgent;
  /** 合入目标，默认 INTEGRATION_BRANCH */
  target?: string;
  clock?: SchedulerClock;
  newId?: () => string;
  /** target_dirty 后的重试间隔，默认 30 秒 */
  target_dirty_retry_ms?: number;
  /** 后台任务（复投、重审）出错时调用，默认 console.warn */
  onError?: (error: unknown, ticket_id: string) => void;
}

export type BackpressureReason =
  | "review_backlog_halve"
  /** 积压已回落，并发正按 recover_step 逐步恢复 */
  | "review_backlog_recovering"
  | "review_backlog_pause"
  | "supervisor_backlog"
  | "pending_pr_limit"
  | "daily_budget";

export interface BackpressureState {
  /** true 时暂停派新单（在途的单照常跑、照常合并） */
  paused: boolean;
  /** 当前允许的编码并发（≤ concurrency_max；paused 时为 0） */
  concurrency: number;
  reasons: BackpressureReason[];
  review_backlog: { pending: number; capacity: number };
  supervisor_backlog: { pending: number; capacity: number } | null;
  /** 排队中（merge_queued）+ 评审中（review_backlog.pending）的 PR 数，超过 limit 暂停派单 */
  pending_prs: { merge_queued: number; in_review: number; total: number; limit: number };
  daily_budget_exhausted: boolean;
}

export type DependencyState = "ready" | "waiting" | "held";

export interface QueueEntryView {
  ticket_id: string;
  status: TicketStatus;
  pr_id: string | null;
  round: number;
  resubmit_counts: { review: number; conflict: number };
  dependency: DependencyState;
}

export interface Scheduler {
  /** 启动：建 6（注入 eventContext），订阅 review_backlog / supervisor_backlog */
  start(): Promise<void>;
  stop(): void;
  /** 登记一张单（状态 pending）。重复登记同一单号报错。 */
  enqueue(ticket: SchedulerTicket): Promise<void>;
  /** 8 在评审通过后调用：PR 进合并队列（状态 merge_queued） */
  submit(input: {
    ticket_id: string;
    pr_id: string;
    worktree_path: string;
    round?: number;
    review_resubmits?: number;
    /**
     * 本轮 worktree 的基线 commit。是本会话内某次合并的 sha 时，只有它之后的合并才算「基线前进」；
     * 不传或不认识时按 enqueue 时的位置算（之后的合并都算）。
     */
    base_commit?: string;
  }): Promise<void>;
  /** 给 6 的 eventContext：按 ticket_id，其次按 pr_id（含已关闭的旧 PR）查本单的 trace */
  eventContext: EventContextFn;
  /** 最近一次合并尝试的结果；没有尝试过返回 undefined */
  mergeResult(pr_id: string): MergeResultRecord | undefined;
  /** 拉 6 的 sync() 并把变化应用到 TicketStatus，返回应用了的变化 */
  sync(): Promise<SyncChange[]>;
  /** 反压信号（T-039 派单只读它，不重复实现） */
  backpressureState(): Promise<BackpressureState>;
  /** 依赖状态：全部合入 ready；有依赖没合入 waiting；有依赖（含间接）已上报 held */
  dependencyState(ticket_id: string): DependencyState;
  status(ticket_id: string): TicketStatus | undefined;
  snapshot(): QueueEntryView[];
  /** 测试 / 关闭用：等合并循环和后台任务都结束 */
  idle(): Promise<void>;
}
