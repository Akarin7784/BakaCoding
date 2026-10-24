// UI-07e：设置 › 预算 §4.6「本项目已花费（来自台账）」。每个已导入项目全部时间的累计花费，
// 只取 ledger:summary（3 的 ledgerSummary）；今天已花费仍只看 budget:status，这里不显示。
import { useEffect, useState } from "react";
import type { BakaDesktopApi, DesktopLedgerSummaryResult } from "../../shared/api";
import { BUDGET_COPY, microToUsd } from "../lib/budgetSettings";

export type ProjectSpendApi = Pick<BakaDesktopApi, "getLedgerSummary">;

export function ProjectSpend({ api }: { api?: ProjectSpendApi }) {
  // undefined = 读取中；null = 调用抛错
  const [res, setRes] = useState<DesktopLedgerSummaryResult | null | undefined>(undefined);

  useEffect(() => {
    if (!api?.getLedgerSummary) return;
    let live = true;
    api
      .getLedgerSummary()
      .then((r) => live && setRes(r))
      .catch(() => live && setRes(null));
    return () => {
      live = false;
    };
  }, [api]);

  if (!api?.getLedgerSummary) return null;
  let body;
  if (res === undefined)
    body = (
      <p className="text-muted-foreground" data-testid="project-spend-loading">
        {BUDGET_COPY.spendLoading}
      </p>
    );
  else if (res === null || !res.ok)
    body = (
      <p role="alert" className="text-danger" data-testid="project-spend-error">
        {res?.reason ?? BUDGET_COPY.spendFailed}
      </p>
    );
  else if (res.projects.length === 0)
    body = (
      <p className="text-muted-foreground" data-testid="project-spend-empty">
        {BUDGET_COPY.spendEmpty}
      </p>
    );
  else
    body = (
      <ul className="space-y-1" data-testid="project-spend-list">
        {res.projects.map((p) => (
          <li
            key={p.project_id}
            className="flex items-baseline justify-between gap-4"
            data-testid={`project-spend-${p.project_id}`}
          >
            <span className="truncate">{p.name}</span>
            <span className="shrink-0">
              <span className="font-medium">${microToUsd(p.total_micro_usd)}</span>
              {p.resubmit_micro_usd > 0 && (
                <span className="text-muted-foreground">
                  {BUDGET_COPY.spendResubmit(microToUsd(p.resubmit_micro_usd))}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    );
  return (
    <div
      className="space-y-2 rounded-md border border-border p-3 text-sm"
      data-testid="project-spend"
    >
      <p className="text-xs text-muted-foreground">{BUDGET_COPY.spendTitle}</p>
      {body}
      <p className="text-xs text-muted-foreground">{BUDGET_COPY.spendHint}</p>
    </div>
  );
}
