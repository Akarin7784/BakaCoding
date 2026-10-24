// UI-07d：设置 › 项目——project:list / project:remove / project:open-folder。
// 打开文件夹只认 project_id：路径由主进程按存储里的 repo_path 取，界面传不了路径；
// 所有失败一律固定文案，repo_path 不进返回的 reason、不写日志。
import { statSync } from "node:fs";
import path from "node:path";
import { ledgerSummary } from "@bakacoding/config-budget";
import type {
  DesktopLedgerSummaryResult,
  DesktopProjectListResult,
  DesktopProjectOpenFolderResult,
  DesktopProjectRemoveResult,
} from "../shared/api.js";
import type { BackendHandle } from "./backend.js";

export const PROJECT_TEXT = {
  readonly: "后端只读，读不到项目列表",
  removeReadonly: "只读模式下不能移除项目",
  removeFailed: "移除项目失败",
  invalidId: "项目参数不合法",
  notFound: "找不到这个项目",
  noPath: "这个项目没有记录仓库路径",
  badPath: "记录的仓库路径不是绝对路径",
  missing: "仓库文件夹不存在或不是文件夹",
  openFailed: "打开文件夹失败",
  ledgerReadonly: "后端只读，读不到台账",
  ledgerFailed: "读取项目花费失败",
} as const;

export interface ProjectListDeps {
  backend: Pick<BackendHandle, "listProjects" | "removeProject" | "status" | "ledgerStore">;
  /** main 注入 shell.openPath；返回空串表示成功，否则是错误信息（不透出） */
  openPath(p: string): Promise<string>;
  /** 测试注入；默认 statSync(p).isDirectory()，不存在为 false */
  isDirectory?: (p: string) => boolean;
  /** 测试注入（Windows 路径用 path.win32） */
  pathImpl?: typeof path;
  /** 只记固定文案和错误名，绝不带路径 */
  warn?: (message: string) => void;
}

const validId = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 200;

function defaultIsDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function projectListHandlers(deps: ProjectListDeps) {
  const pathImpl = deps.pathImpl ?? path;
  const isDir = deps.isDirectory ?? defaultIsDirectory;
  const warn = deps.warn ?? (() => {});
  const list = (): DesktopProjectListResult => {
    const rows = deps.backend.listProjects();
    if (!rows) return { ok: false, reason: PROJECT_TEXT.readonly };
    return {
      ok: true,
      projects: rows.map((r) => ({
        project_id: r.project_id,
        name: r.name,
        repo_path: r.repo_path,
      })),
    };
  };
  return {
    list,
    /**
     * UI-07e：ledger:summary。对 listProjects() 里的每个项目调 3 的 ledgerSummary（已移除的项目不在列表里，
     * 也就不显示）；只拷 id、名称和累计字段，不带 repo_path、不带当日花费。
     */
    async summary(): Promise<DesktopLedgerSummaryResult> {
      const ledger = deps.backend.ledgerStore();
      const rows = deps.backend.listProjects();
      if (!ledger || !rows) return { ok: false, reason: PROJECT_TEXT.ledgerReadonly };
      try {
        const projects = [];
        for (const r of rows) {
          const { project } = await ledgerSummary(ledger, { project_id: r.project_id });
          projects.push({
            project_id: r.project_id,
            name: r.name,
            total_micro_usd: project.total_micro_usd,
            resubmit_micro_usd: project.resubmit_micro_usd,
            entries: project.entries,
            by_role: { ...project.by_role },
          });
        }
        return { ok: true, projects };
      } catch (e) {
        warn(
          `读取项目花费失败（${e instanceof Error ? e.name.replace(/[^A-Za-z0-9_]/g, "") : "Error"}）`,
        );
        return { ok: false, reason: PROJECT_TEXT.ledgerFailed };
      }
    },
    async remove(id: unknown): Promise<DesktopProjectRemoveResult> {
      if (!validId(id)) return { ok: false, reason: PROJECT_TEXT.invalidId };
      if (deps.backend.status().mode !== "live")
        return { ok: false, reason: PROJECT_TEXT.removeReadonly };
      try {
        return { ok: true, ...(await deps.backend.removeProject(id)) };
      } catch (e) {
        warn(
          `移除项目失败（${e instanceof Error ? e.name.replace(/[^A-Za-z0-9_]/g, "") : "Error"}）`,
        );
        return { ok: false, reason: PROJECT_TEXT.removeFailed };
      }
    },
    async openFolder(id: unknown): Promise<DesktopProjectOpenFolderResult> {
      if (!validId(id)) return { ok: false, reason: PROJECT_TEXT.invalidId };
      const rows = deps.backend.listProjects();
      const row = rows?.find((r) => r.project_id === id);
      if (!row) return { ok: false, reason: PROJECT_TEXT.notFound };
      const p = row.repo_path;
      if (!p) return { ok: false, reason: PROJECT_TEXT.noPath };
      if (!pathImpl.isAbsolute(p)) return { ok: false, reason: PROJECT_TEXT.badPath };
      if (!isDir(p)) return { ok: false, reason: PROJECT_TEXT.missing };
      try {
        const err = await deps.openPath(p);
        if (err) {
          warn(PROJECT_TEXT.openFailed);
          return { ok: false, reason: PROJECT_TEXT.openFailed };
        }
        return { ok: true };
      } catch {
        warn(PROJECT_TEXT.openFailed);
        return { ok: false, reason: PROJECT_TEXT.openFailed };
      }
    },
  };
}
