// UI-07b：设置 › 模型（settings:config-get / settings:save）。用真实的 3 writeConfig / writePricing 写临时仓库。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeConfig } from "@bakacoding/app";
import { writePricing } from "@bakacoding/config-budget";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopModelSaveInput, DesktopReloadResult } from "../shared/api.js";
import { MODEL_SETTINGS_TEXT } from "../shared/config-text.js";
import { modelSettingsHandlers, parseSaveInput, type ModelSettingsDeps } from "./model-settings.js";

const repoConfig = fileURLToPath(new URL("../../../../config/", import.meta.url));
const SECRET = "sk-ui07b-secret-value-1234567890";
const GH = "ghp_ui07bTokenValueABCDEFGHIJKLMNOP";

let root: string;
function seed() {
  const models = JSON.parse(readFileSync(join(repoConfig, "models.example.json"), "utf8"));
  models.budget = { ...models.budget, daily_micro_usd: 5_000_000 };
  models.providers.deepseek.models["deepseek-v4-pro"] = {};
  const pricing = JSON.parse(readFileSync(join(repoConfig, "pricing.json"), "utf8"));
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config/models.json"), JSON.stringify(models, null, 2));
  writeFileSync(join(root, "config/pricing.json"), JSON.stringify(pricing, null, 2));
}
const readModels = () => JSON.parse(readFileSync(join(root, "config/models.json"), "utf8"));
const readPricing = () => JSON.parse(readFileSync(join(root, "config/pricing.json"), "utf8"));

function deps(over: Partial<ModelSettingsDeps> = {}): ModelSettingsDeps {
  return {
    repoRoot: () => root,
    repoSource: () => "last_import",
    argv: [],
    env: { DEEPSEEK_API_KEY: SECRET, GITHUB_TOKEN: GH },
    running: () => 0,
    reload: vi.fn(async (): Promise<DesktopReloadResult> => ({ state: "reloaded" })),
    writeConfig,
    writePricing,
    ...over,
  };
}

const rate = (n: number) => ({ input_cache_hit: n, input_cache_miss: n * 2, output: n * 3 });
function input(over: Partial<DesktopModelSaveInput["form"]> = {}): DesktopModelSaveInput {
  return {
    form: {
      supervisor: { provider: "deepseek", model: "deepseek-v4-pro" },
      coder: { provider: "deepseek", model: "deepseek-flash", effort: "high" },
      reviewers: [
        { id: "reviewer-1", provider: "deepseek", model: "deepseek-v4-pro", effort: "max" },
      ],
      ...over,
    },
    pricing: { "deepseek-v4-pro": { peak: rate(10), offpeak: rate(5) } },
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bc-ui07b-"));
  seed();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("settings:config-get", () => {
  it("回表单、服务商和单价；密钥只有是否已设，结果里没有任何密钥值、路径和 base_url", async () => {
    const r = await modelSettingsHandlers(deps()).configGet();
    expect(r).toMatchObject({ ok: true, source: "repo", readonly: false, running: 0 });
    if (!r.ok) throw new Error("应成功");
    expect(r.form.supervisor).toEqual({ provider: "deepseek", model: "deepseek-flash" });
    expect(r.form.coder).toEqual({ provider: "deepseek", model: "deepseek-flash", effort: "low" });
    expect(r.form.reviewers).toHaveLength(2);
    expect(r.providers).toEqual([
      {
        id: "deepseek",
        models: ["deepseek-flash", "deepseek-v4-pro"],
        credential: { name: "DEEPSEEK_API_KEY", set: true },
      },
    ]);
    expect(Object.keys(r.pricing)).toContain("deepseek-flash");
    const text = JSON.stringify(r);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(GH);
    expect(text).not.toContain(root);
    expect(text).not.toContain("base_url");
    expect(text).not.toContain("https://");
  });

  it("配置里的键名恰好是密钥值时也不回（整段换掉）", async () => {
    const m = readModels();
    m.providers.deepseek.models[SECRET] = {};
    writeFileSync(join(root, "config/models.json"), JSON.stringify(m));
    const r = await modelSettingsHandlers(deps()).configGet();
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("密钥没设时 set:false", async () => {
    const r = await modelSettingsHandlers(deps({ env: {} })).configGet();
    expect(r.ok && r.providers[0]!.credential).toEqual({ name: "DEEPSEEK_API_KEY", set: false });
  });

  it("--config / BAKACODING_CONFIG 指定时只读，并照实给出来源", async () => {
    const ext = join(root, "elsewhere.json");
    writeFileSync(ext, readFileSync(join(root, "config/models.json")));
    const a = await modelSettingsHandlers(
      deps({ argv: ["electron", "--config", ext] }),
    ).configGet();
    expect(a).toMatchObject({ ok: true, source: "--config", readonly: true });
    const b = await modelSettingsHandlers(
      deps({ env: { BAKACODING_CONFIG: ext, DEEPSEEK_API_KEY: SECRET } }),
    ).configGet();
    expect(b).toMatchObject({ ok: true, source: "BAKACODING_CONFIG", readonly: true });
    expect(JSON.stringify(b)).not.toContain(root);
  });

  it("没选仓库 / 读不到 / 不合法时回固定文案", async () => {
    expect(await modelSettingsHandlers(deps({ repoSource: () => "cwd" })).configGet()).toEqual({
      ok: false,
      code: "cwd_repo",
      reason: MODEL_SETTINGS_TEXT.cwd_repo,
    });
    writeFileSync(join(root, "config/models.json"), "{ bad");
    expect(await modelSettingsHandlers(deps()).configGet()).toMatchObject({ code: "read_failed" });
    writeFileSync(join(root, "config/models.json"), "{}");
    expect(await modelSettingsHandlers(deps()).configGet()).toMatchObject({
      code: "invalid_config",
    });
  });

  it("带上在途数", async () => {
    const r = await modelSettingsHandlers(deps({ running: () => 3 })).configGet();
    expect(r).toMatchObject({ ok: true, running: 3 });
  });
});

describe("settings:save", () => {
  it("校验 → 写 config → 写 pricing → 重载，按这个顺序；只改表单字段，其余原样保留", async () => {
    const order: string[] = [];
    const d = deps({
      writeConfig: async (p, c, o) => (order.push("config"), writeConfig(p, c, o)),
      writePricing: async (p, c, o) => (order.push("pricing"), writePricing(p, c, o)),
      reload: async () => (order.push("reload"), { state: "reloaded" }),
    });
    const before = readModels();
    const r = await modelSettingsHandlers(d).save(input());
    expect(r).toEqual({ ok: true, written: ["models", "pricing"], reload: { state: "reloaded" } });
    expect(order).toEqual(["config", "pricing", "reload"]);
    const m = readModels();
    expect(m.roles.supervisor).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      effort: "max",
    });
    expect(m.roles.coder).toEqual({
      ...before.roles.coder,
      model: "deepseek-flash",
      effort: "high",
    });
    expect(m.roles.review_board.members).toEqual([
      { id: "reviewer-1", provider: "deepseek", model: "deepseek-v4-pro", effort: "max" },
    ]);
    expect(m.roles.review_board.review_assignment).toBe(
      before.roles.review_board.review_assignment,
    );
    expect(m.roles.sub_agent).toEqual(before.roles.sub_agent);
    expect(m.budget).toEqual(before.budget);
    expect(readPricing().models["deepseek-v4-pro"]).toEqual({ peak: rate(10), offpeak: rate(5) });
    expect(readPricing().models["deepseek-flash"]).toBeDefined();
  });

  it("校验不过时一个文件都不写、不重载，错误按字段标出", async () => {
    const d = deps();
    const before = readFileSync(join(root, "config/models.json"), "utf8");
    const r = await modelSettingsHandlers(d).save(
      input({ coder: { provider: "deepseek", model: "no-such-model", effort: "low" } }),
    );
    expect(r).toMatchObject({ ok: false, code: "invalid", written: [] });
    expect(!r.ok && r.errors).toEqual([
      { field: "coder.model", message: "这个服务商下没有这个模型" },
    ]);
    expect(readFileSync(join(root, "config/models.json"), "utf8")).toBe(before);
    expect(d.reload).not.toHaveBeenCalled();
  });

  it("缺单价、主管混进评审池都按字段报", async () => {
    const pricingLess = { ...input(), pricing: {} };
    const p = readPricing();
    delete p.models["deepseek-v4-pro"];
    writeFileSync(join(root, "config/pricing.json"), JSON.stringify(p));
    const r = await modelSettingsHandlers(deps()).save(pricingLess);
    expect(!r.ok && r.errors?.map((e) => e.field)).toEqual(["pricing.deepseek-v4-pro"]);
    const r2 = await modelSettingsHandlers(deps()).save(
      input({
        reviewers: [
          { id: "supervisor", provider: "deepseek", model: "deepseek-flash", effort: "high" },
        ],
      }),
    );
    expect(!r2.ok && r2.errors?.[0]?.field).toBe("reviewers");
  });

  it("外部配置来源时拒绝保存，不写不重载", async () => {
    const d = deps({
      argv: ["electron", "--config=/etc/x.json"],
      writeConfig: vi.fn(),
      writePricing: vi.fn(),
    });
    expect(await modelSettingsHandlers(d).save(input())).toEqual({
      ok: false,
      code: "external_config",
      reason: MODEL_SETTINGS_TEXT.external_config,
      written: [],
    });
    const e = deps({ env: { BAKACODING_CONFIG: "x.json" }, writeConfig: vi.fn() });
    expect(await modelSettingsHandlers(e).save(input())).toMatchObject({ code: "external_config" });
    expect(d.writeConfig).not.toHaveBeenCalled();
    expect(e.writeConfig).not.toHaveBeenCalled();
    expect(d.reload).not.toHaveBeenCalled();
  });

  it("config 写成、pricing 没写成：written 只有 models，说明照实，报错不带绝对路径，不重载", async () => {
    const d = deps({
      writePricing: async (p) => ({
        ok: false,
        errors: [`EACCES: permission denied, open '${p}.tmp'`],
      }),
    });
    const r = await modelSettingsHandlers(d).save(input());
    expect(r).toMatchObject({
      ok: false,
      code: "partial_write",
      written: ["models"],
      reason: MODEL_SETTINGS_TEXT.partial_write,
    });
    expect(readModels().roles.supervisor.model).toBe("deepseek-v4-pro");
    expect(readPricing().models["deepseek-v4-pro"]).not.toEqual({
      peak: rate(10),
      offpeak: rate(5),
    });
    const text = JSON.stringify(r);
    expect(text).not.toContain(root);
    expect(text).not.toMatch(/\/tmp|\/home|[A-Z]:\\/);
    expect(!r.ok && r.errors?.[0]).toMatchObject({ field: "pricing" });
    expect(d.reload).not.toHaveBeenCalled();
  });

  it("config 就写失败：written 为空，报错不带绝对路径", async () => {
    const d = deps({
      writeConfig: async (p) => ({ ok: false, errors: [`ENOSPC at ${p}`] }),
      writePricing: vi.fn(),
    });
    const r = await modelSettingsHandlers(d).save(input());
    expect(r).toMatchObject({ ok: false, code: "write_failed", written: [] });
    expect(JSON.stringify(r)).not.toContain(root);
    expect(d.writePricing).not.toHaveBeenCalled();
  });

  it("有在途单时文件照写，重载排队的结果原样回给界面", async () => {
    const queued: DesktopReloadResult = { state: "queued", waitingTickets: 2, waitingChat: true };
    const d = deps({ running: () => 3, reload: vi.fn(async () => queued) });
    const r = await modelSettingsHandlers(d).save(input());
    expect(r).toEqual({ ok: true, written: ["models", "pricing"], reload: queued });
    expect(readModels().roles.supervisor.model).toBe("deepseek-v4-pro");
    expect(readPricing().models["deepseek-v4-pro"].peak).toEqual(rate(10));
    expect(d.reload).toHaveBeenCalledTimes(1);
  });

  it("重载失败的原因去掉绝对路径", async () => {
    const d = deps({
      reload: async () => ({ state: "failed", reason: `打不开 ${root}/state/x.db` }),
    });
    const r = await modelSettingsHandlers(d).save(input());
    expect(r.ok && r.reload.state).toBe("failed");
    expect(JSON.stringify(r)).not.toContain(root);
  });

  it("配置文件是符号链接时不写", async () => {
    const real = join(root, "real.json");
    writeFileSync(real, readFileSync(join(root, "config/models.json")));
    rmSync(join(root, "config/models.json"));
    symlinkSync(real, join(root, "config/models.json"));
    const d = deps({ writeConfig: vi.fn() });
    expect(await modelSettingsHandlers(d).save(input())).toMatchObject({ code: "unsafe_path" });
    expect(d.writeConfig).not.toHaveBeenCalled();
  });

  it("像密钥的值被 3 拒绝写入", async () => {
    const r = await modelSettingsHandlers(deps()).save(
      input({
        reviewers: [{ id: SECRET, provider: "deepseek", model: "deepseek-flash", effort: "high" }],
      }),
    );
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(readModels().roles.review_board.members[0].id).toBe("reviewer-1");
  });
});

describe("parseSaveInput", () => {
  it("拒绝多余键、非法档位、负数和小数单价、奇怪名字", () => {
    expect(parseSaveInput(input())).not.toBeNull();
    const bad = [
      null,
      { form: input().form },
      {
        ...input(),
        extra: 1,
        form: { ...input().form, supervisor: { provider: "deepseek", model: "x", effort: "max" } },
      },
      input({ coder: { provider: "deepseek", model: "x", effort: "ultra" as never } }),
      input({ supervisor: { provider: "../etc", model: "x" } }),
      { ...input(), pricing: { a: { peak: rate(-1), offpeak: rate(1) } } },
      { ...input(), pricing: { a: { peak: { ...rate(1), output: 1.5 }, offpeak: rate(1) } } },
    ];
    for (const b of bad) expect(parseSaveInput(b)).toBeNull();
  });
});
