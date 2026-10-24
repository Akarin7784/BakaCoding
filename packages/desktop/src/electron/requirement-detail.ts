// UI-05a：`requirement:detail` 的主进程侧——只读模块 2 的 listTickets({requirement_id}) 和 listPrRounds，
// 字段按白名单挑（不下发整个 fields），所有文本过 sanitizeChatReason（内含 11 的路径脱敏）；
// 不返回评审上限（界面复用 settings:config-get）。错误只给固定文案，不带路径、不带用户输入。
import type { Storage } from "@bakacoding/storage";
import type {
  DesktopRequirementDetailResult,
  DesktopRequirementRound,
  DesktopRequirementTicket,
} from "../shared/api.js";
import { ticketTitle } from "./reader.js";
import { CHAT_TEXT_MAX, sanitizeChatReason } from "./supervisor-chat.js";

export const REQUIREMENT_DETAIL_UNAVAILABLE = "需求详情暂不可用（后端只读或未接线）";
export const REQUIREMENT_DETAIL_INVALID = "需求编号不合法";
export const REQUIREMENT_DETAIL_NOT_FOUND = "找不到这个需求";
export const REQUIREMENT_DETAIL_FAILED = "读取需求详情失败";
/** requirement_id 的长度上限（超了按不合法处理，不查库）。 */
const REQUIREMENT_ID_MAX = 200;

export type RequirementDetailStorage = Pick<Storage, "listTickets" | "listPrRounds">;

/** 只接受 `{ requirement_id: 非空字符串 }`，其余字段丢掉。 */
export function toRequirementId(query: unknown): string | null {
  if (typeof query !== "object" || query === null) return null;
  const id = (query as { requirement_id?: unknown }).requirement_id;
  if (typeof id !== "string" || id.trim() === "" || id.length > REQUIREMENT_ID_MAX) return null;
  return id;
}

export function readRequirementDetail(
  storage: RequirementDetailStorage | undefined,
  query: unknown,
  env: Readonly<Record<string, string | undefined>>,
): DesktopRequirementDetailResult {
  if (!storage) return { ok: false, reason: REQUIREMENT_DETAIL_UNAVAILABLE };
  const requirement_id = toRequirementId(query);
  if (requirement_id === null) return { ok: false, reason: REQUIREMENT_DETAIL_INVALID };
  // 需求原文最长 20000 码点（10 落库时已截），这里按同一上限截，不用 2000 的错误原因上限
  const clean = (s: string) => sanitizeChatReason(s, env, {}, CHAT_TEXT_MAX);
  try {
    const rows = storage.listTickets({ requirement_id });
    if (rows.length === 0) return { ok: false, reason: REQUIREMENT_DETAIL_NOT_FOUND };
    const textOf = rows
      .map((t) => t.fields?.requirement_text)
      .find((v): v is string => typeof v === "string");
    const summary = rows.map((t) => t.decomposition_summary).find((v) => typeof v === "string");
    const tickets: DesktopRequirementTicket[] = rows.map((t) => ({
      ticket_id: t.ticket_id,
      status: t.status ?? "pending",
      rounds: storage.listPrRounds(t.ticket_id).map((r): DesktopRequirementRound => ({
        round: r.round,
        verdict: r.verdict,
        fail_reasons: r.fail_reasons.map(clean),
        review_comments: typeof r.review_comments === "string" ? clean(r.review_comments) : null,
        reviewer: typeof r.reviewer === "string" ? clean(r.reviewer) : null,
      })),
    }));
    return {
      ok: true,
      detail: {
        requirement_id,
        // 先脱敏再截，截完一定不超过 80 字
        name: ticketTitle(clean(rows[0]!.ticket_text)),
        requirement_text: textOf === undefined ? null : clean(textOf),
        decomposition_summary: summary === undefined ? null : clean(summary),
        tickets,
      },
    };
  } catch {
    return { ok: false, reason: REQUIREMENT_DETAIL_FAILED };
  }
}
