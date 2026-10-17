// T-113：「生成配置」（repo:init-config）——预算必填、模板来源、备份后覆盖（要确认）、exclude、路径校验、
// 嵌套 / 非仓库 / cwd 拒绝、写失败和复查失败都撤回、错误不带配置值。
// 3 的 writePricing（T-114，PR #148）还没合入：这里用按它签名和写法（2 空格缩进、末尾换行、只写 pricing.json）写的 fake。
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureExcludeLines, writeConfig, type RepoCheck } from "@bakacoding/app";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DesktopConfigFixResult } from "../shared/api.js";
import { CONFIG_FIX_TEXT, NESTED_REPO_REASON } from "../shared/config-text.js";
import {
  backupName,
  configFixHandlers,
  configTemplateDir,
  EXCLUDE_RULE,
  MAX_DAILY_MICRO_USD,
  parseInitConfig,
  writePricingFrom,
  type ConfigFixDeps,
  type WritePricingFn,
} from "./config-fix.js";
import { needsRepoPrep } from "./backend-switcher.js";

const TEMPLATE_DIR = fileURLToPath(new URL("../../../../config", import.meta.url));
const MODELS_TPL = readFileSync(join(TEMPLATE_DIR, "models.example.json"), "utf8");
const PRICING_TPL = readFileSync(join(TEMPLATE_DIR, "pricing.json"), "utf8");
const FAKE_DS = "sk-t113fakefakefakefakefake0001";

let dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
const saved = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME };
let home = "";
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "bc-home-"));
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, ".config");
});
afterAll(() => {
  if (saved.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = saved.HOME;
  if (saved.XDG === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = saved.XDG;
  rmSync(home, { recursive: true, force: true });
});

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", a, { cwd, encoding: "utf8" }).trim();

function gitRepo(): string {
  const r = tmp("bc-t113-");
  git(r, "init", "-q", "-b", "main");
  return r;
}

const check = (code?: "not_git" | "nested_repo"): RepoCheck =>
  ({
    items: [code ? { id: "git", ok: false, code } : { id: "git", ok: true }],
    current_branch: null,
    identity: { name: false, email: false },
  }) as RepoCheck;

/** T-114 writePricing 的 fake：同签名；只写 pricing.json；写传进来的对象，2 空格缩进、末尾换行 */
const fakeWritePricing: WritePricingFn = async (path, pricing) => {
  if (basename(path) !== "pricing.json")
    return { ok: false, errors: ["(file): 只能写 pricing.json"] };
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(pricing, null, 2)}\n`);
  return { ok: true };
};

function handlers(root: string, over: Partial<ConfigFixDeps> = {}) {
  const reconnect = vi.fn(async () => ({ state: "reloaded" as const }));
  const writePricing = vi.fn(fakeWritePricing);
  const h = configFixHandlers({
    repoRoot: () => root,
    repoSource: () => "last_import",
    reconnect,
    argv: [],
    env: { DEEPSEEK_API_KEY: FAKE_DS },
    templateDir: TEMPLATE_DIR,
    checkRepo: async () => check(),
    writeConfig,
    writePricing,
    ensureExcludeLines,
    now: () => new Date("2026-10-18T07:03:00.123Z"),
    ...over,
  });
  return { h, reconnect, writePricing };
}

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
const exclude = (root: string) => readFileSync(join(root, ".git", "info", "exclude"), "utf8");
const ok = (r: DesktopConfigFixResult) => {
  if (!r.ok) throw new Error(`expected ok, got ${r.code}`);
  return r;
};

describe("parseInitConfig / backupName / writePricingFrom / configTemplateDir", () => {
  it("预算必须是 1..MAX 的整数；confirm_overwrite 只认布尔；参数不是对象就拒绝", () => {
    expect(parseInitConfig({ daily_micro_usd: 1 })).toEqual({ daily: 1, confirm: false });
    expect(parseInitConfig({ confirm_overwrite: true })).toEqual({ confirm: true });
    for (const d of [0, -1, 1.5, "5", Number.NaN, Infinity, MAX_DAILY_MICRO_USD + 1, null])
      expect(parseInitConfig({ daily_micro_usd: d })).toBe("invalid_budget");
    expect(parseInitConfig({ confirm_overwrite: "yes" })).toBe("invalid_budget");
    for (const v of [null, 1, "x", []]) expect(parseInitConfig(v)).toBe("invalid_budget");
  });

  it("备份名：<文件名>.bak-<UTC 时间>，重名加序号", () => {
    const t = new Date("2026-10-18T07:03:00.123Z");
    expect(backupName("models.json", t)).toBe("models.json.bak-20261018T070300Z");
    expect(backupName("models.json", t, 2)).toBe("models.json.bak-20261018T070300Z-2");
  });

  it("writePricingFrom：3 有 writePricing 就用，没有（T-114 合入前）就是 undefined", () => {
    const fn = async () => ({ ok: true as const });
    expect(writePricingFrom({ writePricing: fn })).toBe(fn);
    expect(writePricingFrom({})).toBeUndefined();
    expect(writePricingFrom({ writePricing: "x" })).toBeUndefined();
  });

  it("模板目录：打包后在 exe 旁边的 config-templates/，开发时是仓库根的 config/", () => {
    expect(configTemplateDir(true, "/opt/BakaCoding/BakaCoding.exe", "/x")).toBe(
      join("/opt/BakaCoding", "config-templates"),
    );
    expect(configTemplateDir(false, "/e", "/r/packages/desktop/dist-electron")).toBe(
      join("/r", "config"),
    );
  });
});

describe("repo:init-config：两个都缺（T-113）", () => {
  it("预算必填：不给就拒绝，什么都不写", async () => {
    const root = gitRepo();
    const { h, writePricing } = handlers(root);
    await expect(h.initConfig({})).resolves.toEqual({
      ok: false,
      code: "invalid_budget",
      reason: CONFIG_FIX_TEXT.invalid_budget,
    });
    expect(existsSync(join(root, "config"))).toBe(false);
    expect(writePricing).not.toHaveBeenCalled();
  });

  it("生成：models.json 和模板只差 budget.daily_micro_usd；pricing.json 经 writePricing 写模板内容；写进 exclude、不提交", async () => {
    const root = gitRepo();
    const { h, reconnect, writePricing } = handlers(root);
    const r = ok(await h.initConfig({ daily_micro_usd: 1_234_567 }));
    expect(r).toEqual({
      ok: true,
      written: ["models", "pricing"],
      backups: [],
      excluded: true,
      reload: { state: "reloaded" },
    });
    const tpl = JSON.parse(MODELS_TPL) as { budget: Record<string, unknown> };
    const got = readJson(join(root, "config", "models.json"));
    expect(got).toEqual({ ...tpl, budget: { ...tpl.budget, daily_micro_usd: 1_234_567 } });
    // 模板里的 $5.00 不当默认值
    expect((got.budget as Record<string, unknown>).daily_micro_usd).not.toBe(
      tpl.budget.daily_micro_usd,
    );
    expect(writePricing).toHaveBeenCalledTimes(1);
    expect(writePricing.mock.calls[0]![0]).toBe(join(root, "config", "pricing.json"));
    expect(writePricing.mock.calls[0]![1]).toEqual(JSON.parse(PRICING_TPL));
    expect(readJson(join(root, "config", "pricing.json"))).toEqual(JSON.parse(PRICING_TPL));
    expect(exclude(root)).toContain(`${EXCLUDE_RULE.models}\n`);
    expect(exclude(root)).toContain(`${EXCLUDE_RULE.pricing}\n`);
    // 不进首次提交：git 看不到这两个文件
    expect(git(root, "ls-files", "--others", "--exclude-standard")).toBe("");
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("模板不在：template_missing，不写", async () => {
    const root = gitRepo();
    const { h } = handlers(root, { templateDir: tmp("bc-notpl-") });
    await expect(h.initConfig({ daily_micro_usd: 5 })).resolves.toMatchObject({
      code: "template_missing",
    });
    expect(existsSync(join(root, "config", "models.json"))).toBe(false);
  });

  it("3 还没有 writePricing（T-114 合入前）：要写 pricing.json 时 unavailable，什么都不写", async () => {
    const root = gitRepo();
    const { h } = handlers(root, { writePricing: undefined });
    await expect(h.initConfig({ daily_micro_usd: 5 })).resolves.toMatchObject({
      code: "unavailable",
      reason: CONFIG_FIX_TEXT.unavailable,
    });
    expect(existsSync(join(root, "config"))).toBe(false);
  });
});

describe("repo:init-config：已有但不合法（先备份再覆盖，要确认）", () => {
  const badModels = `{"providers": "${FAKE_DS}"}`;
  function badRepo() {
    const root = gitRepo();
    mkdirSync(join(root, "config"));
    writeFileSync(join(root, "config", "models.json"), badModels);
    writeFileSync(join(root, "config", "pricing.json"), PRICING_TPL);
    return root;
  }

  it("没确认：confirm_required，原文件不动、不备份", async () => {
    const root = badRepo();
    const { h } = handlers(root);
    await expect(h.initConfig({ daily_micro_usd: 5 })).resolves.toMatchObject({
      code: "confirm_required",
    });
    expect(readFileSync(join(root, "config", "models.json"), "utf8")).toBe(badModels);
    expect(readdirSync(join(root, "config")).sort()).toEqual(["models.json", "pricing.json"]);
  });

  it("确认后：原文件逐字节备份成 .bak-*，再覆盖；备份规则写进 exclude，git 看不到备份；只写不合法的那个", async () => {
    const root = badRepo();
    const { h, writePricing } = handlers(root);
    const r = ok(await h.initConfig({ daily_micro_usd: 5, confirm_overwrite: true }));
    expect(r.written).toEqual(["models"]);
    expect(r.backups).toEqual(["models.json.bak-20261018T070300Z"]);
    expect(writePricing).not.toHaveBeenCalled();
    expect(readFileSync(join(root, "config", r.backups[0]!), "utf8")).toBe(badModels);
    expect(readJson(join(root, "config", "models.json")).budget).toMatchObject({
      daily_micro_usd: 5,
    });
    expect(exclude(root)).toContain(`${EXCLUDE_RULE.backup}\n`);
    expect(exclude(root)).toContain(`${EXCLUDE_RULE.models}\n`);
    expect(exclude(root)).not.toContain(EXCLUDE_RULE.pricing);
    expect(git(root, "ls-files", "--others", "--exclude-standard")).toBe("config/pricing.json");
    // 结果和错误里都没有原文件里的密钥值和路径
    expect(JSON.stringify(r)).not.toContain(FAKE_DS);
    expect(JSON.stringify(r)).not.toContain(root);
  });

  it("同一秒已有备份：不覆盖旧备份，换个序号", async () => {
    const root = badRepo();
    writeFileSync(join(root, "config", "models.json.bak-20261018T070300Z"), "old");
    const { h } = handlers(root);
    const r = ok(await h.initConfig({ daily_micro_usd: 5, confirm_overwrite: true }));
    expect(r.backups).toEqual(["models.json.bak-20261018T070300Z-1"]);
    expect(readFileSync(join(root, "config", "models.json.bak-20261018T070300Z"), "utf8")).toBe(
      "old",
    );
  });

  it("writePricing 失败：已写的 models.json 从备份恢复，回 write_failed（错误已脱敏）", async () => {
    const root = badRepo();
    writeFileSync(join(root, "config", "pricing.json"), "{");
    const { h } = handlers(root, {
      writePricing: async () => ({ ok: false, errors: ["(file): 写入配置失败（EACCES）"] }),
    });
    const r = await h.initConfig({ daily_micro_usd: 5, confirm_overwrite: true });
    expect(r).toMatchObject({
      ok: false,
      code: "write_failed",
      errors: ["(file): 写入配置失败（EACCES）"],
    });
    expect(readFileSync(join(root, "config", "models.json"), "utf8")).toBe(badModels);
  });

  it("写完复查不过：撤回（原来缺的删掉、原来坏的恢复），回 verify_failed", async () => {
    const root = gitRepo();
    const { h } = handlers(root, {
      writePricing: async (p) => {
        writeFileSync(p, '{"not": "pricing"}');
        return { ok: true };
      },
    });
    const r = await h.initConfig({ daily_micro_usd: 5 });
    expect(r).toMatchObject({ ok: false, code: "verify_failed" });
    expect(existsSync(join(root, "config", "models.json"))).toBe(false);
    expect(existsSync(join(root, "config", "pricing.json"))).toBe(false);
  });
});

describe("repo:init-config：拒绝（T-113）", () => {
  it("仓库来源是当前工作目录或不明：cwd_repo", async () => {
    for (const src of ["cwd", undefined] as const) {
      const root = gitRepo();
      const { h } = handlers(root, { repoSource: () => src });
      await expect(h.initConfig({ daily_micro_usd: 5 })).resolves.toMatchObject({
        code: "cwd_repo",
      });
      expect(existsSync(join(root, "config"))).toBe(false);
    }
  });

  it("嵌套仓库（T-114 的 nested_repo）/ 不是仓库：先拒绝，不写", async () => {
    const root = tmp("bc-t113-ng-");
    for (const [code, want] of [
      ["nested_repo", NESTED_REPO_REASON],
      ["not_git", CONFIG_FIX_TEXT.not_git],
    ] as const) {
      const { h } = handlers(root, { checkRepo: async () => check(code) });
      await expect(h.initConfig({ daily_micro_usd: 5 })).resolves.toEqual({
        ok: false,
        code,
        reason: want,
      });
    }
    expect(existsSync(join(root, "config"))).toBe(false);
  });

  it("config/ 是符号链接、或 models.json 是符号链接：unsafe_path，不往链接目标写", async () => {
    const outside = tmp("bc-t113-out-");
    const r1 = gitRepo();
    symlinkSync(outside, join(r1, "config"), "dir");
    await expect(handlers(r1).h.initConfig({ daily_micro_usd: 5 })).resolves.toMatchObject({
      code: "unsafe_path",
    });
    expect(readdirSync(outside)).toEqual([]);

    const r2 = gitRepo();
    mkdirSync(join(r2, "config"));
    writeFileSync(join(outside, "target.json"), "{");
    symlinkSync(join(outside, "target.json"), join(r2, "config", "models.json"));
    await expect(
      handlers(r2).h.initConfig({ daily_micro_usd: 5, confirm_overwrite: true }),
    ).resolves.toMatchObject({ code: "unsafe_path" });
    expect(readFileSync(join(outside, "target.json"), "utf8")).toBe("{");
  });

  it("models.json 是 --config / BAKACODING_CONFIG 指定的文件：不生成它；只剩它不对时 external_config", async () => {
    const root = gitRepo();
    mkdirSync(join(root, "config"));
    writeFileSync(join(root, "config", "pricing.json"), PRICING_TPL);
    const ext = join(tmp("bc-t113-ext-"), "m.json");
    writeFileSync(ext, "{");
    const { h } = handlers(root, { env: { BAKACODING_CONFIG: ext } });
    await expect(h.initConfig({})).resolves.toMatchObject({ code: "external_config" });
    expect(readFileSync(ext, "utf8")).toBe("{");
    // pricing 缺了还能生成，且不要求填预算
    rmSync(join(root, "config", "pricing.json"));
    const r = ok(await h.initConfig({}));
    expect(r.written).toEqual(["pricing"]);
    expect(readFileSync(ext, "utf8")).toBe("{");
  });

  it("参数不对：invalid_budget；内部异常：只回固定文案", async () => {
    const root = gitRepo();
    const { h } = handlers(root);
    await expect(h.initConfig("x")).resolves.toMatchObject({ code: "invalid_budget" });
    const { h: h2 } = handlers(root, {
      checkRepo: async () => {
        throw new Error(`boom ${root} ${FAKE_DS}`);
      },
    });
    await expect(h2.initConfig({ daily_micro_usd: 5 })).resolves.toEqual({
      ok: false,
      code: "failed",
      reason: CONFIG_FIX_TEXT.failed,
    });
  });
});

describe("导入后进准备页（T-113）", () => {
  it("needsRepoPrep：config_missing / config_invalid / nested_repo 的只读后端装上、进准备页；别的不算", () => {
    const ro = (code: string) => ({
      mode: "readonly" as const,
      error: { name: "Error", message: "x", code },
    });
    for (const c of ["config_missing", "config_invalid", "nested_repo", "not_git"])
      expect(needsRepoPrep(ro(c))).toBe(true);
    expect(needsRepoPrep(ro("ENOENT"))).toBe(false);
  });
});
