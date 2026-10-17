// T-041a：组合根。把 0 事件总线、2 存储、3 配置 / 预算、6 PR 与编排层 8 / 9 / 10 装到同一条总线上，并做重启接管。
// 不是功能模块：在编排层之上、12 之下（modules.md「组合根」一节）。
import { existsSync } from "node:fs";
import type { Budget, Config } from "@bakacoding/config-budget";
import type { CoderPool } from "@bakacoding/coder-pool";
import { createEventBus, type EventBus } from "@bakacoding/event-bus";
import type { ModelGateway } from "@bakacoding/model-gateway";
import {
  PrAlreadyMergedError,
  type EventContextFn,
  type PrProvider,
  type PrRecord,
  type PrStore,
  type PublishEscalated,
  type TicketPrRecord,
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
  type HighRiskHeldInfo,
} from "@bakacoding/scheduler";
import type { Storage } from "@bakacoding/storage";
import {
  createSubAgent,
  eventLogGrantedScopes,
  eventLogResubmitHistory,
  isHighRiskDiffFile,
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
import type { DiffFile, EventOf, ReviewResult, TicketStatus } from "@bakacoding/types";
import { isUnsafeGlob, type ScopeBus } from "@bakacoding/workspace";

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

/** N5：重启补跑时取上报原因——本单最后一条需要处理的 escalated（跳过只通知的和 10 自己发的）。 */
export function lastEscalationFrom(
  storage: Pick<Storage, "queryEvents">,
): (ticket_id: string) => EventOf<"escalated"> | undefined {
  const skip = new Set(["scope_lock_failed", "merged_but", "resplit_limit"]);
  return (ticket_id) => {
    const evs = storage
      .queryEvents({ ticket_id, types: ["escalated"] })
      .filter(
        (e): e is EventOf<"escalated"> =>
          e.type === "escalated" && e.ticket_id === ticket_id && !skip.has(e.payload.reason),
      )
      .sort((a, b) => a.seq - b.seq);
    return evs.at(-1);
  };
}

/**
 * N1：重拆前关掉旧单的 PR。先 `sync()` 把远端状态同步回本地记录（经 9 的 sync，内部调 6 的 sync，其他单的变化也照常应用），
 * 再只看本单的 `kind: "ticket"` 记录：有 merged 的返回 `"merged"`；没有 open / conflict 的返回 `"none"`；
 * 否则全部关掉返回 `"closed"`（6 抛 `PrAlreadyMergedError` 也算 `"merged"`）。sync 或 close 的其他错误照抛，10 不重拆、重试。
 * 不先 sync 的话，远端已合入、本地还是 open 的 PR 会被 6 在本地标成 closed（6 的 close 只看本地记录）。
 */
export async function closeTicketPrs(
  o: { sync: () => Promise<unknown>; store: Pick<PrStore, "list">; pr: Pick<PrProvider, "close"> },
  ticket_id: string,
  reason: string,
): Promise<"closed" | "none" | "merged"> {
  await o.sync();
  const mine = (await o.store.list()).filter(
    (r: PrRecord): r is TicketPrRecord => r.kind === "ticket" && r.ticket_id === ticket_id,
  );
  if (mine.some((r) => r.status === "merged")) return "merged";
  const open = mine.filter((r) => r.status === "open" || r.status === "conflict");
  if (open.length === 0) return "none";
  for (const r of open) {
    try {
      await o.pr.close(r.pr_id, reason);
    } catch (err) {
      if (err instanceof PrAlreadyMergedError) return "merged";
      throw err;
    }
  }
  return "closed";
}

/**
 * 重启接管时补判高风险（T-041c，N4）：8 按 diff 判出的高风险重启后就丢了（只有 kind: dependency 存在 2 里），
 * 接回前按 6 的 diff 重新判，规则同 8（`isHighRiskDiffFile`：依赖清单 / 锁文件，含删除的；改名的看新旧路径，T-065）。
 * diff 出错按高风险处理：宁可错扣，不可漏扣。同时返回取到的 diff 文件（取不到为 null），
 * 组合根留着给 10 的 `pendingHighRisk()` 算理由和文件，不再取第二次。
 */
export async function judgeHighRiskOnTakeover(
  pr: Pick<PrProvider, "diff">,
  pr_id: string,
  warn: (msg: string, detail?: unknown) => void = () => {},
): Promise<{ high_risk: boolean; files: DiffFile[] | null }> {
  try {
    const files = (await pr.diff(pr_id)).files;
    return { high_risk: files.some(isHighRiskDiffFile), files };
  } catch (err) {
    warn(`重启接管：取 PR ${pr_id} 的 diff 失败，按高风险处理`, err);
    return { high_risk: true, files: null };
  }
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
  const granted = eventLogGrantedScopes(storage);
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
    enqueue: (t) => scheduler.enqueue(withGrantedScopes(t)),
    adopt: (t) => adopt(withGrantedScopes(t)),
    closeTicketPr: (ticket_id, reason) =>
      closeTicketPrs({ sync: () => scheduler.sync(), store, pr }, ticket_id, reason),
    lastEscalation: lastEscalationFrom(storage),
    replaceDependency: (old_id, ids) => scheduler.replaceDependency(old_id, ids),
    highRisk: {
      check: (id, pr_id) => scheduler.checkHighRisk(id, pr_id),
      release: (id, pr_id) => scheduler.releaseHighRisk(id, pr_id),
      reject: (id, pr_id, detail) => scheduler.rejectHighRisk(id, pr_id, detail),
    },
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
    grantedScopes: granted,
    ...(deps.architectureConstraints
      ? { architectureConstraints: deps.architectureConstraints }
      : {}),
    promptTemplate: () => deps.promptTemplate("sub_agent"),
    logger,
  });

  /**
   * 重启前经 extendScope 扩出、并经 8 批准过的写入范围（事件日志里的 write_scope_granted）并进交给 9 的
   * write_scope，9 按它加锁（T-041b，#62 已知缺口）。不安全的 glob 不并。新单没有批准记录，不受影响。
   */
  function withGrantedScopes<T extends SchedulerTicket>(t: T): T {
    const base = t.write_scope ?? [];
    // 没写 write_scope 即整仓 **，并进去反而变窄
    if (base.length === 0) return t;
    const extra = granted(t.ticket_id).filter((g) => !isUnsafeGlob(g));
    if (extra.length === 0) return t;
    const merged = [...base, ...extra.filter((g) => !base.includes(g))];
    return merged.length === base.length ? t : { ...t, write_scope: merged };
  }

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

  /**
   * 重启接管里已在合并队列的单：按 2 的 PR 记录接回 9（adopt 要 PR id 和 head）。查不到未结束的 PR、
   * worktree 不在了都抛错（10 记进 TakeOverReport.failed），不派单、不开新 PR。
   */
  async function adopt(t: SchedulerTicket & { kind?: "dependency" }): Promise<void> {
    const rec = await currentTicketPr(store, t.ticket_id);
    if (!rec)
      throw new Error(`需求单 ${t.ticket_id} 在 2 里没有未结束的 PR 记录，不能直接接回合并队列`);
    if (!existsSync(rec.worktree_path))
      throw new Error(
        `需求单 ${t.ticket_id} 的 PR ${rec.pr_id} 的 worktree 不在了：${rec.worktree_path}`,
      );
    const { kind, ...ticket } = t;
    const m = /-r(\d+)$/.exec(rec.worktree_path);
    await scheduler.adopt(ticket, {
      pr_id: rec.pr_id,
      head_sha: rec.head_sha,
      worktree_path: rec.worktree_path,
      base_commit: rec.base_sha,
      ...(m ? { round: Number(m[1]) } : {}),
      ...((await judgeOnTakeover(rec.pr_id)) || kind === "dependency" ? { high_risk: true } : {}),
    });
  }

  /** N4 补判时取到的 diff 文件（pr_id → 文件，取不到为 null）：扣住时给 10 用，用完即删 */
  const takeoverDiff = new Map<string, DiffFile[] | null>();
  async function judgeOnTakeover(pr_id: string): Promise<boolean> {
    const j = await judgeHighRiskOnTakeover(pr, pr_id, (m, d) => logger.warn(m, d));
    takeoverDiff.set(pr_id, j.files);
    return j.high_risk;
  }

  /**
   * 9 扣住高风险单（T-041c）：补上 PR 链接（2 的 PR 记录）和 diff 文件再交给 10。diff 用 N4 补判时那份，
   * 没有就现取一次（取不到为 null，10 记 diff_unavailable）。10 的 `pendingHighRisk()` 只读这里给的内存数据。
   */
  async function highRiskHeld(info: HighRiskHeldInfo): Promise<void> {
    let diff_files: DiffFile[] | null;
    if (takeoverDiff.has(info.pr_id)) {
      diff_files = takeoverDiff.get(info.pr_id) ?? null;
      takeoverDiff.delete(info.pr_id);
    } else {
      try {
        diff_files = (await pr.diff(info.pr_id)).files;
      } catch (err) {
        logger.warn(`高风险单 ${info.ticket_id}：取 PR ${info.pr_id} 的 diff 失败`, err);
        diff_files = null;
      }
    }
    let pr_url: string | undefined;
    try {
      pr_url = (await store.get(info.pr_id))?.remote?.url;
    } catch (err) {
      logger.warn(`高风险单 ${info.ticket_id}：读 PR 记录 ${info.pr_id} 失败`, err);
    }
    await supervisor.highRiskHeld({ ...info, diff_files, ...(pr_url ? { pr_url } : {}) });
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
    // 高风险闸门（T-041c）：组合根固定打开，AppDeps 关不掉（Q-3）；默认关闭只适用于单独使用 9
    holdHighRisk: true,
    onHighRiskHeld: (info) =>
      void highRiskHeld(info).catch((err) => onError(err, `supervisor(${info.ticket_id})`)),
    onBackpressurePaused: (state) =>
      void supervisor.backpressurePaused(state).catch((err) => onError(err, "supervisor")),
  });

  ready = true;
  await scheduler.start();
  unsubs.push(() => scheduler.stop());
  unsubs.push(subAgent.attach({ subscribe: (type, handler) => bus.subscribe(type, handler) }));
  unsubs.push(supervisor.start());

  // 重启接管：9 已启动、8 / 10 已订阅之后再接回（已在合并队列里的单经 9 的 adopt，其余 enqueue）
  const takeOver = await supervisor.takeOver();
  if (takeOver.failed.length)
    logger.warn(
      `重启接管：${takeOver.failed.length} 张单没接回：${takeOver.failed.map((f) => `${f.ticket_id}（${f.error}）`).join("；")}`,
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
