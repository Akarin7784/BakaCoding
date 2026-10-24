// UI-06d2：写 IPC `integration:review` 的主进程逻辑。调 10 公开的 reviewIntegration({project_id})，
// 结果（IntegrationReview）原样返回；抛 MainMergeError 时按 code 给固定文案，其他异常固定「审查集成分支失败」。
import type { IntegrationReview } from "@bakacoding/supervisor";
import type { DesktopIntegrationReviewResult } from "../shared/api.js";
import { MAIN_MERGE_CODE_TEXT } from "./main-merge.js";

/** 只读 / 未接线时的固定原因。 */
export const INTEGRATION_REVIEW_UNAVAILABLE = "审查集成分支暂不可用（后端只读或未接线）";
/** 不是 MainMergeError 的异常。 */
export const INTEGRATION_REVIEW_FAILED = "审查集成分支失败";

export type ReviewIntegrationFn = (opts: { project_id?: string }) => Promise<IntegrationReview>;

export async function runIntegrationReview(
  fn: ReviewIntegrationFn | undefined,
  input: unknown,
): Promise<DesktopIntegrationReviewResult> {
  if (!fn) return { ok: false, code: "unavailable", reason: INTEGRATION_REVIEW_UNAVAILABLE };
  const pid = (input as { project_id?: unknown } | null)?.project_id;
  try {
    const review = await fn(typeof pid === "string" ? { project_id: pid } : {});
    return { ok: true, review };
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    const named = (e as { name?: unknown } | null)?.name === "MainMergeError";
    if (
      named &&
      typeof code === "string" &&
      Object.prototype.hasOwnProperty.call(MAIN_MERGE_CODE_TEXT, code) &&
      code !== "error"
    )
      return {
        ok: false,
        code: code as keyof typeof MAIN_MERGE_CODE_TEXT,
        reason: MAIN_MERGE_CODE_TEXT[code as keyof typeof MAIN_MERGE_CODE_TEXT],
      };
    return { ok: false, code: "error", reason: INTEGRATION_REVIEW_FAILED };
  }
}
