// 模块 3：预算台账（T-006）。台账经注入的 LedgerStore 落库，本模块不依赖存储模块。
import {
  LedgerEntrySchema,
  type EventOf,
  type LedgerEntry,
  type LedgerStore,
  type Role,
} from "@bakacoding/types";
import type { Config } from "./config.js";
import { isOffpeak, type Pricing } from "./pricing.js";

export interface TicketBudgetState {
  ticket_id: string;
  /** 这张单累计花费（含复投，不分日期）。 */
  spent_micro_usd: number;
  resubmit_micro_usd: number;
  remaining_micro_usd: number;
  /** 进行中的调用预占的金额（还没记进台账）。 */
  reserved_micro_usd: number;
  /** 已花 >= 每单上限。 */
  exhausted: boolean;
  by_role: Record<Role, number>;
}

export interface BudgetState {
  /** 当前 UTC 日期 YYYY-MM-DD，每日预算按它汇总。 */
  day: string;
  daily_limit_micro_usd: number;
  spent_today_micro_usd: number;
  resubmit_today_micro_usd: number;
  remaining_today_micro_usd: number;
  /** 当日进行中的调用预占的金额（还没记进台账）。 */
  reserved_today_micro_usd: number;
  /** 当日已花 >= 每日预算。 */
  daily_exhausted: boolean;
  /** 每单上限 = 每日预算 × per_ticket_ratio，向下取整。 */
  per_ticket_limit_micro_usd: number;
  by_role_today: Record<Role, number>;
  offpeak_now: boolean;
  offpeak_preference: boolean;
  /** 传了 ticket_id 才有。 */
  ticket?: TicketBudgetState;
}

export interface BudgetFailure {
  event_id: string;
  error: Error;
}

/** 只需要 subscribe，避免依赖事件总线包。 */
export interface BudgetBusLike {
  subscribe(
    type: "call_completed",
    handler: (e: EventOf<"call_completed">) => void | Promise<void>,
  ): () => void;
}

export interface ReserveRequest {
  /** 没有单号的调用（如主管）传 null，只占每日预算。 */
  ticket_id: string | null;
  /** 预占金额，整数微美元（模块 1 按「输入估算 + max_tokens」算）。 */
  amount_micro_usd: number;
}

export type ReserveResult =
  | {
      ok: true;
      /** 释放预占。调用方在 call_completed 记进台账之后调；重复调只释放一次。 */
      release(): Promise<void>;
    }
  | { ok: false; scope: "daily" | "ticket" };

export interface Budget {
  /** 手工记一笔；同一 entry_id 重复记只算一次（由 LedgerStore 保证）。 */
  recordCost(entry: LedgerEntry): Promise<void>;
  budgetState(ticket_id?: string): Promise<BudgetState>;
  /**
   * 调用前预占：已花 + 其他调用的预占 >= 上限（每日或每单）时拒绝，否则记下这笔预占。
   * 预占和释放串行执行：释放发生在台账写入之后，所以任何一次判断要么看到预占，要么看到台账里的实际花费。
   * 预占只在本进程内存里，重启即清空。
   */
  reserve(req: ReserveRequest): Promise<ReserveResult>;
  /** 订阅 call_completed 记台账：entry_id 取 event_id，闲时按事件 ts 判断。返回取消订阅。 */
  attach(bus: BudgetBusLike, options?: { onError?: (f: BudgetFailure) => void }): () => void;
}

export interface CreateBudgetOptions {
  budget: Config["budget"];
  pricing: Pricing;
  ledger: LedgerStore;
  now?: () => Date;
}

export function entryFromCallCompleted(
  e: EventOf<"call_completed">,
  pricing: Pricing,
): LedgerEntry {
  return {
    entry_id: e.event_id,
    ts: e.ts,
    requirement_id: e.requirement_id,
    ticket_id: e.ticket_id,
    role: e.payload.role,
    cost_micro_usd: e.payload.cost,
    is_resubmit: e.payload.is_resubmit,
    cache_hit: e.payload.cache_hit,
    offpeak: isOffpeak(new Date(e.ts), pricing),
  };
}

/**
 * 每单上限 = 每日预算 × 比例，向下取整。先把比例换成整数 ppm（百万分之一）再算，
 * 避免浮点误差（5_000_000 × 0.41 直接乘会得到 2_049_999）。
 */
export function perTicketLimit(daily_micro_usd: number, ratio: number): number {
  const ppm = Math.round(ratio * 1_000_000);
  return Math.floor((daily_micro_usd * ppm) / 1_000_000);
}

export function createBudget(opts: CreateBudgetOptions): Budget {
  const { budget, pricing, ledger } = opts;
  const now = opts.now ?? (() => new Date());
  const daily = budget.daily_micro_usd;
  const perTicket = perTicketLimit(daily, budget.per_ticket_ratio);

  const holds = new Map<number, { day: string; ticket_id: string | null; amount: number }>();
  let nextHold = 0;
  let lock: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => T | Promise<T>): Promise<T> => {
    const p = lock.then(fn);
    lock = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  };
  const reservedDay = (day: string) => {
    let n = 0;
    for (const h of holds.values()) if (h.day === day) n += h.amount;
    return n;
  };
  const reservedTicket = (ticket_id: string) => {
    let n = 0;
    for (const h of holds.values()) if (h.ticket_id === ticket_id) n += h.amount;
    return n;
  };

  const recordCost = async (entry: LedgerEntry) => {
    await ledger.append(LedgerEntrySchema.parse(entry));
  };

  return {
    recordCost,
    async budgetState(ticket_id) {
      const t = now();
      const day = t.toISOString().slice(0, 10);
      const today = await ledger.totalsByDay(day);
      const state: BudgetState = {
        day,
        daily_limit_micro_usd: daily,
        spent_today_micro_usd: today.total_micro_usd,
        resubmit_today_micro_usd: today.resubmit_micro_usd,
        remaining_today_micro_usd: Math.max(0, daily - today.total_micro_usd),
        reserved_today_micro_usd: reservedDay(day),
        daily_exhausted: today.total_micro_usd >= daily,
        per_ticket_limit_micro_usd: perTicket,
        by_role_today: today.by_role,
        offpeak_now: isOffpeak(t, pricing),
        offpeak_preference: budget.offpeak_preference,
      };
      if (ticket_id !== undefined) {
        const tk = await ledger.totalsByTicket(ticket_id);
        state.ticket = {
          ticket_id,
          spent_micro_usd: tk.total_micro_usd,
          resubmit_micro_usd: tk.resubmit_micro_usd,
          remaining_micro_usd: Math.max(0, perTicket - tk.total_micro_usd),
          reserved_micro_usd: reservedTicket(ticket_id),
          exhausted: tk.total_micro_usd >= perTicket,
          by_role: tk.by_role,
        };
      }
      return state;
    },
    reserve(req) {
      if (!Number.isSafeInteger(req.amount_micro_usd) || req.amount_micro_usd < 0)
        return Promise.reject(new RangeError("amount_micro_usd 必须是非负整数"));
      return serial(async (): Promise<ReserveResult> => {
        const day = now().toISOString().slice(0, 10);
        const today = await ledger.totalsByDay(day);
        if (today.total_micro_usd + reservedDay(day) >= daily) return { ok: false, scope: "daily" };
        if (req.ticket_id !== null) {
          const tk = await ledger.totalsByTicket(req.ticket_id);
          if (tk.total_micro_usd + reservedTicket(req.ticket_id) >= perTicket)
            return { ok: false, scope: "ticket" };
        }
        const id = nextHold++;
        holds.set(id, { day, ticket_id: req.ticket_id, amount: req.amount_micro_usd });
        return { ok: true, release: () => serial(() => void holds.delete(id)) };
      });
    },
    attach(bus, options = {}) {
      const onError =
        options.onError ??
        ((f: BudgetFailure) => console.error(`[budget] 记台账失败 ${f.event_id}`, f.error));
      return bus.subscribe("call_completed", async (e) => {
        try {
          await recordCost(entryFromCallCompleted(e, pricing));
        } catch (err) {
          onError({
            event_id: e.event_id,
            error: err instanceof Error ? err : new Error(String(err)),
          });
        }
      });
    },
  };
}
