import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { z } from "zod";
import type { TokensSchema } from "@bakacoding/types";
import { ConfigError } from "./config.js";
import { errnoCode, jsonErrorText, schemaIssues } from "./safe-error.js";

type Tokens = z.infer<typeof TokensSchema>;

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

/**
 * 读取并校验价格表。T-099：失败抛 ConfigError，错误不含文件内容、配置原值和完整路径
 * （读不到只报文件名和错误码，JSON 坏只报行列号，校验错误同 validate）。
 */
export function loadPricing(path: string): Pricing {
  const file = basename(path);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new ConfigError([`无法读取价格表 ${file}（${errnoCode(e)}）`]);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError([jsonErrorText(text, e, `价格表 ${file} `)]);
  }
  const r = PricingSchema.safeParse(raw);
  if (!r.success) throw new ConfigError(schemaIssues(r.error.issues).map((m) => `${file} ${m}`));
  return r.data;
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

export interface CallCost {
  /** 整数微美元，向上取整（宁可多算）。 */
  cost_micro_usd: number;
  offpeak: boolean;
}

/**
 * 单次调用的费用：缓存命中输入、未命中输入、输出分别按单价计，按调用时刻选高峰或闲时价。
 * 单价是每 1M token 的微美元价，结果向上取整到 1 微美元。模型不在价目表里直接报错。
 */
export function computeCost(pricing: Pricing, model: string, tokens: Tokens, at: Date): CallCost {
  const m = pricing.models[model];
  if (!m) throw new RangeError(`pricing.json 里没有模型 ${model} 的单价`);
  if (tokens.cache_hit_input > tokens.input)
    throw new RangeError(
      `cache_hit_input（${tokens.cache_hit_input}）不能大于 input（${tokens.input}）`,
    );
  const offpeak = isOffpeak(at, pricing);
  const r = offpeak ? m.offpeak : m.peak;
  const scaled =
    tokens.cache_hit_input * r.input_cache_hit +
    (tokens.input - tokens.cache_hit_input) * r.input_cache_miss +
    tokens.output * r.output;
  return { cost_micro_usd: Math.ceil(scaled / 1_000_000), offpeak };
}
