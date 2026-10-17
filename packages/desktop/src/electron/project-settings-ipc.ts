// T-072：project:import / diagnostics:export / settings:get 三个 IPC。对话框由调用方注入（main 用 electron dialog）。
import path from "node:path";
import { SECRET_NAMES } from "@bakacoding/config-budget";
import {
  IPC_CHANNELS,
  type DesktopExportResult,
  type DesktopImportResult,
  type DesktopSettings,
} from "../shared/api.js";
import { CONFIG_ENV, REPO_ENV } from "./backend.js";
import type { BackendSwitcher } from "./backend-switcher.js";
import { DB_PATH_ENV } from "./config.js";
import type { IpcMainLike } from "./ipc.js";
import { checkProjectDir, repoLockedBy, REPO_LOCKED_REASON } from "./project-import.js";
import { sanitizeSyncErrorMessage } from "./sync-state.js";

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

function inside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function defaultExportName(now: Date): string {
  return `bakacoding-diag-${now.toISOString().replace(/[:.]/g, "").replace(/-/g, "")}.zip`;
}

export function serveProjectSettings(ipc: IpcMainLike, deps: ProjectSettingsDeps): () => void {
  const now = deps.now ?? (() => new Date());

  ipc.handle(IPC_CHANNELS.projectImport, async (): Promise<DesktopImportResult> => {
    if (repoLockedBy(deps.argv, deps.env)) return { ok: false, reason: REPO_LOCKED_REASON };
    const dir = await deps.pickDirectory();
    if (!dir) return { ok: false, canceled: true };
    const check = checkProjectDir(dir, deps.env);
    if (!check.ok) {
      return {
        ok: false,
        ...(check.missing && { missing: check.missing }),
        ...(check.reason !== undefined && { reason: check.reason }),
      };
    }
    const r = await deps.backend.switchTo(path.resolve(dir));
    if (!r.ok) return { ok: false, reason: r.reason };
    deps.saveLastRepo(path.resolve(dir));
    return { ok: true, project: r.project };
  });

  ipc.handle(IPC_CHANNELS.diagnosticsExport, async (): Promise<DesktopExportResult> => {
    const at = now();
    const target = await deps.pickSavePath(path.join(deps.downloadsDir, defaultExportName(at)));
    if (!target) return { ok: false, canceled: true, reason: "已取消" };
    if (inside(target, deps.backend.repoRoot())) {
      return { ok: false, reason: "不能把诊断包保存到仓库目录里，请换个位置" };
    }
    try {
      return { ok: true, path: await deps.backend.exportDiagnostics(target, at) };
    } catch (e) {
      const msg = e instanceof Error ? `${e.name}：${e.message}` : String(e);
      return {
        ok: false,
        reason: sanitizeSyncErrorMessage(`导出失败：${msg}`, deps.env, EXPORT_REASON_MAX),
      };
    }
  });

  ipc.handle(IPC_CHANNELS.settingsGet, (): DesktopSettings => ({
    repo: deps.backend.repoRoot() || null,
    env: envPresence(deps.env),
    mode: deps.backend.prMode(),
  }));

  return () => {
    ipc.removeHandler(IPC_CHANNELS.projectImport);
    ipc.removeHandler(IPC_CHANNELS.diagnosticsExport);
    ipc.removeHandler(IPC_CHANNELS.settingsGet);
  };
}
