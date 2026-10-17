// T-072：project:import / diagnostics:export / settings:get 的依赖与辅助函数；handler 本身在 ipc.ts 的 serveProjectSettings。
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

export function inside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function defaultExportName(now: Date): string {
  return `bakacoding-diag-${now.toISOString().replace(/[:.]/g, "").replace(/-/g, "")}.zip`;
}
