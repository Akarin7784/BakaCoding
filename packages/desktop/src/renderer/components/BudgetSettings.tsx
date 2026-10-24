// UI-07c：设置 › 预算（§4.6）。每日预算（必填、不给默认值）、每单上限比例 (0,1]、闲时优先，
// 以及今天已花费（只取 budget:status，即 3 的 budgetState()）。新预算低于今天已花费时只警告、不拦。
// 保存走 settings:save 的 { budget }（校验 → 写 config/models.json → 07b 的重载规则）；
// --config / BAKACODING_CONFIG 锁定时整页只读。
// UI-07e：budget-today 下面接 ProjectSpend（各项目累计花费，只取 ledger:summary）。
import { useEffect, useState } from "react";
import { Lock, TriangleAlert } from "lucide-react";
import type {
  BakaDesktopApi,
  DesktopBudgetStatusResult,
  DesktopFieldError,
} from "../../shared/api";
import {
  BUDGET_COPY,
  belowToday,
  microToUsd,
  parseBudgetUsd,
  parseRatio,
} from "../lib/budgetSettings";
import { MODEL_COPY, saveNotice, sourceText, type SaveNotice } from "../lib/modelSettings";
import { ProjectSpend } from "./ProjectSpend";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";

export type BudgetSettingsApi = Pick<
  BakaDesktopApi,
  "getBudgetStatus" | "saveBudget" | "getLedgerSummary"
>;
type Loaded = Extract<DesktopBudgetStatusResult, { ok: true }>;

function Err({ id, text }: { id: string; text: string | undefined }) {
  if (!text) return null;
  return (
    <p className="mt-1 text-xs text-danger" data-testid={`field-error-${id}`}>
      {text}
    </p>
  );
}

export function BudgetSettings({ api }: { api?: BudgetSettingsApi }) {
  const [loaded, setLoaded] = useState<DesktopBudgetStatusResult | null | undefined>(undefined);
  const [daily, setDaily] = useState("");
  const [ratio, setRatio] = useState("");
  const [offpeak, setOffpeak] = useState(false);
  const [touched, setTouched] = useState(false);
  const [serverErrors, setServerErrors] = useState<DesktopFieldError[]>([]);
  const [notice, setNotice] = useState<SaveNotice | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!api?.getBudgetStatus) return;
    let live = true;
    api
      .getBudgetStatus()
      .then((r) => {
        if (!live) return;
        setLoaded(r);
        if (r.ok) {
          // 只放配置里已有的值；配置里没有就留空（不给任何默认金额）
          setDaily(r.budget.daily_micro_usd > 0 ? microToUsd(r.budget.daily_micro_usd) : "");
          setRatio(String(r.budget.per_ticket_ratio));
          setOffpeak(r.budget.offpeak_preference);
        }
      })
      .catch(() => live && setLoaded(null));
    return () => {
      live = false;
    };
  }, [api]);

  if (!api?.getBudgetStatus)
    return <p className="text-muted-foreground">没有连接主进程，读不到预算设置。</p>;
  if (loaded === undefined) return <p className="text-muted-foreground">读取中…</p>;
  if (loaded === null) return <p className="text-danger">读取预算失败，请重试。</p>;
  if (!loaded.ok)
    return (
      <p role="alert" className="text-danger" data-testid="budget-load-error">
        {loaded.reason}
      </p>
    );
  const st: Loaded = loaded;
  const ro = st.readonly || !api.saveBudget;
  const dailyMicro = parseBudgetUsd(daily);
  const ratioN = parseRatio(ratio);
  const serverErr = (f: string) => serverErrors.find((e) => e.field === `budget.${f}`)?.message;
  const dailyErr =
    touched && dailyMicro === null ? BUDGET_COPY.dailyInvalid : serverErr("daily_micro_usd");
  const ratioErr =
    touched && ratioN === null ? BUDGET_COPY.ratioInvalid : serverErr("per_ticket_ratio");
  const warn = belowToday(dailyMicro, st.today?.spent_micro_usd);
  const edit = (fn: () => void) => {
    fn();
    setNotice(null);
    setServerErrors([]);
  };

  async function doSave() {
    setConfirming(false);
    setTouched(true);
    if (!api?.saveBudget || dailyMicro === null || ratioN === null) return;
    setSaving(true);
    setNotice(null);
    try {
      const r = await api.saveBudget({
        budget: {
          daily_micro_usd: dailyMicro,
          per_ticket_ratio: ratioN,
          offpeak_preference: offpeak,
        },
      });
      setServerErrors(!r.ok && r.errors ? r.errors : []);
      setNotice(saveNotice(r));
    } catch {
      setNotice({ tone: "error", text: "保存失败，请重试" });
    } finally {
      setSaving(false);
    }
  }
  const trySave = () => {
    setTouched(true);
    if (dailyMicro === null || ratioN === null) return;
    if (st.running > 0) setConfirming(true);
    else void doSave();
  };
  const toneClass = { ok: "text-foreground", warn: "text-danger", error: "text-danger" } as const;

  return (
    <div className="space-y-5" data-testid="budget-settings">
      <div className="space-y-1">
        <p
          className="flex items-center gap-1.5 text-xs text-muted-foreground"
          data-testid="budget-source"
        >
          {st.readonly && <Lock size={12} strokeWidth={1.5} aria-hidden />}
          {sourceText(st.source)}
        </p>
        {st.readonly && (
          <p className="text-xs text-muted-foreground" data-testid="budget-readonly">
            {BUDGET_COPY.readonlyHint}
          </p>
        )}
      </div>

      <div className="rounded-md border border-border p-3 text-sm" data-testid="budget-today">
        {st.today ? (
          <span>
            {BUDGET_COPY.spentToday}（UTC {st.today.day}）：
            <span className="font-medium">${microToUsd(st.today.spent_micro_usd)}</span>
            <span className="text-muted-foreground">
              {" "}
              / 当前生效 ${microToUsd(st.today.daily_limit_micro_usd)}
            </span>
          </span>
        ) : (
          <span className="text-muted-foreground">{BUDGET_COPY.todayUnavailable}</span>
        )}
      </div>

      <ProjectSpend api={api} />

      <div>
        <label htmlFor="budget-daily" className="mb-1 block text-xs text-muted-foreground">
          {BUDGET_COPY.dailyLabel}
        </label>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">$</span>
          <Input
            id="budget-daily"
            inputMode="decimal"
            required
            disabled={ro}
            value={daily}
            onChange={(e) => edit(() => setDaily(e.target.value))}
            aria-invalid={!!dailyErr || undefined}
            className="w-40"
          />
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{BUDGET_COPY.dailyHint}</p>
        <Err id="budget.daily_micro_usd" text={dailyErr} />
        {warn && st.today && (
          <p
            role="status"
            className="mt-1 flex items-start gap-1 text-xs text-danger"
            data-testid="budget-below-today"
          >
            <TriangleAlert size={12} strokeWidth={1.5} className="mt-0.5 shrink-0" aria-hidden />
            {BUDGET_COPY.belowToday(`$${microToUsd(st.today.spent_micro_usd)}`)}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="budget-ratio" className="mb-1 block text-xs text-muted-foreground">
          {BUDGET_COPY.ratioLabel}
        </label>
        <Input
          id="budget-ratio"
          inputMode="decimal"
          disabled={ro}
          value={ratio}
          onChange={(e) => edit(() => setRatio(e.target.value))}
          aria-invalid={!!ratioErr || undefined}
          className="w-40"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          {BUDGET_COPY.ratioHint}
          {dailyMicro !== null && ratioN !== null && (
            <span data-testid="budget-per-ticket">
              {" "}
              每单上限约 ${microToUsd(Math.floor(dailyMicro * ratioN))}。
            </span>
          )}
        </p>
        <Err id="budget.per_ticket_ratio" text={ratioErr} />
      </div>

      <div className="flex items-start justify-between gap-4">
        <div>
          <label htmlFor="budget-offpeak" className="block text-sm">
            {BUDGET_COPY.offpeakLabel}
          </label>
          <p className="text-xs text-muted-foreground">{BUDGET_COPY.offpeakHint}</p>
        </div>
        <Switch
          id="budget-offpeak"
          checked={offpeak}
          disabled={ro}
          onCheckedChange={(v) => edit(() => setOffpeak(v))}
        />
      </div>

      {!ro && (
        <div className="space-y-2 border-t border-border pt-4">
          {confirming ? (
            <div className="space-y-2" data-testid="budget-confirm">
              <p className="text-xs text-muted-foreground">
                {MODEL_COPY.confirmQueued(st.running)}
              </p>
              <div className="flex gap-2">
                <Button size="sm" onClick={doSave}>
                  {MODEL_COPY.confirm}
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setConfirming(false)}>
                  {MODEL_COPY.cancel}
                </Button>
              </div>
            </div>
          ) : (
            <Button size="sm" disabled={saving} onClick={trySave} data-testid="budget-save">
              {saving
                ? MODEL_COPY.saving
                : st.running > 0
                  ? MODEL_COPY.saveQueued
                  : MODEL_COPY.save}
            </Button>
          )}
          {notice && (
            <div role={notice.tone === "ok" ? "status" : "alert"} data-testid="budget-notice">
              <p className={`text-sm ${toneClass[notice.tone]}`}>{notice.text}</p>
              {notice.detail && <p className="text-xs text-muted-foreground">{notice.detail}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
