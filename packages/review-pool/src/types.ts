import type { CallCtx, CheckResultLike, Diff, Effort, EventOf, PermissionList } from "./deps.js";

export type MaybePromise<T> = T | Promise<T>;

/** 7 只用到的需求单字段（types 里还没有 Ticket 类型）。 */
export interface ReviewTicket {
  ticket_id: string;
  /** 需求单原文（目标、背景、改动范围、完成标准、接口声明等） */
  ticket_text: string;
  /** 项目架构约束；没有可省略 */
  architecture_constraints?: string[];
}

export interface ReviewInput {
  ticket: ReviewTicket;
  pr_id: string;
  permission_list: PermissionList;
  /** 8 写好的精简摘要，7 不再调模型生成 */
  summary: string;
  /** 模块 1 call() 的 ctx；是否复投看 ctx.is_resubmit */
  ctx: CallCtx;
  /**
   * 可选：取消评审。进入前已中止直接抛 signal.reason；排队等成员时中止会立刻退出队列并抛；
   * 调模型时原样传给 1 的 call()（T-044），中途取消由 1 中止请求，7 释放成员、不写 AssignmentStore，
   * 统一抛 signal.reason；1 没理会 signal、取消后才返回时同样丢弃结果并抛。
   */
  signal?: AbortSignal;
  /**
   * 可选（T-038）：8 判定的高风险单（依赖类单：改了依赖清单或锁文件，或需求单 `kind: "dependency"`）。
   * 为 true 时评审提示词在不可信区块之前加一段系统说明（「## 高风险单（系统说明）」）；false 或不给时提示词与之前完全相同。
   */
  high_risk?: boolean;
}

/** 7 读到的配置子集；模块 3 的 Config 在结构上满足它。 */
export interface ReviewPoolConfig {
  roles: {
    supervisor: { provider: string; model: string };
    review_board: {
      members: { id: string; provider: string; model: string; effort: Effort }[];
      review_assignment: "least_busy";
      sticky_on_resubmit: boolean;
      skip_rate_limited: boolean;
    };
  };
  backpressure: { reviews_per_member: number };
}

/**
 * 模块 1 的 call()（只用到 output；与 `@bakacoding/model-gateway` 的 `call` 同形）。role 固定传 reviewer。
 * 调用方给了 signal 时第 7 个参数传 `{ signal }`，否则不传。
 */
export type ModelCall = (
  role: "reviewer",
  provider: string,
  model: string,
  effort: Effort,
  prompt: string,
  ctx: CallCtx,
  options?: { signal?: AbortSignal },
) => Promise<{ output: string }>;

/**
 * 模块 1 rateLimitState() 的适配：给定 provider/model 是否正被限流。
 * 模块 1 尚未合入，接线时由调用方把 rateLimitState() 转成这个判断。
 */
export type IsRateLimited = (target: { provider: string; model: string }) => MaybePromise<boolean>;

/** 模块 6 PrProvider 方法的可选参数（T-122）：7 把 `review` 的 signal 原样透传下去。 */
export interface ReviewPrCallOptions {
  signal?: AbortSignal;
}

/**
 * 模块 6 PrProvider 的子集。`review` 给了 signal 时，`checks` / `diff` 的第二个参数传
 * `{ signal }`（T-122，模块 6 的 T-102a / T-110 起支持请求级超时与取消）；没给就不传第二个参数。
 */
export interface ReviewPrSource {
  diff(pr_id: string, opts?: ReviewPrCallOptions): Promise<Diff>;
  checks(pr_id: string, opts?: ReviewPrCallOptions): Promise<CheckResultLike[]>;
}

/**
 * 记住每张单上一轮由哪个成员评审（复投粘性）。默认内存实现；持久化用 `createRoundAssignmentStore`，
 * 从 2 的 PR 轮次 `reviewer` 字段恢复。
 */
export interface AssignmentStore {
  get(ticket_id: string): MaybePromise<string | undefined>;
  set(ticket_id: string, member_id: string): MaybePromise<void>;
}

export type ReviewBacklogEvent = EventOf<"review_backlog">;
/** 发布入参：seq / event_id / ts 由总线补（与模块 0 PublishInput 兼容）。 */
export type ReviewBacklogInput = Omit<ReviewBacklogEvent, "seq" | "event_id" | "ts"> & {
  event_id?: string;
  ts?: string;
};
export type PublishReviewBacklog = (event: ReviewBacklogInput) => unknown;

export interface ReviewPoolDeps {
  getConfig: () => ReviewPoolConfig;
  call: ModelCall;
  pr: ReviewPrSource;
  /** 模块 3 的 promptTemplate("reviewer")；3 尚未提供，由调用方注入 */
  promptTemplate: (role: "reviewer") => MaybePromise<string>;
  publish: PublishReviewBacklog;
  isRateLimited?: IsRateLimited;
  assignments?: AssignmentStore;
  /** 所有可用成员都忙或被限流时，多久重新检查一次限流状态，默认 1000 ms */
  pollIntervalMs?: number;
  logger?: { warn(message: string): void };
}
