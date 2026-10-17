import type {
  BakaEvent,
  CiCheck,
  DiagMergeResult,
  DiagnosticsSource,
  LedgerTotals,
  OutcomeLabel,
  PermissionList,
  RawFile,
  RoundRecord,
  TicketStatus,
} from "@bakacoding/types";

// 数据源相关类型已挪进 @bakacoding/types（T-005），这里转出，保持原有导入路径可用。
export {
  OUTCOME_LABELS,
  type CiCheck,
  type DiagEventFilter,
  type DiagMergeResult as MergeResult,
  type DiagnosticsSource,
  type OutcomeLabel,
  type RawFile,
  type RoundRecord,
  type TicketRecord,
} from "@bakacoding/types";

/**
 * 诊断包 schema 版本。以后只加字段，不破坏旧包（PD §18）。
 * v1.1（T-021）：新增 manifest.excluded_context_env_files；.env 排除规则扩到大小写不敏感和 .envrc。
 */
export const DIAG_SCHEMA = "bakacoding-diag/v1.1" as const;
export type DiagSchema = typeof DIAG_SCHEMA;

/** readPackage 能读的版本：v1.1 只加字段，v1 旧包照常读，缺的字段保持缺省。 */
export const READABLE_DIAG_SCHEMAS = ["bakacoding-diag/v1", DIAG_SCHEMA] as const;
export type ReadableDiagSchema = (typeof READABLE_DIAG_SCHEMAS)[number];

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
  merge?: DiagMergeResult;
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
  /** 新导出的包总是 DIAG_SCHEMA；读回的旧包可能是 v1。 */
  schema: ReadableDiagSchema;
  project_id: string;
  repo?: string;
  scope: ExportScope;
  include_full_repo: boolean;
  created_at: string;
  redaction: "full";
  /** 勾选完整仓库时按默认规则排除的 .env 类文件个数（只记个数，不记路径）。 */
  excluded_env_files: number;
  /** v1.1 新增：上下文片段里按同一规则排除的 .env 类文件个数（只记个数，不记路径）；v1 旧包没有此字段。 */
  excluded_context_env_files?: number;
  /** zip 内全部条目名，与实际条目逐字一致。 */
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
