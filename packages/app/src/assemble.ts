// T-041a：组合根。把 0 事件总线、2 存储、3 配置 / 预算、6 PR 与编排层 8 / 9 / 10 装到同一条总线上，并做重启接管。
// 不是功能模块：在编排层之上、12 之下（modules.md「组合根」一节）。
import { existsSync } from "node:fs";
import type { Budget, Config } from "@bakacoding/config-budget";
import type { CoderPool } from "@bakacoding/coder-pool";
import { createEventBus, type EventBus } from "@bakacoding/event-bus";
import type { ModelGateway } from "@bakacoding/model-gateway";
import type {
  EventContextFn,
  PrProvider,
  PrRecord,
  PrStore,
  PublishEscalated,
  TicketPrRecord,
} from "@bakacoding/pr";
import type { ReviewInput } from "@bakacoding/review-pool";
import {
  createScheduler,
  type DispatchOutcome,
  type ResumeOutcome,
  type Scheduler,
  type SchedulerBus,
  type SchedulerDeps,
  type SchedulerTicket,
  type SubAgentCallOptions,
} from "@bakacoding/scheduler";
import type { Storage } from "@bakacoding/storage";
import {
  createSubAgent,
  eventLogGrantedScopes,
  eventLogResubmitHistory,
  storageTicketPermissions,
  type HandleOptions,
  type ResumeToken,
  type SubAgent,
  type SubAgentPublish,
} from "@bakacoding/sub-agent";
import {
  createSupervisor,
  type Supervisor,
  type SupervisorDeps,
  type TakeOverReport,
} from "@bakacoding/supervisor";
import type { ReviewResult, TicketStatus } from "@bakacoding/types";
import type { ScopeBus } from "@bakacoding/workspace";

export type MaybePromise<T> = T | Promise<T>;

/** 组装入参：0/2/3/6 以下的部件由调用方建好传进来，组合根只负责把它们和 8/9/10 接到同一条总线上。 */
export interface AppDeps {
  /** 3 的 getConfig() 结果 */
  config: Config;
  /** 2 的写入连接（openStorage）。组合根会 `attach` 到总线落库，调用方不要再 attach；关库归调用方 */
  storage: Storage;
  /** 1 的 call（10 用） */
  call: ModelGateway["call"];
  /** 3 的 promptTemplate（10 用 "supervisor"；8 用 "sub_agent"，可选） */
  promptTemplate: (role: "supervisor" | "sub_agent") => MaybePromise<string>;
  /** 5 的编码池。组装 5 时把同一个 4 的 PermissionRegistry 注入 CoderPoolDeps.registry（由调用方建 5 时负责） */
  coder: Pick<CoderPool, "runTicket">;
  /** 7 的 review */
  review: (input: ReviewInput) => Promise<ReviewResult>;
  /** 3 的预算（budgetState）。台账 `budget.attach(bus)` 由调用方用返回的同一条 `bus` 做 */
  budget: Pick<Budget, "budgetState">;
  /**
   * 6：建 PR 实现（通常包一层 createPrProvider）。组合根传入：`eventContext`（转调 9 的）、`publish`（同一条总线）、
   * `store`（2 的 prStore()，重启接管靠它找已开的 PR）。8、9 用同一个实例。
   */
  createPr: (opts: {
    eventContext: EventContextFn;
    publish: PublishEscalated;
    store: PrStore;
  }) => MaybePromise<PrProvider>;
  /** 4 的 worktree（create(ticket_id, base, round) / cleanup(path)） */
  worktrees: SchedulerDeps["worktrees"];
  /** 4 的 worktree 根目录 `<repo>/.bakacoding/worktrees` */
  worktreeRoot: string;
  /** 集成分支当前 HEAD（9 的合并日志起点、10 的新单基线）。v1 一次组装对应一个仓库 */
  targetHead: () => MaybePromise<string>;
  /** 10 的 1:1 出口 */
  notifyUser: SupervisorDeps["notifyUser"];
  listFiles?: SupervisorDeps["listFiles"];
  architectureConstraints?: (project_id: string) => MaybePromise<readonly string[]>;
  /** 已有的总线（如 1 / 3 需要先拿到它）；不给就按 `storage.nextSeq()` 新建一条。8 / 9 / 10 / 2 一律用这一条 */
  bus?: EventBus;
  /** 9 的可选参数 */
  scheduler?: Partial<
    Pick<
      SchedulerDeps,
      "target" | "clock" | "target_dirty_retry_ms" | "exclusive_zones" | "dispatch_poll_ms"
    >
  >;
  /** 越界写申请等批复的时长（4 默认 5 分钟） */
  scopeTimeoutMs?: number;
  onError?: (error: unknown, where: string) => void;
  logger?: { warn(message: string, detail?: unknown): void };
  newId?: () => string;
}

export interface App {
  /** 唯一的一条总线：8 的 publish、8 的 scopeRequests.bus、9 的 bus、10 的 publish / subscribe、2 的 attach 都是它 */
  bus: EventBus;
  supervisor: Supervisor;
  scheduler: Scheduler;
  subAgent: SubAgent;
  pr: PrProvider;
  /** 启动时重启接管的结果（10 的 takeOver） */
  takeOver: TakeOverReport;
  /** 停 9、退订 8 / 10 / 2 的订阅；不关存储 */
  stop(): void;
}

/** 9 / 8 写 TicketStatus：读回整行、只换 status（不带 fields，2 保留原值）。 */
function storageTicketStatus(
  storage: Pick<Storage, "getTicket" | "saveTicket">,
  warn: (m: string) => void,
) {
  return {
    setStatus(ticket_id: string, status: TicketStatus): void {
      const row = storage.getTicket(ticket_id);
      if (!row) {
        warn(`写状态 ${status} 时找不到需求单 ${ticket_id}，跳过`);
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { fields: _fields, ...rest } = row;
      storage.saveTicket({ ...rest, status });
    },
  };
}

/**
 * 本单当前的 PR：2 里 kind 为 ticket、单号一致、未结束（open / conflict）的记录里最新的一条。
 * 重启后派单靠它沿用已开的 PR（PD §12）。
 */
export async function currentTicketPr(
  store: Pick<PrStore, "list">,
  ticket_id: string,
): Promise<TicketPrRecord | undefined> {
  const open = (await store.list()).filter(
    (r: PrRecord): r is TicketPrRecord =>
      r.kind === "ticket" &&
      r.ticket_id === ticket_id &&
      (r.status === "open" || r.status === "conflict"),
  );
  open.sort((a, b) =>
    a.created_ts === b.created_ts
      ? a.pr_id.localeCompare(b.pr_id)
      : a.created_ts < b.created_ts
        ? -1
        : 1,
  );
  return open.at(-1);
}

export async function assemble(deps: AppDeps): Promise<App> {
  const logger = deps.logger ?? {
    warn: (m: string, d?: unknown) => console.warn(`[app] ${m}`, d ?? ""),
  };
  const onError =
    deps.onError ?? ((err: unknown, where: string) => logger.warn(`${where} 出错`, err));
  const { storage, config } = deps;
  const bus = deps.bus ?? createEventBus({ initialSeq: storage.nextSeq() });
  const unsubs: Array<() => void> = [];
  unsubs.push(storage.attach(bus, { onError: (e) => onError(e, "storage.attach") }));

  const store = storage.prStore<PrRecord>() as PrStore;
  const tickets = storageTicketStatus(storage, (m) => logger.warn(m));
  const publish = (e: Parameters<EventBus["publish"]>[0]) => bus.publish(e);

  // 6、8、10 先建，闭包里转调后面才建的 9（都只在 9 start() 之后才会被调用）
  let ready = false;
  const eventContext: EventContextFn = (info) => {
    if (!ready) throw new Error("调度器还没建好");
    return scheduler.eventContext(info);
  };
  const pr = await deps.createPr({ eventContext, publish, store });

  // ---- 10 ----
  const supervisor = createSupervisor({
    call: deps.call,
    getConfig: () => config,
    promptTemplate: () => deps.promptTemplate("supervisor"),
    storage,
    enqueue: (t) => scheduler.enqueue(t),
    publish,
    subscribe: (type, handler) => bus.subscribe(type, handler),
    targetHead: () => deps.targetHead(),
    ...(deps.listFiles ? { listFiles: deps.listFiles } : {}),
    notifyUser: deps.notifyUser,
    ...(deps.newId ? { newId: deps.newId } : {}),
    logger,
  });

  // ---- 8 ----
  const subAgent = createSubAgent({
    getConfig: () => config,
    coder: deps.coder,
    review: deps.review,
    pr,
    budgetState: (ticket_id) => deps.budget.budgetState(ticket_id),
    rounds: {
      save: (r) => storage.savePrRecord(r),
      list: (ticket_id) => storage.listPrRounds(ticket_id),
    },
    tickets,
    resubmitHistory: eventLogResubmitHistory(storage),
    worktreeRoot: deps.worktreeRoot,
    worktrees: deps.worktrees,
    submit: (input) => scheduler.submit(input),
    publish: publish as SubAgentPublish,
    prRecords: { get: (pr_id) => store.get(pr_id) },
    loadTicket: (ticket_id) => supervisor.loadTicket(ticket_id),
    permissions: storageTicketPermissions(storage),
    scopeRequests: {
      bus: bus as unknown as ScopeBus,
      ...(deps.scopeTimeoutMs !== undefined ? { timeout_ms: deps.scopeTimeoutMs } : {}),
    },
    scheduler: { extendScope: (id, scope) => scheduler.extendScope(id, scope) },
    grantedScopes: eventLogGrantedScopes(storage),
    ...(deps.architectureConstraints
      ? { architectureConstraints: deps.architectureConstraints }
      : {}),
    promptTemplate: () => deps.promptTemplate("sub_agent"),
    logger,
  });

  /** 9 只有 SchedulerTicket：按单号用 10 的 loadTicket 补全成 SubAgentTicket；重启后沿用 2 里已开的 PR。 */
  async function handle(
    t: SchedulerTicket,
    options: SubAgentCallOptions = {},
  ): Promise<DispatchOutcome> {
    const ticket = await supervisor.loadTicket(t.ticket_id);
    if (!ticket)
      throw new Error(`需求单 ${t.ticket_id} 读不出（不存在或 fields_invalid），不能派单`);
    const opts: HandleOptions = options.signal ? { signal: options.signal } : {};
    const current = await currentTicketPr(store, t.ticket_id);
    if (current) {
      // 不重复开 PR（PD §12）：worktree 不在了就报错交给 9 上报，不另开 r0 / 新 PR
      if (!existsSync(current.worktree_path))
        throw new Error(
          `需求单 ${t.ticket_id} 已有 PR ${current.pr_id}，但它的 worktree 不在了：${current.worktree_path}`,
        );
      opts.pr_id = current.pr_id;
      opts.worktree = { path: current.worktree_path, branch: current.branch };
    }
    return subAgent.handle(ticket, opts);
  }

  // ---- 9 ----
  const scheduler: Scheduler = createScheduler({
    ...deps.scheduler,
    bus: bus as unknown as SchedulerBus,
    createPr: () => pr,
    config,
    targetHead: () => deps.targetHead(),
    budgetState: () => deps.budget.budgetState(),
    tickets,
    saveMergeResult: (ticket_id, result) => storage.saveMergeResult(ticket_id, result),
    worktrees: deps.worktrees,
    subAgent: {
      handle,
      resubmitConflict: (req) => subAgent.resubmitConflict(req),
      reReview: (req) => subAgent.reReview(req),
      resume: (t, token, options) =>
        subAgent.resume(
          { ticket_id: t.ticket_id },
          token as ResumeToken,
          options,
        ) as Promise<ResumeOutcome>,
    },
    onError: (err, ticket_id) => onError(err, `scheduler(${ticket_id})`),
    ...(deps.newId ? { newId: deps.newId } : {}),
    // TODO(T-041c)：9 加了高风险闸门后，在这里打开（holdHighRisk: true）。默认关闭只适用于单独使用 9 的场景。
  });

  ready = true;
  await scheduler.start();
  unsubs.push(() => scheduler.stop());
  unsubs.push(subAgent.attach({ subscribe: (type, handler) => bus.subscribe(type, handler) }));
  unsubs.push(supervisor.start());

  // 重启接管：9 已启动、8 / 10 已订阅之后再接回（TODO(T-041a 后续)：已在合并队列里的单等 9 的 adopt）
  const takeOver = await supervisor.takeOver();
  if (takeOver.awaiting_adopt.length)
    logger.warn(
      `重启接管：${takeOver.awaiting_adopt.length} 张单已在合并队列里，要等 9 的 adopt 才能接回：${takeOver.awaiting_adopt.join("、")}`,
    );

  return {
    bus,
    supervisor,
    scheduler,
    subAgent,
    pr,
    takeOver,
    stop() {
      for (const u of unsubs.splice(0).reverse()) {
        try {
          u();
        } catch (err) {
          onError(err, "stop");
        }
      }
    },
  };
}
