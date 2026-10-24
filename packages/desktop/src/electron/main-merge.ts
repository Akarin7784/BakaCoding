// UI-06d：写 IPC `main:merge` 的主进程逻辑。head_sha 原样透传给 10 的 mergeMain（它自己校验并用 expected_head），
// MainMergeError.code 逐个映射成固定文案；其他异常一律固定「合入 main 失败」，不透出路径和原始错误。
import type { MainMergeErrorCode, MainMergeResult } from "@bakacoding/supervisor";
import type { DesktopMainMergeResult } from "../shared/api.js";

/** 只读 / 未接线时的固定原因。 */
export const MAIN_MERGE_UNAVAILABLE = "合入 main 暂不可用（后端只读或未接线）";
/** 不是 MainMergeError 的异常。 */
export const MAIN_MERGE_FAILED = "合入 main 失败";
/** 参数不对（没有 head_sha 或不是 40 位十六进制）。 */
export const MAIN_MERGE_INVALID = "合入请求不完整（缺少审查过的集成分支提交）";

/** MainMergeError.code → 界面固定文案（穷举，新增码编译不过；不含路径、sha、原始错误）。 */
export const MAIN_MERGE_CODE_TEXT: Record<MainMergeErrorCode, string> = {
  unavailable: "合入 main 暂不可用（没有接 PR 能力）",
  not_reviewed: "集成分支还没有通过审查，不能合入",
  stale_head: "集成分支在审查后有新提交，请重新审查",
  conflict: "合入 main 有冲突，请手动处理",
  merge_blocked: "合入被仓库规则拦下，请到仓库查看",
  rate_limit: "触发限流，稍后再试",
  target_dirty: "main 工作区有未提交的改动，请先处理",
  error: MAIN_MERGE_FAILED,
};

const isCode = (c: unknown): c is MainMergeErrorCode =>
  typeof c === "string" && Object.prototype.hasOwnProperty.call(MAIN_MERGE_CODE_TEXT, c);

const SHA_RE = /^[0-9a-f]{40}$/;

export type MergeMainFn = (opts: { by: "user"; head_sha: string }) => Promise<MainMergeResult>;

/** fn 为 undefined（只读 / 未接线）→ 固定 ok:false；用户点按钮 = by:"user"。 */
export async function runMainMerge(
  fn: MergeMainFn | undefined,
  input: unknown,
): Promise<DesktopMainMergeResult> {
  if (!fn) return { ok: false, code: "unavailable", reason: MAIN_MERGE_UNAVAILABLE };
  const head_sha = (input as { head_sha?: unknown } | null)?.head_sha;
  if (typeof head_sha !== "string" || !SHA_RE.test(head_sha))
    return { ok: false, code: "invalid", reason: MAIN_MERGE_INVALID };
  try {
    const r = await fn({ by: "user", head_sha });
    return r.result === "merged"
      ? { ok: true, result: "merged", sha: r.sha }
      : { ok: true, result: "notified" };
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    const named = (e as { name?: unknown } | null)?.name === "MainMergeError";
    if (named && isCode(code)) return { ok: false, code, reason: MAIN_MERGE_CODE_TEXT[code] };
    return { ok: false, code: "error", reason: MAIN_MERGE_FAILED };
  }
}
