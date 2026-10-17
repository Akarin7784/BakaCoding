// T-113：准备页「生成配置」（repo:init-config）。缺的或不合法的 config/models.json、config/pricing.json 用安装包里的
// 模板（config-templates/models.example.json、pricing.json）生成：models.json 只改 budget.daily_micro_usd（用户必填），
// 经 3 的 writeConfig 写；pricing.json 原样经 3 的 writePricing（T-114）写，桌面端不自己复制文件。
// 不合法的旧文件先备份成 `<名字>.bak-<UTC 时间>` 再覆盖（要用户确认）；生成的文件和备份都写进 .git/info/exclude，
// 不进首次提交。写完再用 3 的校验复查，不过就撤回。所有失败只回 shared/config-text.ts 的固定文案。
import { copyFile, lstat, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import type {
  ExcludeRule,
  RepoCheck,
  WriteConfigOptions,
  WriteConfigResult,
} from "@bakacoding/app";
import type {
  DesktopConfigCheck,
  DesktopConfigFixFailure,
  DesktopConfigFixResult,
  DesktopReloadResult,
  DesktopRepoSource,
} from "../shared/api.js";
import { CONFIG_FIX_TEXT } from "../shared/config-text.js";
import { inspectConfig, MODELS_FILE, PRICING_FILE } from "./config-inspect.js";

/** 安装包里的模板文件名（scripts/package-app.mjs 的 extraFiles，开发时是仓库根的 config/） */
export const MODELS_TEMPLATE = "models.example.json";
export const PRICING_TEMPLATE = "pricing.json";
/** 生成的文件和备份在 .git/info/exclude 里的规则（相对仓库根；只加这次写了的） */
export const EXCLUDE_RULE = {
  models: `/${MODELS_FILE}`,
  pricing: `/${PRICING_FILE}`,
  backup: "/config/*.json.bak-*",
} as const;
/** 每日预算上限（微美元）：100 万美元，防止误填一长串数字 */
export const MAX_DAILY_MICRO_USD = 1_000_000_000_000;

/** 3 的 writePricing（T-114，PR #148）签名；T-114 合入前由组装处按名字取，取不到就是 undefined */
export type WritePricingFn = (
  path: string,
  pricing: unknown,
  opts?: WriteConfigOptions,
) => Promise<WriteConfigResult>;
export type WriteConfigFn = (
  path: string,
  config: unknown,
  opts?: WriteConfigOptions,
) => Promise<WriteConfigResult>;

/**
 * 从 3 的模块对象里取 writePricing（T-114 / PR #148 合入前 3 还没有这个导出，取不到就是 undefined，
 * 「生成配置」要写 pricing.json 时回 unavailable）。T-114 合入后改成直接 import。
 */
export function writePricingFrom(mod: object): WritePricingFn | undefined {
  const fn = (mod as { writePricing?: unknown }).writePricing;
  return typeof fn === "function" ? (fn as WritePricingFn) : undefined;
}

/** 模板目录：打包后是 exe 旁边的 config-templates/（scripts/package-app.mjs），开发时是仓库根的 config/ */
export function configTemplateDir(packaged: boolean, execPath: string, mainDir: string): string {
  return packaged
    ? path.join(path.dirname(execPath), "config-templates")
    : path.resolve(mainDir, "..", "..", "..", "config");
}

export interface ConfigFixDeps {
  repoRoot(): string;
  repoSource(): DesktopRepoSource | undefined;
  reconnect(): Promise<DesktopReloadResult>;
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  /** 模板目录（打包后是 exe 旁边的 config-templates/） */
  templateDir: string;
  checkRepo(root: string): Promise<RepoCheck>;
  writeConfig: WriteConfigFn;
  writePricing: WritePricingFn | undefined;
  ensureExcludeLines(dir: string, lines: readonly ExcludeRule[]): Promise<boolean>;
  inspect?: typeof inspectConfig;
  now?: () => Date;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const failure = (
  code: DesktopConfigFixFailure["code"],
  errors?: string[],
): DesktopConfigFixFailure => ({
  ok: false,
  code,
  reason: CONFIG_FIX_TEXT[code],
  ...(errors && errors.length > 0 && { errors }),
});

export interface ParsedInitConfig {
  daily?: number;
  confirm: boolean;
}

/** 参数：必须是对象；daily_micro_usd 给了就得是 1..MAX 的整数；confirm_overwrite 给了就得是布尔。 */
export function parseInitConfig(v: unknown): ParsedInitConfig | "invalid_budget" {
  if (!isObj(v)) return "invalid_budget";
  const { daily_micro_usd: d, confirm_overwrite: c } = v;
  if (c !== undefined && typeof c !== "boolean") return "invalid_budget";
  if (d !== undefined) {
    if (typeof d !== "number" || !Number.isSafeInteger(d) || d < 1 || d > MAX_DAILY_MICRO_USD)
      return "invalid_budget";
  }
  return { ...(d !== undefined && { daily: d as number }), confirm: c === true };
}

/** 备份文件名：`models.json.bak-20261018T070300Z`（UTC，同一秒重名加 -1、-2…） */
export function backupName(file: string, now: Date, n = 0): string {
  const t = now
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[-:]/g, "");
  return `${file}.bak-${t}${n ? `-${n}` : ""}`;
}

/** 不存在 → "missing"；是普通文件（不是符号链接）→ "file"；别的 → "unsafe" */
async function kind(p: string): Promise<"missing" | "file" | "dir" | "unsafe"> {
  try {
    const s = await lstat(p);
    if (s.isSymbolicLink()) return "unsafe";
    if (s.isFile()) return "file";
    if (s.isDirectory()) return "dir";
    return "unsafe";
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unsafe";
  }
}

async function readTemplate(dir: string, name: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(dir, name), "utf8")) as unknown;
}

type Target = "models" | "pricing";

export interface ConfigFixHandlers {
  initConfig(arg: unknown): Promise<DesktopConfigFixResult>;
  /** repo:check 带上的配置状态（git 项不过时不给） */
  inspect(): DesktopConfigCheck;
}

export function configFixHandlers(deps: ConfigFixDeps): ConfigFixHandlers {
  const inspect = deps.inspect ?? inspectConfig;
  const now = deps.now ?? (() => new Date());
  return {
    inspect: () => inspect(deps.repoRoot(), deps.env, deps.argv),
    async initConfig(arg) {
      try {
        return await initConfig(arg);
      } catch {
        return failure("failed");
      }
    },
  };

  async function initConfig(arg: unknown): Promise<DesktopConfigFixResult> {
    const src = deps.repoSource();
    if (src === undefined || src === "cwd") return failure("cwd_repo");
    const req = parseInitConfig(arg === undefined ? {} : arg);
    if (req === "invalid_budget") return failure("invalid_budget");

    // 顺序同准备页：git 项先过（不是仓库 / 嵌套仓库都不写）
    const root = deps.repoRoot();
    let check: RepoCheck;
    try {
      check = await deps.checkRepo(root);
    } catch {
      return failure("failed");
    }
    const git = check.items.find((i) => i.id === "git");
    if (!git?.ok)
      return failure((git?.code as string) === "nested_repo" ? "nested_repo" : "not_git");

    const state = inspect(root, deps.env, deps.argv);
    const targets: Target[] = [];
    if (!state.models_external && state.models !== "ok") targets.push("models");
    if (state.pricing !== "ok") targets.push("pricing");
    if (targets.length === 0) {
      if (state.models !== "ok") return failure("external_config");
      return { ok: true, written: [], backups: [], excluded: false, reload: await reconnect() };
    }
    if (targets.includes("models") && req.daily === undefined) return failure("invalid_budget");
    const overwrite = targets.filter((t) => state[t] === "invalid");
    if (overwrite.length > 0 && !req.confirm) return failure("confirm_required");
    if (!deps.writePricing && targets.includes("pricing")) return failure("unavailable");

    // 路径：仓库根取真实路径；config/ 和目标文件都不能是符号链接或别的类型
    const realRoot = await realpath(root);
    const configDir = path.join(realRoot, "config");
    const dirKind = await kind(configDir);
    if (dirKind !== "missing" && dirKind !== "dir") return failure("unsafe_path");
    const file = (t: Target) => path.join(realRoot, t === "models" ? MODELS_FILE : PRICING_FILE);
    for (const t of targets) {
      const k = await kind(file(t));
      if (k !== (state[t] === "missing" ? "missing" : "file")) return failure("unsafe_path");
    }

    let models: unknown;
    let pricing: unknown;
    try {
      if (targets.includes("models")) {
        const tpl = await readTemplate(deps.templateDir, MODELS_TEMPLATE);
        if (!isObj(tpl) || !isObj(tpl.budget)) return failure("template_missing");
        // 只改每日预算，其余（模型名、角色、预算的其它字段）照模板
        models = { ...tpl, budget: { ...tpl.budget, daily_micro_usd: req.daily } };
      }
      if (targets.includes("pricing"))
        pricing = await readTemplate(deps.templateDir, PRICING_TEMPLATE);
    } catch {
      return failure("template_missing");
    }

    // 先备份要覆盖的文件（COPYFILE_EXCL，不覆盖已有备份）
    const backups = new Map<Target, string>();
    for (const t of overwrite) {
      const name = path.basename(file(t));
      const at = now();
      let done = false;
      for (let n = 0; n < 20 && !done; n++) {
        const b = backupName(name, at, n);
        try {
          await copyFile(file(t), path.join(configDir, b), 1 /* COPYFILE_EXCL */);
          backups.set(t, b);
          done = true;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") return failure("write_failed");
        }
      }
      if (!done) return failure("write_failed");
    }

    const written: Target[] = [];
    const undo = async () => {
      for (const t of written) {
        const b = backups.get(t);
        if (b) await copyFile(path.join(configDir, b), file(t)).catch(() => {});
        else await rm(file(t), { force: true }).catch(() => {});
      }
    };
    const opts: WriteConfigOptions = { env: deps.env as NodeJS.ProcessEnv };
    for (const t of targets) {
      const r =
        t === "models"
          ? await deps.writeConfig(file(t), models, opts)
          : await deps.writePricing!(file(t), pricing, opts);
      if (!r.ok) {
        await undo();
        return failure("write_failed", r.errors.slice(0, 20));
      }
      written.push(t);
    }

    // 写完复查（3 的 validate / loadPricing）；不过就撤回
    const after = inspect(root, deps.env, deps.argv);
    if (targets.some((t) => after[t] !== "ok")) {
      await undo();
      return failure("verify_failed", after.errors);
    }

    // 生成的文件和备份不进首次提交：写进 .git/info/exclude（失败不撤回配置，只回 excluded:false）
    let excluded: boolean;
    try {
      const rules: string[] = written.map((t) => EXCLUDE_RULE[t]);
      if (backups.size > 0) rules.push(EXCLUDE_RULE.backup);
      excluded = await deps.ensureExcludeLines(realRoot, rules);
    } catch {
      excluded = false;
    }
    return {
      ok: true,
      written,
      backups: [...backups.values()],
      excluded,
      reload: await reconnect(),
    };
  }

  async function reconnect(): Promise<DesktopReloadResult> {
    try {
      return await deps.reconnect();
    } catch {
      return { state: "failed", reason: "重新连接失败" };
    }
  }
}
