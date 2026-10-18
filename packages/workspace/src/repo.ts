// 仓库检查与修复组（T-086）：准备页逐项检查 + 一键修复。界面只调用，所有写操作都由用户先确认。
import { execFile } from "node:child_process";
import { lstat, mkdtemp, mkdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isProtectedPath } from "./guard.js";
import { ensureBakacodingIgnored, isBakacodingIgnored } from "./worktree.js";
import { gitEnv, REPO_GIT_TIMEOUT_MS } from "./git-env.js";
import { withGitWriteLock } from "./git-lock.js";

/** 每次 git 调用的默认超时（定义挪到 git-env.ts，T-094）。 */
export { REPO_GIT_TIMEOUT_MS };
export const MAIN_BRANCH = "main";
export const INITIAL_COMMIT_MESSAGE = "初始提交（BakaCoding）";

export type RepoCheckId = "git" | "commit" | "main" | "ignored";
export type RepoCheckCode = "not_git" | "nested_repo" | "no_commits" | "no_main" | "not_ignored";

export interface RepoCheckItem {
  id: RepoCheckId;
  ok: boolean;
  code?: RepoCheckCode;
  /** 中文说明，不含路径。 */
  detail?: string;
  /** 只在 code 为 no_main 时给：当前检出的分支名（分离 HEAD 时不给）。 */
  current?: string;
}

export interface RepoCheck {
  /** 固定顺序：git、commit、main、ignored。 */
  items: RepoCheckItem[];
  /** 当前分支名；不是仓库或分离 HEAD 时为 null。 */
  current_branch: string | null;
  /**
   * 仓库的默认分支（T-120）。识别顺序：`origin/HEAD` 指向的远程默认分支（本地有同名分支且有提交）
   * → 本地 `main`（保持 v1 行为）→ 当前检出分支（有提交）。都没有（空仓库、分离 HEAD 且没有可用的
   * main 等）时为 null。`main` 检查项通过与否由它决定，`no_main` 表示「找不到可用的默认分支」。
   */
  default_branch: string | null;
  /** 是否配了 user.name / user.email（任意层级），不回传值。 */
  identity: { name: boolean; email: boolean };
}

export type RepoFixCode =
  | "not_git"
  | "nested_repo"
  | "repo_exists"
  | "no_commits"
  | "has_commits"
  | "main_exists"
  | "no_identity"
  | "invalid_identity"
  | "invalid_files"
  | "timeout"
  | "git_failed";

const MESSAGES: Record<RepoFixCode, string> = {
  not_git: "这个文件夹还不是 Git 仓库",
  nested_repo:
    "这个文件夹在另一个 Git 仓库里面。请导入上层仓库的根目录，或把文件夹移到仓库外再初始化",
  repo_exists: "这个文件夹已经是 Git 仓库",
  no_commits: "仓库还没有任何提交",
  has_commits: "仓库已经有提交，不能再做首次提交",
  main_exists: "main 分支已经存在",
  no_identity: "还没有设置 Git 用户名和邮箱",
  invalid_identity: "Git 用户名或邮箱不合法",
  invalid_files: "要提交的文件不在可提交列表里",
  timeout: "Git 命令超时",
  git_failed: "Git 命令执行失败",
};

/** 修复失败。message 是固定中文文案，不含路径和 git 原始输出。 */
export class RepoFixError extends Error {
  override readonly name = "RepoFixError";
  constructor(
    readonly code: RepoFixCode,
    /** 失败的 git 子命令名（只在 git_failed / timeout 时给）。 */
    readonly step?: string,
  ) {
    super(step ? `${MESSAGES[code]}（git ${step}）` : MESSAGES[code]);
  }
}

export interface RepoOptions {
  /** 每次 git 调用的超时，默认 REPO_GIT_TIMEOUT_MS。 */
  timeout_ms?: number;
}

interface GitOpts {
  timeout_ms: number;
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer;
}

interface GitResult {
  code: number;
  stdout: string;
}

function runGit(cwd: string, step: string, args: string[], o: GitOpts): Promise<GitResult> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      "git",
      args,
      {
        cwd,
        timeout: o.timeout_ms,
        maxBuffer: 64 * 1024 * 1024,
        env: gitEnv(o.env),
        windowsHide: true,
      },
      (err, stdout) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
          if (e.killed || e.signal === "SIGTERM") return reject(new RepoFixError("timeout", step));
          if (typeof e.code === "number") return resolvePromise({ code: e.code, stdout });
          return reject(new RepoFixError("git_failed", step));
        }
        resolvePromise({ code: 0, stdout });
      },
    );
    // git 可能不读 stdin 就退出，写入时的 EPIPE 忽略，结果以退出码为准。
    child.stdin?.on("error", () => {});
    child.stdin?.end(o.input ?? "");
  });
}

async function gitOk(cwd: string, step: string, args: string[], o: GitOpts): Promise<string> {
  const r = await runGit(cwd, step, args, o);
  if (r.code !== 0) {
    throw new RepoFixError("git_failed", step);
  }
  return r.stdout;
}

async function gitTry(
  cwd: string,
  step: string,
  args: string[],
  o: GitOpts,
): Promise<string | null> {
  const r = await runGit(cwd, step, args, o);
  return r.code === 0 ? r.stdout.trim() : null;
}

function opts(o?: RepoOptions): GitOpts {
  return { timeout_ms: o?.timeout_ms ?? REPO_GIT_TIMEOUT_MS };
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** detail 里展示的分支名上限（字符）。`current` 字段仍给完整分支名。 */
const BRANCH_DETAIL_MAX = 100;
const shortBranch = (b: string) =>
  b.length > BRANCH_DETAIL_MAX ? `${b.slice(0, BRANCH_DETAIL_MAX - 1)}…` : b;

/**
 * dir 和 Git 仓库的关系（T-114）：
 * - `root`：dir 自己就是仓库根，带真实路径；
 * - `nested`：dir 在另一个仓库里面（是它的子目录，或 dir 还不存在但最近的已有上级在仓库里）；
 * - `none`：不在任何仓库里。
 * 先看 `rev-parse --show-toplevel`；它失败时（不是仓库、或 git 因所有权等原因拒绝）再从上级目录
 * 往上逐层 lstat 找 `.git`（目录或文件都算），找到就当 nested。外层仓库的路径不对外返回。
 */
type RepoStatus = { kind: "root"; root: string } | { kind: "nested" } | { kind: "none" };

async function repoStatus(dir: string, o: GitOpts): Promise<RepoStatus> {
  let probe = dir;
  while (!(await isDir(probe))) {
    const up = dirname(probe);
    if (up === probe) return { kind: "none" };
    probe = up;
  }
  const exists = probe === dir;
  const top = await gitTry(probe, "rev-parse", ["rev-parse", "--show-toplevel"], o);
  if (top !== null) {
    if (!exists) return { kind: "nested" };
    const [a, b] = await Promise.all([realpath(dir), realpath(top)]);
    return a === b ? { kind: "root", root: b } : { kind: "nested" };
  }
  // dir 存在时它自己的 .git 不算（rev-parse 失败时按原来的“不是仓库”处理），从上级开始找。
  const real = await realpath(probe);
  return (await hasGitAbove(exists ? dirname(real) : real)) ? { kind: "nested" } : { kind: "none" };
}

async function hasGitAbove(start: string): Promise<boolean> {
  for (let d = start; ; d = dirname(d)) {
    try {
      await lstat(join(d, ".git"));
      return true;
    } catch {
      // 没有就继续往上
    }
    if (dirname(d) === d) return false;
  }
}

const hasCommit = async (root: string, o: GitOpts) =>
  (await gitTry(root, "rev-parse", ["rev-parse", "--verify", "-q", "HEAD^{commit}"], o)) !== null;
const hasBranchCommit = async (root: string, ref: string, o: GitOpts) =>
  (await gitTry(
    root,
    "rev-parse",
    ["rev-parse", "--verify", "-q", `refs/heads/${ref}^{commit}`],
    o,
  )) !== null;
const hasMain = async (root: string, o: GitOpts) => hasBranchCommit(root, MAIN_BRANCH, o);
const currentBranch = async (root: string, o: GitOpts) =>
  (await gitTry(root, "symbolic-ref", ["symbolic-ref", "--short", "-q", "HEAD"], o)) || null;
const configured = async (root: string, key: string, o: GitOpts) =>
  !!(await gitTry(root, "config", ["config", "--get", key], o));

/**
 * 默认分支识别（T-120）：`origin/HEAD` 指向的远程默认分支（本地有同名分支且有提交）→ 本地 `main`
 * （保持 v1 行为，不因用户检出在功能分支上而改基线）→ 当前检出分支（有提交，master / trunk 这类仓库）。
 * 都不可用时返回 null（`no_main`）。只读；git 调用都带超时。
 */
async function defaultBranch(
  root: string,
  branch: string | null,
  o: GitOpts,
): Promise<string | null> {
  const remoteHead = await gitTry(
    root,
    "symbolic-ref",
    ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"],
    o,
  );
  if (remoteHead) {
    const name = remoteHead.startsWith("origin/") ? remoteHead.slice("origin/".length) : remoteHead;
    if (name && (await hasBranchCommit(root, name, o))) return name;
  }
  if (await hasBranchCommit(root, MAIN_BRANCH, o)) return MAIN_BRANCH;
  if (branch && (await hasBranchCommit(root, branch, o))) return branch;
  return null;
}

/**
 * 逐项检查 dir（T-086）：是 Git 仓库（dir 本身是仓库根）、至少一次提交、有可用的默认分支（T-120：
 * `origin/HEAD` → 本地 main → 当前检出分支，见 `defaultBranch`）、`.bakacoding/` 已忽略。
 * `main` 项通过表示存在默认分支，不再要求分支名必须叫 main；`no_main` 表示找不到可用的默认分支。
 * dir 在另一个仓库里面时 git 项记 nested_repo（T-114），detail 不含外层仓库路径。
 * 只读，不改任何文件；git 调用都带超时。前一项不通过时后面各项一律记不通过。
 */
export async function checkRepo(dir: string, options?: RepoOptions): Promise<RepoCheck> {
  const o = opts(options);
  const status = await repoStatus(resolve(dir), o);
  if (status.kind !== "root") {
    const git: RepoCheckCode = status.kind === "nested" ? "nested_repo" : "not_git";
    return {
      items: [
        { id: "git", ok: false, code: git, detail: MESSAGES[git] },
        { id: "commit", ok: false, code: "no_commits", detail: MESSAGES.no_commits },
        { id: "main", ok: false, code: "no_main", detail: "没找到默认分支" },
        { id: "ignored", ok: false, code: "not_ignored", detail: ".bakacoding/ 还没加入忽略" },
      ],
      current_branch: null,
      default_branch: null,
      identity: { name: false, email: false },
    };
  }
  const root = status.root;
  const [commit, branch, ignored, name, email] = await Promise.all([
    hasCommit(root, o),
    currentBranch(root, o),
    isBakacodingIgnored(root),
    configured(root, "user.name", o),
    configured(root, "user.email", o),
  ]);
  const base = await defaultBranch(root, branch, o);
  const mainItem: RepoCheckItem = base
    ? { id: "main", ok: true }
    : {
        id: "main",
        ok: false,
        code: "no_main",
        detail: branch
          ? `没找到默认分支（当前是 ${shortBranch(branch)}）`
          : "没找到默认分支（分离 HEAD）",
        ...(branch ? { current: branch } : {}),
      };
  return {
    items: [
      { id: "git", ok: true },
      commit
        ? { id: "commit", ok: true }
        : { id: "commit", ok: false, code: "no_commits", detail: MESSAGES.no_commits },
      mainItem,
      ignored
        ? { id: "ignored", ok: true }
        : { id: "ignored", ok: false, code: "not_ignored", detail: ".bakacoding/ 还没加入忽略" },
    ],
    current_branch: branch,
    default_branch: base,
    identity: { name, email },
  };
}

/** Git 身份（T-108）：name / email 至少给一项，只写传进来的那几项。 */
export interface GitIdentity {
  name?: string;
  email?: string;
}

function assertIdentity(id: GitIdentity): void {
  const bad = (s: unknown, max: number) =>
    typeof s !== "string" || s.trim() === "" || s.length > max || /[\r\n\0<>]/.test(s);
  if (typeof id !== "object" || id === null) throw new RepoFixError("invalid_identity");
  const { name, email } = id;
  if (name === undefined && email === undefined) throw new RepoFixError("invalid_identity");
  if (name !== undefined && bad(name, 200)) throw new RepoFixError("invalid_identity");
  if (email !== undefined && (bad(email, 320) || !/^[^\s@]+@[^\s@]+$/.test(email.trim())))
    throw new RepoFixError("invalid_identity");
}

/** 只写本仓库 `.git/config`，只写给了的那几项。调用前必须已经 assertIdentity。 */
async function writeIdentity(root: string, id: GitIdentity, o: GitOpts): Promise<void> {
  if (id.name !== undefined)
    await gitOk(root, "config", ["config", "--local", "user.name", id.name.trim()], o);
  if (id.email !== undefined)
    await gitOk(root, "config", ["config", "--local", "user.email", id.email.trim()], o);
}

/**
 * 初始化 Git（T-086）：dir 不存在就新建，执行 `git init`，HEAD 指向 main；给了 identity 只写本仓库 `.git/config`，只写给了的那几项（T-108）；
 * 然后把 `/.bakacoding/` 写进 `.git/info/exclude`。dir 已经是仓库根时抛 repo_exists；dir 在另一个仓库里面时
 * 抛 nested_repo（T-114，不建目录、不 init、不写忽略）。这两种情况都什么都不改。
 */
export async function initRepo(
  dir: string,
  init: { identity?: GitIdentity } = {},
  options?: RepoOptions,
): Promise<void> {
  const o = opts(options);
  if (init.identity !== undefined) assertIdentity(init.identity);
  const abs = resolve(dir);
  // T-094：仓库写操作持进程内 git 写锁，与建 / 删 worktree、合入后清理串行
  return withGitWriteLock(abs, () => initRepoLocked(abs, init, o));
}

async function initRepoLocked(
  abs: string,
  init: { identity?: GitIdentity },
  o: GitOpts,
): Promise<void> {
  const status = await repoStatus(abs, o);
  if (status.kind === "root") throw new RepoFixError("repo_exists");
  if (status.kind === "nested") throw new RepoFixError("nested_repo");
  await mkdir(abs, { recursive: true });
  // 不依赖 git 2.28 的 `-b`：先 init，再把未出生的 HEAD 指到 main。
  await gitOk(abs, "init", ["init", "-q"], o);
  await gitOk(abs, "symbolic-ref", ["symbolic-ref", "HEAD", `refs/heads/${MAIN_BRANCH}`], o);
  if (init.identity) await writeIdentity(abs, init.identity, o);
  await ensureBakacodingIgnored(abs);
}

export type ExcludedReason = "protected" | "bakacoding";

export interface InitialCommitFiles {
  /** 将提交的文件（相对仓库根，posix 分隔符，按字典序）。 */
  include: string[];
  /** 默认排除的文件：.env 类和私钥类（`protected`，规则同模块 4 的受保护路径，`.env.example` 不排除）、`.bakacoding/` 下的运行数据。 */
  excluded: { path: string; reason: ExcludedReason }[];
}

function classify(rel: string): ExcludedReason | null {
  if (rel === ".bakacoding" || rel.startsWith(".bakacoding/")) return "bakacoding";
  return isProtectedPath(rel, "ro") ? "protected" : null;
}

async function requireRoot(dir: string, o: GitOpts): Promise<string> {
  const status = await repoStatus(resolve(dir), o);
  if (status.kind === "nested") throw new RepoFixError("nested_repo");
  if (status.kind === "none") throw new RepoFixError("not_git");
  return status.root;
}

async function listFiles(root: string, o: GitOpts): Promise<InitialCommitFiles> {
  const out = await gitOk(
    root,
    "-c",
    ["-c", "core.quotepath=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    o,
  );
  const all = [...new Set(out.split("\0").filter(Boolean))].sort();
  const include: string[] = [];
  const excluded: InitialCommitFiles["excluded"] = [];
  for (const p of all) {
    const reason = classify(p);
    if (reason) excluded.push({ path: p, reason });
    else include.push(p);
  }
  return { include, excluded };
}

/**
 * 列出首次提交会带上的文件，给确认框用（T-086）：已暂存 + 未跟踪且没被 .gitignore / exclude 忽略的文件，
 * 默认排除 .env 类、私钥类和 `.bakacoding/` 下的文件。只读。
 */
export async function listInitialCommitFiles(
  dir: string,
  options?: RepoOptions,
): Promise<InitialCommitFiles> {
  const o = opts(options);
  return listFiles(await requireRoot(dir, o), o);
}

/**
 * 首次提交（T-086），提交到 main：只在仓库还没有任何提交时执行。
 * `{ files }` 只提交列出的文件，每个都必须在 listInitialCommitFiles 的 include 里，否则整体拒绝（invalid_files）、什么都不改；
 * `{ empty: true }` 做空提交。用临时索引建树，不跑 hooks；提交后 HEAD 指向 main，暂存区重置为这次提交，工作区文件不动。
 * identity 可以只给 name 或只给 email（T-108），只写给了的那几项、只写本仓库 `.git/config`；给的加上仓库已配的还凑不齐 user.name 和 user.email 时
 * 抛 no_identity（界面在确认框里只让用户补缺的那项），不用默认名字提交。文件、身份都先校验，任何一项不通过都整体拒绝、`.git/config` 不改。
 */
export async function initialCommit(
  dir: string,
  what: ({ files: readonly string[] } | { empty: true }) & { identity?: GitIdentity },
  options?: RepoOptions,
): Promise<{ commit: string }> {
  const o = opts(options);
  if (what.identity !== undefined) assertIdentity(what.identity);
  const root = await requireRoot(dir, o);
  return withGitWriteLock(root, () => initialCommitLocked(root, what, o));
}

async function initialCommitLocked(
  root: string,
  what: ({ files: readonly string[] } | { empty: true }) & { identity?: GitIdentity },
  o: GitOpts,
): Promise<{ commit: string }> {
  if (await hasCommit(root, o)) throw new RepoFixError("has_commits");
  // T-108：先校验文件和身份，全部通过才写 `.git/config`，拒绝时什么都不改。
  let files: string[] = [];
  if (!("empty" in what && what.empty === true)) {
    const req = (what as { files: readonly string[] }).files;
    if (!Array.isArray(req) || req.length === 0 || req.some((f) => typeof f !== "string"))
      throw new RepoFixError("invalid_files");
    const allowed = new Set((await listFiles(root, o)).include);
    files = [...new Set(req)];
    if (files.some((f) => !allowed.has(f))) throw new RepoFixError("invalid_files");
  }
  const id = what.identity;
  const hasName = id?.name !== undefined || (await configured(root, "user.name", o));
  const hasEmail = id?.email !== undefined || (await configured(root, "user.email", o));
  if (!hasName || !hasEmail) throw new RepoFixError("no_identity");
  if (id) await writeIdentity(root, id, o);
  const tmp = await mkdtemp(join(tmpdir(), "bc-index-"));
  try {
    const env = { GIT_INDEX_FILE: join(tmp, "index") };
    if (files.length > 0) {
      await gitOk(root, "update-index", ["update-index", "--add", "-z", "--stdin"], {
        ...o,
        env,
        input: files.map((f) => `${f}\0`).join(""),
      });
    }
    const tree = (await gitOk(root, "write-tree", ["write-tree"], { ...o, env })).trim();
    const commit = (
      await gitOk(root, "commit-tree", ["commit-tree", tree, "-m", INITIAL_COMMIT_MESSAGE], o)
    ).trim();
    // 旧值写空串：main 已存在就失败，不覆盖。
    await gitOk(root, "update-ref", ["update-ref", `refs/heads/${MAIN_BRANCH}`, commit, ""], o);
    await gitOk(root, "symbolic-ref", ["symbolic-ref", "HEAD", `refs/heads/${MAIN_BRANCH}`], o);
    await gitOk(root, "read-tree", ["read-tree", "HEAD"], o);
    return { commit };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * 从当前 HEAD 新建 main（T-086）：只新建，不切换、不改名、不删原分支。
 * 返回 `from`：当前分支名，分离 HEAD 时是提交哈希。没有提交抛 no_commits，main 已存在抛 main_exists。
 */
export async function createMainBranch(
  dir: string,
  options?: RepoOptions,
): Promise<{ from: string }> {
  const o = opts(options);
  const root = await requireRoot(dir, o);
  return withGitWriteLock(root, () => createMainBranchLocked(root, o));
}

async function createMainBranchLocked(root: string, o: GitOpts): Promise<{ from: string }> {
  if (!(await hasCommit(root, o))) throw new RepoFixError("no_commits");
  if (await hasMain(root, o)) throw new RepoFixError("main_exists");
  const from =
    (await currentBranch(root, o)) ??
    (await gitOk(root, "rev-parse", ["rev-parse", "HEAD"], o)).trim();
  const head = (await gitOk(root, "rev-parse", ["rev-parse", "HEAD^{commit}"], o)).trim();
  await gitOk(root, "update-ref", ["update-ref", `refs/heads/${MAIN_BRANCH}`, head, ""], o);
  return { from };
}
