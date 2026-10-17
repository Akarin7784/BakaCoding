// T-062：警告列表去重、截断、可见条数上限。
import type { TicketWarningView } from "../mock/types.js";

/** 列表最多直接显示的条数，其余用「+N 条」。 */
export const WARNINGS_VISIBLE_MAX = 50;
/** detail 预览截断长度。 */
export const WARNING_DETAIL_PREVIEW = 500;
/** 悬停完整文案上限。 */
export const WARNING_DETAIL_TITLE_MAX = 4000;

export interface DedupedWarning extends TicketWarningView {
  /** 同一 ticket_id + code 出现次数（至少 1）。 */
  count: number;
}

/** 按 ticket_id + code 去重，保留首次出现的顺序与文案，累加 count。 */
export function dedupeWarnings(warnings: readonly TicketWarningView[]): DedupedWarning[] {
  const map = new Map<string, DedupedWarning>();
  const order: string[] = [];
  for (const w of warnings) {
    const key = `${w.ticket_id}\0${w.code}`;
    const prev = map.get(key);
    if (prev) {
      prev.count += 1;
    } else {
      map.set(key, { ...w, count: 1 });
      order.push(key);
    }
  }
  return order.map((k) => map.get(k)!);
}

export function truncateDetail(
  detail: string,
  preview = WARNING_DETAIL_PREVIEW,
  titleMax = WARNING_DETAIL_TITLE_MAX,
): { preview: string; title: string; truncated: boolean } {
  const title = detail.length > titleMax ? detail.slice(0, titleMax) : detail;
  if (detail.length <= preview) return { preview: detail, title, truncated: false };
  return { preview: `${detail.slice(0, preview)}…`, title, truncated: true };
}

/** 可见前 N 条 + 剩余条数（按去重后的列表计）。 */
export function sliceWarningsForDisplay(
  warnings: readonly TicketWarningView[],
  max = WARNINGS_VISIBLE_MAX,
): { visible: DedupedWarning[]; more: number } {
  const deduped = dedupeWarnings(warnings);
  if (deduped.length <= max) return { visible: deduped, more: 0 };
  return { visible: deduped.slice(0, max), more: deduped.length - max };
}
