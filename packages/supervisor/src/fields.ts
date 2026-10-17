// T-040：需求单结构化字段在 2 的 tickets.fields（T-055）里的存取格式。字段由 10 定义，2 只按 JSON 原样存。
import type { TicketFields } from "@bakacoding/storage";
import { TraceSchema } from "@bakacoding/types";
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
});
export type StoredFields = z.infer<typeof StoredFieldsSchema>;

export function encodeFields(t: SupervisorTicket): TicketFields {
  const f: StoredFields = {
    write_scope: [...t.write_scope],
    interfaces: t.interfaces.map((i) => ({ file: i.file, symbol: i.symbol })),
    depends_on: [...t.depends_on],
    priority: t.priority,
    kind: t.kind ?? null,
    origin: t.origin,
    trace: { trace_id: t.trace_id, span_id: t.span_id, parent_span_id: t.parent_span_id },
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
