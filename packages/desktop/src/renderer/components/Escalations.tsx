import { TriangleAlert } from "lucide-react";
import type { EscalationView, TicketWarningView } from "../mock/types";
import { sliceWarningsForDisplay, truncateDetail, type DedupedWarning } from "../lib/warnings";

export const ESCALATION_REASON: Record<EscalationView["reason"], string> = {
  review_limit: "评审复投超限",
  conflict_limit: "冲突复投超限",
  scope_lock_failed: "写入范围锁定失败",
  resplit_limit: "重新拆单超限",
  github_manual: "需人工处理 GitHub",
  coder_failed: "编码多次未完成",
  budget_exceeded: "本单预算用完",
  internal_error: "内部错误",
  merged_but: "合并后续步骤失败",
  high_risk_rejected: "用户拒绝了高风险 PR",
};

/** 合并队列给不认识的 PR 上报时，requirement_id 填 `unattributed:<pr_id>`（T-035）。 */
export const UNATTRIBUTED_PREFIX = "unattributed:";

/** 上报指向谁：不认识的 PR 显示 PR 号，否则显示单号，没有单号显示需求号。 */
export function escalationTarget(e: EscalationView): string {
  if (e.requirement_id.startsWith(UNATTRIBUTED_PREFIX)) {
    return `PR ${e.requirement_id.slice(UNATTRIBUTED_PREFIX.length)}`;
  }
  return e.ticket_id ?? e.requirement_id;
}

/**
 * 已合入集成分支、之后的收尾出错：T-038 起 reason 是 `merged_but`；
 * 更早的版本（T-035）只在 detail 里写 `merged_but: …`，旧库里的事件照样认（T-050）。
 */
export function isMergedBut(e: EscalationView): boolean {
  return e.reason === "merged_but" || (e.detail?.trimStart().startsWith("merged_but") ?? false);
}

/**
 * ticket_warning 的中文文案（T-050 / T-062）。故意不按 TICKET_WARNING_CODES 穷举：
 * 模块 10 加了新代码而这里还没配文案时，显示代码本身，桌面的类型检查也不会挂。
 */
export const TICKET_WARNING_LABEL: Readonly<Record<string, string>> = {
  write_scope_defaulted: "没给写入范围，按整个仓库可写处理",
  fields_invalid: "单子的结构化字段缺失或损坏，不能续跑",
  requirement_truncated: "需求原文过长，已截断",
  pr_close_failed: "关闭旧 PR 失败，稍后重试",
  high_risk_reject_not_applied: "PR 已关但裁决未生效，新 PR 仍在等你裁决",
  takeover_skipped: "重启接管时跳过了这张单",
};

export function ticketWarningLabel(code: string): string {
  return Object.hasOwn(TICKET_WARNING_LABEL, code) ? TICKET_WARNING_LABEL[code]! : code;
}

export function TicketWarningItem({ w }: { w: DedupedWarning | TicketWarningView }) {
  const count = "count" in w ? w.count : 1;
  const detailInfo = w.detail ? truncateDetail(w.detail) : null;
  return (
    <li data-testid="ticket-warning" className="flex items-start gap-1">
      <TriangleAlert size={14} strokeWidth={1.5} className="mt-0.5 shrink-0" aria-hidden />
      <span>
        {w.ticket_id} · {ticketWarningLabel(w.code)}
        {count > 1 ? `（×${count}）` : ""}
        {detailInfo ? (
          <>
            ：
            <span title={detailInfo.title} data-testid="ticket-warning-detail">
              {detailInfo.preview}
            </span>
          </>
        ) : null}
      </span>
    </li>
  );
}

/** 需求单提示列表：比「需要人工介入」弱一级，用灰字，不抢眼。T-062：去重、截断、最多约 50 条。 */
export function TicketWarningList({ warnings }: { warnings: TicketWarningView[] }) {
  if (warnings.length === 0) return null;
  const { visible, more } = sliceWarningsForDisplay(warnings);
  return (
    <ul
      role="status"
      aria-label="需求单提示"
      className="space-y-1 border-b border-border px-4 py-2 text-xs text-muted-foreground"
      data-testid="ticket-warning-list"
    >
      {visible.map((w) => (
        <TicketWarningItem key={`${w.ticket_id}:${w.code}:${w.event_id}`} w={w} />
      ))}
      {more > 0 && (
        <li data-testid="ticket-warning-more" className="pl-5 text-muted-foreground">
          +{more} 条
        </li>
      )}
    </ul>
  );
}

export function EscalationItem({ e }: { e: EscalationView }) {
  return (
    <li data-testid="escalation">
      需要人工介入 · {escalationTarget(e)} · {ESCALATION_REASON[e.reason]}
      {isMergedBut(e) ? "（代码已进集成分支）" : ""}
      {e.detail ? `：${e.detail}` : ""}
    </li>
  );
}

/** 未归属：找不到所属项目的上报，单独列出，不丢。 */
export function UnattributedPanel({
  escalations,
  warnings = [],
  readonly = false,
}: {
  escalations: EscalationView[];
  /** 找不到所属项目的 ticket_warning（T-050）。 */
  warnings?: TicketWarningView[];
  /** 后端只读时显示「只读」标签（T-077） */
  readonly?: boolean;
}) {
  return (
    <section aria-label="未归属" className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2">
        <span className="flex-1 text-sm font-medium">未归属</span>
        {readonly && (
          <span className="text-xs text-muted-foreground" data-testid="readonly-tag">
            只读
          </span>
        )}
      </header>
      <p className="px-4 pt-2 text-xs text-muted-foreground">
        这些上报找不到所属项目（比如集成 PR、重启后不认识的 PR），在这里集中显示。
      </p>
      <TicketWarningList warnings={warnings} />
      {escalations.length === 0 ? (
        warnings.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">没有未归属的上报</p>
        )
      ) : (
        <ul
          role="alert"
          aria-label="需要人工介入"
          className="space-y-1 overflow-y-auto px-4 py-2 text-sm"
        >
          {escalations.map((e) => (
            <EscalationItem key={e.event_id} e={e} />
          ))}
        </ul>
      )}
    </section>
  );
}
