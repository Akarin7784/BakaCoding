// UI-03a：项目准备页的仓库检查与修复 IPC（docs/ui-design.md §4.1，modules.md §12）。
// 只调 4 的 checkRepo / initRepo / listInitialCommitFiles / initialCommit / createMainBranch（经组合根再导出），
// 仓库固定是当前后端的仓库根；渲染进程传的参数在这里先做类型校验，失败只回 RepoFixError 的固定文案。
// 评审 B1：仓库来源是当前工作目录（或不明）时三个写操作一律拒绝（cwd_repo），界面那边也不给入口，这里是纵深防御。
import path from "node:path";
import {
  checkRepo as checkRepoDefault,
  createMainBranch as createMainBranchDefault,
  initialCommit as initialCommitDefault,
  initRepo as initRepoDefault,
  listInitialCommitFiles as listInitialCommitFilesDefault,
  RepoFixError,
} from "@bakacoding/app";
import { CONFIG_FIX_TEXT, NESTED_REPO_REASON } from "../shared/config-text.js";
import type { ConfigFixHandlers } from "./config-fix.js";
import type {
  DesktopConfigFixResult,
  DesktopGitIdentity,
  DesktopRepoSource,
  DesktopReloadResult,
  DesktopRepoCheckResult,
  DesktopRepoFilesResult,
  DesktopRepoFixFailure,
  DesktopRepoFixResult,
} from "../shared/api.js";

/** 4 的修复函数（测试注入）。 */
export interface RepoFixFns {
  checkRepo: typeof checkRepoDefault;
  initRepo: typeof initRepoDefault;
  listInitialCommitFiles: typeof listInitialCommitFilesDefault;
  initialCommit: typeof initialCommitDefault;
  createMainBranch: typeof createMainBranchDefault;
}

export const DEFAULT_REPO_FIX_FNS: RepoFixFns = {
  checkRepo: checkRepoDefault,
  initRepo: initRepoDefault,
  listInitialCommitFiles: listInitialCommitFilesDefault,
  initialCommit: initialCommitDefault,
  createMainBranch: createMainBranchDefault,
};

export interface RepoFixDeps {
  /** 当前后端的仓库根（BackendSwitcher.repoRoot） */
  repoRoot(): string;
  /** 当前后端的仓库来源（BackendStatus.repoSource）；cwd 或 undefined 时拒绝写操作 */
  repoSource(): DesktopRepoSource | undefined;
  /** 写操作成功后调（BackendSwitcher.reconnect，与只读横幅「重新连接」同一条路径） */
  reconnect(): Promise<DesktopReloadResult>;
  fns?: Partial<RepoFixFns>;
  /** T-113：生成配置（repo:init-config）与 repo:check 里的配置状态；不给时 initConfig 回 unavailable、check 不带 config */
  config?: ConfigFixHandlers;
}

/** 一次首次提交最多带的文件数（防止渲染进程塞超大数组）。 */
export const MAX_INITIAL_FILES = 20_000;
/** 单个相对路径的上限（字符）。 */
const MAX_REL_PATH = 4096;

type FixCode = DesktopRepoFixFailure["code"];
/** 4 的 RepoFixError 码（cwd_repo 是桌面端自己的拒绝码） */
type ModuleFixCode = Exclude<FixCode, "cwd_repo">;
const FIX_CODES: ReadonlySet<string> = new Set<ModuleFixCode>([
  "not_git",
  "repo_exists",
  "no_commits",
  "has_commits",
  "main_exists",
  "no_identity",
  "invalid_identity",
  "invalid_files",
  "timeout",
  "git_failed",
]);

/**
 * 嵌套仓库（T-113）：repo:init 主进程自己先拒绝时回这一句（4 抛 RepoFixError("nested_repo") 的映射由 T-114 #148 的 FIX_CODES 负责）。
 * TODO(T-114 合入后)：`nested_repo` 进了 DesktopRepoFixFailure 的 code，去掉这里的 cast。
 */
export const NESTED_REPO_FAILURE = {
  ok: false,
  code: "nested_repo",
  reason: NESTED_REPO_REASON,
} as unknown as DesktopRepoFixFailure;

/** 失败一律用 RepoFixError 的固定文案；不是 RepoFixError（或码不认识）的记成 git_failed，不带原始信息。 */
export function repoFixFailure(e: unknown): DesktopRepoFixFailure {
  if (e instanceof RepoFixError && FIX_CODES.has(e.code))
    return { ok: false, code: e.code, reason: e.message };
  return { ok: false, code: "git_failed", reason: new RepoFixError("git_failed").message };
}

const fail = (code: ModuleFixCode): DesktopRepoFixFailure => repoFixFailure(new RepoFixError(code));

/** 来源是当前工作目录时写操作的固定回复（UI-03a 评审 B1） */
export const CWD_REPO_REASON = "还没选项目文件夹：请先导入项目，再准备仓库";
export const CWD_REPO_FAILURE: DesktopRepoFixFailure = {
  ok: false,
  code: "cwd_repo",
  reason: CWD_REPO_REASON,
};

/** 文件夹名上限（字符）；界面再按显示宽度截断 */
const MAX_FOLDER_NAME = 255;

/** 仓库根的最后一级文件夹名：只给 basename，不带上级路径。 */
export function repoFolderName(root: string): string {
  const trimmed = root.replace(/[\\/]+$/, "");
  const name = trimmed.split(/[\\/]/).pop() ?? "";
  return (name || trimmed || root).slice(0, MAX_FOLDER_NAME);
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * identity 参数：不传 → undefined；传了必须是 `{ name: string; email: string }`（长度上限同 4），
 * 否则 invalid_identity。内容（邮箱格式、换行等）再由 4 校验。
 */
export function parseIdentity(v: unknown): DesktopGitIdentity | undefined | "invalid" {
  if (v === undefined) return undefined;
  if (!isObj(v)) return "invalid";
  const { name, email } = v;
  // UI-03b（T-108）：可以只给一项，至少一项；给了的必须是字符串
  if (name === undefined && email === undefined) return "invalid";
  if (name !== undefined && (typeof name !== "string" || name.length > 200)) return "invalid";
  if (email !== undefined && (typeof email !== "string" || email.length > 320)) return "invalid";
  return {
    ...(name !== undefined && { name: name as string }),
    ...(email !== undefined && { email: email as string }),
  };
}

/**
 * 首次提交的相对路径：非空字符串、不含 NUL、不是绝对路径（posix、Windows 盘符、UNC、以 \ 开头）、
 * 任何一段都不是 `..`。真正「只认 list-initial-files 列出的」由 4 的 initialCommit（invalid_files）保证，这里先挡一层。
 */
export function isSafeRelPath(p: unknown): p is string {
  if (typeof p !== "string" || p.length === 0 || p.length > MAX_REL_PATH) return false;
  if (p.includes("\0")) return false;
  if (path.posix.isAbsolute(p) || path.win32.isAbsolute(p) || /^[A-Za-z]:/.test(p)) return false;
  return !p.split(/[\\/]/).some((seg) => seg === "..");
}

export type ParsedInitialCommit =
  | { files: string[]; identity?: DesktopGitIdentity }
  | { empty: true; identity?: DesktopGitIdentity };

export function parseInitialCommit(v: unknown): ParsedInitialCommit | ModuleFixCode {
  if (!isObj(v)) return "invalid_files";
  const identity = parseIdentity(v.identity);
  if (identity === "invalid") return "invalid_identity";
  const id = identity ? { identity } : {};
  const hasFiles = v.files !== undefined;
  const hasEmpty = v.empty !== undefined;
  if (hasEmpty && !hasFiles) return v.empty === true ? { empty: true, ...id } : "invalid_files";
  if (!hasFiles || hasEmpty) return "invalid_files";
  const files = v.files;
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_INITIAL_FILES)
    return "invalid_files";
  if (!files.every(isSafeRelPath)) return "invalid_files";
  return { files: [...(files as string[])], ...id };
}

export interface RepoFixHandlers {
  check(): Promise<DesktopRepoCheckResult>;
  init(arg: unknown): Promise<DesktopRepoFixResult>;
  listInitialFiles(): Promise<DesktopRepoFilesResult>;
  initialCommit(arg: unknown): Promise<DesktopRepoFixResult>;
  createMain(): Promise<DesktopRepoFixResult>;
  initConfig(arg: unknown): Promise<DesktopConfigFixResult>;
}

/** 五个通道的处理函数（不抛过 IPC）。写操作成功后 reconnect；reconnect 自己出错按 failed 回，修复本身仍算成功。 */
export function repoFixHandlers(deps: RepoFixDeps): RepoFixHandlers {
  const fns: RepoFixFns = { ...DEFAULT_REPO_FIX_FNS, ...deps.fns };
  /** 写操作只在来源明确不是 cwd 时放行（不明 = 组装失败的占位后端没带来源，按 cwd 处理） */
  const writable = (): boolean => {
    const src = deps.repoSource();
    return src !== undefined && src !== "cwd";
  };
  const reconnect = async (): Promise<DesktopReloadResult> => {
    try {
      return await deps.reconnect();
    } catch {
      return { state: "failed", reason: "重新连接失败" };
    }
  };
  return {
    async check() {
      try {
        const root = deps.repoRoot();
        const r = await fns.checkRepo(root);
        // T-113：git 项过了才带配置状态（准备页顺序 git → 配置 → 提交）
        const gitOk = r.items.find((i) => i.id === "git")?.ok === true;
        let config;
        if (gitOk && deps.config) {
          try {
            config = deps.config.inspect();
          } catch {
            config = undefined;
          }
        }
        return {
          ok: true,
          folder: repoFolderName(root),
          ...(config && { config }),
          check: {
            items: r.items.map((i) => ({
              id: i.id,
              ok: i.ok,
              ...(i.code && { code: i.code }),
              ...(i.detail && { detail: i.detail }),
              ...(i.current !== undefined && { current: i.current }),
            })),
            current_branch: r.current_branch,
            identity: { name: !!r.identity.name, email: !!r.identity.email },
          },
        };
      } catch (e) {
        return repoFixFailure(e);
      }
    },
    async init(arg) {
      if (!writable()) return CWD_REPO_FAILURE;
      const o = arg === undefined ? {} : arg;
      if (!isObj(o)) return fail("invalid_identity");
      const identity = parseIdentity(o.identity);
      if (identity === "invalid") return fail("invalid_identity");
      try {
        // T-113：嵌套仓库主进程先拒绝（不靠 4 的版本；T-114 起 4 自己也会抛 nested_repo）
        const r = await fns.checkRepo(deps.repoRoot());
        const git = r.items.find((i) => i.id === "git");
        if (git && !git.ok && (git.code as string) === "nested_repo") return NESTED_REPO_FAILURE;
        await fns.initRepo(deps.repoRoot(), identity ? { identity } : {});
      } catch (e) {
        return repoFixFailure(e);
      }
      return { ok: true, reload: await reconnect() };
    },
    async listInitialFiles() {
      try {
        const r = await fns.listInitialCommitFiles(deps.repoRoot());
        return {
          ok: true,
          include: [...r.include],
          excluded: r.excluded.map((x) => ({ path: x.path, reason: x.reason })),
        };
      } catch (e) {
        return repoFixFailure(e);
      }
    },
    async initialCommit(arg) {
      if (!writable()) return CWD_REPO_FAILURE;
      const req = parseInitialCommit(arg);
      if (typeof req === "string") return fail(req);
      let commit: string;
      try {
        ({ commit } = await fns.initialCommit(deps.repoRoot(), req));
      } catch (e) {
        return repoFixFailure(e);
      }
      return { ok: true, commit, reload: await reconnect() };
    },
    async createMain() {
      if (!writable()) return CWD_REPO_FAILURE;
      let from: string;
      try {
        ({ from } = await fns.createMainBranch(deps.repoRoot()));
      } catch (e) {
        return repoFixFailure(e);
      }
      return { ok: true, from, reload: await reconnect() };
    },
    async initConfig(arg) {
      if (!writable()) return { ok: false, code: "cwd_repo", reason: CWD_REPO_REASON };
      if (!deps.config)
        return { ok: false, code: "unavailable", reason: CONFIG_FIX_TEXT.unavailable };
      return deps.config.initConfig(arg);
    },
  };
}
