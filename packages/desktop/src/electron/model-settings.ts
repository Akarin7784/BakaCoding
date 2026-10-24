// UI-07b：设置 › 模型。settings:config-get 读当前各角色模型和单价给界面编辑，settings:save 按
// 「校验 → 写 config/models.json → 写 config/pricing.json → 重载」保存。
// - 密钥只回名字和是否已设（`!!env[name]`），绝不回值；也不回 base_url 和任何路径。
// - 配置来源是 --config / BAKACODING_CONFIG 时整页只读，保存直接拒绝（不碰外部文件）。
// - 写文件走 3 的 writeConfig / writePricing（原子写、拒绝像密钥的值）；有在途单时文件照写，
//   重载交给 backend.reload()（T-093）排队，空闲后自动执行。
// - config 写成、pricing 没写成时回 partial_write + written:["models"]，不重载；报错经 cleanWriteError 去掉绝对路径。
// UI-07c：设置 › 预算。settings:save 也接 `{ budget }`：校验 → 只写 config/models.json 的 budget 段 → 同样的重载；
// budget:status 回当前 budget 段和今天已花费（原样取 3 的 budgetState()，不自己算）。
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  ConfigSchema,
  formatConfigIssue,
  PricingSchema,
  SECRET_NAMES,
  validate,
} from "@bakacoding/config-budget";
import type { BudgetState } from "@bakacoding/config-budget";
import {
  DESKTOP_EFFORTS,
  type DesktopBudgetForm,
  type DesktopBudgetStatusResult,
  type DesktopEffort,
  type DesktopFieldError,
  type DesktopModelConfigResult,
  type DesktopModelForm,
  type DesktopModelPricing,
  type DesktopModelSaveFile,
  type DesktopModelSaveResult,
  type DesktopPriceRate,
  type DesktopReloadResult,
  type DesktopRepoSource,
} from "../shared/api.js";
import { BUDGET_STATUS_TEXT, MODEL_SETTINGS_TEXT } from "../shared/config-text.js";
import { cleanWriteError, type WriteConfigFn, type WritePricingFn } from "./config-fix.js";
import { configSource, MODELS_FILE, PRICING_FILE, resolveConfigPath } from "./config-inspect.js";

export interface ModelSettingsDeps {
  repoRoot(): string;
  repoSource(): DesktopRepoSource | undefined;
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  /** 在途单数 + 主管对话在途（>0 时保存后重载会排队） */
  running(): number;
  /** backend.reload()（T-093）：忙时自动排队 */
  reload(): Promise<DesktopReloadResult>;
  writeConfig: WriteConfigFn;
  writePricing: WritePricingFn;
  /** UI-07c：当前后端 3 的 budgetState()（backend.budgetState()）；只读后端回 null。没注入时 today 为 null */
  budgetState?(): Promise<BudgetState | null>;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
const MAX_REVIEWERS = 16;
const MAX_PRICED = 64;
const fail = (
  code: Exclude<DesktopModelSaveResult, { ok: true }>["code"],
  written: DesktopModelSaveFile[] = [],
  extra: { reason?: string; errors?: DesktopFieldError[] } = {},
): DesktopModelSaveResult => ({
  ok: false,
  code,
  reason: extra.reason ?? MODEL_SETTINGS_TEXT[code],
  written,
  ...(extra.errors && { errors: extra.errors }),
});

/** 当前环境里密钥的值（长度够长的才算，免得把短词误判）；只用于从回给界面的字符串里剔除 */
function secretValues(env: ModelSettingsDeps["env"], names: Iterable<string>): string[] {
  const out: string[] = [];
  for (const n of new Set([...SECRET_NAMES, ...names])) {
    const v = env[n];
    if (v && v.length >= 8) out.push(v);
  }
  return out;
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8"));
}

/** 只认普通文件 / 目录；符号链接、其它类型、读不到都算不安全（同 config-fix 的 kind） */
async function plain(p: string, want: "file" | "dir"): Promise<"ok" | "missing" | "unsafe"> {
  try {
    const s = await lstat(p);
    return !s.isSymbolicLink() && (want === "file" ? s.isFile() : s.isDirectory())
      ? "ok"
      : "unsafe";
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unsafe";
  }
}

const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const effort = (v: unknown, d: DesktopEffort): DesktopEffort =>
  (DESKTOP_EFFORTS as readonly unknown[]).includes(v) ? (v as DesktopEffort) : d;

/** 从合法的 models.json 原始对象取出表单（只取这页能改的字段） */
export function formFromConfig(raw: Json): DesktopModelForm {
  const roles = isObj(raw.roles) ? raw.roles : {};
  const sup = isObj(roles.supervisor) ? roles.supervisor : {};
  const coder = isObj(roles.coder) ? roles.coder : {};
  const rb = isObj(roles.review_board) ? roles.review_board : {};
  const members = Array.isArray(rb.members) ? rb.members.filter(isObj) : [];
  return {
    supervisor: { provider: str(sup.provider), model: str(sup.model) },
    coder: {
      provider: str(coder.provider),
      model: str(coder.model),
      effort: effort(coder.effort, "low"),
    },
    reviewers: members.map((m) => ({
      id: str(m.id),
      provider: str(m.provider),
      model: str(m.model),
      effort: effort(m.effort, "high"),
    })),
  };
}

function rateOf(v: unknown): DesktopPriceRate {
  const o = isObj(v) ? v : {};
  const n = (x: unknown) => (typeof x === "number" ? x : 0);
  return {
    input_cache_hit: n(o.input_cache_hit),
    input_cache_miss: n(o.input_cache_miss),
    output: n(o.output),
  };
}

export function modelSettingsHandlers(deps: ModelSettingsDeps) {
  const paths = () => {
    const root = deps.repoRoot();
    return {
      root,
      models: resolveConfigPath(deps.argv, deps.env, root),
      pricing: path.join(root, PRICING_FILE),
    };
  };

  async function configGet(): Promise<DesktopModelConfigResult> {
    try {
      const src = deps.repoSource();
      const ext = configSource(deps.argv, deps.env);
      if (!ext && (src === undefined || src === "cwd"))
        return { ok: false, code: "cwd_repo", reason: MODEL_SETTINGS_TEXT.cwd_repo };
      const p = paths();
      let raw: unknown;
      let pricingRaw: unknown;
      try {
        raw = await readJson(p.models);
        pricingRaw = await readJson(p.pricing);
      } catch {
        return { ok: false, code: "read_failed", reason: MODEL_SETTINGS_TEXT.read_failed };
      }
      if (!isObj(raw) || validate(raw).length > 0 || !PricingSchema.safeParse(pricingRaw).success)
        return { ok: false, code: "invalid_config", reason: MODEL_SETTINGS_TEXT.invalid_config };
      const provRaw = isObj(raw.providers) ? raw.providers : {};
      const credNames: string[] = [];
      const providers = Object.entries(provRaw).map(([id, v]) => {
        const pv = isObj(v) ? v : {};
        const m = /^env:([A-Z0-9_]+)$/.exec(str(pv.credential_ref));
        if (m) credNames.push(m[1]!);
        return {
          id,
          models: Object.keys(isObj(pv.models) ? pv.models : {}),
          credential: m ? { name: m[1]!, set: !!deps.env[m[1]!] } : null,
        };
      });
      const pricing: DesktopModelPricing = {};
      const pm = (pricingRaw as { models: Record<string, unknown> }).models;
      for (const [name, v] of Object.entries(pm)) {
        const o = isObj(v) ? v : {};
        pricing[name] = { peak: rateOf(o.peak), offpeak: rateOf(o.offpeak) };
      }
      const result: Extract<DesktopModelConfigResult, { ok: true }> = {
        ok: true,
        source: ext ?? "repo",
        readonly: ext !== null,
        providers,
        form: formFromConfig(raw),
        pricing,
        running: Math.max(0, deps.running() | 0),
      };
      // UI-05c：复投上限按 3 的 schema 解析（没写时是 schema 默认值）；解析不出就不带，界面用默认值
      const parsed = ConfigSchema.safeParse(raw);
      if (parsed.success)
        result.pipeline = {
          resubmit_limits: { review: parsed.data.pipeline.resubmit_limits.review },
        };
      // 兜底：配置里的键名（服务商 id、模型名）万一就是某个密钥的值，整段换掉，绝不回给界面
      const secrets = secretValues(deps.env, credNames);
      if (secrets.length === 0) return result;
      return JSON.parse(JSON.stringify(result), (_k, v: unknown) =>
        typeof v === "string" && secrets.some((s) => v.includes(s)) ? "(已隐藏)" : v,
      ) as DesktopModelConfigResult;
    } catch {
      return { ok: false, code: "failed", reason: MODEL_SETTINGS_TEXT.failed };
    }
  }

  async function budgetStatus(): Promise<DesktopBudgetStatusResult> {
    const no = (code: keyof typeof BUDGET_STATUS_TEXT): DesktopBudgetStatusResult => ({
      ok: false,
      code,
      reason: BUDGET_STATUS_TEXT[code],
    });
    try {
      const src = deps.repoSource();
      const ext = configSource(deps.argv, deps.env);
      if (!ext && (src === undefined || src === "cwd")) return no("cwd_repo");
      let raw: unknown;
      try {
        raw = await readJson(paths().models);
      } catch {
        return no("read_failed");
      }
      if (!isObj(raw) || validate(raw).length > 0) return no("invalid_config");
      // 今天已花费只从 3 的 budgetState() 来；取不到（只读后端 / 抛错）就是 null，界面照实说
      let st: BudgetState | null = null;
      try {
        st = (await deps.budgetState?.()) ?? null;
      } catch {
        st = null;
      }
      return {
        ok: true,
        source: ext ?? "repo",
        readonly: ext !== null,
        budget: budgetFromConfig(raw),
        today: st && {
          day: st.day,
          spent_micro_usd: st.spent_today_micro_usd,
          reserved_micro_usd: st.reserved_today_micro_usd,
          daily_limit_micro_usd: st.daily_limit_micro_usd,
          per_ticket_limit_micro_usd: st.per_ticket_limit_micro_usd,
        },
        running: Math.max(0, deps.running() | 0),
      };
    } catch {
      return no("failed");
    }
  }

  async function save(input: unknown): Promise<DesktopModelSaveResult> {
    let written: DesktopModelSaveFile[] = [];
    let p: ReturnType<typeof paths> | undefined;
    try {
      if (configSource(deps.argv, deps.env)) return fail("external_config");
      const src = deps.repoSource();
      if (src === undefined || src === "cwd") return fail("cwd_repo");
      const budget = isObj(input) && "budget" in input ? parseBudgetInput(input) : undefined;
      const parsed = budget === undefined ? parseSaveInput(input) : null;
      if (budget === null || (budget === undefined && !parsed)) return fail("invalid_input");
      p = paths();
      const root = await realpath(p.root);
      const cfgDir = path.join(root, path.dirname(MODELS_FILE));
      const modelsFile = path.join(root, MODELS_FILE);
      const pricingFile = path.join(root, PRICING_FILE);
      const kinds = [await plain(cfgDir, "dir"), await plain(modelsFile, "file")];
      // 预算只写 models.json，不要求 pricing.json
      if (!budget) kinds.push(await plain(pricingFile, "file"));
      if (kinds.includes("unsafe")) return fail("unsafe_path");
      if (kinds.includes("missing")) return fail("read_failed");
      if (budget) return await saveBudget(budget, root, modelsFile);
      if (!parsed) return fail("invalid_input");
      let raw: unknown;
      let pricingRaw: unknown;
      try {
        raw = await readJson(modelsFile);
        pricingRaw = await readJson(pricingFile);
      } catch {
        return fail("read_failed");
      }
      if (!isObj(raw) || !isObj(pricingRaw)) return fail("read_failed");
      // 1. 校验：合并后整份配置过 3 的 validate，价格表过 PricingSchema，再查角色用的服务商 / 模型 / 单价都在
      const nextConfig = mergeConfig(raw, parsed.form);
      const nextPricing = {
        ...pricingRaw,
        models: { ...(isObj(pricingRaw.models) ? pricingRaw.models : {}), ...parsed.pricing },
      };
      const errors = [
        ...validate(nextConfig).map(configFieldError),
        ...(PricingSchema.safeParse(nextPricing).error?.issues ?? []).map((i) =>
          pricingFieldError(formatConfigIssue(i), i.path),
        ),
        ...crossCheck(nextConfig, nextPricing.models as Json, parsed.form),
      ];
      if (errors.length > 0)
        return fail("invalid", [], { errors: errors.map((e) => clean(e, root)) });
      // 2. 写 config
      const wc = await deps.writeConfig(modelsFile, nextConfig, {
        env: deps.env as NodeJS.ProcessEnv,
      });
      if (!wc.ok)
        return fail("write_failed", [], {
          errors: wc.errors.map((m) => clean({ field: "config", message: m }, root)),
        });
      written = ["models"];
      // 3. 写 pricing；失败时 config 已经写了，照实告诉界面，不重载
      const wp = await deps.writePricing(pricingFile, nextPricing, {
        env: deps.env as NodeJS.ProcessEnv,
      });
      if (!wp.ok)
        return fail("partial_write", written, {
          errors: wp.errors.map((m) => clean({ field: "pricing", message: m }, root)),
        });
      written = ["models", "pricing"];
      // 4. 重载：有在途单时 backend.reload() 排队，空闲后自动执行
      return { ok: true, written, reload: await reloadClean(root) };
    } catch {
      return written.length === 0
        ? fail("failed")
        : fail(written.length === 1 ? "partial_write" : "failed", written);
    }
  }

  /** 07b 的重载规则：backend.reload()（忙时排队），失败原因去掉绝对路径 */
  async function reloadClean(root: string): Promise<DesktopReloadResult> {
    let reload: DesktopReloadResult;
    try {
      reload = await deps.reload();
    } catch {
      reload = { state: "failed", reason: "重载失败" };
    }
    if (reload.state === "failed")
      reload = {
        state: "failed",
        reason: cleanWriteError(reload.reason, [root, deps.repoRoot()], deps.env),
      };
    return reload;
  }

  /** UI-07c：校验 → 只写 models.json 的 budget 段 → 重载（同 07b，不碰 pricing.json） */
  async function saveBudget(
    form: DesktopBudgetForm,
    root: string,
    modelsFile: string,
  ): Promise<DesktopModelSaveResult> {
    let raw: unknown;
    try {
      raw = await readJson(modelsFile);
    } catch {
      return fail("read_failed");
    }
    if (!isObj(raw)) return fail("read_failed");
    const old = isObj(raw.budget) ? raw.budget : {};
    const next = { ...raw, budget: { ...old, ...form } };
    const errors = [...budgetRangeErrors(form), ...validate(next).map(configFieldError)];
    if (errors.length > 0) {
      const seen = new Set<string>();
      return fail("invalid", [], {
        errors: errors
          .filter((e) => (seen.has(e.field) ? false : (seen.add(e.field), true)))
          .map((e) => clean(e, root)),
      });
    }
    const wc = await deps.writeConfig(modelsFile, next, { env: deps.env as NodeJS.ProcessEnv });
    if (!wc.ok)
      return fail("write_failed", [], {
        errors: wc.errors.map((m) => clean({ field: "config", message: m }, root)),
      });
    return { ok: true, written: ["models"], reload: await reloadClean(root) };
  }

  const clean = (e: DesktopFieldError, root: string): DesktopFieldError => ({
    field: e.field,
    message: cleanWriteError(e.message, [root, deps.repoRoot()], deps.env),
  });

  return { configGet, save, budgetStatus };
}

function mergeConfig(raw: Json, form: DesktopModelForm): Json {
  const roles = isObj(raw.roles) ? raw.roles : {};
  const old = (k: string) => (isObj(roles[k]) ? (roles[k] as Json) : {});
  return {
    ...raw,
    roles: {
      ...roles,
      supervisor: { ...old("supervisor"), ...form.supervisor, effort: "max" },
      coder: { ...old("coder"), ...form.coder },
      review_board: { ...old("review_board"), members: form.reviewers.map((r) => ({ ...r })) },
    },
  };
}

/** validate 的错误「roles.coder.model: …」→ 表单路径 */
function configFieldError(message: string): DesktopFieldError {
  const m = /^(\S+?)[：:]/.exec(message);
  const p = m?.[1] ?? "";
  let field = "config";
  const r = /^roles\.(supervisor|coder)\.(provider|model|effort)/.exec(p);
  const rb = /^roles\.review_board\.members\.(\d+)\.(id|provider|model|effort)/.exec(p);
  const b = /^budget\.(daily_micro_usd|per_ticket_ratio|offpeak_preference)\b/.exec(p);
  if (r) field = `${r[1]}.${r[2]}`;
  else if (b) field = `budget.${b[1]}`;
  else if (rb) field = `reviewers.${rb[1]}.${rb[2]}`;
  else if (p.startsWith("roles.review_board")) field = "reviewers";
  return { field, message };
}

function pricingFieldError(message: string, p: readonly (string | number)[]): DesktopFieldError {
  return {
    field: p[0] === "models" && typeof p[1] === "string" ? `pricing.${p[1]}` : "pricing",
    message,
  };
}

/** 角色用的服务商必须在 providers 里、模型必须在该服务商的 models 里，且价格表有这个模型的单价 */
function crossCheck(cfg: Json, priced: Json, form: DesktopModelForm): DesktopFieldError[] {
  const providers = isObj(cfg.providers) ? cfg.providers : {};
  const out: DesktopFieldError[] = [];
  const check = (field: string, r: { provider: string; model: string }) => {
    const pv = providers[r.provider];
    if (!isObj(pv)) {
      out.push({ field: `${field}.provider`, message: "没有这个服务商" });
      return;
    }
    if (!isObj(pv.models) || !Object.hasOwn(pv.models, r.model))
      out.push({ field: `${field}.model`, message: "这个服务商下没有这个模型" });
    else if (!Object.hasOwn(priced, r.model))
      out.push({ field: `pricing.${r.model}`, message: "缺少这个模型的单价" });
  };
  check("supervisor", form.supervisor);
  check("coder", form.coder);
  form.reviewers.forEach((r, i) => check(`reviewers.${i}`, r));
  const seen = new Set<string>();
  return out.filter((e) => (seen.has(e.field) ? false : (seen.add(e.field), true)));
}

const isRate = (v: unknown): v is DesktopPriceRate =>
  isObj(v) &&
  Object.keys(v).length === 3 &&
  (["input_cache_hit", "input_cache_miss", "output"] as const).every(
    (k) => Number.isSafeInteger(v[k]) && (v[k] as number) >= 0,
  );

/** 参数形状：名字只许常见字符、档位在枚举里、单价是非负整数；多余的键一律拒绝 */
export function parseSaveInput(
  v: unknown,
): { form: DesktopModelForm; pricing: DesktopModelPricing } | null {
  if (!isObj(v) || !isObj(v.form) || !isObj(v.pricing)) return null;
  const name = (x: unknown) => typeof x === "string" && NAME_RE.test(x);
  const eff = (x: unknown) => (DESKTOP_EFFORTS as readonly unknown[]).includes(x);
  const { supervisor: s, coder: c, reviewers: rs } = v.form;
  if (!isObj(s) || !name(s.provider) || !name(s.model) || Object.keys(s).length !== 2) return null;
  if (
    !isObj(c) ||
    !name(c.provider) ||
    !name(c.model) ||
    !eff(c.effort) ||
    Object.keys(c).length !== 3
  )
    return null;
  if (!Array.isArray(rs) || rs.length > MAX_REVIEWERS) return null;
  for (const r of rs)
    if (
      !isObj(r) ||
      !name(r.id) ||
      !name(r.provider) ||
      !name(r.model) ||
      !eff(r.effort) ||
      Object.keys(r).length !== 4
    )
      return null;
  const entries = Object.entries(v.pricing);
  if (entries.length > MAX_PRICED) return null;
  for (const [k, p] of entries)
    if (
      !name(k) ||
      !isObj(p) ||
      Object.keys(p).length !== 2 ||
      !isRate(p.peak) ||
      !isRate(p.offpeak)
    )
      return null;
  const pick = <T extends Json>(o: T, ks: readonly string[]) =>
    Object.fromEntries(ks.map((k) => [k, o[k]]));
  return {
    form: {
      supervisor: pick(s, ["provider", "model"]) as DesktopModelForm["supervisor"],
      coder: pick(c, ["provider", "model", "effort"]) as DesktopModelForm["coder"],
      reviewers: rs.map((r) =>
        pick(r as Json, ["id", "provider", "model", "effort"]),
      ) as DesktopModelForm["reviewers"],
    },
    pricing: Object.fromEntries(
      entries.map(([k, p]) => [
        k,
        {
          peak: pick((p as Json).peak as Json, ["input_cache_hit", "input_cache_miss", "output"]),
          offpeak: pick((p as Json).offpeak as Json, [
            "input_cache_hit",
            "input_cache_miss",
            "output",
          ]),
        },
      ]),
    ) as unknown as DesktopModelPricing,
  };
}

/** 从合法的 models.json 原始对象取出 budget 段（validate 过，字段一定在） */
export function budgetFromConfig(raw: Json): DesktopBudgetForm {
  const b = isObj(raw.budget) ? raw.budget : {};
  return {
    daily_micro_usd: typeof b.daily_micro_usd === "number" ? b.daily_micro_usd : 0,
    per_ticket_ratio: typeof b.per_ticket_ratio === "number" ? b.per_ticket_ratio : 0.05,
    offpeak_preference: b.offpeak_preference === true,
  };
}

/** 每日预算的上限（100 万美元），同 T-113 生成配置 */
export const MAX_DAILY_MICRO_USD = 1_000_000_000_000;

/** 预算的范围检查：每日预算是正整数微美元；比例在 (0, 1]，0、负数、大于 1、NaN 都拒绝 */
export function budgetRangeErrors(b: DesktopBudgetForm): DesktopFieldError[] {
  const out: DesktopFieldError[] = [];
  const d = b.daily_micro_usd;
  if (!Number.isSafeInteger(d) || d <= 0 || d > MAX_DAILY_MICRO_USD)
    out.push({ field: "budget.daily_micro_usd", message: "每日预算必须大于 0，最多 6 位小数" });
  const r = b.per_ticket_ratio;
  if (!Number.isFinite(r) || !(r > 0) || r > 1)
    out.push({ field: "budget.per_ticket_ratio", message: "每单比例必须大于 0、不超过 1" });
  return out;
}

/**
 * 预算参数形状：恰好 `{ budget: { daily_micro_usd, per_ticket_ratio, offpeak_preference } }`，
 * 类型对（数字 / 数字 / 布尔）；多余的键一律拒绝。范围（> 0、(0,1]、NaN）留给 budgetRangeErrors 按字段报。
 */
export function parseBudgetInput(v: unknown): DesktopBudgetForm | null {
  if (!isObj(v) || Object.keys(v).length !== 1 || !isObj(v.budget)) return null;
  const b = v.budget;
  if (Object.keys(b).length !== 3) return null;
  if (typeof b.daily_micro_usd !== "number" || typeof b.per_ticket_ratio !== "number") return null;
  if (typeof b.offpeak_preference !== "boolean") return null;
  return {
    daily_micro_usd: b.daily_micro_usd,
    per_ticket_ratio: b.per_ticket_ratio,
    offpeak_preference: b.offpeak_preference,
  };
}
