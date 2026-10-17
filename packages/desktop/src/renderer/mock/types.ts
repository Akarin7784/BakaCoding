// 界面用的数据形状。事件部分对齐 docs/modules.md「事件清单」(project_created、group_message)
// 和 T-001 群里已定的写法：公共字段在顶层、事件字段放 payload、时间用 ts（Z 结尾 UTC）。
// T-001 合入前不直接依赖其 schema；合入后改为从 @bakacoding/types 引入。
import type { Effort } from "@bakacoding/types";

export interface EventCommon {
  event_id: string;
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  ticket_id?: string;
  /** UTC，Z 结尾 */
  ts: string;
}

export interface ProjectCreatedEvent extends EventCommon {
  type: "project_created";
  payload: { project_id: string; name: string; language: string; has_github_remote: boolean };
}

export type GroupMessageKind = "dispatch" | "report" | "review_verdict" | "resubmit" | "escalation";

export interface GroupMessageEvent extends EventCommon {
  type: "group_message";
  payload: {
    project_id: string;
    requirement_id: string;
    sender: "supervisor" | "sub_agent";
    kind: GroupMessageKind;
    content: string;
    /** 调用事件（call_completed）的 event_id 列表，界面默认折叠 */
    flash_calls: string[];
  };
}

/** call_completed 的界面摘要，用来展开 flash_calls。 */
export interface FlashCallSummary {
  event_id: string;
  model: string;
  effort: Effort;
  latency_ms: number;
  tokens: { input: number; output: number; cache_hit_input: number };
  output: string;
}

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

export type PrStatus =
  "queued" | "running" | "in_review" | "resubmitting" | "conflict" | "merged" | "escalated";

export interface PrItem {
  pr_id: string;
  ticket_id: string;
  requirement_id: string;
  title: string;
  status: PrStatus;
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

export interface ProjectView {
  project: ProjectCreatedEvent;
  requirements: Requirement[];
  messages: GroupMessageEvent[];
  prs: PrItem[];
  git: GitStatus;
  pool: PoolStatus;
}
