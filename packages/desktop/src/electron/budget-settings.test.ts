// UI-07c：设置 › 预算（budget:status / settings:save 的 { budget }）。用真实的 3 writeConfig 写临时仓库。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeConfig } from "@bakacoding/app";
import { writePricing, type BudgetState } from "@bakacoding/config-budget";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopReloadResult } from "../shared/api.js";
import { BUDGET_STATUS_TEXT, MODEL_SETTINGS_TEXT } from "../shared/config-text.js";
import {
  budgetRangeErrors,
  modelSettingsHandlers,
  parseBudgetInput,
  type ModelSettingsDeps,
} from "./model-settings.js";

const repoConfig = fileURLToPath(new URL("../../../../config/", import.meta.url));
const SECRET = "sk-ui07c-secret-value-1234567890";

let root: string;
function seed() {
  const models = JSON.parse(readFileSync(join(repoConfig, "models.example.json"), "utf8"));
  models.budget = { daily_micro_usd: 5_000_000, per_ticket_ratio: 0.05, offpeak_preference: false };
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config/models.json"), JSON.stringify(models, null, 2));
}
const modelsPath = () => join(root, "config/models.json");
const readModels = () => JSON.parse(readFileSync(modelsPath(), "utf8"));

const STATE: BudgetState = {
  day: "2026-10-24",
  daily_limit_micro_usd: 5_000_000,
  spent_today_micro_usd: 1_234_567,
  resubmit_today_micro_usd: 0,
  remaining_today_micro_usd: 3_765_433,
  reserved_today_micro_usd: 1000,
  daily_exhausted: false,
  per_ticket_limit_micro_usd: 250_000,
  by_role_today: {} as BudgetState["by_role_today"],
  offpeak_now: false,
  offpeak_preference: false,
};

function deps(over: Partial<ModelSettingsDeps> = {}): ModelSettingsDeps {
  return {
    repoRoot: () => root,
    repoSource: () => "last_import",
    argv: [],
    env: { DEEPSEEK_API_KEY: SECRET },
    running: () => 0,
    reload: vi.fn(async (): Promise<DesktopReloadResult> => ({ state: "reloaded" })),
    writeConfig,
    writePricing,
    budgetState: vi.fn(async () => STATE),
    ...over,
  };
}
const budget = (over: Record<string, unknown> = {}) => ({
  budget: { daily_micro_usd: 8_000_000, per_ticket_ratio: 0.1, offpeak_preference: true, ...over },
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bc-ui07c-"));
  seed();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("budget:status", () => {
  it("回 budget 段；今天已花费原样来自 3 的 budgetState()，不另算", async () => {
    const d = deps();
    const r = await modelSettingsHandlers(d).budgetStatus();
    expect(d.budgetState).toHaveBeenCalledTimes(1);
    expect(r).toEqual({
      ok: true,
      source: "repo",
      readonly: false,
      budget: { daily_micro_usd: 5_000_000, per_ticket_ratio: 0.05, offpeak_preference: false },
      today: {
        day: "2026-10-24",
        spent_micro_usd: 1_234_567,
        reserved_micro_usd: 1000,
        daily_limit_micro_usd: 5_000_000,
        per_ticket_limit_micro_usd: 250_000,
      },
      running: 0,
    });
  });

  it("budgetState 换个数，结果跟着换（证明没有自己从台账算）", async () => {
    const r = await modelSettingsHandlers(
      deps({ budgetState: async () => ({ ...STATE, spent_today_micro_usd: 42 }) }),
    ).budgetStatus();
    expect(r.ok && r.today?.spent_micro_usd).toBe(42);
  });

  it("只读后端（budgetState 回 null）或抛错时 today 为 null，不编数", async () => {
    const a = await modelSettingsHandlers(deps({ budgetState: async () => null })).budgetStatus();
    expect(a).toMatchObject({ ok: true, today: null });
    const b = await modelSettingsHandlers(
      deps({
        budgetState: async () => {
          throw new Error(`boom ${root}/config/models.json`);
        },
      }),
    ).budgetStatus();
    expect(b).toMatchObject({ ok: true, today: null });
    expect(JSON.stringify(b)).not.toContain(root);
  });

  it("--config / BAKACODING_CONFIG 时只读，照实给出来源", async () => {
    const ext = join(root, "elsewhere.json");
    writeFileSync(ext, readFileSync(modelsPath()));
    const a = await modelSettingsHandlers(
      deps({ argv: ["electron", "--config", ext] }),
    ).budgetStatus();
    expect(a).toMatchObject({ ok: true, source: "--config", readonly: true });
    const b = await modelSettingsHandlers(deps({ env: { BAKACODING_CONFIG: ext } })).budgetStatus();
    expect(b).toMatchObject({ ok: true, source: "BAKACODING_CONFIG", readonly: true });
    expect(JSON.stringify([a, b])).not.toContain(root);
  });

  it("没选仓库 / 读不到 / 不合法时回固定文案，不带路径", async () => {
    const a = await modelSettingsHandlers(deps({ repoSource: () => "cwd" })).budgetStatus();
    expect(a).toEqual({ ok: false, code: "cwd_repo", reason: BUDGET_STATUS_TEXT.cwd_repo });
    writeFileSync(modelsPath(), "{ not json");
    const b = await modelSettingsHandlers(deps()).budgetStatus();
    expect(b).toEqual({ ok: false, code: "read_failed", reason: BUDGET_STATUS_TEXT.read_failed });
    writeFileSync(modelsPath(), JSON.stringify({ budget: {} }));
    const c = await modelSettingsHandlers(deps()).budgetStatus();
    expect(c).toMatchObject({ ok: false, code: "invalid_config" });
    expect(JSON.stringify([a, b, c])).not.toContain(root);
  });
});

describe("settings:save { budget }", () => {
  it("校验 → 只写 models.json 的 budget 段 → 重载；其余原样，不碰 pricing.json", async () => {
    const before = readModels();
    const d = deps();
    const r = await modelSettingsHandlers(d).save(budget());
    expect(r).toEqual({ ok: true, written: ["models"], reload: { state: "reloaded" } });
    const after = readModels();
    expect(after.budget).toEqual(budget().budget);
    expect({ ...after, budget: null }).toEqual({ ...before, budget: null });
    expect(d.reload).toHaveBeenCalledTimes(1);
  });

  it("每日预算低于今天已花费也照存（只在界面警告，不拦）", async () => {
    const r = await modelSettingsHandlers(deps()).save(budget({ daily_micro_usd: 1 }));
    expect(r.ok).toBe(true);
    expect(readModels().budget.daily_micro_usd).toBe(1);
  });

  it.each([
    ["0", 0],
    ["负数", -0.1],
    ["大于 1", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("比例是 %s 时拒绝，按字段报，不写不重载", async (_n, ratio) => {
    const d = deps();
    const r = await modelSettingsHandlers(d).save(budget({ per_ticket_ratio: ratio }));
    expect(r).toMatchObject({ ok: false, code: "invalid", written: [] });
    expect(!r.ok && r.errors?.map((e) => e.field)).toEqual(["budget.per_ticket_ratio"]);
    expect(readModels().budget.per_ticket_ratio).toBe(0.05);
    expect(d.reload).not.toHaveBeenCalled();
  });

  it("比例正好是 1 可以存", async () => {
    expect((await modelSettingsHandlers(deps()).save(budget({ per_ticket_ratio: 1 }))).ok).toBe(
      true,
    );
  });

  it.each([
    ["0", 0],
    ["负数", -1],
    ["小数微美元", 1.5],
    ["NaN", Number.NaN],
  ])("每日预算是 %s 时拒绝（必填、> 0）", async (_n, daily) => {
    const r = await modelSettingsHandlers(deps()).save(budget({ daily_micro_usd: daily }));
    expect(r).toMatchObject({ ok: false, code: "invalid" });
    expect(!r.ok && r.errors?.map((e) => e.field)).toEqual(["budget.daily_micro_usd"]);
    expect(readModels().budget.daily_micro_usd).toBe(5_000_000);
  });

  it("缺每日预算、类型不对或多余键：invalid_input，不写", async () => {
    const h = modelSettingsHandlers(deps());
    for (const bad of [
      { budget: { per_ticket_ratio: 0.1, offpeak_preference: true } },
      { budget: { daily_micro_usd: null, per_ticket_ratio: 0.1, offpeak_preference: true } },
      { budget: { daily_micro_usd: "5", per_ticket_ratio: 0.1, offpeak_preference: true } },
      budget({ extra: 1 }),
      { ...budget(), form: {} },
    ])
      expect(await h.save(bad)).toMatchObject({ ok: false, code: "invalid_input", written: [] });
    expect(parseBudgetInput(budget())).toEqual(budget().budget);
    expect(readModels().budget.daily_micro_usd).toBe(5_000_000);
  });

  it("配置来自 --config / BAKACODING_CONFIG 时只读：拒绝，不碰外部文件也不重载", async () => {
    const ext = join(root, "elsewhere.json");
    writeFileSync(ext, readFileSync(modelsPath()));
    const before = readFileSync(ext, "utf8");
    for (const over of [
      { argv: ["electron", "--config", ext] },
      { env: { BAKACODING_CONFIG: ext } },
    ]) {
      const d = deps(over);
      const r = await modelSettingsHandlers(d).save(budget());
      expect(r).toEqual({
        ok: false,
        code: "external_config",
        reason: MODEL_SETTINGS_TEXT.external_config,
        written: [],
      });
      expect(d.reload).not.toHaveBeenCalled();
    }
    expect(readFileSync(ext, "utf8")).toBe(before);
    expect(readModels().budget.daily_micro_usd).toBe(5_000_000);
  });

  it("有在途单时文件照写，重载排队的结果原样回给界面", async () => {
    const reload = vi.fn(async (): Promise<DesktopReloadResult> => ({
      state: "queued",
      waitingTickets: 2,
    }));
    const r = await modelSettingsHandlers(deps({ running: () => 2, reload })).save(budget());
    expect(r).toEqual({
      ok: true,
      written: ["models"],
      reload: { state: "queued", waitingTickets: 2 },
    });
  });

  it("写失败 / 重载失败的原因去掉绝对路径", async () => {
    const a = await modelSettingsHandlers(
      deps({
        writeConfig: async () => ({ ok: false, errors: [`EACCES ${root}/config/models.json`] }),
      }),
    ).save(budget());
    expect(a).toMatchObject({ ok: false, code: "write_failed", written: [] });
    const b = await modelSettingsHandlers(
      deps({ reload: async () => ({ state: "failed", reason: `坏了 ${root}/x` }) }),
    ).save(budget());
    expect(b).toMatchObject({ ok: true, reload: { state: "failed" } });
    expect(JSON.stringify([a, b])).not.toContain(root);
  });

  it("models.json 是符号链接时不写", async () => {
    const real = join(root, "real.json");
    writeFileSync(real, readFileSync(modelsPath()));
    rmSync(modelsPath());
    symlinkSync(real, modelsPath());
    const r = await modelSettingsHandlers(deps()).save(budget());
    expect(r).toMatchObject({ ok: false, code: "unsafe_path" });
  });

  it("没有 pricing.json 也能存预算（只写 models.json）", async () => {
    expect((await modelSettingsHandlers(deps()).save(budget())).ok).toBe(true);
  });
});

describe("budgetRangeErrors（不靠 3 的 validate 兜底）", () => {
  const f = (daily: number, ratio: number) =>
    budgetRangeErrors({
      daily_micro_usd: daily,
      per_ticket_ratio: ratio,
      offpeak_preference: false,
    }).map((e) => e.field);
  it("比例只收 (0,1]", () => {
    expect(f(1, 1)).toEqual([]);
    expect(f(1, 0.0001)).toEqual([]);
    for (const r of [0, -0.1, 1.0001, Number.NaN, Number.POSITIVE_INFINITY])
      expect(f(1, r)).toEqual(["budget.per_ticket_ratio"]);
  });
  it("每日预算是正整数微美元", () => {
    for (const d of [0, -1, 1.5, Number.NaN, 1e13])
      expect(f(d, 0.5)).toEqual(["budget.daily_micro_usd"]);
  });
});
