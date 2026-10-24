// UI-06d2：写 IPC `integration:review` 的主进程逻辑。调 10 公开的 reviewIntegration({project_id})，
// 结果只把 result、head_sha 和 blocked 的原因码交给渲染进程（ticket_ids、check url、detail、file 不出主进程）；抛 MainMergeError 时按 code 给固定文案，其他异常固定「审查集成分支失败」。
import type { IntegrationReview } from "@bakacoding/supervisor";
import type {
  DesktopIntegrationReview,
  DesktopIntegrationReviewResult,
  IntegrationBlockCode,
} from "../shared/api.js";
import { MAIN_MERGE_CODE_TEXT } from "./main-merge.js";

/** 只读 / 未接线时的固定原因。 */
export const INTEGRATION_REVIEW_UNAVAILABLE = "审查集成分支暂不可用（后端只读或未接线）";
/** 不是 MainMergeError 的异常。 */
export const INTEGRATION_REVIEW_FAILED = "审查集成分支失败";

const BLOCK_CODES: ReadonlySet<string> = new Set<IntegrationBlockCode>([
  "nothing_to_merge",
  "tickets_in_flight",
  "ci_failed",
  "ci_pending",
  "model_blocked",
  "review_failed",
]);

/** 从 10 的 IntegrationReview 里只挑渲染端要的字段；新建对象，不带任何其他字段。认不出的形状返回 null。 */
export function toRendererReview(review: IntegrationReview): DesktopIntegrationReview | null {
  if (review?.result === "ok" && typeof review.head_sha === "string")
    return { result: "ok", head_sha: review.head_sha };
  if (review?.result === "blocked") {
    const codes = (Array.isArray(review.reasons) ? review.reasons : [])
      .map((r) => (r as { code?: unknown } | null)?.code)
      .filter((c): c is IntegrationBlockCode => typeof c === "string" && BLOCK_CODES.has(c));
    return { result: "blocked", reasons: [...new Set(codes)] };
  }
  return null;
}

export type ReviewIntegrationFn = (opts: { project_id?: string }) => Promise<IntegrationReview>;

export async function runIntegrationReview(
  fn: ReviewIntegrationFn | undefined,
  input: unknown,
): Promise<DesktopIntegrationReviewResult> {
  if (!fn) return { ok: false, code: "unavailable", reason: INTEGRATION_REVIEW_UNAVAILABLE };
  const pid = (input as { project_id?: unknown } | null)?.project_id;
  try {
    const review = toRendererReview(await fn(typeof pid === "string" ? { project_id: pid } : {}));
    if (!review) return { ok: false, code: "error", reason: INTEGRATION_REVIEW_FAILED };
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
