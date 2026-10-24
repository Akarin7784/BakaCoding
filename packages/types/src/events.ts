import { z } from "zod";
import { EffortSchema, IsoUtcSchema, MicroUsdSchema, RoleSchema, TraceSchema } from "./common.js";
import { TicketStatusSchema } from "./ticket.js";

const Id = z.string().min(1);

export const EventCommonSchema = TraceSchema.extend({
  event_id: Id,
  seq: z.number().int().nonnegative(),
  ts: IsoUtcSchema,
  requirement_id: Id.nullable().describe(
    "所属需求；只有项目级事件（PROJECT_LEVEL_EVENT_TYPES：project_created / project_removed / review_backlog / supervisor_backlog）可以为 null，其他事件必填",
  ),
  ticket_id: Id.nullable(),
});

/** 不属于任何需求的项目级事件：只有这些事件的 `requirement_id` 可以为 null。 */
export const PROJECT_LEVEL_EVENT_TYPES = [
  "project_created",
  "project_removed",
  "review_backlog",
  "supervisor_backlog",
] as const;
export type ProjectLevelEventType = (typeof PROJECT_LEVEL_EVENT_TYPES)[number];

const ev = <T extends string, P extends z.ZodRawShape>(type: T, payload: P) =>
  EventCommonSchema.extend({
    type: z.literal(type),
    requirement_id: Id.describe("所属需求，必填"),
    payload: z.object(payload),
  });

const projectEv = <T extends ProjectLevelEventType, P extends z.ZodRawShape>(type: T, payload: P) =>
  EventCommonSchema.extend({ type: z.literal(type), payload: z.object(payload) });

export const TokensSchema = z
  .object({
    input: z
      .number()
      .int()
      .nonnegative()
      .describe("全部输入 token，含缓存命中部分；未命中 = input - cache_hit_input"),
    output: z.number().int().nonnegative().describe("输出 token"),
    cache_hit_input: z
      .number()
      .int()
      .nonnegative()
      .describe("缓存命中的输入 token，是 input 的子集，必须 <= input"),
  })
  .refine((t) => t.cache_hit_input <= t.input, {
    message: "cache_hit_input 不能大于 input",
    path: ["cache_hit_input"],
  })
  .describe("token 计数：input 含 cache_hit_input，未命中 = input - cache_hit_input");

export const ProjectCreatedSchema = projectEv("project_created", {
  project_id: Id,
  name: z.string().min(1),
  language: z.string().min(1),
  has_github_remote: z.boolean(),
  /** T-142：仓库所在路径，可选；只给桌面端主进程用，诊断包导出时必须去掉（T-143） */
  repo_path: z.string().min(1).optional(),
});
/** T-142：项目记录已删除。只删记录，不动仓库，不删历史事件；之后再发 project_created 可重新登记。 */
export const ProjectRemovedSchema = projectEv("project_removed", {
  project_id: Id,
});
export const CallCompletedSchema = ev("call_completed", {
  role: RoleSchema,
  provider: Id,
  model: Id,
  effort: EffortSchema,
  prompt: z.string(),
  output: z.string(),
  tokens: TokensSchema,
  cache_hit: z.boolean(),
  latency_ms: z.number().int().nonnegative(),
  cost: MicroUsdSchema,
  is_resubmit: z.boolean(),
  rate_limited_retry: z.number().int().nonnegative(),
  error: z
    .object({
      code: z
        .string()
        .min(1)
        .describe(
          "模块 1 的错误码：AUTH / QUOTA / RATE_LIMIT / INVALID_REQUEST / CONTEXT_WINDOW_EXCEEDED / SERVER / NETWORK / BAD_RESPONSE / CONFIG，取消为 ABORTED",
        ),
    })
    .nullable()
    .optional()
    .describe("调用失败时的标记；成功为 null。旧事件没有这个字段，按成功处理"),
});
const TicketRequired = { ticket_id: Id.describe("写入范围申请所属单号，必填") };
export const WriteScopeRequestedSchema = ev("write_scope_requested", {
  request_id: Id,
  requested_scope: z.array(z.string().min(1)).min(1),
  reason: z.string(),
}).extend(TicketRequired);
export const WriteScopeGrantedSchema = ev("write_scope_granted", {
  request_id: Id.describe("对应 write_scope_requested 的 request_id"),
  granted_scope: z.array(z.string().min(1)).min(1),
}).extend(TicketRequired);
export const WriteScopeDeniedSchema = ev("write_scope_denied", {
  request_id: Id.describe("对应 write_scope_requested 的 request_id"),
  requested_scope: z.array(z.string().min(1)).min(1),
  reason: z.string(),
}).extend(TicketRequired);
export const ESCALATION_REASONS = [
  "review_limit",
  "conflict_limit",
  "scope_lock_failed",
  "resplit_limit",
  "github_manual", // 模块 6：需人工处理 GitHub，详情写 detail，不带 resubmit_counts
  "coder_failed", // 模块 8：编码池 gave_up / turn_limit（或 done 但 NoChangesError）超复投上限，detail 写最后一次状态
  "budget_exceeded", // 模块 8：本单预算用完，不复投，主管直接交给用户
  "internal_error", // 模块 8：评审调用、写轮次记录、读预算出错等内部异常，detail 写 `<阶段>_error: …`；主管直接交给用户，不重拆
  "merged_but", // 模块 9（T-038）：已合入集成分支、之后的收尾出错；单子状态保持 merged，detail 写 `merged_but: …`
  "high_risk_rejected", // 模块 9（T-041c）：用户拒绝了高风险 PR（依赖类单）；PR 已关，detail 写用户给的原因；主管不重拆
] as const;
export const EscalatedSchema = ev("escalated", {
  reason: z.enum(ESCALATION_REASONS),
  detail: z.string().optional(),
  resubmit_counts: z
    .object({
      review: z.number().int().nonnegative(),
      conflict: z.number().int().nonnegative(),
    })
    .optional(),
});
export const ChangedInterfaceSchema = z.object({
  file: z.string().min(1),
  symbol: z.string().min(1),
});
/** interface_changed 由合并成功的单触发，ticket_id 必须非 null。 */
export const InterfaceChangedSchema = ev("interface_changed", {
  pr_id: Id,
  base_commit: z.string().regex(/^[0-9a-f]{7,64}$/),
  changed_interfaces: z.array(ChangedInterfaceSchema),
  summary: z.string(),
  affected_ticket_ids: z.array(Id),
}).extend({ ticket_id: Id.describe("合并成功的单号，必填") });
/** 项目级积压指标（T-066 / T-042 Q-3）：requirement_id / ticket_id 可为 null，trace 新开。 */
export const SupervisorBacklogSchema = projectEv("supervisor_backlog", {
  pending: z.number().int().nonnegative(),
  capacity: z.number().int().nonnegative(),
});
export const ReviewBacklogSchema = projectEv("review_backlog", {
  pending: z.number().int().nonnegative(),
  capacity: z.number().int().nonnegative(),
});
export const GROUP_MESSAGE_KINDS = [
  "dispatch",
  "report",
  "review_verdict",
  "resubmit",
  "escalation",
] as const;
export const GroupMessageSchema = ev("group_message", {
  project_id: Id,
  sender: z.enum(["supervisor", "sub_agent"]),
  kind: z.enum(GROUP_MESSAGE_KINDS),
  content: z.string(),
  flash_calls: z.array(Id),
});

/**
 * 单级警告的代码（T-040）：所有需求单级别的警告都用 `ticket_warning`，代码只加不改。
 * - `write_scope_defaulted`：手动 / 测试单没给写入范围（或给了第一段不是字面量的范围，如 `**`），按 `**` 处理。
 * - `fields_invalid`：需求单的结构化字段缺失、损坏或不合格式（含写入范围复查不过），这张单不能续跑。
 * - `requirement_truncated`（T-041b）：需求原文超过上限（20000 码点），存进需求单字段时截断了；重拆只能看到截断后的原文。
 *   每个拆单批次只发一条，挂在这一批的第一张单上，`detail` 列出整批单号。
 * - `pr_close_failed`（T-041b）：重拆前关旧 PR 失败（先同步远端状态，同步或关闭出错）；在确认旧 PR 已关或不存在之前不重拆，
 *   主管会按 30 秒、2 分钟、10 分钟重试，仍失败就交给用户。
 */
export const TICKET_WARNING_CODES = [
  "write_scope_defaulted",
  "fields_invalid",
  "requirement_truncated",
  "pr_close_failed",
  "high_risk_reject_not_applied", // T-041c：拒绝高风险 PR 时已关（或试图关）PR，但 9 那边拒绝没生效（如 PR 中途换了，stale_pr）
] as const;
export type TicketWarningCode = (typeof TICKET_WARNING_CODES)[number];
/** ticket_warning 是单级事件，ticket_id 必须非 null。 */
export const TicketWarningSchema = ev("ticket_warning", {
  project_id: Id,
  code: z.enum(TICKET_WARNING_CODES),
  detail: z.string(),
}).extend({ ticket_id: Id.describe("出警告的单号，必填") });

/**
 * 需求单状态变更（T-085）：组合根在 `tickets.setStatus` 写库成功、且状态真的变了之后发一条；
 * 同状态重复写、写库失败、新建单子都不发。`from` 为 null 表示旧记录没有状态。单级事件，ticket_id 必须非 null。
 */
export const TicketStatusChangedSchema = ev("ticket_status_changed", {
  project_id: Id,
  from: TicketStatusSchema.nullable(),
  to: TicketStatusSchema,
}).extend({ ticket_id: Id.describe("状态变化的单号，必填") });

export const EventSchema = z.discriminatedUnion("type", [
  ProjectCreatedSchema,
  ProjectRemovedSchema,
  CallCompletedSchema,
  WriteScopeRequestedSchema,
  WriteScopeGrantedSchema,
  WriteScopeDeniedSchema,
  EscalatedSchema,
  InterfaceChangedSchema,
  SupervisorBacklogSchema,
  ReviewBacklogSchema,
  GroupMessageSchema,
  TicketWarningSchema,
  TicketStatusChangedSchema,
]);
export type BakaEvent = z.infer<typeof EventSchema>;
export type EventType = BakaEvent["type"];
export type EventCommon = z.infer<typeof EventCommonSchema>;
export type EventMap = { [K in EventType]: Extract<BakaEvent, { type: K }>["payload"] };
export type EventOf<K extends EventType> = Extract<BakaEvent, { type: K }>;
export const EVENT_TYPES = EventSchema.options.map((o) => o.shape.type.value) as EventType[];
