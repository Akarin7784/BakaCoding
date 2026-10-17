// 界面用的数据形状。事件与状态全部取自 @bakacoding/types（docs/modules.md 为准），
// 这里只保留界面自己的视图类型（需求列表、主管对话、PR 列表行、编码池与 Git 区）。
import type { EventMap, EventOf, TicketStatus } from "@bakacoding/types";

export type ProjectCreatedEvent = EventOf<"project_created">;
export type GroupMessageEvent = EventOf<"group_message">;
export type GroupMessageKind = EventMap["group_message"]["kind"];

/** call_completed 的界面摘要，用来展开 flash_calls。 */
export type FlashCallSummary = Pick<EventOf<"call_completed">, "event_id"> &
  Pick<EventMap["call_completed"], "model" | "effort" | "latency_ms" | "tokens" | "output">;

export interface Requirement {
  requirement_id: string;
  title: string;
}

export interface SupervisorMessage {
  id: string;
  from: "user" | "supervisor";
  content: string;
  ts: string;
}

/** PR 列表的一行。status 是需求单流水线状态（模块 9 维护），不是 PR 自身的 PrStatus。 */
export interface PrItem {
  pr_id: string;
  ticket_id: string;
  requirement_id: string;
  title: string;
  status: TicketStatus;
  resubmit_count: number;
}

export interface PoolStatus {
  concurrency: { active: number; limit: number };
  rate_limited: boolean;
  backpressure: boolean;
}

export interface GitStatus {
  current_branch: string;
  integration_branch: string;
  integration_ahead_of_main: number;
  main_merge: "user" | "auto";
}

/** escalated 事件在界面上的提示：需要人工介入。 */
export interface EscalationView {
  event_id: string;
  ts: string;
  requirement_id: string;
  ticket_id: string | null;
  reason: EventMap["escalated"]["reason"];
  detail?: string;
}

export interface ProjectView {
  project: ProjectCreatedEvent;
  requirements: Requirement[];
  messages: GroupMessageEvent[];
  prs: PrItem[];
  escalations: EscalationView[];
  /** 存储里还没有 Git 区数据（模块 6/9 未接入）时为 null。 */
  git: GitStatus | null;
  /** 存储里还没有编码池状态（模块 5/9 未接入）时为 null。 */
  pool: PoolStatus | null;
}
