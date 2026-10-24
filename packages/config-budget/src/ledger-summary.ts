// 模块 3：账本汇总（T-090）。只按项目汇总全部时间的累计花费；当日花费只从 budget:status（budgetState）取。
import type { LedgerBreakdown, LedgerStore } from "@bakacoding/types";

export interface LedgerSummary {
  /** 项目全部时间的累计花费（含复投），四个角色都列。 */
  project: LedgerBreakdown;
}

/** project_id 为空或不是字符串时抛的 TypeError，`code` 固定为 `invalid_project_id`，消息不带值。 */
export type InvalidProjectIdError = TypeError & { code: "invalid_project_id" };

export async function ledgerSummary(
  ledger: Pick<LedgerStore, "totalsByProject">,
  opts: { project_id: string },
): Promise<LedgerSummary> {
  const project_id = (opts as { project_id?: unknown } | undefined)?.project_id;
  if (typeof project_id !== "string" || project_id === "") {
    throw Object.assign(new TypeError("project_id 须为非空字符串"), {
      code: "invalid_project_id" as const,
    }) satisfies InvalidProjectIdError;
  }
  return { project: await ledger.totalsByProject(project_id) };
}
