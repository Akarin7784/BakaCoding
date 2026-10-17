import type { BakaEvent } from "./events.js";
import type { Diff } from "./diff.js";
import type { PermissionList } from "./permissions.js";
import type { TicketStatus } from "./ticket.js";

// 诊断数据源接口：模块 11 消费、模块 2 实现（与 LedgerStore 同样的注入方式，11 不依赖 2）。

/** 每张单的结果标签（PD §18）：通过、复投后通过、超限上报、被用户否决。 */
export const OUTCOME_LABELS = [
  "passed",
  "passed_after_resubmit",
  "escalated",
  "rejected_by_user",
] as const;
export type OutcomeLabel = (typeof OUTCOME_LABELS)[number];

/** 原始文件（上下文片段或完整仓库中的文件）。 */
export interface RawFile {
  path: string;
  content: string;
}

export interface RoundRecord {
  round: number;
  diff: Diff;
  verdict: "pass" | "fail";
  /** 不通过原因。 */
  fail_reasons: string[];
  /** 复投时带回的评审意见。 */
  review_comments?: string;
}

export interface DiagMergeResult {
  conflicted: boolean;
  base_changed: boolean;
  re_reviewed: boolean;
  merged: boolean;
}

export interface CiCheck {
  name: string;
  conclusion: string;
  tests?: string[];
}

/** 数据源给出的单张需求单记录（来自模块 2 的 PR 记录、合并结果、基线与上下文包）。 */
export interface TicketRecord {
  project_id: string;
  ticket_id: string;
  requirement_id: string;
  created_at: string;
  /** 需求单原文。 */
  ticket_text: string;
  /** 主管拆单时的推理摘要。 */
  decomposition_summary?: string;
  status?: TicketStatus;
  outcome?: OutcomeLabel;
  base_commit: string;
  permission_list: PermissionList;
  rounds: RoundRecord[];
  merge?: DiagMergeResult;
  ci_checks?: CiCheck[];
  /** 复现所需的上下文片段（默认随包导出）。 */
  context_snippets: RawFile[];
  marked_for_eval_set?: boolean;
}

export interface DiagEventFilter {
  project_id: string;
  ticket_id?: string;
  requirement_id?: string;
  from?: string;
  to?: string;
}

/**
 * 诊断数据源（模块 11 消费）。模块 2 的 `Storage.diagnosticsSource()` 提供实现，启动时注入给 11。
 * 只在 include_full_repo 为 true 时才调用 repoFiles。
 */
export interface DiagnosticsSource {
  queryEvents(filter: DiagEventFilter): Promise<BakaEvent[]>;
  queryTickets(filter: DiagEventFilter): Promise<TicketRecord[]>;
  repoFiles?(project_id: string): Promise<RawFile[]>;
}
