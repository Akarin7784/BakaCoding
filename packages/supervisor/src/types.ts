import type { Config } from "@bakacoding/config-budget";
import type { ModelGateway } from "@bakacoding/model-gateway";
import type { SchedulerTicket } from "@bakacoding/scheduler";
import type { Storage } from "@bakacoding/storage";
import type { SubAgentTicket } from "@bakacoding/sub-agent";
import type { ESCALATION_REASONS, EventOf } from "@bakacoding/types";

export type MaybePromise<T> = T | Promise<T>;

type EscalationReason = (typeof ESCALATION_REASONS)[number];

/** 接口声明的一项：文件 + 符号（与 interface_changed 的 changed_interfaces 同结构）。 */
type InterfaceDecl = EventOf<"interface_changed">["payload"]["changed_interfaces"][number];

/** 单子来源：主管拆的（split）、手动单、测试单。只有 manual / test 允许默认整仓 `**`。 */
export type TicketOrigin = "split" | "manual" | "test";

/** 拆单最多调用模型的次数（1 次 + 2 次退回重拆）。常量，不进配置。 */
export const SPLIT_MAX_ATTEMPTS = 3;

/** 用户在 1:1 里发的一条消息。 */
export interface UserMessage {
  text: string;
  /** 界面已知项目时直接传；不传就由主管判断或追问 */
  project_id?: string;
  message_id?: string;
}

/** chat 的回复：由调用方（12）展示在 1:1 里；chat 不再另调 notifyUser。 */
export interface ChatReply {
  text: string;
  kind: "answer" | "ask_project" | "decision_saved" | "dispatched" | "split_failed";
  project_id?: string;
  requirement_id?: string;
  ticket_ids?: string[];
}

export interface SplitRequest {
  project_id: string;
  /** 需求原文（不可信输入） */
  text: string;
  /** 不给由 10 生成 `req-<短 id>` */
  requirement_id?: string;
  /** 不给用 deps.targetHead(project_id) */
  base_commit?: string;
  /** T-041 重拆预留：T-040 只把它作为不可信材料拼进提示词 */
  feedback?: { ticket_id: string; reason: EscalationReason; detail?: string }[];
}

export interface SplitResult {
  requirement_id: string;
  trace_id: string;
  /** 推理摘要，同时写进每张单的 decomposition_summary */
  summary: string;
  tickets: SupervisorTicket[];
  /** 用了几次模型调用（1..SPLIT_MAX_ATTEMPTS） */
  attempts: number;
}

/** 主管产出的需求单：结构上同时满足 9 的 SchedulerTicket 和 8 的 SubAgentTicket。 */
export interface SupervisorTicket {
  ticket_id: string;
  project_id: string;
  requirement_id: string;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  ticket_text: string;
  base_commit: string;
  write_scope: string[];
  interfaces: InterfaceDecl[];
  depends_on: string[];
  priority: "normal" | "deferred";
  kind?: "dependency";
  architecture_constraints?: readonly string[];
  /** 拆单时固定为空，由 8 生成 */
  permission_list: [];
  origin: TicketOrigin;
}

export interface ManualTicketInput {
  project_id: string;
  ticket_text: string;
  origin: "manual" | "test";
  /** 不给按整仓 `**`，并发 ticket_warning(write_scope_defaulted) */
  write_scope?: string[];
  interfaces?: InterfaceDecl[];
  depends_on?: string[];
  priority?: "normal" | "deferred";
  requirement_id?: string;
  base_commit?: string;
}

/** 校验错误（split 单任何一条即整批退回；manual / test 单直接报错）。 */
export interface TicketValidationError {
  code:
    | "output_invalid"
    | "write_scope_missing"
    | "write_scope_trailing_slash"
    | "write_scope_unsafe"
    | "write_scope_whole_repo"
    | "write_scope_bare_directory"
    | "interfaces_missing"
    | "interface_unsafe"
    | "depends_on_unknown"
    | "depends_on_cycle";
  /** 出错的单（模型输出里的 key 或手动单号）；整份输出出错时不给 */
  ticket?: string;
  /** 出错的条目（如某个 write_scope） */
  entry?: string;
  message: string;
}

type PublishOf<K extends "group_message" | "ticket_warning"> = Omit<EventOf<K>, "seq">;

export interface SupervisorDeps {
  /** 1 的 call */
  call: ModelGateway["call"];
  /** 3：只用 roles.supervisor */
  getConfig: () => { roles: Pick<Config["roles"], "supervisor"> };
  /** 3 的 promptTemplate（T-008）；10 不带默认模板 */
  promptTemplate: (role: "supervisor") => MaybePromise<string>;
  /**
   * 2 的存取（T-055，全部同步）。结构化字段（write_scope、interfaces、depends_on、priority、kind、origin、trace）
   * 写在 `saveTicket` 的 `fields` 里；`fields` 为 null（旧数据或损坏）或不合 10 的格式时，10 按「没有结构化字段」处理。
   */
  storage: Pick<
    Storage,
    | "listProjects"
    | "listDecisions"
    | "saveDecision"
    | "registerRequirement"
    | "saveTicket"
    | "getTicket"
    | "listTickets"
  >;
  /** 9 的 enqueue */
  enqueue: (ticket: SchedulerTicket) => unknown;
  /** 0：只发 group_message 与 ticket_warning（10 自己填 event_id、ts） */
  publish: (event: PublishOf<"group_message"> | PublishOf<"ticket_warning">) => unknown;
  /** 0：只订阅 project_created */
  subscribe: (
    type: "project_created",
    handler: (event: EventOf<"project_created">) => void | Promise<void>,
  ) => () => void;
  /** 集成分支 HEAD，作为新单基线 */
  targetHead: (project_id: string) => MaybePromise<string>;
  /** 可选：基线上的文件清单，用作拆单上下文和判断「裸目录」 */
  listFiles?: (project_id: string, commit: string) => MaybePromise<readonly string[]>;
  /** 1:1 出口（主动通知，如项目导入完成）；1:1 历史 v1 不持久化 */
  notifyUser: (message: { text: string; project_id?: string; requirement_id?: string }) => unknown;
  newId?: () => string;
  clock?: () => Date;
  logger?: { warn(msg: string, detail?: unknown): void };
}

/**
 * 重启接管的结果（T-041a）：按 2 的 `tickets.status` 分类，每张单只进一类。
 * 单号都按 `listTickets()` 的顺序（created_at、ticket_id 升序）。
 */
export interface TakeOverReport {
  /** pending / coding / in_review / resubmitting：已重新登记到 9（`enqueue`），派单时组合根沿用已开的 PR */
  enqueued: string[];
  /**
   * 结构化字段缺失、不合格式或写入范围复查不过（`loadTicket` 返回 undefined，已发一次 `ticket_warning(fields_invalid)`）：
   * 不接回、不重拆、不上报
   */
  skipped_invalid: string[];
  /**
   * merge_queued / conflict / re_reviewing：要用 9 的 `adopt` 直接恢复进合并队列（T-061 合入后另开分支做），
   * 本次没有接回，只列出来
   */
  awaiting_adopt: string[];
  /** escalated：补跑上报处理在 T-041b，本次只列出来 */
  escalated: string[];
  /** merged：跳过 */
  merged: string[];
  /** 接回时出错（如 9 的 enqueue 抛错）；不影响其余单 */
  failed: { ticket_id: string; error: string }[];
}

export interface Supervisor {
  chat(message: UserMessage): Promise<ChatReply>;
  split(request: SplitRequest): Promise<SplitResult>;
  /** 订阅 project_created，返回退订函数 */
  start(): () => void;
  createManualTicket(input: ManualTicketInput): Promise<SupervisorTicket>;
  /** 从 2 还原单子，装配时注入 8 的 deps.loadTicket */
  loadTicket(ticket_id: string): Promise<SubAgentTicket | undefined>;
  /**
   * 重启接管（T-041a）：扫描 2 的 `listTickets()`，按状态把没到终态的单接回 9（见 `TakeOverReport`）。
   * 同一进程里已经接回过（或本进程建的）单不再重复登记。重新登记时 `depends_on` 里已 merged 的单去掉
   * （9 重启后不认识它们，留着会一直 waiting）。
   */
  takeOver(): Promise<TakeOverReport>;
}
