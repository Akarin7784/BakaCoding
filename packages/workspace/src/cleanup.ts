import { execFile } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { gitEnv, REPO_GIT_TIMEOUT_MS } from "./git-env.js";
import { withGitWriteLock } from "./git-lock.js";

const run = promisify(execFile);

/** 与 worktree.ts 的 WORKTREES_DIR 相同（这里单独写一份，避免循环导入）。 */
const WORKTREES_SUBDIR = ".bakacoding/worktrees";
const TICKET_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** 集成分支（6 的 INTEGRATION_BRANCH），清理绝不碰它。4 不依赖 6，这里写死同一个值。 */
const PROTECTED_BRANCHES: ReadonlySet<string> = new Set(["bakacoding/integration"]);

// ---------- 合入后清理（T-094） ----------

export interface CleanupMergedOptions {
  /** 本单合入的目标分支（如 `bakacoding/integration`）；分支头已包含在它里面才删分支 */
  merged_into: string;
  /** 另认 `refs/remotes/<remote>/<merged_into>`（GitHub 模式传 `origin`）；只读，不删远程分支 */
  remote?: string;
  /** 删 worktree / 遇到锁文件时的重试间隔，默认 [500, 2000, 5000] 毫秒 */
  retry_delays_ms?: readonly number[];
  /** 测试注入 */
  sleep?: (ms: number) => Promise<void>;
  /** 测试注入：git 删 worktree 都失败后的兜底删除，默认 fs.rm（递归、强制、maxRetries 5） */
  removeDir?: (path: string) => Promise<void>;
  /** 每条 git 的超时，默认 REPO_GIT_TIMEOUT_MS（30 秒）；超时的命令被杀掉、记进 errors，锁随之释放 */
  git_timeout_ms?: number;
  /** 测试注入：执行 git（参数不含 `git` 本身） */
  runGit?: (cwd: string, args: string[]) => Promise<string>;
}

export interface CleanupMergedResult {
  removed_worktrees: string[];
  deleted_branches: string[];
  kept_branches: { branch: string; reason: "not_merged" | "checked_out" | "protected" }[];
  errors: { target: string; message: string }[];
}

export const DEFAULT_CLEANUP_RETRY_DELAYS_MS: readonly number[] = [500, 2000, 5000];

/** 清理用的 git：环境用 4 的 gitEnv()（剔掉所有 GIT_ 变量），带超时（默认 REPO_GIT_TIMEOUT_MS）。 */
function defaultGit(timeout: number): (cwd: string, args: string[]) => Promise<string> {
  return async (cwd, args) => {
    const { stdout } = await run("git", args, {
      cwd,
      env: gitEnv(),
      timeout,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim();
  };
}

function errMessage(err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown };
  const s = typeof e?.stderr === "string" && e.stderr.trim() ? e.stderr.trim() : undefined;
  return (s ?? (err instanceof Error ? err.message : String(err))).slice(0, 500);
}

/** git 因锁文件失败（另一进程或命令正在写）：可以等一会儿再试。 */
export function isGitLockError(err: unknown): boolean {
  return /\.lock'?[:]? File exists|Unable to create '[^']*\.lock'|another git process/i.test(
    errMessage(err),
  );
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface Ctx {
  repo: string;
  git: (args: string[]) => Promise<string>;
  delays: readonly number[];
  sleep: (ms: number) => Promise<void>;
  removeDir: (path: string) => Promise<void>;
}

/** 锁文件冲突时按 delays 重试；其他错误直接抛。 */
async function gitRetry(ctx: Ctx, args: string[]): Promise<string> {
  for (let i = 0; ; i++) {
    try {
      return await ctx.git(args);
    } catch (err) {
      if (i >= ctx.delays.length || !isGitLockError(err)) throw err;
      await ctx.sleep(ctx.delays[i]!);
    }
  }
}

function isManagedPath(repo: string, p: string): boolean {
  const root = join(repo, WORKTREES_SUBDIR);
  const rel = relative(root, resolve(p));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
  // worktrees 根目录本身不在（lstat 报 ENOENT）：路径按字面判断已在根下（目录都不在，fs.rm 也删不到别处）。
  // lstat 的其它错误（EACCES、ENOTDIR 等）一律当不受管（宁可漏删）。
  try {
    lstatSync(root);
  } catch (err) {
    return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
  }
  // 按真实路径再查一次（防 worktrees 目录里的符号链接把删除带到别处）；其他出错一律当不受管（宁可漏删）。
  // 根目录是悬空符号链接时 lstat 成功、这里 realpath 报 ENOENT，同样当不受管。
  try {
    const realRoot = realpathSync(root);
    const realP = existsSync(p) ? realpathSync(p) : resolve(realRoot, rel);
    const r2 = relative(realRoot, realP);
    return r2 !== "" && !r2.startsWith("..") && !isAbsolute(r2);
  } catch {
    return false;
  }
}

async function listWorktrees(ctx: Ctx): Promise<{ path: string; branch?: string }[]> {
  const out = await ctx.git(["worktree", "list", "--porcelain"]);
  const res: { path: string; branch?: string }[] = [];
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) res.push({ path: line.slice(9) });
    else if (line.startsWith("branch refs/heads/") && res.length)
      res[res.length - 1]!.branch = line.slice(18);
  }
  return res;
}

/** 删一个 worktree：git 删（重试）→ 兜底 fs.rm → prune。目录还在就记错，不删它的分支。 */
async function removeWorktree(ctx: Ctx, path: string): Promise<string | undefined> {
  let lastErr: unknown;
  for (let i = 0; i <= ctx.delays.length; i++) {
    if (!existsSync(path)) break;
    try {
      // 只对这一条命令开长路径（Windows MAX_PATH），不改用户的 git config
      await ctx.git(["-c", "core.longpaths=true", "worktree", "remove", "--force", path]);
      lastErr = undefined;
      break;
    } catch (err) {
      lastErr = err;
      if (i < ctx.delays.length) await ctx.sleep(ctx.delays[i]!);
    }
  }
  if (existsSync(path)) {
    try {
      await ctx.removeDir(path);
    } catch (err) {
      lastErr = err;
    }
  }
  try {
    await gitRetry(ctx, ["worktree", "prune"]);
  } catch (err) {
    if (!existsSync(path)) lastErr = err;
  }
  if (existsSync(path)) return `删除 worktree 失败：${errMessage(lastErr ?? "目录仍在")}`;
  return undefined;
}

async function refSha(ctx: Ctx, ref: string): Promise<string | undefined> {
  try {
    return await ctx.git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  } catch {
    return undefined;
  }
}

async function isAncestor(ctx: Ctx, sha: string, ref: string): Promise<boolean> {
  if (!(await refSha(ctx, ref))) return false;
  try {
    await ctx.git(["merge-base", "--is-ancestor", sha, ref]);
    return true;
  } catch {
    return false;
  }
}

/**
 * 单子合入后清理（T-094）：删掉该单所有轮次 `<ticket_id>-r<n>` 的 worktree（含目录已不在、只剩登记的）
 * 和本地分支 `bakacoding/<ticket_id>-r<n>`（含 worktree 已不在、只剩分支的）。
 * - 分支头已包含在 `merged_into`（或 `<remote>/<merged_into>`）里才删，否则保留（`not_merged`）；
 *   仍被某个 worktree 检出的保留（`checked_out`）；`bakacoding/integration` 永不删（`protected`）。
 * - 删 worktree：`git -c core.longpaths=true worktree remove --force`，失败按 retry_delays_ms 重试，
 *   仍失败用 fs.rm 兜底，再 `worktree prune`；目录还在就记进 errors、不删它的分支。
 * - 整个过程持 withGitWriteLock；每一项单独处理，出错只收进 errors，**从不抛错**。不碰远程分支。
 */
export async function cleanupMergedWorktrees(
  repoRoot: string,
  ticket_id: string,
  opts: CleanupMergedOptions,
): Promise<CleanupMergedResult> {
  const result: CleanupMergedResult = {
    removed_worktrees: [],
    deleted_branches: [],
    kept_branches: [],
    errors: [],
  };
  if (!TICKET_RE.test(ticket_id) || ticket_id.includes("..")) {
    result.errors.push({
      target: ticket_id,
      message: `非法 ticket_id：${JSON.stringify(ticket_id)}`,
    });
    return result;
  }
  const into = opts.merged_into;
  if (typeof into !== "string" || !into || into.startsWith("-") || /\s|\.\./.test(into)) {
    result.errors.push({ target: ticket_id, message: `非法 merged_into：${JSON.stringify(into)}` });
    return result;
  }
  const repo = resolve(repoRoot);
  const runGit = opts.runGit ?? defaultGit(opts.git_timeout_ms ?? REPO_GIT_TIMEOUT_MS);
  const ctx: Ctx = {
    repo,
    git: (args) => runGit(repo, args),
    delays: opts.retry_delays_ms ?? DEFAULT_CLEANUP_RETRY_DELAYS_MS,
    sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    removeDir:
      opts.removeDir ??
      ((p) => rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })),
  };
  const nameRe = new RegExp(`^${escapeRe(ticket_id)}-r\\d+$`);

  try {
    await withGitWriteLock(repo, async () => {
      // 1. worktree
      const blocked = new Set<string>(); // worktree 没删掉的分支：不删
      let wts: { path: string; branch?: string }[];
      try {
        wts = await listWorktrees(ctx);
      } catch (err) {
        result.errors.push({ target: "git worktree list", message: errMessage(err) });
        return;
      }
      for (const w of wts) {
        const base = relative(join(repo, WORKTREES_SUBDIR), resolve(w.path));
        const byName = nameRe.test(base);
        const byBranch =
          w.branch?.startsWith("bakacoding/") === true &&
          nameRe.test(w.branch.slice("bakacoding/".length));
        if (!byName && !byBranch) continue;
        if (!isManagedPath(repo, w.path)) {
          // 不受管：不删目录，也不删它的分支（之后的 prune 若因目录不在而去掉登记，分支仍保留）
          if (w.branch) blocked.add(w.branch);
          continue;
        }
        try {
          const err = await removeWorktree(ctx, w.path);
          if (err) {
            result.errors.push({ target: w.path, message: err });
            if (w.branch) blocked.add(w.branch);
          } else {
            result.removed_worktrees.push(w.path);
          }
        } catch (err) {
          result.errors.push({ target: w.path, message: errMessage(err) });
          if (w.branch) blocked.add(w.branch);
        }
      }
      try {
        await gitRetry(ctx, ["worktree", "prune"]);
      } catch (err) {
        result.errors.push({ target: "git worktree prune", message: errMessage(err) });
      }

      // 2. 分支
      let refs: string[];
      try {
        const out = await ctx.git([
          "for-each-ref",
          "--format=%(refname)",
          `refs/heads/bakacoding/`,
        ]);
        refs = out.split("\n").filter(Boolean);
      } catch (err) {
        result.errors.push({ target: "git for-each-ref", message: errMessage(err) });
        return;
      }
      let checkedOut: Set<string>;
      try {
        checkedOut = new Set(
          (await listWorktrees(ctx)).flatMap((w) => (w.branch ? [w.branch] : [])),
        );
      } catch (err) {
        result.errors.push({ target: "git worktree list", message: errMessage(err) });
        return;
      }
      for (const ref of refs) {
        const branch = ref.slice("refs/heads/".length);
        if (!nameRe.test(branch.slice("bakacoding/".length))) continue;
        if (PROTECTED_BRANCHES.has(branch)) {
          result.kept_branches.push({ branch, reason: "protected" });
          continue;
        }
        if (blocked.has(branch) || checkedOut.has(branch)) {
          result.kept_branches.push({ branch, reason: "checked_out" });
          continue;
        }
        try {
          const sha = await refSha(ctx, ref);
          if (!sha) throw new Error(`读不到分支 ${branch}`);
          const targets = [`refs/heads/${into}`];
          if (opts.remote) targets.push(`refs/remotes/${opts.remote}/${into}`);
          let merged = false;
          for (const t of targets) if (!merged) merged = await isAncestor(ctx, sha, t);
          if (!merged) {
            result.kept_branches.push({ branch, reason: "not_merged" });
            continue;
          }
          // 带旧值删除：期间分支被移动过就失败，不误删
          await gitRetry(ctx, ["update-ref", "-d", ref, sha]);
          result.deleted_branches.push(branch);
        } catch (err) {
          result.errors.push({ target: branch, message: errMessage(err) });
        }
      }
    });
  } catch (err) {
    result.errors.push({ target: ticket_id, message: errMessage(err) });
  }
  return result;
}
