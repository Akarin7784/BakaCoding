import type { AssignmentStore } from "./types.js";

/** 默认的内存实现：进程重启后丢失。要跨重启保留用 `createRoundAssignmentStore`（读 2 的 PR 轮次 `reviewer`）。 */
export class InMemoryAssignmentStore implements AssignmentStore {
  private readonly m = new Map<string, string>();
  get(ticket_id: string): string | undefined {
    return this.m.get(ticket_id);
  }
  set(ticket_id: string, member_id: string): void {
    this.m.set(ticket_id, member_id);
  }
}
