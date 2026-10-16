import { z } from "zod";
import { IsoUtcSchema, MicroUsdSchema, RoleSchema } from "./common.js";

export const LedgerEntrySchema = z.object({
  /** 幂等键：重复 append 同一 entry_id 不重复计费（通常取 call_completed 的 event_id）。 */
  entry_id: z.string().min(1),
  ts: IsoUtcSchema,
  requirement_id: z.string().min(1),
  ticket_id: z.string().min(1).nullable(),
  role: RoleSchema,
  cost_micro_usd: MicroUsdSchema,
  is_resubmit: z.boolean(),
  cache_hit: z.boolean(),
  offpeak: z.boolean(),
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

export interface LedgerTotals {
  total_micro_usd: number;
  resubmit_micro_usd: number;
  entries: number;
}

/** 台账存储：模块 2 实现，注入模块 3（3 不直接依赖 2）。 */
export interface LedgerStore {
  append(entry: LedgerEntry): Promise<void>;
  /** day 为 UTC 日期 YYYY-MM-DD。 */
  totalsByDay(day: string): Promise<LedgerTotals>;
  totalsByTicket(ticket_id: string): Promise<LedgerTotals>;
}
