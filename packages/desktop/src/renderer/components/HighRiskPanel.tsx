// T-062：高风险 PR 放行 / 拒绝面板。
import { useState } from "react";
import { ShieldAlert } from "lucide-react";
import type { DesktopPendingHighRisk } from "../../shared/api.js";
import {
  formatHighRiskFile,
  highRiskDecisionErrorLabel,
  highRiskReasonLabel,
} from "../lib/high-risk-labels";
import { Button } from "./ui/button";

export interface HighRiskPanelProps {
  items: DesktopPendingHighRisk[];
  /** 只读或未接线时禁用按钮。 */
  disabled?: boolean;
  onDecide: (
    ticket_id: string,
    pr_id: string,
    decision: "release" | "reject",
  ) => Promise<{ ok: true } | { ok: false; code: string; message: string }>;
}

export function HighRiskPanel({ items, disabled, onDecide }: HighRiskPanelProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  if (items.length === 0) return null;

  const decide = async (item: DesktopPendingHighRisk, decision: "release" | "reject") => {
    const key = `${item.ticket_id}:${item.pr_id}`;
    setBusy(key);
    setErrors((e) => {
      const next = { ...e };
      delete next[key];
      return next;
    });
    try {
      const r = await onDecide(item.ticket_id, item.pr_id, decision);
      if (!r.ok) {
        const msg =
          r.code === "stale_pr"
            ? "PR 已更新，请重新查看"
            : highRiskDecisionErrorLabel(r.code) || r.message;
        setErrors((e) => ({ ...e, [key]: msg }));
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      aria-label="高风险 PR 待裁决"
      data-testid="high-risk-panel"
      className="border-b border-border bg-muted/40"
    >
      <header className="flex items-center gap-2 px-4 py-2 text-sm font-medium">
        <ShieldAlert size={16} strokeWidth={1.5} aria-hidden />
        高风险 PR 待裁决
        <span className="text-xs font-normal text-muted-foreground">（{items.length}）</span>
      </header>
      <ul className="space-y-3 px-4 pb-3">
        {items.map((item) => {
          const key = `${item.ticket_id}:${item.pr_id}`;
          const files = item.files.map(formatHighRiskFile);
          const more = item.files_more > 0 ? ` 等另 ${item.files_more} 个` : "";
          return (
            <li
              key={key}
              data-testid="high-risk-item"
              data-ticket={item.ticket_id}
              data-pr={item.pr_id}
              className="rounded-md border border-border bg-background p-3 text-sm"
            >
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="font-medium">{item.ticket_id}</span>
                <span className="text-muted-foreground">PR {item.pr_id}</span>
                {item.pr_url ? (
                  <a
                    href={item.pr_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-accent underline-offset-2 hover:underline"
                  >
                    打开 PR
                  </a>
                ) : null}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                理由：{item.reasons.map(highRiskReasonLabel).join("；")}
              </p>
              {files.length > 0 && (
                <p className="mt-1 text-xs" data-testid="high-risk-files">
                  命中文件：{files.join("、")}
                  {more}
                </p>
              )}
              {errors[key] && (
                <p role="alert" data-testid="high-risk-error" className="mt-2 text-xs text-danger">
                  {errors[key]}
                </p>
              )}
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  disabled={disabled || busy === key}
                  data-testid="high-risk-release"
                  onClick={() => void decide(item, "release")}
                >
                  放行
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={disabled || busy === key}
                  data-testid="high-risk-reject"
                  onClick={() => void decide(item, "reject")}
                >
                  拒绝
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
