// UI-06c：右面板 Git 区的只读查询。4 的 branchStatus（T-155）+ 6 的 INTEGRATION_BRANCH + 配置 main_merge。
import type { BranchStatus, BranchStatusCode } from "@bakacoding/app";
import { INTEGRATION_BRANCH } from "@bakacoding/pr";
import type { DesktopGitStatusResult } from "../shared/api.js";

/** 只读 / 未接线时的固定原因。 */
export const GIT_STATUS_UNAVAILABLE = "Git 状态暂不可用（后端只读或未接线）";
/** 不是 BranchStatusError 的异常：固定文案，不透出原文。 */
export const GIT_STATUS_FAILED = "读取 Git 状态失败";

/** BranchStatusError.code → 界面固定文案（穷举，新增码编译不过；不含路径、分支名）。 */
export const GIT_STATUS_CODE_TEXT: Record<BranchStatusCode, string> = {
  not_git: "当前文件夹不是 Git 仓库",
  nested_repo: "当前文件夹在另一个 Git 仓库里面",
  invalid_branch: "分支名不合法",
  no_base: "找不到 main 分支",
  no_integration: "还没有集成分支",
  timeout: "读取 Git 状态超时",
  git_failed: "读取 Git 状态失败",
};

const isCode = (c: unknown): c is BranchStatusCode =>
  typeof c === "string" && Object.prototype.hasOwnProperty.call(GIT_STATUS_CODE_TEXT, c);

export interface GitStatusSource {
  repoRoot: string;
  mainMerge: "user" | "supervisor";
  branchStatus: (dir: string, options: { integration_branch: string }) => Promise<BranchStatus>;
}

/** src 为 undefined（只读 / 未接线）→ 固定 ok:false；错误只按 code 映射成固定文案。 */
export async function readGitStatus(
  src: GitStatusSource | undefined,
): Promise<DesktopGitStatusResult> {
  if (!src) return { ok: false, reason: GIT_STATUS_UNAVAILABLE };
  try {
    const st = await src.branchStatus(src.repoRoot, { integration_branch: INTEGRATION_BRANCH });
    return {
      ok: true,
      current_branch: typeof st.current_branch === "string" ? st.current_branch : null,
      integration_branch: INTEGRATION_BRANCH,
      ahead: st.ahead,
      main_merge: src.mainMerge,
    };
  } catch (e) {
    const code = (e as { name?: unknown; code?: unknown } | null)?.code;
    const named = (e as { name?: unknown } | null)?.name === "BranchStatusError";
    return {
      ok: false,
      reason: named && isCode(code) ? GIT_STATUS_CODE_TEXT[code] : GIT_STATUS_FAILED,
    };
  }
}
