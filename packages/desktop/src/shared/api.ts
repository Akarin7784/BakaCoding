// 主进程 ↔ preload ↔ 渲染进程的数据契约。只放类型和通道名，不引入 Node 或存储模块，
// 渲染进程可以安全地 import type。
import type {
  BackpressureReason,
  BackpressureState,
  HighRiskDecisionErrorCode,
  SyncState,
} from "@bakacoding/scheduler";
import type { HighRiskFile, HighRiskReason } from "@bakacoding/sub-agent";
import type {
  ChatReply,
  HighRiskDecisionResult,
  PendingHighRisk,
  UserMessage,
} from "@bakacoding/supervisor";
import type { Project } from "@bakacoding/config-budget";
import type { BakaEvent, Role, TicketStatus } from "@bakacoding/types";
import type { SupervisorMessage as StoredSupervisorMessage } from "@bakacoding/storage";

/** 主管对话里存下来的一条消息（UI-04a，原样取自 2 / 10 的 SupervisorMessage）。 */
export type DesktopSupervisorMessage = StoredSupervisorMessage;

/** IPC 通道名。 */
export const IPC_CHANNELS = {
  /** invoke：取一次完整快照。 */
  snapshot: "bakacoding:snapshot",
  /** 主进程 → 渲染进程：增量更新。 */
  update: "bakacoding:update",
  /** invoke：后端状态（live / readonly）。 */
  backendStatus: "bakacoding:backend:status",
  /** invoke：渲染进程就绪，主进程回放缓冲的 supervisor 通知。 */
  supervisorReady: "bakacoding:supervisor:ready",
  /** 主进程 → 渲染进程：主管 1:1 通知。 */
  supervisorNotify: "bakacoding:supervisor:notify",
  /** invoke：等裁决的高风险 PR 清单（同步内存快照，T-062）。 */
  highRiskPending: "bakacoding:high-risk:pending",
  /** invoke：放行 / 拒绝高风险 PR（T-062）。 */
  highRiskDecide: "bakacoding:high-risk:decide",
  /** 主进程 → 渲染进程：高风险待裁决清单刷新（T-062）。 */
  highRiskPendingUpdate: "bakacoding:high-risk:pending-update",
  /** invoke：9 的定时同步状态（syncState() 快照，T-067）。 */
  syncState: "bakacoding:sync:state",
  /** 主进程 → 渲染进程：同步状态有变化时推送（T-067）。 */
  syncStateUpdate: "bakacoding:sync:state-update",
  /** invoke：主管 1:1 对话，转给 10 的 chat()（T-071）。 */
  supervisorChat: "bakacoding:supervisor:chat",
  /**
   * invoke：主管 1:1 对话历史（UI-04a），转给 10 的 history()；参数 `{before?, limit?}`（limit 默认 50）。
   * 整条对话一条流，不按项目筛选；只读后端回空列表；失败原因已脱敏、不带路径。
   */
  supervisorHistory: "bakacoding:supervisor:history",
  /**
   * invoke：重试拆单（UI-04c），转给 10 的 split()；参数 `{project_id, text, requirement_id?}`。
   * 不经 chat；只读后端回固定失败；失败原因已脱敏，结果只有需求 id 和单号，不带路径。
   */
  supervisorSplit: "bakacoding:supervisor:split",
  /** invoke：需求详情（UI-05a，只读）：模块 2 的 listTickets({requirement_id}) + listPrRounds，字段按白名单挑、文本已脱敏。 */
  requirementDetail: "bakacoding:requirement:detail",
  /** invoke：Git 区状态（UI-06c，只读，无参数）：4 的 branchStatus + 6 的 INTEGRATION_BRANCH + 配置 main_merge。 */
  gitStatus: "bakacoding:git:status",
  /**
   * invoke：编码池状态（UI-06b，只读）：原样取 9 的 backpressureState()，无参数。
   * 后端只读 / 未接线固定 ok:false；抛错 ok:false + 固定文案，不带路径。
   */
  poolState: "bakacoding:pool:state",
  /** invoke：选目录导入项目，切换后端到该仓库（T-072）。 */
  projectImport: "bakacoding:project:import",
  /** invoke：对上次导入失败（只缺配置）的目录用默认模板补配置，再完成导入；无参数（T-081）。 */
  projectCreateDefaultConfig: "bakacoding:project:create-default-config",
  /** invoke：选保存路径，导出诊断包（T-072；T-130 起可带可选粒度参数）。 */
  diagnosticsExport: "bakacoding:diagnostics:export",
  /** invoke：设置 › 项目（UI-07d）：已导入项目列表（名称、仓库路径；已移除的不返回）；无参数。 */
  projectList: "bakacoding:project:list",
  /** invoke：设置 › 项目（UI-07d）：移除一条项目记录（参数 project_id；不删文件、不删历史事件），成功后发 project_removed。 */
  projectRemove: "bakacoding:project:remove",
  /** invoke：设置 › 项目（UI-07d）：打开项目所在文件夹（参数 project_id，路径由主进程按记录取，界面传不了路径）。 */
  projectOpenFolder: "bakacoding:project:open-folder",
  /** invoke：打开数据目录（userData，状态 / 标记文件所在；T-130，无参数）。 */
  diagnosticsOpenDataDir: "bakacoding:diagnostics:open-data-dir",
  /** invoke：只读设置（仓库、环境变量是否已设、本地 / GitHub 模式）（T-072）。 */
  settingsGet: "bakacoding:settings:get",
  /** invoke：设置 › 关于（UI-07a）：版本号、commit、运行时版本，不带路径；无参数。 */
  appAbout: "bakacoding:app:about",
  /**
   * invoke：设置 › 模型（UI-07b）：当前各角色模型和单价，供编辑；密钥只回是否已设，另带配置来源
   * （--config / BAKACODING_CONFIG 时整页只读）；无参数。
   */
  settingsConfigGet: "bakacoding:settings:config-get",
  /**
   * invoke：设置 › 模型保存（UI-07b）：先校验，再写 config/models.json、再写 config/pricing.json，最后重载；
   * 有在途单时文件照写、重载排队。部分失败回 written 说明写了哪个文件；报错已脱敏、不带绝对路径。
   */
  settingsSave: "bakacoding:settings:save",
  /**
   * invoke：设置 › 预算（UI-07c）：每日预算设置（读 config/models.json）和今天已花费
   * （原样取自 3 的 budgetState()，不另算；只读后端时为 null）；无参数。报错已脱敏、不带路径。
   */
  budgetStatus: "bakacoding:budget:status",
  /**
   * invoke：设置 › 预算（UI-07e）：每个已导入项目全部时间的累计花费（3 的 ledgerSummary，来自台账）；
   * 已移除的项目不返回，不带路径、不带当日花费（当日只看 budget:status）；无参数。
   */
  ledgerSummary: "bakacoding:ledger:summary",
  /** invoke：界面主题偏好同步给主进程，设置 nativeTheme.themeSource 和标题栏按钮颜色（UI-02）。 */
  windowTheme: "bakacoding:window:theme",
  /** invoke：同一仓库停掉再起来；有在途单则排队，空闲后自动执行（T-093）。 */
  backendReload: "bakacoding:backend:reload",
  /** invoke：只读横幅的「重新连接」；与 backend:reload 同一条路径（T-093）。 */
  backendReconnect: "bakacoding:backend:reconnect",
  /** invoke：项目准备页逐项检查当前仓库（UI-03a，4 的 checkRepo，只读）。 */
  repoCheck: "bakacoding:repo:check",
  /** invoke：初始化 Git（UI-03a，4 的 initRepo）；成功后自动 backend:reconnect。 */
  repoInit: "bakacoding:repo:init",
  /** invoke：首次提交确认框要列的文件（UI-03a，4 的 listInitialCommitFiles，只读）。 */
  repoListInitialFiles: "bakacoding:repo:list-initial-files",
  /** invoke：首次提交（UI-03a，4 的 initialCommit）；成功后自动 backend:reconnect。 */
  repoInitialCommit: "bakacoding:repo:initial-commit",
  /** invoke：从当前分支新建 main（UI-03a，4 的 createMainBranch）；成功后自动 backend:reconnect。 */
  repoCreateMain: "bakacoding:repo:create-main",
  /** invoke（T-113）：生成配置——缺的或不合法的 config/models.json、config/pricing.json 用安装包模板生成；成功后自动 backend:reconnect。 */
  repoInitConfig: "bakacoding:repo:init-config",
  /** invoke（UI-03b，UI-07 复用）：密钥状态 / 保存 / 清除，接 3 的 secretStatus / setUserSecret / clearUserSecret。 */
  secretStatus: "bakacoding:secret:status",
  secretSet: "bakacoding:secret:set",
  secretClear: "bakacoding:secret:clear",
  /** invoke（UI-03b，UI-07 复用）：测试连接，接 1 的 testConnection。 */
  providerTest: "bakacoding:provider:test",
  /** 主进程 → 渲染进程：开始退出收尾，界面显示「正在退出…」；不带内容，每次退出只发一次（T-106）。 */
  appQuitting: "bakacoding:app:quitting",
} as const;

/** 界面主题偏好（与渲染进程 lib/theme.ts 的 THEME_PREFERENCES 一致，测试锁住）。 */
export const WINDOW_THEME_SOURCES = ["system", "light", "dark"] as const;
export type WindowThemeSource = (typeof WINDOW_THEME_SOURCES)[number];

/** window:theme 的结果：dark 为主进程应用后 nativeTheme.shouldUseDarkColors。 */
export type DesktopWindowThemeResult = { ok: true; dark: boolean } | { ok: false; reason: string };

/** 设置 › 项目（UI-07d）的一行：repo_path 来自模块 2（T-142 / T-145），老记录为 null。只给界面显示，不进事件、日志和诊断包。 */
export interface DesktopProjectRow {
  project_id: string;
  name: string;
  repo_path: string | null;
}
/** project:list 的结果；后端只读（没有存储）时 ok:false，reason 为固定文案。 */
export type DesktopProjectListResult =
  { ok: true; projects: DesktopProjectRow[] } | { ok: false; reason: string };
/** project:remove 的结果：removed:false = 记录本来就不在；失败 reason 为固定文案，不带路径。 */
export type DesktopProjectRemoveResult =
  { ok: true; removed: boolean } | { ok: false; reason: string };
/** 设置 › 预算「本项目已花费（来自台账）」的一行（UI-07e）：只有 id、名称和累计数，不带路径。 */
export interface DesktopProjectSpendRow {
  project_id: string;
  name: string;
  total_micro_usd: number;
  resubmit_micro_usd: number;
  entries: number;
  by_role: Record<Role, number>;
}
/** ledger:summary 的结果；后端只读或抛错时 ok:false，reason 为固定文案。 */
export type DesktopLedgerSummaryResult =
  { ok: true; projects: DesktopProjectSpendRow[] } | { ok: false; reason: string };
/** project:open-folder 的结果；失败 reason 为固定文案，不带路径。 */
export type DesktopProjectOpenFolderResult = { ok: true } | { ok: false; reason: string };

/** 界面关心的事件类型；其余事件主进程不下发。 */
export const UI_EVENT_TYPES = [
  "project_created",
  "group_message",
  "call_completed",
  "escalated",
  "ticket_warning",
  // UI-05a：步骤条小标记 / 时间线用（modules.md 事件表 `ticket_status_changed`，T-085）
  "ticket_status_changed",
] as const satisfies readonly BakaEvent["type"][];
export type UiEventType = (typeof UI_EVENT_TYPES)[number];
export type UiEvent = Extract<BakaEvent, { type: UiEventType }>;

/** 需求单在界面上的摘要（来自模块 2 的 tickets / pr_rounds 表）。 */
export interface TicketView {
  ticket_id: string;
  project_id: string;
  requirement_id: string;
  created_at: string;
  /** 需求单原文第一行，最多 80 字。 */
  title: string;
  /** 库里没有状态或状态不认识时按 pending 显示。 */
  status: TicketStatus;
  /** 已保存的 PR 轮次数 - 1，最小 0。 */
  resubmit_count: number;
}

export type DbStatus =
  | { path: string; state: "ok" }
  | { path: string; state: "missing" }
  | { path: string; state: "error"; message: string };

export interface DesktopSnapshot {
  db: DbStatus;
  /** 按 seq 升序；call_completed 的 prompt 不下发（置空串）。 */
  events: UiEvent[];
  tickets: TicketView[];
  /** 已下发的最大 seq，空库为 -1。 */
  last_seq: number;
}

export interface DesktopUpdate {
  db: DbStatus;
  /** seq 大于上次 last_seq 的新事件。 */
  events: UiEvent[];
  /** 需求单有变化时给出完整列表；没变化时省略。 */
  tickets?: TicketView[];
  last_seq: number;
}

/** 与主进程 BackendStatus 同形（不引入 storage 类型，health 用宽松对象）。 */
/** 只读详情（UI-08，§4.7）：脱敏后的错误名、信息、错误码、一层 cause。 */
export interface DesktopBackendError {
  name: string;
  message: string;
  code?: string;
  cause?: { name: string; message: string };
}

/**
 * 仓库从哪来（UI-03a 评审 B1），按 repoRoot 解析顺序：`--repo` 参数 > BAKACODING_REPO > 上次导入 > 当前工作目录。
 * `cwd` 时界面不提供初始化 / 首次提交 / 新建 main（Windows 双击启动时当前目录是解压目录）。
 */
export type DesktopRepoSource = "arg" | "env" | "last_import" | "cwd";

export interface DesktopBackendStatus {
  mode: "live" | "readonly";
  /** 仓库来源（UI-03a）；组装失败的占位后端不知道时不出现，按 cwd 处理 */
  repoSource?: DesktopRepoSource;
  reason?: string;
  /** 后端起不来时的错误详情（UI-08）；锁被占等没有错误对象的情况不出现。 */
  error?: DesktopBackendError;
  takeOver?: {
    enqueued: number;
    adopted: number;
    escalated: number;
    failed: number;
    held: number;
    skipped_invalid: number;
  };
  storage?: {
    ok: boolean;
    lease_lost: boolean;
    closed: boolean;
    ingest_failures: number;
  };
  /** 重载进度（T-093）：queued = 等 waitingTickets 张在途单跑完；running = 正在停起。没有就不出现。 */
  reload?: { state: "queued"; waitingTickets: number; waitingChat: boolean } | { state: "running" };
}

/**
 * `backend:reload` / `backend:reconnect` 结果（T-093）。reloaded：已重新起来且是 live；
 * queued：已排队，等 waitingTickets 张在途单（编码 / 评审 / 合并队列）跑完后自动重载；
 * failed：没起来（现在是只读）或正在切换项目，reason 已脱敏截断。
 */
export type DesktopReloadResult =
  | { state: "reloaded" }
  | { state: "queued"; waitingTickets: number; waitingChat: boolean }
  | { state: "failed"; reason: string };

/** 4 的 checkRepo() 检查项（UI-03a）：detail 是中文、不含路径；current 只在 no_main 时给。 */
export interface DesktopRepoCheckItem {
  id: "git" | "commit" | "main" | "ignored";
  ok: boolean;
  /** nested_repo（T-114）：文件夹在另一个 Git 仓库里面，detail 是固定文案、不带外层路径 */
  code?: "not_git" | "nested_repo" | "no_commits" | "no_main" | "not_ignored";
  detail?: string;
  current?: string;
}

/** 4 的 checkRepo() 结果：items 固定 git / commit / main / ignored 顺序；identity 只回是否已配。 */
export interface DesktopRepoCheck {
  items: DesktopRepoCheckItem[];
  current_branch: string | null;
  identity: { name: boolean; email: boolean };
}

/** 单个配置文件的状态（T-113）：ok / 不存在 / 内容不合法（读不到、不是 JSON、校验不过都算 invalid）。 */
export type DesktopConfigFileState = "ok" | "missing" | "invalid";

/**
 * 准备页「生成配置」项（T-113）。models_external：models.json 用的是 `--config` / BAKACODING_CONFIG 指定的文件，
 * 准备页不生成它；errors 是脱敏后的字段错误（不含配置值和路径），最多 MAX_CONFIG_ERRORS 条。
 */
export interface DesktopConfigCheck {
  models: DesktopConfigFileState;
  pricing: DesktopConfigFileState;
  models_external: boolean;
  errors: string[];
}

/** Git 身份：只写进本仓库 .git/config。 */
/** UI-03b（接 T-108）：可以只给 name 或只给 email，至少一项；只写本仓库 .git/config。 */
export interface DesktopGitIdentity {
  name?: string;
  email?: string;
}

/**
 * 仓库修复失败（UI-03a）：code 取 4 的 RepoFixError 码，reason 是它的固定中文文案（不含路径和 git 原始输出）。
 * 主进程拿到非 RepoFixError 的异常一律记成 git_failed。
 */
export interface DesktopRepoFixFailure {
  ok: false;
  code:
    | "not_git"
    /** T-114：文件夹在另一个 Git 仓库里面（固定文案，不带外层路径） */
    | "nested_repo"
    | "repo_exists"
    | "no_commits"
    | "has_commits"
    | "main_exists"
    | "no_identity"
    | "invalid_identity"
    | "invalid_files"
    | "timeout"
    | "git_failed"
    /** UI-03a 评审 B1：仓库来源是当前工作目录（或不明）时主进程拒绝写操作 */
    | "cwd_repo";
  reason: string;
}

/** repo:init-config 的参数（T-113）：要写 models.json 时 daily_micro_usd 必填；要覆盖不合法的文件时 confirm_overwrite 必须为 true。 */
export interface DesktopInitConfigRequest {
  daily_micro_usd?: number;
  confirm_overwrite?: boolean;
}

/** repo:init-config 失败码（T-113）：reason 是 shared/config-text.ts 的固定文案；errors 只在 verify_failed / write_failed 时给（已脱敏）。 */
export interface DesktopConfigFixFailure {
  ok: false;
  code:
    | "cwd_repo"
    | "not_git"
    | "nested_repo"
    | "external_config"
    | "invalid_budget"
    | "confirm_required"
    | "unsafe_path"
    | "template_missing"
    | "unavailable"
    | "write_failed"
    | "verify_failed"
    | "failed";
  reason: string;
  errors?: string[];
}

/**
 * repo:init-config 成功（T-113）：written 是这次写了的文件；backups 是备份文件名（只给文件名，不带路径）；
 * excluded：生成的文件和备份已写进 .git/info/exclude（不提交进仓库）。
 */
export type DesktopConfigFixResult =
  | {
      ok: true;
      written: ("models" | "pricing")[];
      backups: string[];
      excluded: boolean;
      reload: DesktopReloadResult;
    }
  | DesktopConfigFixFailure;

/** `folder`：仓库根的最后一级文件夹名（basename，不带上级路径），给准备页标题和确认框显示。 */
export type DesktopRepoCheckResult =
  | { ok: true; check: DesktopRepoCheck; folder: string; config?: DesktopConfigCheck }
  | DesktopRepoFixFailure;

/** 首次提交会带上的文件（相对仓库根、posix 分隔符）与默认排除的文件。 */
export type DesktopRepoFilesResult =
  | {
      ok: true;
      include: string[];
      excluded: { path: string; reason: "protected" | "bakacoding" }[];
    }
  | DesktopRepoFixFailure;

/** 写操作结果：成功后主进程已调 backend:reconnect，reload 是它的结果。 */
export type DesktopRepoFixResult =
  { ok: true; reload: DesktopReloadResult; commit?: string; from?: string } | DesktopRepoFixFailure;

/** repo:initial-commit 的参数：files 只认 repo:list-initial-files 列出的相对路径。 */
export type DesktopInitialCommitRequest = ({ files: string[] } | { empty: true }) & {
  identity?: DesktopGitIdentity;
};

export interface SupervisorNotifyMessage {
  text: string;
  project_id?: string;
  requirement_id?: string;
}

/** 等用户裁决的高风险单（与 10 的 PendingHighRisk 同形；files 用 8 的 HighRiskFile）。 */
export type DesktopPendingHighRisk = PendingHighRisk;

export type DesktopHighRiskDecision = "release" | "reject";

/** decideHighRisk 的 IPC 结果：成功带 10 的结果；失败带 9/10 的错误码（不抛过 IPC）。 */
export type DesktopDecideHighRiskResult =
  | { ok: true; result: HighRiskDecisionResult }
  | { ok: false; code: HighRiskDecisionErrorCode; message: string };

/**
 * 9 的 `syncState()` 经 IPC 下发的形状（T-067）。live 时与 9 的 SyncState 同字段，
 * 只是 `last_error.message` 已在主进程脱敏、截到 SYNC_ERROR_MESSAGE_MAX 字；
 * 只读 / 未接线时 `available: false`，`reason` 只写变量名 / 错误名。
 */
export type DesktopSyncState =
  ({ available: true } & SyncState) | { available: false; reason: string };

/** 10 的 ChatReply.kind 联合（T-071）。 */
export type ChatReplyKind = ChatReply["kind"];

/**
 * `supervisor:chat` 的 IPC 结果（T-071）：成功带 10 原样的 ChatReply；
 * 只读 / 未接线 / chat() 抛错都是 ok:false，reason 已在主进程脱敏、截到 CHAT_REASON_MAX 字。
 */
export type DesktopChatResult = { ok: true; reply: ChatReply } | { ok: false; reason: string };
/** `supervisor:split` 的参数（UI-04c）：text 取自这条回复所回答的用户消息；requirement_id 原样传回。 */
export interface DesktopSplitRequest {
  project_id: string;
  text: string;
  requirement_id?: string;
}
/** `supervisor:split` 的结果（UI-04c）：只带需求 id 和单号（不带推理摘要，避免路径）；reason 已脱敏。 */
export type DesktopSplitResult =
  { ok: true; requirement_id: string; ticket_ids: string[] } | { ok: false; reason: string };
/** `requirement:detail` 的参数（UI-05a）。 */
export interface DesktopRequirementDetailQuery {
  requirement_id: string;
}
/** 需求详情里的一轮评审（UI-05a）：只挑 round / verdict / fail_reasons / review_comments / reviewer，文本已脱敏。 */
export interface DesktopRequirementRound {
  round: number;
  verdict: "pass" | "fail";
  fail_reasons: string[];
  review_comments: string | null;
  reviewer: string | null;
}
/** 需求详情里的一张单（UI-05a）：只有 id、状态和各轮评审。 */
export interface DesktopRequirementTicket {
  ticket_id: string;
  status: TicketStatus;
  rounds: DesktopRequirementRound[];
}
/**
 * `requirement:detail` 的结果（UI-05a）：只含需求本身的数据，不下发整个 fields，不含评审上限（走 settings:config-get）。
 * name 取第一张单原文首行、截到 80 字；所有文本过 sanitizeChatReason；reason 是固定文案。
 */
export type DesktopRequirementDetailResult =
  | {
      ok: true;
      detail: {
        requirement_id: string;
        name: string;
        requirement_text: string | null;
        decomposition_summary: string | null;
        tickets: DesktopRequirementTicket[];
      };
    }
  | { ok: false; reason: string };
/** `supervisor:history` 的参数（UI-04a）：before 为 message_id 游标，limit 默认 50。 */
export interface DesktopHistoryQuery {
  before?: string;
  limit?: number;
}
/** `supervisor:history` 的结果（UI-04a）：按时间正序；只读为 ok:true 空列表；reason 已脱敏截断。 */
export type DesktopHistoryResult =
  { ok: true; messages: DesktopSupervisorMessage[] } | { ok: false; reason: string };
/** `project:import` 结果（T-072）：project 原样取自 3 的 importProject；note 为补充说明（如在用 BAKACODING_CONFIG）。 */
export type DesktopImportResult =
  | { ok: true; project: Project; note?: string }
  | {
      ok: false;
      canceled?: true;
      missing?: string[];
      reason?: string;
      /** T-081：只缺配置文件，可以点「用默认模板创建」 */
      canCreateDefaultConfig?: true;
    }
  /**
   * UI-03b：文件夹还没准备好（不是 Git 仓库 / 没有提交 / 没有 main）：已切到它（只读，来源 last_import），
   * 界面直接进项目准备页；reason 是只读原因（已脱敏）。
   */
  | { ok: false; needsPrep: true; reason: string; note?: string };

/** `diagnostics:export` 结果（T-072）；reason 已脱敏截断。 */
export type DesktopExportResult =
  { ok: true; path: string } | { ok: false; canceled?: true; reason: string };

/**
 * `diagnostics:export` 的可选粒度（T-130，与 11 的 `ExportScope` 同形）。
 * 省略 = 最近 24 小时（T-072 的一键导出行为逐字不变）。
 */
export type DesktopExportScope =
  | { kind: "time_range"; from: string; to: string }
  | { kind: "ticket"; ticket_id: string }
  | { kind: "requirement"; requirement_id: string };

export interface DesktopExportOptions {
  scope?: DesktopExportScope;
}

/** `diagnostics:open-data-dir` 结果（T-130）；reason 是固定文案，不带路径。 */
export type DesktopOpenDataDirResult = { ok: true } | { ok: false; reason: string };

/** `settings:get` 结果（T-072）：环境变量只给名字和是否已设，绝不给值。 */
export interface DesktopSettings {
  repo: string | null;
  env: { name: string; set: boolean }[];
  /** readonly：后端只读（没有 PR 实现，不显示成 local） */
  mode: "local" | "github" | "readonly";
}

/**
 * `app:about` 结果（UI-07a）：只有版本号、commit（7–40 位小写十六进制）和运行时版本，
 * 主进程按白名单格式过滤，拿不到或格式不对就是 null，绝不带路径。
 */
export interface DesktopAbout {
  version: string | null;
  commit: string | null;
  runtime: { electron: string | null; chrome: string | null; node: string | null };
}

/** 模型配置来源（UI-07b）：repo = 仓库里的 config/models.json；另两种是启动参数指定的外部文件，界面只读 */
export type DesktopConfigSource = "repo" | "--config" | "BAKACODING_CONFIG";
/** 思考档位（与 1 / 3 的 EFFORTS 一致） */
export const DESKTOP_EFFORTS = ["off", "low", "high", "max"] as const;
export type DesktopEffort = (typeof DESKTOP_EFFORTS)[number];

/** 模型页表单（UI-07b）：只含这页能改的字段；主管档位固定 max，不在表单里 */
export interface DesktopModelForm {
  supervisor: { provider: string; model: string };
  coder: { provider: string; model: string; effort: DesktopEffort };
  reviewers: { id: string; provider: string; model: string; effort: DesktopEffort }[];
}
/** 每 1M token 的微美元单价（pricing.json 的 peak / offpeak） */
export interface DesktopPriceRate {
  input_cache_hit: number;
  input_cache_miss: number;
  output: number;
}
export type DesktopModelPricing = Record<
  string,
  { peak: DesktopPriceRate; offpeak: DesktopPriceRate }
>;

/** `settings:config-get` 结果（UI-07b）。密钥只有名字和是否已设，绝不带值；不带路径和 base_url */
export type DesktopModelConfigResult =
  | {
      ok: true;
      source: DesktopConfigSource;
      /** source 不是 repo 时为 true：整页只读 */
      readonly: boolean;
      /** 可选的服务商和它下面的模型名；credential 是 credential_ref 指向的环境变量名和是否已设 */
      providers: {
        id: string;
        models: string[];
        credential: { name: string; set: boolean } | null;
      }[];
      form: DesktopModelForm;
      pricing: DesktopModelPricing;
      /** 在途单数（含主管对话）：>0 时保存后重载会排队 */
      running: number;
      /**
       * UI-05c：需求页「第 N 轮 / 上限」用的复投上限，取 3 的 ConfigSchema 解析后的值（含默认值 3）。
       * 可选：旧主进程 / 测试桩没有这个字段时界面按默认值处理。
       */
      pipeline?: { resubmit_limits: { review: number } };
    }
  | {
      ok: false;
      code: "cwd_repo" | "read_failed" | "invalid_config" | "failed";
      reason: string;
    };

export type DesktopModelSaveFile = "models" | "pricing";
/** `settings:save` 参数（UI-07b） */
export interface DesktopModelSaveInput {
  form: DesktopModelForm;
  pricing: DesktopModelPricing;
}
/** 设置 › 预算可改的字段（UI-07c），和 config 的 budget 段同名同单位 */
export interface DesktopBudgetForm {
  /** 每日预算，整数微美元（1 美元 = 1_000_000），必填、> 0 */
  daily_micro_usd: number;
  /** 每单上限占每日预算的比例，(0, 1] */
  per_ticket_ratio: number;
  /** 闲时优先 */
  offpeak_preference: boolean;
}
/** `settings:save` 的预算参数（UI-07c）：只改 config/models.json 的 budget 段，然后照 07b 重载 */
export interface DesktopBudgetSaveInput {
  budget: DesktopBudgetForm;
}
/** `budget:status` 结果（UI-07c）。today 原样来自 3 的 budgetState()；只读后端时为 null */
export type DesktopBudgetStatusResult =
  | {
      ok: true;
      source: DesktopConfigSource;
      /** source 不是 repo 时为 true：整页只读 */
      readonly: boolean;
      /** 配置文件里当前的 budget 段 */
      budget: DesktopBudgetForm;
      today: {
        /** UTC 日期 YYYY-MM-DD */
        day: string;
        spent_micro_usd: number;
        reserved_micro_usd: number;
        /** 后端当前生效的每日预算和每单上限（保存后要等重载才变） */
        daily_limit_micro_usd: number;
        per_ticket_limit_micro_usd: number;
      } | null;
      /** 在途单数（含主管对话）：>0 时保存后重载会排队 */
      running: number;
    }
  | {
      ok: false;
      code: "cwd_repo" | "read_failed" | "invalid_config" | "failed";
      reason: string;
    };
/** 字段错误：field 是表单路径（supervisor.model / reviewers.0.effort / pricing.<模型名> / config） */
export interface DesktopFieldError {
  field: string;
  message: string;
}
/** `settings:save` 结果（UI-07b）。written 是这次真的写成了的文件，部分失败时界面据此照实说明 */
export type DesktopModelSaveResult =
  | { ok: true; written: DesktopModelSaveFile[]; reload: DesktopReloadResult }
  | {
      ok: false;
      code:
        | "external_config"
        | "cwd_repo"
        | "invalid_input"
        | "invalid"
        | "unsafe_path"
        | "read_failed"
        | "write_failed"
        | "partial_write"
        | "failed";
      reason: string;
      written: DesktopModelSaveFile[];
      errors?: DesktopFieldError[];
    };

/** preload 通过 contextBridge 暴露在 window.bakacoding 上的 API。 */
export interface BakaDesktopApi {
  readonly platform: string;
  getSnapshot(): Promise<DesktopSnapshot>;
  /** 订阅增量更新，返回取消订阅函数。 */
  onUpdate(listener: (update: DesktopUpdate) => void): () => void;
  getBackendStatus(): Promise<DesktopBackendStatus>;
  /** 告诉主进程渲染已就绪；返回回放的通知列表。 */
  markSupervisorReady(): Promise<SupervisorNotifyMessage[]>;
  onSupervisorNotify(listener: (msg: SupervisorNotifyMessage) => void): () => void;
  /** 取一次待裁决高风险清单（T-062）；只读模式为空数组。 */
  getPendingHighRisk(): Promise<DesktopPendingHighRisk[]>;
  /** 放行 / 拒绝（T-062）；stale_pr 等失败以 ok:false 返回。 */
  decideHighRisk(
    ticket_id: string,
    pr_id: string,
    decision: DesktopHighRiskDecision,
    detail?: string,
  ): Promise<DesktopDecideHighRiskResult>;
  /** 订阅待裁决清单刷新（T-062）。 */
  onPendingHighRisk(listener: (list: DesktopPendingHighRisk[]) => void): () => void;
  /** 取一次定时同步状态（T-067）；只读模式 available:false。 */
  getSyncState(): Promise<DesktopSyncState>;
  /** 订阅同步状态变化（T-067）。 */
  onSyncState(listener: (state: DesktopSyncState) => void): () => void;
  /** 发一条消息给主管（T-071）；失败以 ok:false 返回，不抛过 IPC。 */
  supervisorChat(message: UserMessage): Promise<DesktopChatResult>;
  /** 重试拆单（UI-04c）：走 supervisor:split → 10 的 split()，不经 chat；失败以 ok:false 返回。 */
  supervisorSplit(request: DesktopSplitRequest): Promise<DesktopSplitResult>;
  /** 取需求详情（UI-05a，只读）；失败以 ok:false 返回（固定文案），不抛过 IPC。 */
  getRequirementDetail(
    query: DesktopRequirementDetailQuery,
  ): Promise<DesktopRequirementDetailResult>;
  /** 取 Git 区状态（UI-06c，只读）；失败以 ok:false 返回（固定文案），不抛过 IPC。旧 preload 可以没有。 */
  getGitStatus?(): Promise<DesktopGitStatusResult>;
  /** 取编码池状态（UI-06b，只读）；旧版 preload 可以没有。失败以 ok:false 返回，不抛过 IPC。 */
  getPoolState?(): Promise<DesktopPoolStateResult>;
  /** 取主管对话历史（UI-04a）；失败以 ok:false 返回，不抛过 IPC。 */
  getSupervisorHistory(query?: DesktopHistoryQuery): Promise<DesktopHistoryResult>;
  /** 选目录导入项目（T-072）。 */
  importProject(): Promise<DesktopImportResult>;
  /** 对上次导入时选的目录用默认模板补配置并完成导入（T-081）；目录由主进程记住，不从界面传。 */
  createDefaultConfig(): Promise<DesktopImportResult>;
  /** 导出诊断包（T-072）；T-130 起可带粒度，省略 = 最近 24 小时。 */
  exportDiagnostics(options?: DesktopExportOptions): Promise<DesktopExportResult>;
  /** 打开数据目录（userData，状态 / 标记文件所在；T-130）。 */
  openDataDir(): Promise<DesktopOpenDataDirResult>;
  /** 只读设置（T-072）。 */
  getSettings(): Promise<DesktopSettings>;
  /** 设置 › 项目（UI-07d）：已导入项目列表；旧版 preload / 测试假 API 可以没有。 */
  listProjects?(): Promise<DesktopProjectListResult>;
  /** 设置 › 项目（UI-07d）：移除项目记录（界面先二次确认）；旧版 preload / 测试假 API 可以没有。 */
  removeProject?(project_id: string): Promise<DesktopProjectRemoveResult>;
  /** 设置 › 项目（UI-07d）：打开项目所在文件夹；旧版 preload / 测试假 API 可以没有。 */
  openProjectFolder?(project_id: string): Promise<DesktopProjectOpenFolderResult>;
  /** 设置 › 关于（UI-07a）；旧版 preload / 测试假 API 可以没有。 */
  getAbout?(): Promise<DesktopAbout>;
  /** 设置 › 模型（UI-07b）：取当前配置供编辑；旧版 preload / 测试假 API 可以没有。 */
  getModelConfig?(): Promise<DesktopModelConfigResult>;
  /** 设置 › 模型（UI-07b）：校验 → 写 config → 写 pricing → 重载；旧版 preload / 测试假 API 可以没有。 */
  saveModelConfig?(input: DesktopModelSaveInput): Promise<DesktopModelSaveResult>;
  /** 设置 › 预算（UI-07c）：每日预算设置和今天已花费；旧版 preload / 测试假 API 可以没有。 */
  getBudgetStatus?(): Promise<DesktopBudgetStatusResult>;
  /** 设置 › 预算（UI-07e）：各项目累计花费（来自台账）；旧版 preload / 测试假 API 可以没有。 */
  getLedgerSummary?(): Promise<DesktopLedgerSummaryResult>;
  /** 设置 › 预算（UI-07c）：同 settings:save，只写 config/models.json 的 budget 段再重载。 */
  saveBudget?(input: DesktopBudgetSaveInput): Promise<DesktopModelSaveResult>;
  /** 主题偏好同步给主进程（UI-02）；旧版 preload / 测试假 API 可以没有。 */
  setWindowTheme?(source: WindowThemeSource): Promise<DesktopWindowThemeResult>;
  /** 重载后端（T-093）：改配置或密钥后调用；有在途单时排队。 */
  reloadBackend(): Promise<DesktopReloadResult>;
  /** 只读横幅「重新连接」（T-093）。 */
  reconnectBackend(): Promise<DesktopReloadResult>;
  /** 项目准备页（UI-03a）：逐项检查当前仓库；旧版 preload / 测试假 API 可以没有。 */
  checkRepo?(): Promise<DesktopRepoCheckResult>;
  /** 初始化 Git（UI-03a）。 */
  initRepo?(req?: { identity?: DesktopGitIdentity }): Promise<DesktopRepoFixResult>;
  /** 首次提交确认框的文件清单（UI-03a）。 */
  listInitialFiles?(): Promise<DesktopRepoFilesResult>;
  /** 首次提交（UI-03a）。 */
  initialCommit?(req: DesktopInitialCommitRequest): Promise<DesktopRepoFixResult>;
  /** 从当前分支新建 main（UI-03a）。 */
  createMainBranch?(): Promise<DesktopRepoFixResult>;
  /** 生成配置（T-113）。 */
  initConfig?(req: DesktopInitConfigRequest): Promise<DesktopConfigFixResult>;
  /** 密钥状态（UI-03b）：只回是否已设、来源、末 4 位，绝不回值。 */
  secretStatus?(name: DesktopSecretName): Promise<DesktopSecretStatusResult>;
  /** 保存密钥（UI-03b）：值只经这一次调用传到主进程，主进程绝不回传。 */
  setSecret?(name: DesktopSecretName, value: string): Promise<DesktopSecretSetResult>;
  /** 清除 BakaCoding 保存的密钥（UI-03b）；系统环境变量里的不能清。 */
  clearSecret?(name: DesktopSecretName): Promise<DesktopSecretClearResult>;
  /** 测试连接（UI-03b）：只发一个极小请求，计入台账（记在主管名下）。 */
  testProvider?(target: DesktopProviderTarget): Promise<DesktopProviderTestResult>;
  /** 订阅「正在退出」（T-106），返回取消订阅函数；旧版 preload / 测试假 API 可以没有。 */
  onQuitting?(listener: () => void): () => void;
}

/** 界面能保存的密钥名（与 3 的 SECRET_NAMES 一致，测试锁住）。 */
export const DESKTOP_SECRET_NAMES = ["DEEPSEEK_API_KEY", "GITHUB_TOKEN"] as const;
export type DesktopSecretName = (typeof DESKTOP_SECRET_NAMES)[number];

/** 3 的 secretStatus 原样（来源 system 时没有 last4）。 */
export interface DesktopSecretStatus {
  set: boolean;
  source: "bakacoding" | "system" | null;
  last4?: string;
}

/** secret:* 失败：code 是固定码，reason 是固定中文文案（shared/secret-text.ts），不含值、路径和原始报错。 */
export interface DesktopSecretFailure {
  ok: false;
  code:
    | "invalid_name"
    | "invalid_value"
    | "unsupported_platform"
    | "write_failed"
    | "not_owned"
    | "not_set"
    | "failed";
  reason: string;
}
export type DesktopSecretStatusResult =
  { ok: true; status: DesktopSecretStatus } | DesktopSecretFailure;
/** 保存成功：后端是只读时主进程顺手重新连接一次，结果在 reload；live 时不重连（网关每次调用现读环境变量）。 */
export type DesktopSecretSetResult =
  { ok: true; status: DesktopSecretStatus; reload?: DesktopReloadResult } | DesktopSecretFailure;
export type DesktopSecretClearResult =
  { ok: true; status: DesktopSecretStatus } | DesktopSecretFailure;

export interface DesktopProviderTarget {
  provider: string;
  model?: string;
}
/** 1 的 testConnection 失败原因，加上桌面端自己的 invalid_target / unavailable（后端只读）/ failed。 */
export type DesktopProviderTestCode =
  | "budget_exhausted"
  | "no_secret"
  | "auth_failed"
  | "quota_exhausted"
  | "rate_limited"
  | "network"
  | "config_error"
  | "http_error"
  | "invalid_target"
  | "unavailable"
  | "failed";
/** provider:test 结果：失败时 reason 是 code 对应的固定中文文案（shared/secret-text.ts），HTTP 失败带 status。 */
export type DesktopProviderTestResult =
  | { ok: true; latency_ms: number; cost_micro_usd: number }
  | { ok: false; code: DesktopProviderTestCode; reason: string; status?: number };

export type {
  ChatReply,
  UserMessage,
  Project,
  HighRiskDecisionErrorCode,
  HighRiskFile,
  HighRiskReason,
  HighRiskDecisionResult,
  SyncState,
  BackpressureReason,
  BackpressureState,
};

declare global {
  interface Window {
    bakacoding?: BakaDesktopApi;
  }
}

/** Git 区状态（UI-06c）：`git:status` 的结果。`current_branch` 分离 HEAD 时为 null；`ahead` = 集成分支领先 main 的提交数。 */
export type DesktopGitStatusResult =
  | {
      ok: true;
      current_branch: string | null;
      integration_branch: string;
      ahead: number;
      main_merge: "user" | "supervisor";
    }
  | { ok: false; reason: string };
/**
 * `pool:state` 结果（UI-06b）：state 原样是 9 的 `BackpressureState`（不改 9 的接口）。
 * 后端只读 / 未接线固定 ok:false；抛错 ok:false，reason 为固定文案。
 */
export type DesktopPoolStateResult =
  { ok: true; state: BackpressureState } | { ok: false; reason: string };
