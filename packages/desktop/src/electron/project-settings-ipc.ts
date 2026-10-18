// T-072：project:import / diagnostics:export / settings:get 的依赖与辅助函数；handler 本身在 ipc.ts 的 serveProjectSettings。
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { SECRET_NAMES } from "@bakacoding/config-budget";
import type { DesktopSettings } from "../shared/api.js";
import { CONFIG_ENV, REPO_ENV } from "./backend.js";
import type { BackendSwitcher } from "./backend-switcher.js";
import { DB_PATH_ENV } from "./config.js";
import type { EnsureExcludeLines } from "./default-config.js";

/** 设置页列出的非密钥变量（密钥变量取 3 的 SECRET_NAMES）。 */
export const NON_SECRET_ENV_NAMES = [REPO_ENV, CONFIG_ENV, DB_PATH_ENV] as const;
export const EXPORT_REASON_MAX = 2000;

export interface ProjectSettingsDeps {
  backend: Pick<
    BackendSwitcher,
    "switchTo" | "repoRoot" | "prMode" | "exportDiagnostics" | "status"
  >;
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  /** 目录选择；取消返回 null */
  pickDirectory(): Promise<string | null>;
  /** 保存对话框；取消返回 null */
  pickSavePath(defaultPath: string): Promise<string | null>;
  /** 用户的下载目录（诊断包默认保存位置） */
  downloadsDir: string;
  /** 导入成功后记下仓库路径（userData） */
  saveLastRepo(repo: string): void;
  now?: () => Date;
  /** T-081：默认模板目录（main 按打包 / 开发决定；测试注入） */
  templateDir?: string;
  /** T-081：追加 .git/info/exclude 行（T-082 的模块 4 实现，main.ts 注入真实函数）。未注入时跳过 */
  ensureExcludeLines?: EnsureExcludeLines;
}

/** 名字 + 已设 / 未设；值绝不出主进程。 */
export function envPresence(
  env: Readonly<Record<string, string | undefined>>,
): DesktopSettings["env"] {
  return [...SECRET_NAMES, ...NON_SECRET_ENV_NAMES].map((name) => ({ name, set: !!env[name] }));
}

export interface InsideOptions {
  /** 默认 process.platform；win32 时不区分大小写 */
  platform?: NodeJS.Platform;
  /** 默认 fs.realpathSync.native */
  realpath?: (p: string) => string;
  /** 默认 fs.lstatSync；路径不存在时返回 null */
  lstat?: (p: string) => { isSymbolicLink(): boolean } | null;
  /** 相对路径的基准，默认 process.cwd() */
  cwd?: string;
  /** 默认 node:path（测试 Windows 时可传 path.win32） */
  pathImpl?: typeof path;
}

function defaultLstat(p: string) {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

/** 目标本身是符号链接（含悬空链接）？是就不跟进去，直接拒绝。 */
export function isSymlinkTarget(target: string, opts: InsideOptions = {}): boolean {
  return (opts.lstat ?? defaultLstat)(target)?.isSymbolicLink() ?? false;
}

/**
 * 保存目标 child 是否要当作「在 parent 里」拒绝。保守判断：拿不准就算在里面。
 * - 不做词法规范化（`link/../x` 里的 `..` 交给真实路径解析）：相对路径只拼上 cwd 前缀；
 * - 目标本身是符号链接（含悬空）→ 拒绝；basename 为空 / `.` / `..` → 拒绝；
 * - realpath(dirname(child))，失败就拒绝（不往上找）；接上 basename；
 * - 与 realpath(parent) 比 path.relative：rel 为 `""` 或不以 `..` 段开头、也不是绝对路径即在里面；
 *   `..foo` 这类目录名算在里面；win32 不区分大小写。
 */
export function inside(child: string, parent: string, opts: InsideOptions = {}): boolean {
  const pathImpl = opts.pathImpl ?? path;
  const realpath = opts.realpath ?? ((p: string) => realpathSync.native(p));
  const cwd = opts.cwd ?? process.cwd();
  const abs = pathImpl.isAbsolute(child) ? child : `${cwd}${pathImpl.sep}${child}`;
  if (isSymlinkTarget(abs, opts)) return true;
  const base = pathImpl.basename(abs);
  if (base === "" || base === "." || base === "..") return true;
  let dir: string;
  try {
    dir = realpath(pathImpl.dirname(abs));
  } catch {
    return true;
  }
  let a: string;
  try {
    a = realpath(parent);
  } catch {
    a = pathImpl.resolve(parent);
  }
  let b = pathImpl.join(dir, base);
  if ((opts.platform ?? process.platform) === "win32") {
    a = a.toLowerCase();
    b = b.toLowerCase();
  }
  const rel = pathImpl.relative(a, b);
  return (
    rel === "" || !(rel === ".." || rel.startsWith(`..${pathImpl.sep}`) || pathImpl.isAbsolute(rel))
  );
}

export function defaultExportName(now: Date): string {
  return `bakacoding-diag-${now.toISOString().replace(/[:.]/g, "").replace(/-/g, "")}.zip`;
}
