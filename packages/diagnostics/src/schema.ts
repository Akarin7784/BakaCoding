import type {
  BakaEvent,
  Diff,
  LedgerTotals,
  PermissionList,
  TicketStatus,
} from "@bakacoding/types";

/** 诊断包 schema 版本。以后只加字段，不破坏旧包（PD §18）。 */
export const DIAG_SCHEMA = "bakacoding-diag/v1" as const;
export type DiagSchema = typeof DIAG_SCHEMA;

/** 导出范围：单张需求单、一个需求（含拆出的所有单）、某个时间段（PD §18、modules.md 11）。 */
export type ExportScope =
  | { kind: "ticket"; ticket_id: string }
  | { kind: "requirement"; requirement_id: string }
  | { kind: "time_range"; from: string; to: string };

/** modules.md 11：export({ project_id, scope, include_full_repo }) → zip_path。 */
export interface ExportOptions {
  project_id: string;
  scope: ExportScope;
  /** 带完整仓库须用户勾选，默认 false：只带 diff 和上下文片段。 */
  include_full_repo?: boolean;
}

/** 每张单的结果标签（PD §18）：通过、复投后通过、超限上报、被用户否决。 */
export const OUTCOME_LABELS = [
  "passed",
  "passed_after_resubmit",
  "escalated",
  "rejected_by_user",
] as const;
export type OutcomeLabel = (typeof OUTCOME_LABELS)[number];

/** 用户在导出界面人工补填的评测任务；2 不额外采集（v1 不跑测试）。 */
export interface EvalTask {
  /** 测试名列表，转 SWE-bench 时作为 FAIL_TO_PASS。 */
  test_names: string[];
  /** 运行命令。 */
  run_command: string;
  /** 可选：应保持通过的测试，转 SWE-bench 时作为 PASS_TO_PASS，缺省为空。 */
  pass_to_pass?: string[];
  /** 可选：测试补丁，转 SWE-bench 时作为 test_patch。 */
  test_patch?: string;
  /** 测试名是否由 GitHub CI check 预填（仅作参考）。 */
  prefilled_from_ci?: boolean;
}

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

export interface MergeResult {
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
  merge?: MergeResult;
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
 * 诊断数据源。由模块 2 实现（queryEvents / query）；在 2 落地前由调用方注入。
 * 只在 include_full_repo 为 true 时才调用 repoFiles。
 */
export interface DiagnosticsSource {
  queryEvents(filter: DiagEventFilter): Promise<BakaEvent[]>;
  queryTickets(filter: DiagEventFilter): Promise<TicketRecord[]>;
  repoFiles?(project_id: string): Promise<RawFile[]>;
}

/** 导出时的运行依赖（不属于 modules.md 的导出参数）。 */
export interface ExportDeps {
  source: DiagnosticsSource;
  /** zip 输出目录。 */
  out_dir: string;
  /** 用户在导出界面补填的 eval_task，按 ticket_id。 */
  eval_tasks?: Record<string, EvalTask>;
  /** 仓库标识（如 owner/repo），写进 manifest.repo，转 SWE-bench 时作 repo 字段；缺省用 project_id。 */
  repo?: string;
  now?: () => Date;
}

/** 规则名 → 命中次数，不含合计和原文。 */
export type RedactionReport = Record<string, number>;

export interface CostSummary extends LedgerTotals {
  ticket_id: string | null;
}

export interface DiagTicket {
  ticket_id: string;
  requirement_id: string;
  created_at: string;
  ticket_text: string;
  decomposition_summary?: string;
  status?: TicketStatus;
  outcome?: OutcomeLabel;
  base_commit: string;
  permission_list: PermissionList;
  rounds: (RoundRecord & { diff_file: string })[];
  resubmit_count: number;
  merge?: MergeResult;
  ci_checks?: CiCheck[];
  context_files: string[];
  cost: CostSummary;
  marked_for_eval_set?: boolean;
  eval_task?: EvalTask;
}

export interface DiagStats {
  tickets: number;
  outcomes: Partial<Record<OutcomeLabel, number>>;
  rounds: number;
  /** 第一轮评审即通过的单数。 */
  first_round_pass: number;
  /** 评审判过、但合入前被用户否决的单数（评审精度的反例，供离线统计）。 */
  review_pass_rejected_by_user: number;
}

export interface DiagManifest {
  schema: DiagSchema;
  project_id: string;
  repo?: string;
  scope: ExportScope;
  include_full_repo: boolean;
  created_at: string;
  redaction: "full";
  files: string[];
  stats: DiagStats;
}

/** 内存中的诊断包（已完整脱敏）。toSweBenchJsonl 的输入。 */
export interface DiagPackage {
  manifest: DiagManifest;
  events: BakaEvent[];
  tickets: DiagTicket[];
  costs: CostSummary[];
  redaction_report: RedactionReport;
  /** 原始文件：diff、上下文片段、可选完整仓库，path 为 zip 内路径。 */
  raw_files: RawFile[];
}
