import type { Config } from "@bakacoding/config-budget";
import type { ModelGateway } from "@bakacoding/model-gateway";
import type { SchedulerTicket } from "@bakacoding/scheduler";
import type { Decision, TicketInput } from "@bakacoding/storage";
import type { SubAgentTicket } from "@bakacoding/sub-agent";
import type { ESCALATION_REASONS, EventOf, TicketStatus, Trace } from "@bakacoding/types";

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

/** 需求单结构化字段（存储小单约定：tickets 表可选 JSON 列，旧数据读出为 null）。 */
interface TicketStructuredFields {
  write_scope?: string[] | null;
  interfaces?: InterfaceDecl[] | null;
  depends_on?: string[] | null;
  priority?: "normal" | "deferred" | null;
  kind?: "dependency" | null;
  origin?: TicketOrigin | null;
  trace?: Trace | null;
}

/** getTicket / listTickets 读出的一行（只列 10 用到的字段）。 */
type StoredTicketRow = Pick<
  TicketInput,
  "ticket_id" | "project_id" | "requirement_id" | "ticket_text" | "base_commit" | "permission_list"
> & { status?: TicketStatus | null } & TicketStructuredFields;

type PublishOf<K extends "group_message" | "ticket_warning"> = Omit<EventOf<K>, "seq">;

export interface SupervisorDeps {
  /** 1 的 call */
  call: ModelGateway["call"];
  /** 3：只用 roles.supervisor */
  getConfig: () => { roles: Pick<Config["roles"], "supervisor"> };
  /** 3 的 promptTemplate（T-008）；10 不带默认模板 */
  promptTemplate: (role: "supervisor") => MaybePromise<string>;
  /**
   * 2 的存取。`saveTicket` / `getTicket` / `listTickets` 的结构化字段按存储小单的约定（T-055 待合）；
   * `listProjects` 的 `name` 可选（2 现在只给 project_id，缺名字时用 project_created 里记下的或 project_id）。
   */
  storage: {
    listProjects(): MaybePromise<readonly { project_id: string; name?: string | null }[]>;
    listDecisions(project_id: string): MaybePromise<readonly Decision[]>;
    saveDecision(d: { project_id: string; content: string }): MaybePromise<Decision>;
    registerRequirement(requirement_id: string, project_id: string): MaybePromise<void>;
    saveTicket(ticket: TicketInput & TicketStructuredFields): MaybePromise<void>;
    getTicket(ticket_id: string): MaybePromise<StoredTicketRow | undefined | null>;
    listTickets(filter: {
      project_id?: string;
      status?: TicketStatus;
    }): MaybePromise<readonly StoredTicketRow[]>;
  };
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

export interface Supervisor {
  chat(message: UserMessage): Promise<ChatReply>;
  split(request: SplitRequest): Promise<SplitResult>;
  /** 订阅 project_created，返回退订函数 */
  start(): () => void;
  createManualTicket(input: ManualTicketInput): Promise<SupervisorTicket>;
  /** 从 2 还原单子，装配时注入 8 的 deps.loadTicket */
  loadTicket(ticket_id: string): Promise<SubAgentTicket | undefined>;
}
