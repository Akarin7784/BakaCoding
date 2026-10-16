import { readFileSync } from "node:fs";
import { z } from "zod";

const MicroUsd = z.number().int().nonnegative();
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const IsoUtc = z.string().datetime({ offset: false });

const RateSchema = z
  .object({
    input_cache_hit: MicroUsd,
    input_cache_miss: MicroUsd,
    output: MicroUsd,
  })
  .strict()
  .describe("每 1M token 的价格，单位微美元（1 USD = 1_000_000）");

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export const PricingSchema = z
  .object({
    $schema_version: z.literal("bakacoding.pricing.v1"),
    currency: z.literal("USD"),
    unit: z.literal("micro_usd_per_1m_tokens"),
    source: z
      .object({
        url: z.string().url(),
        accessed_at: IsoUtc,
        quote: z.string().min(1),
        note: z.string().min(1).optional(),
      })
      .strict(),
    models: z.record(z.object({ peak: RateSchema, offpeak: RateSchema }).strict()),
    peak_hours_utc: z.array(z.tuple([HHMM, HHMM])).min(1),
    peak_weekdays: z.array(z.enum(WEEKDAYS)),
    cn_public_holidays: z
      .array(
        z
          .object({
            year: z.number().int(),
            source: z
              .object({ title: z.string().min(1), url: z.string().url(), accessed_at: IsoUtc })
              .strict(),
            dates: z.array(IsoDate).describe("北京时间日期"),
          })
          .strict(),
      )
      .describe("按年份列出的中国法定节假日（含调休放假日），以北京时间日期计"),
  })
  .strict();
export type Pricing = z.infer<typeof PricingSchema>;

export function loadPricing(path: string): Pricing {
  return PricingSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

const BEIJING_OFFSET_MS = 8 * 3600_000;

/**
 * 是否处于 DeepSeek 闲时。
 * - 星期与节假日按北京时间日期判断；周末、节假日全天闲时。
 * - 工作日内 UTC 时刻落在 peak_hours_utc（左闭右开）为高峰。
 * - 某年没有节假日数据时不做节假日豁免，按高峰规则计（宁可多算钱）。
 */
export function isOffpeak(date: Date, pricing: Pricing): boolean {
  const bj = new Date(date.getTime() + BEIJING_OFFSET_MS);
  const bjDate = bj.toISOString().slice(0, 10);
  const weekday = WEEKDAYS[bj.getUTCDay()]!;
  if (!pricing.peak_weekdays.includes(weekday)) return true;
  const year = pricing.cn_public_holidays.find((h) => h.year === bj.getUTCFullYear());
  if (year?.dates.includes(bjDate)) return true;
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  return !pricing.peak_hours_utc.some(([a, b]) => minutes >= toMin(a) && minutes < toMin(b));
}
