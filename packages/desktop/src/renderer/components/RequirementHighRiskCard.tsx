// UI-05d：需求页里的高风险待办卡片（docs/ui-design.md §4.4：高风险 PR 裁决挪进需求页时间线，
// 「放行 / 拒绝」两个按钮，拒绝需填理由）。顶部高风险横条（HighRiskPanel）保留作兜底，不动。
// 裁决走现有 high-risk:decide（ticket_id, pr_id, decision, detail?），拒绝理由放进 detail，不加新接口。
import { useState } from "react";
import { ShieldAlert } from "lucide-react";
import type { DesktopPendingHighRisk } from "../../shared/api";
import { HIGH_RISK_CARD_COPY as C } from "../lib/copy";
import {
  formatHighRiskFile,
  highRiskDecisionErrorLabel,
  highRiskReasonLabel,
} from "../lib/high-risk-labels";
import { READONLY_COPY } from "../lib/readonly";
import { redactForView } from "../lib/redact";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

export type HighRiskDecide = (
  ticket_id: string,
  pr_id: string,
  decision: "release" | "reject",
  detail?: string,
) => Promise<{ ok: true } | { ok: false; code: string; message: string }>;

function Card({
  item,
  disabled,
  onDecide,
}: {
  item: DesktopPendingHighRisk;
  disabled: boolean;
  onDecide: HighRiskDecide;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  const decide = async (decision: "release" | "reject") => {
    setBusy(true);
    setError(null);
    try {
      const r = await onDecide(
        item.ticket_id,
        item.pr_id,
        decision,
        ...(decision === "reject" ? [reason.trim()] : []),
      );
      if (!r.ok) {
        setError(highRiskDecisionErrorLabel(r.code) || r.message);
      }
    } catch {
      setError(highRiskDecisionErrorLabel("unavailable"));
    } finally {
      setBusy(false);
    }
  };

  const files = item.files.map((f) => redactForView(formatHighRiskFile(f)));
  const off = disabled || busy;
  return (
    <li
      data-testid="requirement-high-risk"
      data-ticket={item.ticket_id}
      data-pr={item.pr_id}
      className="rounded-md bg-danger-soft p-3 text-sm ring-1 ring-danger/30"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <ShieldAlert size={16} strokeWidth={1.5} className="text-danger" aria-hidden />
        <span className="font-medium text-danger">{C.title(item.ticket_id)}</span>
        <span className="text-xs text-muted-foreground">PR {item.pr_id}</span>
        {item.pr_url ? (
          <a
            href={item.pr_url}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-accent underline-offset-2 hover:underline"
          >
            {C.openPr}
          </a>
        ) : null}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {C.reasons}
        {item.reasons.map(highRiskReasonLabel).join("；")}
      </p>
      {files.length > 0 && (
        <p className="mt-1 text-xs">
          {C.files}
          {files.join("、")}
          {item.files_more > 0 ? C.more(item.files_more) : ""}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="mt-2 text-xs text-danger"
          data-testid="requirement-high-risk-error"
        >
          {error}
        </p>
      )}
      {rejecting ? (
        <div className="mt-2 space-y-2">
          <Textarea
            aria-label={C.rejectReason}
            placeholder={C.rejectPlaceholder}
            value={reason}
            disabled={off}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              className="text-danger"
              disabled={off || reason.trim() === ""}
              onClick={() => void decide("reject")}
            >
              {C.confirmReject}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => setRejecting(false)}
            >
              {C.cancel}
            </Button>
          </div>
        </div>
      ) : (
        <div
          className="mt-2 flex gap-2"
          title={disabled ? READONLY_COPY.decideDisabled : undefined}
        >
          <Button size="sm" disabled={off} onClick={() => void decide("release")}>
            {C.release}
          </Button>
          <Button size="sm" variant="secondary" disabled={off} onClick={() => setRejecting(true)}>
            {C.reject}
          </Button>
        </div>
      )}
    </li>
  );
}

export function RequirementHighRiskCards({
  items,
  disabled = false,
  onDecide,
}: {
  items: readonly DesktopPendingHighRisk[];
  disabled?: boolean;
  onDecide: HighRiskDecide;
}) {
  if (items.length === 0) return null;
  return (
    <section aria-label={C.label} className="space-y-2">
      <h3 className="text-xs font-medium text-danger">{C.label}</h3>
      <ul className="space-y-2">
        {items.map((i) => (
          <Card
            key={`${i.ticket_id}:${i.pr_id}`}
            item={i}
            disabled={disabled}
            onDecide={onDecide}
          />
        ))}
      </ul>
    </section>
  );
}
