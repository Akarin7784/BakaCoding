// 主进程 ↔ preload ↔ 渲染进程的数据契约。只放类型和通道名，不引入 Node 或存储模块，
// 渲染进程可以安全地 import type。
import type { HighRiskDecisionErrorCode, SyncState } from "@bakacoding/scheduler";
import type { HighRiskFile, HighRiskReason } from "@bakacoding/sub-agent";
import type {
  ChatReply,
  HighRiskDecisionResult,
  PendingHighRisk,
  UserMessage,
} from "@bakacoding/supervisor";
import type { Project } from "@bakacoding/config-budget";
import type { BakaEvent, TicketStatus } from "@bakacoding/types";

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
  /** invoke：选目录导入项目，切换后端到该仓库（T-072）。 */
  projectImport: "bakacoding:project:import",
  /** invoke：选保存路径，导出最近 24 小时诊断包（T-072）。 */
  diagnosticsExport: "bakacoding:diagnostics:export",
  /** invoke：只读设置（仓库、环境变量是否已设、本地 / GitHub 模式）（T-072）。 */
  settingsGet: "bakacoding:settings:get",
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

/** 界面关心的事件类型；其余事件主进程不下发。 */
export const UI_EVENT_TYPES = [
  "project_created",
  "group_message",
  "call_completed",
  "escalated",
  "ticket_warning",
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
  code?: "not_git" | "no_commits" | "no_main" | "not_ignored";
  detail?: string;
  current?: string;
}

/** 4 的 checkRepo() 结果：items 固定 git / commit / main / ignored 顺序；identity 只回是否已配。 */
export interface DesktopRepoCheck {
  items: DesktopRepoCheckItem[];
  current_branch: string | null;
  identity: { name: boolean; email: boolean };
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

/** `folder`：仓库根的最后一级文件夹名（basename，不带上级路径），给准备页标题和确认框显示。 */
export type DesktopRepoCheckResult =
  { ok: true; check: DesktopRepoCheck; folder: string } | DesktopRepoFixFailure;

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
/** `project:import` 结果（T-072）：project 原样取自 3 的 importProject；note 为补充说明（如在用 BAKACODING_CONFIG）。 */
export type DesktopImportResult =
  | { ok: true; project: Project; note?: string }
  | { ok: false; canceled?: true; missing?: string[]; reason?: string };

/** `diagnostics:export` 结果（T-072）；reason 已脱敏截断。 */
export type DesktopExportResult =
  { ok: true; path: string } | { ok: false; canceled?: true; reason: string };

/** `settings:get` 结果（T-072）：环境变量只给名字和是否已设，绝不给值。 */
export interface DesktopSettings {
  repo: string | null;
  env: { name: string; set: boolean }[];
  /** readonly：后端只读（没有 PR 实现，不显示成 local） */
  mode: "local" | "github" | "readonly";
}

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
  /** 选目录导入项目（T-072）。 */
  importProject(): Promise<DesktopImportResult>;
  /** 导出诊断包（T-072）。 */
  exportDiagnostics(): Promise<DesktopExportResult>;
  /** 只读设置（T-072）。 */
  getSettings(): Promise<DesktopSettings>;
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
  | { ok: true; status: DesktopSecretStatus }
  | DesktopSecretFailure;
/** 保存成功：后端是只读时主进程顺手重新连接一次，结果在 reload；live 时不重连（网关每次调用现读环境变量）。 */
export type DesktopSecretSetResult =
  | { ok: true; status: DesktopSecretStatus; reload?: DesktopReloadResult }
  | DesktopSecretFailure;
export type DesktopSecretClearResult =
  | { ok: true; status: DesktopSecretStatus }
  | DesktopSecretFailure;

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
};

declare global {
  interface Window {
    bakacoding?: BakaDesktopApi;
  }
}
