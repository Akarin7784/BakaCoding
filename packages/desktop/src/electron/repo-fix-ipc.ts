// UI-03a：项目准备页的仓库检查与修复 IPC（docs/ui-design.md §4.1，modules.md §12）。
// 只调 4 的 checkRepo / initRepo / listInitialCommitFiles / initialCommit / createMainBranch（经组合根再导出），
// 仓库固定是当前后端的仓库根；渲染进程传的参数在这里先做类型校验，失败只回 RepoFixError 的固定文案。
import path from "node:path";
import {
  checkRepo as checkRepoDefault,
  createMainBranch as createMainBranchDefault,
  initialCommit as initialCommitDefault,
  initRepo as initRepoDefault,
  listInitialCommitFiles as listInitialCommitFilesDefault,
  RepoFixError,
} from "@bakacoding/app";
import type {
  DesktopGitIdentity,
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
  /** 写操作成功后调（BackendSwitcher.reconnect，与只读横幅「重新连接」同一条路径） */
  reconnect(): Promise<DesktopReloadResult>;
  fns?: Partial<RepoFixFns>;
}

/** 一次首次提交最多带的文件数（防止渲染进程塞超大数组）。 */
export const MAX_INITIAL_FILES = 20_000;
/** 单个相对路径的上限（字符）。 */
const MAX_REL_PATH = 4096;

type FixCode = DesktopRepoFixFailure["code"];
const FIX_CODES: ReadonlySet<string> = new Set<FixCode>([
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

/** 失败一律用 RepoFixError 的固定文案；不是 RepoFixError（或码不认识）的记成 git_failed，不带原始信息。 */
export function repoFixFailure(e: unknown): DesktopRepoFixFailure {
  if (e instanceof RepoFixError && FIX_CODES.has(e.code))
    return { ok: false, code: e.code, reason: e.message };
  return { ok: false, code: "git_failed", reason: new RepoFixError("git_failed").message };
}

const fail = (code: FixCode): DesktopRepoFixFailure => repoFixFailure(new RepoFixError(code));

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
  if (typeof name !== "string" || typeof email !== "string") return "invalid";
  if (name.length > 200 || email.length > 320) return "invalid";
  return { name, email };
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

export function parseInitialCommit(v: unknown): ParsedInitialCommit | FixCode {
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
}

/** 五个通道的处理函数（不抛过 IPC）。写操作成功后 reconnect；reconnect 自己出错按 failed 回，修复本身仍算成功。 */
export function repoFixHandlers(deps: RepoFixDeps): RepoFixHandlers {
  const fns: RepoFixFns = { ...DEFAULT_REPO_FIX_FNS, ...deps.fns };
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
        const r = await fns.checkRepo(deps.repoRoot());
        return {
          ok: true,
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
      const o = arg === undefined ? {} : arg;
      if (!isObj(o)) return fail("invalid_identity");
      const identity = parseIdentity(o.identity);
      if (identity === "invalid") return fail("invalid_identity");
      try {
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
      let from: string;
      try {
        ({ from } = await fns.createMainBranch(deps.repoRoot()));
      } catch (e) {
        return repoFixFailure(e);
      }
      return { ok: true, from, reload: await reconnect() };
    },
  };
}
