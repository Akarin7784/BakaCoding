import { z } from "zod";

export const EFFORTS = ["off", "low", "high", "max"] as const;
export const EffortSchema = z.enum(EFFORTS);
export type Effort = z.infer<typeof EffortSchema>;

/** 角色：与配置 roles.* 对应；reviewer 为评审池成员。 */
export const ROLES = ["supervisor", "reviewer", "sub_agent", "coder"] as const;
export const RoleSchema = z
  .enum(ROLES)
  .describe(
    "调用角色。配置 roles.review_board 指整个评审组；事件与台账中的 reviewer 指评审组中的单个成员",
  );
export type Role = z.infer<typeof RoleSchema>;

/** 金额统一为整数微美元（1 USD = 1_000_000）。 */
export const MicroUsdSchema = z.number().int().nonnegative();
export type MicroUsd = z.infer<typeof MicroUsdSchema>;

export const IsoUtcSchema = z.string().datetime({ offset: false });

export const TraceSchema = z.object({
  trace_id: z.string().min(1),
  span_id: z.string().min(1),
  parent_span_id: z.string().min(1).nullable(),
});
export type Trace = z.infer<typeof TraceSchema>;

export const CallCtxSchema = z.object({
  role: RoleSchema,
  requirement_id: z.string().min(1),
  ticket_id: z.string().min(1).nullable(),
  is_resubmit: z.boolean(),
  trace: TraceSchema,
});
export type CallCtx = z.infer<typeof CallCtxSchema>;
