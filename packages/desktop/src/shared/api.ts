// 主进程 ↔ preload ↔ 渲染进程的数据契约。只放类型和通道名，不引入 Node 或存储模块，
// 渲染进程可以安全地 import type。
import type { HighRiskDecisionErrorCode, SyncState } from "@bakacoding/scheduler";
import type { HighRiskFile, HighRiskReason } from "@bakacoding/sub-agent";
import type { HighRiskDecisionResult, PendingHighRisk } from "@bakacoding/supervisor";
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
  /** invoke：选目录导入项目，切换后端到该仓库（T-072）。 */
  projectImport: "bakacoding:project:import",
  /** invoke：选保存路径，导出最近 24 小时诊断包（T-072）。 */
  diagnosticsExport: "bakacoding:diagnostics:export",
  /** invoke：只读设置（仓库、环境变量是否已设、本地 / GitHub 模式）（T-072）。 */
  settingsGet: "bakacoding:settings:get",
} as const;

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
export interface DesktopBackendStatus {
  mode: "live" | "readonly";
  reason?: string;
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
}

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

/** `project:import` 结果（T-072）：project 原样取自 3 的 importProject。 */
export type DesktopImportResult =
  | { ok: true; project: Project }
  | { ok: false; canceled?: true; missing?: string[]; reason?: string };

/** `diagnostics:export` 结果（T-072）；reason 已脱敏截断。 */
export type DesktopExportResult =
  { ok: true; path: string } | { ok: false; canceled?: true; reason: string };

/** `settings:get` 结果（T-072）：环境变量只给名字和是否已设，绝不给值。 */
export interface DesktopSettings {
  repo: string | null;
  env: { name: string; set: boolean }[];
  mode: "local" | "github";
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
  /** 选目录导入项目（T-072）。 */
  importProject(): Promise<DesktopImportResult>;
  /** 导出诊断包（T-072）。 */
  exportDiagnostics(): Promise<DesktopExportResult>;
  /** 只读设置（T-072）。 */
  getSettings(): Promise<DesktopSettings>;
}

export type {
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
