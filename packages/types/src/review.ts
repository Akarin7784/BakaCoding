import { z } from "zod";

/** 模块 7 评审结论。 */
export const REVIEW_VERDICTS = ["pass", "fail"] as const;
export const ReviewVerdictSchema = z.enum(REVIEW_VERDICTS);
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;

/**
 * 评审不过的原因类别：未完成需求、越出范围（对照 permission_list）、明显 bug、违反架构约束、
 * CI 失败（由 7 根据 6 的 checks 直接给出，不经模型）。
 */
export const REVIEW_REASON_CATEGORIES = [
  "incomplete",
  "out_of_scope",
  "bug",
  "arch_violation",
  "ci_failed",
] as const;
export const ReviewReasonCategorySchema = z.enum(REVIEW_REASON_CATEGORIES);
export type ReviewReasonCategory = z.infer<typeof ReviewReasonCategorySchema>;

export const ReviewReasonSchema = z
  .object({
    category: ReviewReasonCategorySchema,
    detail: z.string().min(1),
    file: z.string().min(1).optional(),
    line: z.number().int().positive().optional(),
  })
  .strict();
export type ReviewReason = z.infer<typeof ReviewReasonSchema>;

/** review() 的返回值：判不过时至少一条原因。 */
export const ReviewResultSchema = z
  .object({
    verdict: ReviewVerdictSchema,
    reasons: z.array(ReviewReasonSchema),
  })
  .strict()
  .refine((r) => r.verdict === "pass" || r.reasons.length > 0, {
    message: "verdict 为 fail 时 reasons 至少一条",
    path: ["reasons"],
  });
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

/** 评审模型的 JSON 输出：只能用前四类原因，ci_failed 由模块 7 根据 CI 结果自己给出。 */
export const REVIEW_MODEL_REASON_CATEGORIES = [
  "incomplete",
  "out_of_scope",
  "bug",
  "arch_violation",
] as const satisfies readonly ReviewReasonCategory[];
export const ReviewModelOutputSchema = z
  .object({
    verdict: ReviewVerdictSchema,
    reasons: z.array(
      ReviewReasonSchema.extend({ category: z.enum(REVIEW_MODEL_REASON_CATEGORIES) }).strict(),
    ),
  })
  .strict()
  .refine((r) => r.verdict === "pass" || r.reasons.length > 0, {
    message: "verdict 为 fail 时 reasons 至少一条",
    path: ["reasons"],
  });
export type ReviewModelOutput = z.infer<typeof ReviewModelOutputSchema>;
