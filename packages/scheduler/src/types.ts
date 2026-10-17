import type { BudgetState, Config } from "@bakacoding/config-budget";
import type { EventContext, EventContextFn, PrProvider, SyncChange } from "@bakacoding/pr";
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
  /**
   * 写入范围（glob）：派单时按它加写入范围逻辑锁（T-039），也用来算 interface_changed 的受影响单。
   * 不给（或为空）按整个仓库 `**` 处理：与所有单互斥。
   */
  write_scope?: string[];
  /** 接口声明（必填项，文件 + 符号）；合并后与改动文件取交集作为 changed_interfaces */
  interfaces?: ChangedInterface[];
  /**
   * 排期优先级（PD §4，与思考档位无关）：`deferred` 的单在 3 的闲时开关 `budget.offpeak_preference` 打开、
   * 当前不是闲时时不派（T-039）；默认 `normal`。
   */
  priority?: "normal" | "deferred";
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
  /** 新 worktree 的基线 sha（T-039：9 先读目标分支 HEAD，再从这个 sha 建 worktree） */
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
  /** 本单基线之后合入的单（base_unknown 时为空：记录不足，不知道合了哪些） */
  merged_since: Array<{ ticket_id: string; sha: string; files: string[] }>;
  /** 合并日志定不了本单基线、且目标分支 HEAD 与本单基线不同，保守重审 */
  base_unknown?: true;
  /** base_unknown 时目标分支当前 HEAD */
  target_head?: string;
}

/**
 * 8 的结果：`pr_id` 为（新）PR 已开出且评审通过，可以回到合并队列；`escalated` 为 8 已自己发了上报。
 * `review_resubmits` 为 8 累计的评审复投次数（9 只记录，不改）。
 */
export type SubAgentOutcome =
  | { pr_id: string; review_resubmits?: number }
  | { escalated: true; pr_id?: string }
  /**
   * 冲突复投或重审途中当日预算用完（T-037）：8 不上报、不计复投；9 把单子放回 pending，
   * 存下续跑凭据（9 不解析），预算重置后原样交回 8 的 resume。
   */
  | { requeue_budget: true; resume: unknown };

/**
 * 8 的 resume(ticket, token) 的结果（与 8 的 SubAgentOutcome 同形，9 只用到这些字段）。
 * resume 走 8 的主流程：评审通过时 8 自己调 9 的 submit，再返回 merge_queued。
 */
export type ResumeOutcome =
  | { kind: "merge_queued"; pr_id: string }
  | { kind: "escalated"; pr_id: string | null }
  | { kind: "requeue_budget"; resume: unknown };

/**
 * 8 的 handle(ticket) 的结果（与 8 的 SubAgentOutcome 同形，9 只用到这些字段）：`merge_queued` 时 8 已经
 * 写好 merge_queued 并调过 9 的 submit；`escalated` / `requeue_budget` 时 8 已经写好 escalated / pending（进队前的状态归 8）。
 */
export type DispatchOutcome = ResumeOutcome;

/**
 * 9 调 8 的 handle / resume 时带的选项（T-039）：`signal` 在 9 的 stop() 时中止，8 原样传给 5 的 runTicket
 * 和 7 的 review；中止后 8 抛 signal.reason，9 不上报、不改状态（没有 aborted 状态）。
 */
export interface SubAgentCallOptions {
  signal?: AbortSignal;
}

/** 8 的接口（8 未实现前注入 mock）。 */
export interface SchedulerSubAgent {
  /**
   * 派单（T-039）：对应 8 的 `handle(ticket)`。不注入时 9 不派单，只做合并队列（T-035 行为）。
   * 8 的 handle 要完整的 SubAgentTicket，组合根按单号补全（同 resume）。
   */
  handle?(ticket: SchedulerTicket, options?: SubAgentCallOptions): Promise<DispatchOutcome>;
  resubmitConflict(req: ConflictResubmitRequest): Promise<SubAgentOutcome>;
  reReview(req: ReReviewRequest): Promise<SubAgentOutcome>;
  /**
   * 预算重置后续跑：对应 8 的 `resume(ticket, token)`，token 是 8 给的续跑凭据，原样交回。
   * 注意：8 的 resume 要完整的 SubAgentTicket，9 只有 SchedulerTicket，组合根要按单号补全（或 8 像
   * resubmitConflict 一样自己 lookup）。
   */
  resume(
    ticket: SchedulerTicket,
    token: unknown,
    options?: SubAgentCallOptions,
  ): Promise<ResumeOutcome>;
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
    > &
      Partial<Pick<Config["pipeline"], "concurrency_hard_max">>;
    backpressure: Config["backpressure"];
  };
  /**
   * 目标分支（集成分支）当前 HEAD 的 sha，如 `git rev-parse <target>`。start() 时读一次作为合并日志的起点；
   * 合并日志定不了某张单的基线时（重启后、基线未知），合并前再读一次比对。
   */
  targetHead(): MaybePromise<string>;
  /**
   * 3 的 budgetState()：`daily_exhausted` 停派新单、决定何时续跑预算暂停的单；`offpeak_now` /
   * `offpeak_preference`（可选）决定 `priority: deferred` 的单是否等闲时（T-039）。
   */
  budgetState(): MaybePromise<
    Pick<BudgetState, "daily_exhausted"> &
      Partial<Pick<BudgetState, "offpeak_now" | "offpeak_preference">>
  >;
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
  /**
   * 找不到所属单的 PR（集成记录、重启后不认识的 PR）的事件上下文。不传时返回最小上下文：
   * requirement_id / trace_id 为 `unattributed:<pr_id>`，span_id 新生成，parent_span_id 为 null。
   * （EventContext 没有 project_id / ticket_id 字段；ticket_id 由 6 按 PR 记录自己填，集成记录为 null。）
   */
  unknownEventContext?: (info: { pr_id: string; ticket_id: string | null }) => EventContext;
  /** 后台任务（复投、重审）出错时调用，默认 console.warn；9 随后发 escalated(github_manual) */
  onError?: (error: unknown, ticket_id: string) => void;
  /**
   * 独占区域（PD §4：依赖清单、锁文件、全局配置、迁移、公共类型）的 glob，默认 `DEFAULT_EXCLUSIVE_ZONES`。
   * 写入范围碰到独占区域的单单独排队：同一时刻最多一张在持锁（T-039）。
   */
  exclusive_zones?: readonly string[];
  /**
   * 派单轮询间隔（毫秒，默认 60 秒；0 关闭）。入队、交队、合并、编码结束、积压变化时都会立即派单，
   * 轮询只用来接住预算重置、进入闲时、反压恢复这类没有事件的变化。只在注入了 8 的 handle 时启用。
   */
  dispatch_poll_ms?: number;
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
  /** 9 内存里的状态；8 编码 / 评审期间（进队前）仍是 pending，以 2 里的 TicketStatus 为准 */
  status: TicketStatus;
  /** 9 派出、还占着编码槽位（handle 未返回且还没 submit） */
  coding: boolean;
  /** 当前持有的写入范围锁；没持锁为 null（终态自动释放） */
  locked_scope: string[] | null;
  pr_id: string | null;
  round: number;
  resubmit_counts: { review: number; conflict: number };
  dependency: DependencyState;
  /** 因当日预算用完放回 pending、等预算重置后续跑 */
  budget_paused: boolean;
  /** 8 在 submit 时标的高风险（依赖类单，T-038）；只打标，9 照常合并 */
  high_risk: boolean;
}

export interface Scheduler {
  /** 启动：建 6（注入 eventContext），订阅 review_backlog / supervisor_backlog（T-038 起不再订阅 write_scope_requested） */
  start(): Promise<void>;
  /** 停止：停合并循环、取消等待中的定时器、停止派单，并中止交给 8 的 handle / resume（signal，T-039） */
  stop(): void;
  /** 登记一张单（状态 pending）。重复登记同一单号报错。注入了 8 的 handle 时随即尝试派单。 */
  enqueue(ticket: SchedulerTicket): Promise<void>;
  /**
   * 写入范围逻辑锁（modules.md §9 `lock`）：把 write_scope 并进本单已持有的锁。与其他在途单的锁可能重叠、
   * 或本单碰到独占区域而另一张独占单正持锁时返回 `fail`，不改任何锁。单子到终态时自动释放。
   */
  lock(ticket_id: string, write_scope: readonly string[]): "ok" | "fail";
  /**
   * 派单一轮（T-039）：反压闸门打开时先把预算暂停的单交回 8 续跑，再按入队顺序把依赖已合入、能加上写入范围锁、
   * 不需等闲时的 pending 单交给 8 的 handle，直到编码槽位（反压给的并发，不超过 concurrency_hard_max）占满。
   * 返回这一轮新派出的单号。内部在各种变化时会自动调用，一般不用手动调。
   */
  dispatch(): Promise<string[]>;
  /** 8 在评审通过后调用：PR 进合并队列（状态 merge_queued） */
  submit(input: {
    ticket_id: string;
    pr_id: string;
    worktree_path: string;
    round?: number;
    review_resubmits?: number;
    /**
     * 本轮 worktree 的基线 commit，不传用 6 的 diff(pr_id).base_sha。是本会话内某次合并的 sha 或 start()
     * 时的目标分支 HEAD 时，从那里算「基线前进」；都不是（或拿不到）时合并前和目标分支当前 HEAD 比，
     * 不同就保守地重审。
     */
    base_commit?: string;
    /** 依赖类单（改了依赖清单或锁文件，或需求单 kind: "dependency"）由 8 标为高风险（T-038）；只打标，不扣留 */
    high_risk?: boolean;
  }): Promise<void>;
  /**
   * 重启接管（T-041a，提案 R3）：把重启前已在合并队列里（2 里是 merge_queued / conflict / re_reviewing）的单
   * 直接登记成 `merge_queued` 并排到队尾，**不派单**（不交 8 的 handle）、只触发合并循环。
   * - 必须带 PR id 和 head（`pr_id`、`head_sha` 非空，还要 `worktree_path`），否则抛错、不登记。
   * - 幂等：同一单已用同一个 PR 接回过（还没到终态）再调返回 `"already"`，什么都不改；单已用别的 PR 登记、
   *   是 pending（enqueue 过）或已到终态时抛错。
   * - 基线：`base_commit` 一般是 PR 记录的 `base_sha`；重启后合并日志定不了它，合并前和目标分支 HEAD 比，
   *   不同就保守重审（同 submit 的 base_unknown）。冲突复投数默认取 `round`（worktree 的轮次 n）。
   * - 写入范围锁直接占上（重启前它就持着锁，不检查重叠）。
   */
  adopt(
    ticket: SchedulerTicket,
    input: {
      pr_id: string;
      /** PR 当前 head 提交（6 的记录里的 head_sha）；没有就不接 */
      head_sha: string;
      worktree_path: string;
      round?: number;
      base_commit?: string;
      review_resubmits?: number;
      /** 默认等于 round */
      conflict_resubmits?: number;
      high_risk?: boolean;
    },
  ): Promise<"adopted" | "already">;
  /**
   * 8 转来的范围外写入申请（T-038，8 是 write_scope_requested 的唯一答复方，9 不再订阅它）：对本单重新加锁，
   * 成功把范围并进本单 write_scope 并返回 ok；失败不改锁、发 `escalated(scope_lock_failed)`，返回原因。
   * 未登记或已终态的单返回失败。granted / denied 事件由 8 发。
   */
  extendScope(
    ticket_id: string,
    scope: readonly string[],
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** 给 6 的 eventContext：按 ticket_id，其次按 pr_id（含已关闭的旧 PR）查本单的 trace */
  eventContext: EventContextFn;
  /** 最近一次合并尝试的结果；没有尝试过返回 undefined */
  mergeResult(pr_id: string): MergeResultRecord | undefined;
  /** 拉 6 的 sync() 并把变化应用到 TicketStatus，返回应用了的变化 */
  sync(): Promise<SyncChange[]>;
  /**
   * 预算重置后续跑：当日预算未用完时，把因预算放回 pending 的单交回 8 的 resume（带原续跑凭据），
   * 返回这次续跑的单号；预算仍用完返回 []。T-039 在派单闸门打开时调用。
   */
  resumeBudgetPaused(): Promise<string[]>;
  /** 因当日预算放回 pending、等续跑的单号（T-039 不要把它们当新单再派） */
  budgetPaused(): string[];
  /** 反压信号（T-039 派单只读它，不重复实现） */
  backpressureState(): Promise<BackpressureState>;
  /** 依赖状态：全部合入 ready；有依赖没合入 waiting；有依赖（含间接）已上报 held */
  dependencyState(ticket_id: string): DependencyState;
  status(ticket_id: string): TicketStatus | undefined;
  snapshot(): QueueEntryView[];
  /** 测试 / 关闭用：等合并循环和后台任务都结束 */
  idle(): Promise<void>;
}
