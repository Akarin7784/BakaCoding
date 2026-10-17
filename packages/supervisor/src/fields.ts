// T-040：需求单结构化字段在 2 的 tickets.fields（T-055）里的存取格式。字段由 10 定义，2 只按 JSON 原样存。
import type { TicketFields } from "@bakacoding/storage";
import { ESCALATION_REASONS, TraceSchema } from "@bakacoding/types";
import { z } from "zod";
import type { SupervisorTicket } from "./types.js";

/** 读回时校验：库里的数据不一定是 10 写的（旧数据、手工改过、以后的版本），不合格式按「没有结构化字段」处理。 */
export const StoredFieldsSchema = z.object({
  write_scope: z.array(z.string().min(1)).min(1),
  interfaces: z.array(z.object({ file: z.string().min(1), symbol: z.string().min(1) }).strict()),
  depends_on: z.array(z.string().min(1)),
  priority: z.enum(["normal", "deferred"]),
  kind: z.literal("dependency").nullable(),
  origin: z.enum(["split", "manual", "test"]),
  trace: TraceSchema,
  /** T-041b：需求原文（截到 MAX_REQUIREMENT_TEXT 码点），重拆时作上下文。T-041b 之前的单没有 */
  requirement_text: z.string().optional(),
  /** T-041b：这张单是同一需求第几次重拆出来的（0 = 首次拆单），缺省按 0 */
  resplit: z.number().int().nonnegative().optional(),
  /** T-041b：重拆时取代的旧单号 */
  resplit_of: z.array(z.string().min(1)).optional(),
});
export type StoredFields = z.infer<typeof StoredFieldsSchema>;

/** 需求原文存进 fields 的上限（码点，T-041b）。包内常量，不导出到 index.ts。 */
export const MAX_REQUIREMENT_TEXT = 20000;

/** 按码点截断；返回截断后的文字和原长（码点）。 */
export function truncateRequirement(text: string): {
  text: string;
  length: number;
  truncated: boolean;
} {
  const cps = Array.from(text);
  if (cps.length <= MAX_REQUIREMENT_TEXT) return { text, length: cps.length, truncated: false };
  return { text: cps.slice(0, MAX_REQUIREMENT_TEXT).join(""), length: cps.length, truncated: true };
}

/**
 * 上报处理的标记（T-041b），和上面的结构化字段放在同一个 fields 里，但单独宽松解析：
 * 标记坏了只当没有标记，不连累结构化字段判 fields_invalid；结构化字段坏了也照样能读出标记。
 */
export const MarkersSchema = z.object({
  /** 上报已处理（Q10）：先于关 PR、重拆或交用户落库 */
  escalation_handled: z
    .object({
      action: z.enum(["resplit", "notify_user", "resplit_limit", "ignored"]),
      at: z.string(),
      reason: z.enum(ESCALATION_REASONS).optional(),
      /** 重拆中途失败（拆单不合法、模型出错等）的原因 */
      error: z.string().optional(),
    })
    .optional(),
  /** 重拆前关旧 PR 已完成（N1）：确认关掉、本来没有，或其实已合入 */
  pr_close_done: z
    .object({ at: z.string(), result: z.enum(["closed", "none", "merged"]) })
    .optional(),
  /**
   * 拒绝高风险 PR 时关 PR 的结果（T-041c，N5）：closed 已关；none 没有要关的 PR；merged 其实已合入（不拒绝，
   * 只在重试时可能写）；unconfirmed 关 PR 失败（如限流），本地 PR 记录不标关闭，进程内按 30 秒 / 2 分钟 / 10 分钟重试。
   */
  high_risk_close: z
    .object({
      at: z.string(),
      pr_id: z.string(),
      state: z.enum(["closed", "none", "merged", "unconfirmed"]),
      error: z.string().optional(),
    })
    .optional(),
  /**
   * 已合入、但 interface_changed / 合入后清理还没做完（T-112）：9 写 merged 之前由组合根写入，发完、排上清理后清掉。
   * takeOver 对带它的 merged 单调 `deps.recoverMergeFollowup` 补做。
   */
  merge_followup: z
    .object({ at: z.string(), pr_id: z.string().min(1), merge_sha: z.string().min(1) })
    .optional(),
});
export type Markers = z.infer<typeof MarkersSchema>;

export function readMarkers(fields: TicketFields | null): Markers {
  if (fields === null || typeof fields !== "object") return {};
  const out: Markers = {};
  const raw = fields as Record<string, unknown>;
  const h = MarkersSchema.shape.escalation_handled.safeParse(raw.escalation_handled);
  if (h.success && h.data) out.escalation_handled = h.data;
  const c = MarkersSchema.shape.pr_close_done.safeParse(raw.pr_close_done);
  if (c.success && c.data) out.pr_close_done = c.data;
  const hr = MarkersSchema.shape.high_risk_close.safeParse(raw.high_risk_close);
  if (hr.success && hr.data) out.high_risk_close = hr.data;
  const mf = MarkersSchema.shape.merge_followup.safeParse(raw.merge_followup);
  if (mf.success && mf.data) out.merge_followup = mf.data;
  return out;
}

/** 重拆相关字段（宽松读：结构化字段坏了也能读出 resplit / resplit_of）。 */
export function readResplit(fields: TicketFields | null): {
  resplit: number;
  resplit_of: string[];
} {
  if (fields === null || typeof fields !== "object") return { resplit: 0, resplit_of: [] };
  const raw = fields as Record<string, unknown>;
  const r = z.number().int().nonnegative().safeParse(raw.resplit);
  const o = z.array(z.string().min(1)).safeParse(raw.resplit_of);
  return { resplit: r.success ? r.data : 0, resplit_of: o.success ? o.data : [] };
}

export interface FieldsExtra {
  requirement_text?: string;
  resplit?: number;
  resplit_of?: string[];
}

export function encodeFields(t: SupervisorTicket, extra: FieldsExtra = {}): TicketFields {
  const f: StoredFields = {
    write_scope: [...t.write_scope],
    interfaces: t.interfaces.map((i) => ({ file: i.file, symbol: i.symbol })),
    depends_on: [...t.depends_on],
    priority: t.priority,
    kind: t.kind ?? null,
    origin: t.origin,
    trace: { trace_id: t.trace_id, span_id: t.span_id, parent_span_id: t.parent_span_id },
    ...(extra.requirement_text !== undefined ? { requirement_text: extra.requirement_text } : {}),
    ...(extra.resplit ? { resplit: extra.resplit } : {}),
    ...(extra.resplit_of?.length ? { resplit_of: [...extra.resplit_of] } : {}),
  };
  return f;
}

/** fields 为 null 或不合格式返回 undefined，并给出原因。 */
export function decodeFields(
  fields: TicketFields | null,
): { ok: true; fields: StoredFields } | { ok: false; reason: string } {
  if (fields === null)
    return { ok: false, reason: "没有结构化字段（fields 为 null：旧数据或库里损坏）" };
  const r = StoredFieldsSchema.safeParse(fields);
  if (r.success) return { ok: true, fields: r.data };
  const issue = r.error.issues[0];
  return {
    ok: false,
    reason: `结构化字段不合格式（${issue ? `${issue.path.join(".")}: ${issue.message}` : "未知错误"}）`,
  };
}
