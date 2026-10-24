// UI-07b：设置 › 模型（§4.6）。主管模型（档位固定 max）、编码模型和档位、评审池成员（模型、档位），
// 以及这些模型的单价。顶部一行说配置来源；--config / BAKACODING_CONFIG 锁定时整页只读并说明原因。
// 保存走 settings:save（校验 → 写 config → 写 pricing → 重载），字段错误标在对应字段下；
// 有在途单时按钮写「等当前单跑完后重载」并要确认；部分失败照 written 说清写了哪个文件。
import { useEffect, useMemo, useState } from "react";
import { Lock, Plus, Trash2, Zap } from "lucide-react";
import {
  DESKTOP_EFFORTS,
  type BakaDesktopApi,
  type DesktopEffort,
  type DesktopFieldError,
  type DesktopModelConfigResult,
  type DesktopModelForm,
  type DesktopModelPricing,
  type DesktopPriceRate,
} from "../../shared/api";
import { providerTestText } from "../lib/secretItem";
import {
  MODEL_COPY,
  nextReviewerId,
  saveNotice,
  sourceText,
  usedModels,
  type SaveNotice,
} from "../lib/modelSettings";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

export type ModelSettingsApi = Pick<
  BakaDesktopApi,
  "getModelConfig" | "saveModelConfig" | "testProvider"
>;
type Loaded = Extract<DesktopModelConfigResult, { ok: true }>;

const SEP = "\u0000";
const RATE_KEYS: { key: keyof DesktopPriceRate; label: string }[] = [
  { key: "input_cache_hit", label: "输入（缓存命中）" },
  { key: "input_cache_miss", label: "输入（未命中）" },
  { key: "output", label: "输出" },
];
const ZERO: DesktopPriceRate = { input_cache_hit: 0, input_cache_miss: 0, output: 0 };

function FieldError({ errors, field }: { errors: DesktopFieldError[]; field: string }) {
  const mine = errors.filter((e) => e.field === field || e.field.startsWith(`${field}.`));
  if (mine.length === 0) return null;
  return (
    <p className="mt-1 text-xs text-danger" data-testid={`field-error-${field}`}>
      {mine.map((e) => e.message).join("；")}
    </p>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 text-xs text-muted-foreground">{title}</h3>
      {children}
    </div>
  );
}

export function ModelSettings({ api }: { api?: ModelSettingsApi }) {
  const [loaded, setLoaded] = useState<DesktopModelConfigResult | null | undefined>(undefined);
  const [form, setForm] = useState<DesktopModelForm | null>(null);
  const [pricing, setPricing] = useState<DesktopModelPricing>({});
  const [errors, setErrors] = useState<DesktopFieldError[]>([]);
  const [notice, setNotice] = useState<SaveNotice | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [test, setTest] = useState<string | null>(null);

  useEffect(() => {
    if (!api?.getModelConfig) return;
    let live = true;
    api
      .getModelConfig()
      .then((r) => {
        if (!live) return;
        setLoaded(r);
        if (r.ok) {
          setForm(r.form);
          setPricing(r.pricing);
        }
      })
      .catch(() => live && setLoaded(null));
    return () => {
      live = false;
    };
  }, [api]);

  const options = useMemo(
    () =>
      loaded?.ok
        ? loaded.providers.flatMap((p) => p.models.map((m) => ({ provider: p.id, model: m })))
        : [],
    [loaded],
  );

  if (!api?.getModelConfig)
    return <p className="text-muted-foreground">没有连接主进程，读不到模型配置。</p>;
  if (loaded === undefined) return <p className="text-muted-foreground">读取中…</p>;
  if (loaded === null) return <p className="text-danger">读取模型配置失败，请重试。</p>;
  if (!loaded.ok)
    return (
      <p role="alert" className="text-danger" data-testid="model-load-error">
        {loaded.reason}
      </p>
    );
  if (!form) return null;
  const cfg: Loaded = loaded;
  const ro = cfg.readonly || !api.saveModelConfig;

  const modelSelect = (
    id: string,
    value: { provider: string; model: string },
    onChange: (v: { provider: string; model: string }) => void,
    field: string,
  ) => (
    <Select
      value={`${value.provider}${SEP}${value.model}`}
      disabled={ro}
      onValueChange={(v) => {
        const [provider = "", model = ""] = v.split(SEP);
        onChange({ provider, model });
      }}
    >
      <SelectTrigger
        id={id}
        aria-label="模型"
        className="min-w-0 flex-1"
        aria-invalid={errors.some((e) => e.field.startsWith(field)) || undefined}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {[
          ...options,
          ...(options.some((o) => o.provider === value.provider && o.model === value.model)
            ? []
            : [value]),
        ].map((o) => (
          <SelectItem key={`${o.provider}${SEP}${o.model}`} value={`${o.provider}${SEP}${o.model}`}>
            {o.model}
            <span className="ml-1 text-muted-foreground">· {o.provider}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  const effortSelect = (
    value: DesktopEffort,
    onChange: (e: DesktopEffort) => void,
    label: string,
  ) => (
    <Select value={value} disabled={ro} onValueChange={(v) => onChange(v as DesktopEffort)}>
      <SelectTrigger aria-label={label} className="w-24 shrink-0">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {DESKTOP_EFFORTS.map((e) => (
          <SelectItem key={e} value={e}>
            {e}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  const update = (f: DesktopModelForm) => {
    setForm(f);
    setNotice(null);
  };

  async function doSave() {
    if (!api?.saveModelConfig || !form) return;
    setConfirming(false);
    setSaving(true);
    setNotice(null);
    try {
      const priced = Object.fromEntries(
        usedModels(form).map((m) => [m, pricing[m] ?? { peak: ZERO, offpeak: ZERO }]),
      );
      const r = await api.saveModelConfig({ form, pricing: priced });
      setErrors(!r.ok && r.errors ? r.errors : []);
      setNotice(saveNotice(r));
    } catch {
      setNotice({ tone: "error", text: "保存失败，请重试" });
    } finally {
      setSaving(false);
    }
  }
  async function doTest() {
    if (!api?.testProvider || !form) return;
    setTest(MODEL_COPY.testing);
    try {
      setTest(providerTestText(await api.testProvider(form.supervisor)));
    } catch {
      setTest("测试失败，请重试");
    }
  }

  const priceRow = (model: string) => {
    const p = pricing[model] ?? { peak: ZERO, offpeak: ZERO };
    const set = (period: "peak" | "offpeak", key: keyof DesktopPriceRate, raw: string) => {
      const n = raw === "" ? 0 : Number(raw);
      setPricing({ ...pricing, [model]: { ...p, [period]: { ...p[period], [key]: n } } });
      setNotice(null);
    };
    return (
      <div
        key={model}
        className="rounded-md border border-border p-3"
        data-testid={`price-${model}`}
      >
        <div className="mb-2 text-sm font-medium">{model}</div>
        <div className="grid grid-cols-[4rem_repeat(3,minmax(0,1fr))] items-center gap-2 text-xs">
          <span />
          {RATE_KEYS.map((k) => (
            <span key={k.key} className="text-muted-foreground">
              {k.label}
            </span>
          ))}
          {(["peak", "offpeak"] as const).map((period) => (
            <div key={period} className="contents">
              <span className="text-muted-foreground">{period === "peak" ? "高峰" : "闲时"}</span>
              {RATE_KEYS.map((k) => (
                <Input
                  key={k.key}
                  type="number"
                  min={0}
                  step={1}
                  inputMode="numeric"
                  aria-label={`${model} ${period === "peak" ? "高峰" : "闲时"}${k.label}`}
                  disabled={ro}
                  value={String(p[period][k.key])}
                  onChange={(e) => set(period, k.key, e.target.value)}
                  aria-invalid={errors.some((e) => e.field === `pricing.${model}`) || undefined}
                />
              ))}
            </div>
          ))}
        </div>
        <FieldError errors={errors} field={`pricing.${model}`} />
      </div>
    );
  };

  const toneClass = { ok: "text-foreground", warn: "text-danger", error: "text-danger" } as const;

  return (
    <div className="space-y-5" data-testid="model-settings">
      <div className="space-y-1">
        <p
          className="flex items-center gap-1.5 text-xs text-muted-foreground"
          data-testid="model-source"
        >
          {cfg.readonly && <Lock size={12} strokeWidth={1.5} aria-hidden />}
          {sourceText(cfg.source)}
        </p>
        {cfg.readonly && (
          <p className="text-xs text-muted-foreground" data-testid="model-readonly">
            {MODEL_COPY.readonlyHint}
          </p>
        )}
      </div>

      <Section title="主管">
        <div className="flex items-center gap-2">
          {modelSelect(
            "model-supervisor",
            form.supervisor,
            (v) => update({ ...form, supervisor: v }),
            "supervisor",
          )}
          <span className="w-24 shrink-0 text-xs text-muted-foreground">
            {MODEL_COPY.supervisorEffort}
          </span>
        </div>
        <FieldError errors={errors} field="supervisor" />
        {api.testProvider && (
          <div className="mt-2 flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={doTest}
              disabled={test === MODEL_COPY.testing}
            >
              <Zap strokeWidth={1.5} />
              {MODEL_COPY.test}
            </Button>
            {test && (
              <span className="text-xs text-muted-foreground" data-testid="model-test">
                {test}
              </span>
            )}
          </div>
        )}
      </Section>

      <Section title="编码">
        <div className="flex items-center gap-2">
          {modelSelect(
            "model-coder",
            form.coder,
            (v) => update({ ...form, coder: { ...form.coder, ...v } }),
            "coder",
          )}
          {effortSelect(
            form.coder.effort,
            (e) => update({ ...form, coder: { ...form.coder, effort: e } }),
            "编码档位",
          )}
        </div>
        <FieldError errors={errors} field="coder" />
      </Section>

      <Section title="评审池">
        <div className="space-y-2">
          {form.reviewers.length === 0 && (
            <p className="text-xs text-muted-foreground">{MODEL_COPY.noReviewers}</p>
          )}
          {form.reviewers.map((r, i) => {
            const set = (patch: Partial<typeof r>) =>
              update({
                ...form,
                reviewers: form.reviewers.map((x, j) => (j === i ? { ...x, ...patch } : x)),
              });
            return (
              <div key={r.id + i} data-testid={`reviewer-${i}`}>
                <div className="flex items-center gap-2">
                  <code className="w-24 shrink-0 truncate text-xs text-muted-foreground">
                    {r.id}
                  </code>
                  {modelSelect(`model-reviewer-${i}`, r, (v) => set(v), `reviewers.${i}`)}
                  {effortSelect(r.effort, (e) => set({ effort: e }), `${r.id} 档位`)}
                  <Button
                    variant="secondary"
                    size="icon-sm"
                    aria-label={`移除 ${r.id}`}
                    disabled={ro}
                    onClick={() =>
                      update({ ...form, reviewers: form.reviewers.filter((_, j) => j !== i) })
                    }
                  >
                    <Trash2 strokeWidth={1.5} />
                  </Button>
                </div>
                <FieldError errors={errors} field={`reviewers.${i}`} />
              </div>
            );
          })}
          <FieldError errors={errors.filter((e) => e.field === "reviewers")} field="reviewers" />
          {!ro && options.length > 0 && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                update({
                  ...form,
                  reviewers: [
                    ...form.reviewers,
                    { id: nextReviewerId(form), ...options[0]!, effort: "high" },
                  ],
                })
              }
            >
              <Plus strokeWidth={1.5} />
              {MODEL_COPY.addReviewer}
            </Button>
          )}
        </div>
      </Section>

      <Section title="单价">
        <p className="mb-2 text-xs text-muted-foreground">{MODEL_COPY.priceUnit}</p>
        <div className="space-y-2">{usedModels(form).map(priceRow)}</div>
      </Section>

      <FieldError
        errors={errors.filter((e) => e.field === "config" || e.field === "pricing")}
        field="config"
      />
      <FieldError errors={errors.filter((e) => e.field === "pricing")} field="pricing" />

      {!ro && (
        <div className="space-y-2 border-t border-border pt-4">
          {confirming ? (
            <div className="space-y-2" data-testid="model-confirm">
              <p className="text-xs text-muted-foreground">
                {MODEL_COPY.confirmQueued(cfg.running)}
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
            <Button
              size="sm"
              disabled={saving}
              onClick={() => (cfg.running > 0 ? setConfirming(true) : void doSave())}
              data-testid="model-save"
            >
              {saving
                ? MODEL_COPY.saving
                : cfg.running > 0
                  ? MODEL_COPY.saveQueued
                  : MODEL_COPY.save}
            </Button>
          )}
          {notice && (
            <div role={notice.tone === "ok" ? "status" : "alert"} data-testid="model-notice">
              <p className={`text-sm ${toneClass[notice.tone]}`}>{notice.text}</p>
              {notice.detail && <p className="text-xs text-muted-foreground">{notice.detail}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
