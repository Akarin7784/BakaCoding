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

type PublishOf<K extends "group_message" | "ticket_warning" | "escalated"> = Omit<
  EventOf<K>,
  "seq"
>;

/**
 * 上报处理的结果（T-041b，提案 S9）：
 * - `resplit`：重拆（同一需求已重拆次数 < `pipeline.resplit_limit`）；
 * - `notify_user`：只在 1:1 里交给用户（`budget_exceeded`、`internal_error`、`github_manual`、`merged_but`、
 *   `scope_lock_failed`、旧单没有需求原文、旧 PR 其实已合入、拆单失败、已经处理过的单再次上报等）；
 * - `resplit_limit`：已重拆次数 ≥ 上限，发 `escalated(resplit_limit)` 并交给用户；
 * - `ignored`：10 自己发的 `resplit_limit`。
 */
export type EscalationAction = "resplit" | "notify_user" | "resplit_limit" | "ignored";

/** 10 订阅的事件（T-041b，提案 S2）。 */
type SubscribedType = "project_created" | "escalated";

export interface SupervisorDeps {
  /** 1 的 call */
  call: ModelGateway["call"];
  /** 3：用 roles.supervisor 和 pipeline.resplit_limit（T-041b，提案 S4；3 的 Config 本来就满足） */
  getConfig: () => {
    roles: Pick<Config["roles"], "supervisor">;
    pipeline: Pick<Config["pipeline"], "resplit_limit">;
  };
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
  /**
   * 可选（T-041a）：重启接管时把已在合并队列里的单（merge_queued / conflict / re_reviewing）直接接回 9。
   * 组合根注入：按单号查 2 的 PR 记录，转调 9 的 `adopt`（带 pr_id / head / worktree）；查不到 PR 等情况抛错。
   * 不注入时这些单只列进 `TakeOverReport.awaiting_adopt`（单独使用 10 的场景）。
   */
  adopt?: (ticket: SchedulerTicket & { kind?: "dependency" }) => unknown;
  /**
   * 0：发 group_message、ticket_warning，以及 T-041b 起的 escalated（只发 `resplit_limit`，提案 S3）。
   * 10 自己填 event_id、ts。
   */
  publish: (
    event: PublishOf<"group_message"> | PublishOf<"ticket_warning"> | PublishOf<"escalated">,
  ) => unknown;
  /** 0：订阅 project_created，T-041b 起另订阅 escalated（提案 S2） */
  subscribe: <K extends SubscribedType>(
    type: K,
    handler: (event: EventOf<K>) => void | Promise<void>,
  ) => () => void;
  /**
   * 可选（T-041b，N1）：重拆前关掉旧单的 PR。组合根实现：先同步远端状态（9 的 `sync()`，内部调 6 的 `sync()`），
   * 再只看本单的 `kind: "ticket"` 记录：有 merged 的返回 `"merged"`（10 不重拆，交用户）；没有 open / conflict 的
   * 返回 `"none"`；否则全部关掉返回 `"closed"`（6 抛 `PrAlreadyMergedError` 时也返回 `"merged"`）。
   * 抛错（同步或关闭失败）时 10 不重拆，发 `ticket_warning(pr_close_failed)` 并重试。
   * 不注入时 10 不关 PR，按 `"none"` 处理并记 warn（单独使用 10 的场景）。
   */
  closeTicketPr?: (ticket_id: string, reason: string) => MaybePromise<"closed" | "none" | "merged">;
  /**
   * 可选（T-041b，N5）：本单最后一条需要处理的 `escalated`（跳过 `scope_lock_failed`、`merged_but`、
   * `resplit_limit`），重启补跑上报处理时用来取原因。组合根用 2 的 `queryEvents` 实现。
   * 不注入或查不到时按 `notify_user` 处理（不重拆）。
   */
  lastEscalation?: (ticket_id: string) => MaybePromise<EventOf<"escalated"> | undefined>;
  /**
   * 可选（T-041b）：9 的 `replaceDependency`（提案 R2）。重拆后把下游单依赖里的旧单号换成新单号，返回被改的单号；
   * 不注入时只改 2 里的 `fields.depends_on`（单独使用 10 的场景）。
   */
  replaceDependency?: (
    old_ticket_id: string,
    new_ticket_ids: readonly string[],
  ) => MaybePromise<string[]>;
  /**
   * 可选（T-041b）：关旧 PR 失败后重试用的定时器（默认全局 setTimeout / clearTimeout），测试注入。
   * 重试间隔 30 秒、2 分钟、10 分钟；`start()` 返回的退订函数会清掉没到期的重试。
   */
  timers?: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  };
  /**
   * 可选（T-041c，提案 S5）：9 的高风险闸门。`release` 接 9 的 `releaseHighRisk`，`reject` 接 `rejectHighRisk`；
   * `decideHighRisk` 转调它们。不注入时 `decideHighRisk` 返回 `{ ok: false }`（单独使用 10 的场景）。
   */
  highRisk?: {
    release(ticket_id: string): MaybePromise<"released" | "already">;
    reject(ticket_id: string, detail: string): MaybePromise<void>;
  };
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
  /** merge_queued / conflict / re_reviewing：经 `deps.adopt` 直接恢复进 9 的合并队列（状态一律 merge_queued） */
  adopted: string[];
  /** 同上，但没注入 `deps.adopt`（单独使用 10）：没有接回，只列出来 */
  awaiting_adopt: string[];
  /** escalated：全部列出（含已处理过的）；本次补跑过上报处理的另见 `escalations` */
  escalated: string[];
  /**
   * 本次补跑了上报处理的单及其结果（T-041b，N3）：已上报、还没有 `escalation_handled` 的单补跑一次；
   * 已标记要重拆、但旧 PR 还没确认关掉的单从关旧 PR 这一步接着做。每次 takeOver 最多补跑 5 张，其余进 `held`。
   */
  escalations: { ticket_id: string; action: EscalationAction }[];
  /**
   * 没有接回的单（T-041b，N4）：依赖（含间接）已上报又没被重拆取代、或依赖 `fields_invalid` 的单，不接回 9
   * （接回也会一直 waiting）；以及超出本次补跑上限、留到下次 takeOver 的已上报单（`blocked_by` 为空）。
   * 每张单在 1:1 里只通知一次（同一进程内）。
   */
  held: { ticket_id: string; blocked_by: string[] }[];
  /** merged：跳过 */
  merged: string[];
  /** 接回时出错（9 的 enqueue / adopt 抛错，如查不到 PR 记录）；不影响其余单，下次 takeOver 再试 */
  failed: { ticket_id: string; error: string }[];
}

/** 9 扣住高风险单时的通知（T-041c，N3；同 9 的 `HighRiskHeldInfo`，10 不依赖 9 的类型）。 */
export interface HighRiskHeldInput {
  ticket_id: string;
  pr_id: string;
  requirement_id: string;
  /** submit：评审通过刚交进合并队列；adopt：重启接管接回（放行不保存）；resubmit：放行后冲突复投换了新 PR */
  cause: "submit" | "adopt" | "resubmit";
}

/** 反压暂停时 9 给的状态（T-041c，取 9 的 `BackpressureState` 里用得到的字段）。 */
export interface BackpressurePausedInput {
  reasons: readonly string[];
  pending_prs: { total: number; limit: number; high_risk_held: number };
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
  /**
   * 高风险 PR 裁决（T-041c，提案 S7、Q4 b）：只由用户做，不调模型。转调 `deps.highRisk`；
   * 出错（没注入、单不在等裁决、PR 已合入等）返回 `{ ok: false, error }`，不抛。
   * 拒绝时 9 关 PR 并发 `escalated(high_risk_rejected)`，10 按上报处理（不重拆，交用户）。
   */
  decideHighRisk(
    ticket_id: string,
    decision: "release" | "reject",
    detail?: string,
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * 9 扣住高风险单（T-041c，N3）：组合根接 9 的 `onHighRiskHeld`。通知用户（同一 PR 在本进程只通知一次；
   * 重启后重新扣住、放行后换了新 PR 都会写明），记进待裁决清单。
   */
  highRiskHeld(info: HighRiskHeldInput): Promise<void>;
  /** 等用户裁决的高风险单（T-041c，N3；T-042 主管待办、T-062 界面用）。已到终态的单自动去掉。 */
  pendingHighRisk(): { ticket_id: string; pr_id: string }[];
  /**
   * 反压暂停派单（T-041c，Q-7）：组合根接 9 的 `onBackpressurePaused`。通知用户暂停原因，
   * 并写明待合并 PR 里有几张是被高风险闸门扣着、等用户裁决的。
   */
  backpressurePaused(state: BackpressurePausedInput): Promise<void>;
}
