// T-081：导入缺配置时「用默认模板创建」。只在用户点按钮后由主进程调用；模板目录由主进程决定，渲染进程传不进路径。
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { ExcludeRule } from "@bakacoding/app";
import { GIT_DIR, MODELS_FILE, PRICING_FILE, configSource } from "./project-import.js";

/** 模板文件名 → 写到所选仓库里的相对路径 */
export const TEMPLATE_FILES = [
  { template: "models.example.json", target: MODELS_FILE },
  { template: "pricing.json", target: PRICING_FILE },
] as const;

/**
 * 模块 4 的 `ensureExcludeLines(dir, lines)`（T-082，经 `@bakacoding/app` 再导出）的注入点：
 * 把行追加进 `git rev-parse --git-path info/exclude`；dir 不是 git 仓库时返回 false、不抛错。
 */
export type EnsureExcludeLines = (
  dir: string,
  lines: readonly ExcludeRule[],
) => Promise<boolean>;

/** 模板目录：打包版在 exe 同一层的 config-templates/；开发时用仓库根的 config/。 */
export function defaultTemplateDir(packaged: boolean, execPath: string, repoRoot: string): string {
  return packaged
    ? path.join(path.dirname(execPath), "config-templates")
    : path.join(repoRoot, "config");
}

export type CreateDefaultConfigResult =
  { ok: true; created: string[] } | { ok: false; reason: string };

function lstatOrNull(p: string) {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

/**
 * 只补缺的文件（COPYFILE_EXCL，已有的绝不覆盖）；用了 `--config` / BAKACODING_CONFIG 时只补 pricing.json。
 * 不是 git 仓库（UI-03b 起能导入准备页，但这里写 exclude 需要 .git）、config/ 或目标是符号链接、
 * config 不是目录 → 拒绝，一个文件都不写。
 */
export function createDefaultConfigFiles(
  dir: string,
  templateDir: string,
  argv: readonly string[] = [],
  env: Readonly<Record<string, string | undefined>> = {},
): CreateDefaultConfigResult {
  if (!existsSync(path.join(dir, GIT_DIR)))
    return { ok: false, reason: "不是 git 仓库（没有 .git），不能创建配置" };
  const cfgDir = path.join(dir, "config");
  const cfg = lstatOrNull(cfgDir);
  if (cfg?.isSymbolicLink()) return { ok: false, reason: "config 是符号链接，不能写入" };
  if (cfg && !cfg.isDirectory()) return { ok: false, reason: "config 不是文件夹，不能写入" };
  const source = configSource(argv, env);
  const todo = TEMPLATE_FILES.filter((f) => !(source && f.target === MODELS_FILE)).filter((f) => {
    const st = lstatOrNull(path.join(dir, f.target));
    return st === null;
  });
  for (const f of TEMPLATE_FILES) {
    if (lstatOrNull(path.join(dir, f.target))?.isSymbolicLink())
      return { ok: false, reason: `${f.target} 是符号链接，不能写入` };
  }
  for (const f of todo) {
    if (!existsSync(path.join(templateDir, f.template)))
      return { ok: false, reason: `找不到模板 ${f.template}` };
  }
  if (!cfg && todo.length) mkdirSync(cfgDir);
  const created: string[] = [];
  for (const f of todo) {
    try {
      copyFileSync(
        path.join(templateDir, f.template),
        path.join(dir, f.target),
        constants.COPYFILE_EXCL,
      );
      created.push(f.target);
    } catch (e) {
      // EEXIST：刚好被别人建了，不覆盖、不算我们建的
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  return { ok: true, created };
}

/** 缺失清单只含配置文件时才可能给按钮；还要配合 DirCheck 的 notGit / envConfigMissing 和模板目录（见 ipc 的 failure） */
export function canCreateDefaultConfig(missing: readonly string[] | undefined): boolean {
  return (
    !!missing?.length &&
    !missing.includes(GIT_DIR) &&
    missing.every((m) => m === MODELS_FILE || m === PRICING_FILE)
  );
}
