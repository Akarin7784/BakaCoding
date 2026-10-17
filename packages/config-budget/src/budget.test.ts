import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ROLES,
  type EventOf,
  type LedgerEntry,
  type LedgerStore,
  type LedgerBreakdown,
} from "@bakacoding/types";
import { createBudget, perTicketLimit, type BudgetBusLike } from "./budget.js";
import { computeCost, loadPricing } from "./pricing.js";

const pricing = loadPricing(
  fileURLToPath(new URL("../../../config/pricing.json", import.meta.url)),
);

/** 内存版 LedgerStore：按 entry_id 幂等，按 UTC 日期汇总。 */
function memLedger(): LedgerStore & { entries: LedgerEntry[] } {
  const entries: LedgerEntry[] = [];
  const sum = (xs: LedgerEntry[]): LedgerBreakdown => {
    const by_role = Object.fromEntries(ROLES.map((r) => [r, 0])) as LedgerBreakdown["by_role"];
    for (const x of xs) by_role[x.role] += x.cost_micro_usd;
    return {
      total_micro_usd: xs.reduce((a, x) => a + x.cost_micro_usd, 0),
      resubmit_micro_usd: xs.filter((x) => x.is_resubmit).reduce((a, x) => a + x.cost_micro_usd, 0),
      entries: xs.length,
      by_role,
    };
  };
  return {
    entries,
    async append(e) {
      if (!entries.some((x) => x.entry_id === e.entry_id)) entries.push(e);
    },
    async totalsByDay(day) {
      return sum(entries.filter((x) => x.ts.slice(0, 10) === day));
    },
    async totalsByTicket(id) {
      return sum(entries.filter((x) => x.ticket_id === id));
    },
  };
}

const budgetCfg = { daily_micro_usd: 1_000_000, per_ticket_ratio: 0.05, offpeak_preference: false };
const entry = (over: Partial<LedgerEntry>): LedgerEntry => ({
  entry_id: "e",
  ts: "2026-10-17T05:00:00.000Z",
  requirement_id: "R-1",
  ticket_id: "T-1",
  role: "coder",
  cost_micro_usd: 100,
  is_resubmit: false,
  cache_hit: false,
  offpeak: false,
  ...over,
});

describe("computeCost", () => {
  // 2026-10-19 周一 02:00 UTC 是高峰；2026-10-17 周六全天闲时
  const peak = new Date("2026-10-19T02:00:00Z");
  const off = new Date("2026-10-17T02:00:00Z");
  const tokens = { input: 1_000_000, cache_hit_input: 400_000, output: 100_000 };

  it("命中、未命中、输出分开计价，高峰价", () => {
    // 0.4M×6000 + 0.6M×300000 + 0.1M×1200000 = 2400 + 180000 + 120000
    expect(computeCost(pricing, "deepseek-flash", tokens, peak)).toEqual({
      cost_micro_usd: 302_400,
      offpeak: false,
    });
  });

  it("闲时价是高峰的一半", () => {
    expect(computeCost(pricing, "deepseek-flash", tokens, off)).toEqual({
      cost_micro_usd: 151_200,
      offpeak: true,
    });
  });

  it("不足 1 微美元向上取整", () => {
    expect(
      computeCost(pricing, "deepseek-flash", { input: 1, cache_hit_input: 1, output: 0 }, peak)
        .cost_micro_usd,
    ).toBe(1);
    expect(
      computeCost(pricing, "deepseek-flash", { input: 0, cache_hit_input: 0, output: 0 }, peak)
        .cost_micro_usd,
    ).toBe(0);
  });

  it("未知模型或命中数大于输入时报错", () => {
    expect(() => computeCost(pricing, "nope", tokens, peak)).toThrow(/nope/);
    expect(() =>
      computeCost(pricing, "deepseek-flash", { input: 1, cache_hit_input: 2, output: 0 }, peak),
    ).toThrow(RangeError);
  });
});

describe("perTicketLimit", () => {
  it("比例先换成整数 ppm，没有浮点误差", () => {
    expect(Math.floor(5_000_000 * 0.41)).toBe(2_049_999);
    expect(perTicketLimit(5_000_000, 0.41)).toBe(2_050_000);
    expect(perTicketLimit(100, 0.29)).toBe(29);
    expect(perTicketLimit(1_000_000, 0.05)).toBe(50_000);
    expect(perTicketLimit(3, 0.5)).toBe(1);
  });
});

describe("budgetState / recordCost", () => {
  it("按 UTC 日期汇总当日花费，复投单列，按角色分列", async () => {
    const ledger = memLedger();
    const b = createBudget({
      budget: budgetCfg,
      pricing,
      ledger,
      now: () => new Date("2026-10-17T12:00:00Z"),
    });
    await b.recordCost(entry({ entry_id: "a", cost_micro_usd: 300 }));
    await b.recordCost(entry({ entry_id: "b", cost_micro_usd: 200, is_resubmit: true }));
    await b.recordCost(entry({ entry_id: "c", cost_micro_usd: 50, role: "sub_agent" }));
    await b.recordCost(
      entry({ entry_id: "d", cost_micro_usd: 70, role: "reviewer", ticket_id: "T-2" }),
    );
    await b.recordCost(
      entry({ entry_id: "e", ts: "2026-10-16T23:59:59.000Z", cost_micro_usd: 999 }),
    );
    await b.recordCost(entry({ entry_id: "a", cost_micro_usd: 300 }));
    const s = await b.budgetState("T-1");
    expect(s).toMatchObject({
      day: "2026-10-17",
      daily_limit_micro_usd: 1_000_000,
      spent_today_micro_usd: 620,
      resubmit_today_micro_usd: 200,
      remaining_today_micro_usd: 999_380,
      daily_exhausted: false,
      per_ticket_limit_micro_usd: 50_000,
      by_role_today: { coder: 500, sub_agent: 50, reviewer: 70, supervisor: 0 },
      offpeak_now: true,
      offpeak_preference: false,
    });
    expect(s.ticket).toEqual({
      ticket_id: "T-1",
      spent_micro_usd: 1549,
      resubmit_micro_usd: 200,
      remaining_micro_usd: 48_451,
      exhausted: false,
      by_role: { coder: 1499, sub_agent: 50, reviewer: 0, supervisor: 0 },
    });
    expect((await b.budgetState()).ticket).toBeUndefined();
  });

  it("达到上限即 exhausted，剩余不为负", async () => {
    const ledger = memLedger();
    const b = createBudget({
      budget: { ...budgetCfg, daily_micro_usd: 1000, per_ticket_ratio: 0.1 },
      pricing,
      ledger,
      now: () => new Date("2026-10-19T02:00:00Z"),
    });
    await b.recordCost(
      entry({ entry_id: "x", ts: "2026-10-19T01:00:00.000Z", cost_micro_usd: 100 }),
    );
    let s = await b.budgetState("T-1");
    expect(s.offpeak_now).toBe(false);
    expect(s.ticket).toMatchObject({ exhausted: true, remaining_micro_usd: 0 });
    expect(s.daily_exhausted).toBe(false);
    await b.recordCost(
      entry({
        entry_id: "y",
        ts: "2026-10-19T01:30:00.000Z",
        cost_micro_usd: 950,
        ticket_id: null,
      }),
    );
    s = await b.budgetState();
    expect(s).toMatchObject({ daily_exhausted: true, remaining_today_micro_usd: 0 });
  });

  it("非法条目直接拒绝", async () => {
    const b = createBudget({ budget: budgetCfg, pricing, ledger: memLedger() });
    await expect(b.recordCost(entry({ cost_micro_usd: 1.5 }))).rejects.toThrow();
  });
});

describe("attach：从 call_completed 记台账", () => {
  function fakeBus() {
    let h: ((e: EventOf<"call_completed">) => void | Promise<void>) | undefined;
    const bus: BudgetBusLike = {
      subscribe(_t, handler) {
        h = handler;
        return () => (h = undefined);
      },
    };
    return {
      bus,
      emit: (e: EventOf<"call_completed">) => h?.(e),
      get active() {
        return !!h;
      },
    };
  }
  const call = (over: Partial<EventOf<"call_completed">> = {}): EventOf<"call_completed"> =>
    ({
      event_id: "ev-1",
      seq: 0,
      type: "call_completed",
      ts: "2026-10-19T02:00:00.000Z",
      trace_id: "tr",
      span_id: "sp",
      parent_span_id: null,
      requirement_id: "R-1",
      ticket_id: "T-1",
      project_id: null,
      payload: {
        role: "reviewer",
        provider: "deepseek",
        model: "deepseek-flash",
        effort: "high",
        prompt: "",
        output: "",
        tokens: { input: 10, output: 1, cache_hit_input: 10 },
        cache_hit: true,
        latency_ms: 5,
        cost: 42,
        is_resubmit: true,
        rate_limited_retry: 0,
      },
      ...over,
    }) as EventOf<"call_completed">;

  it("entry_id 取 event_id，重放不重复记；闲时按事件 ts 算", async () => {
    const ledger = memLedger();
    const b = createBudget({ budget: budgetCfg, pricing, ledger });
    const f = fakeBus();
    const off = b.attach(f.bus);
    await f.emit(call());
    await f.emit(call());
    await f.emit(call({ event_id: "ev-2", ts: "2026-10-17T02:00:00.000Z" }));
    expect(ledger.entries).toEqual([
      {
        entry_id: "ev-1",
        ts: "2026-10-19T02:00:00.000Z",
        requirement_id: "R-1",
        ticket_id: "T-1",
        role: "reviewer",
        cost_micro_usd: 42,
        is_resubmit: true,
        cache_hit: true,
        offpeak: false,
      },
      expect.objectContaining({ entry_id: "ev-2", offpeak: true }),
    ]);
    off();
    expect(f.active).toBe(false);
  });

  it("落库失败交给 onError，不抛给总线", async () => {
    const ledger = memLedger();
    ledger.append = async () => {
      throw new Error("disk full");
    };
    const errors: string[] = [];
    const b = createBudget({ budget: budgetCfg, pricing, ledger });
    const f = fakeBus();
    b.attach(f.bus, { onError: (x) => errors.push(`${x.event_id}:${x.error.message}`) });
    await expect(f.emit(call())).resolves.toBeUndefined();
    expect(errors).toEqual(["ev-1:disk full"]);
  });
});
