import type { PermissionList } from "@bakacoding/types";
import type { SubAgent, SubAgentTicket } from "./types.js";

/**
 * 8 的内部入口（不从 index.ts 导出，T-038）。
 *
 * `recordGrantedScope`：把批准的写入范围以 `rw` 追加到本单权限清单末尾并写回 2 的需求单记录。生产路径上只有 8 自己在
 * 审批通过、已发 `write_scope_granted` 之后调用；这里留给同包测试用（`import { recordGrantedScope } from "./internal.js"`）。
 * 接受任何安全 glob（含 `**`），不安全的不写回。ticket 可以只带 ticket_id（同 resume 的查找规则）。
 */
export type RecordGrantedScope = (
  ticket: SubAgentTicket | { ticket_id: string },
  granted_scope: readonly string[],
) => Promise<PermissionList>;

const recorders = new WeakMap<SubAgent, RecordGrantedScope>();

/** createSubAgent 登记本实例的写回函数。 */
export function registerRecorder(agent: SubAgent, fn: RecordGrantedScope): void {
  recorders.set(agent, fn);
}

/** 测试用：调某个 8 实例内部的 recordGrantedScope。 */
export function recordGrantedScope(
  agent: SubAgent,
  ticket: SubAgentTicket | { ticket_id: string },
  granted_scope: readonly string[],
): Promise<PermissionList> {
  const fn = recorders.get(agent);
  if (!fn) throw new Error("不是 createSubAgent 建的实例");
  return fn(ticket, granted_scope);
}
