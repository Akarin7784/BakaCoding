// T-072：project:import / diagnostics:export / settings:get 的依赖与辅助函数；handler 本身在 ipc.ts 的 serveProjectSettings。
import { realpathSync } from "node:fs";
import path from "node:path";
import { SECRET_NAMES } from "@bakacoding/config-budget";
import type { DesktopSettings } from "../shared/api.js";
import { CONFIG_ENV, REPO_ENV } from "./backend.js";
import type { BackendSwitcher } from "./backend-switcher.js";
import { DB_PATH_ENV } from "./config.js";

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
  /** 默认 node:path（测试 Windows 时可传 path.win32） */
  pathImpl?: typeof path;
}

/** 解析符号链接；路径不存在时解析最近一个存在的上级，再接上余下部分。 */
function realpathExisting(p: string, realpath: (p: string) => string, pathImpl: typeof path) {
  let cur = pathImpl.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return pathImpl.join(realpath(cur), ...rest.reverse());
    } catch {
      const parent = pathImpl.dirname(cur);
      if (parent === cur) return pathImpl.join(cur, ...rest.reverse());
      rest.push(pathImpl.basename(cur));
      cur = parent;
    }
  }
}

/**
 * child 是否在 parent 里（含相等）。两边都先 realpath（child 可能还不存在，取存在的上级），
 * 再看 path.relative：`..foo` 这类以两个点开头的目录名算在里面；指进仓库的符号链接也算在里面。
 */
export function inside(child: string, parent: string, opts: InsideOptions = {}): boolean {
  const pathImpl = opts.pathImpl ?? path;
  const realpath = opts.realpath ?? ((p: string) => realpathSync.native(p));
  let a = realpathExisting(parent, realpath, pathImpl);
  let b = realpathExisting(child, realpath, pathImpl);
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
