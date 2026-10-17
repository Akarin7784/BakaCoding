import { z } from "zod";

export const PR_STATUSES = ["open", "merged", "conflict", "closed"] as const;

export const PrStatusSchema = z
  .enum(PR_STATUSES)
  .describe(
    "模块 6 PR 生命周期状态（仅此）；调度状态 queued / in_review / resubmitting / escalated 归模块 8/9，不在此枚举",
  );
export type PrStatus = z.infer<typeof PrStatusSchema>;
