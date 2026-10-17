// 仓库检查与修复组（T-086）：准备页逐项检查 + 一键修复。界面只调用，所有写操作都由用户先确认。
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isProtectedPath } from "./guard.js";
import { ensureBakacodingIgnored, isBakacodingIgnored } from "./worktree.js";
import { gitEnv } from "./git-env.js";

/** 每次 git 调用的默认超时。 */
export const REPO_GIT_TIMEOUT_MS = 30_000;
export const MAIN_BRANCH = "main";
export const INITIAL_COMMIT_MESSAGE = "初始提交（BakaCoding）";

export type RepoCheckId = "git" | "commit" | "main" | "ignored";
export type RepoCheckCode = "not_git" | "no_commits" | "no_main" | "not_ignored";

export interface RepoCheckItem {
  id: RepoCheckId;
  ok: boolean;
  code?: RepoCheckCode;
  /** 中文说明，不含路径。 */
  detail?: string;
  /** 只在 code 为 no_main 时给：当前分支名（分离 HEAD 或没有分支时不给）。 */
  current?: string;
}

export interface RepoCheck {
  /** 固定顺序：git、commit、main、ignored。 */
  items: RepoCheckItem[];
  /** 当前分支名；不是仓库或分离 HEAD 时为 null。 */
  current_branch: string | null;
  /** 是否配了 user.name / user.email（任意层级），不回传值。 */
  identity: { name: boolean; email: boolean };
}

export type RepoFixCode =
  | "not_git"
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

/** dir 自己就是仓库根（不是外层仓库的子目录）时返回真实路径，否则 null。 */
async function ownRepoRoot(dir: string, o: GitOpts): Promise<string | null> {
  if (!(await isDir(dir))) return null;
  const top = await gitTry(dir, "rev-parse", ["rev-parse", "--show-toplevel"], o);
  if (top === null) return null;
  const [a, b] = await Promise.all([realpath(dir), realpath(top)]);
  return a === b ? b : null;
}

const hasCommit = async (root: string, o: GitOpts) =>
  (await gitTry(root, "rev-parse", ["rev-parse", "--verify", "-q", "HEAD^{commit}"], o)) !== null;
const hasMain = async (root: string, o: GitOpts) =>
  (await gitTry(
    root,
    "rev-parse",
    ["rev-parse", "--verify", "-q", `refs/heads/${MAIN_BRANCH}^{commit}`],
    o,
  )) !== null;
const currentBranch = async (root: string, o: GitOpts) =>
  (await gitTry(root, "symbolic-ref", ["symbolic-ref", "--short", "-q", "HEAD"], o)) || null;
const configured = async (root: string, key: string, o: GitOpts) =>
  !!(await gitTry(root, "config", ["config", "--get", key], o));

/**
 * 逐项检查 dir（T-086）：是 Git 仓库（dir 本身是仓库根）、至少一次提交、有 main 分支、`.bakacoding/` 已忽略。
 * 只读，不改任何文件；git 调用都带超时。前一项不通过时后面各项一律记不通过。
 */
export async function checkRepo(dir: string, options?: RepoOptions): Promise<RepoCheck> {
  const o = opts(options);
  const root = await ownRepoRoot(resolve(dir), o);
  if (root === null) {
    return {
      items: [
        { id: "git", ok: false, code: "not_git", detail: MESSAGES.not_git },
        { id: "commit", ok: false, code: "no_commits", detail: MESSAGES.no_commits },
        { id: "main", ok: false, code: "no_main", detail: "没找到 main 分支" },
        { id: "ignored", ok: false, code: "not_ignored", detail: ".bakacoding/ 还没加入忽略" },
      ],
      current_branch: null,
      identity: { name: false, email: false },
    };
  }
  const [commit, main, branch, ignored, name, email] = await Promise.all([
    hasCommit(root, o),
    hasMain(root, o),
    currentBranch(root, o),
    isBakacodingIgnored(root),
    configured(root, "user.name", o),
    configured(root, "user.email", o),
  ]);
  const mainItem: RepoCheckItem = main
    ? { id: "main", ok: true }
    : {
        id: "main",
        ok: false,
        code: "no_main",
        detail:
          branch && branch !== MAIN_BRANCH
            ? `没找到 main 分支（当前是 ${shortBranch(branch)}）`
            : "没找到 main 分支",
        ...(branch && branch !== MAIN_BRANCH ? { current: branch } : {}),
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
    identity: { name, email },
  };
}

export interface GitIdentity {
  name: string;
  email: string;
}

function assertIdentity(id: GitIdentity): void {
  const bad = (s: unknown, max: number) =>
    typeof s !== "string" || s.trim() === "" || s.length > max || /[\r\n\0<>]/.test(s);
  if (bad(id.name, 200) || bad(id.email, 320) || !/^[^\s@]+@[^\s@]+$/.test(id.email.trim()))
    throw new RepoFixError("invalid_identity");
}

/**
 * 初始化 Git（T-086）：dir 不存在就新建，执行 `git init`，HEAD 指向 main；给了 identity 只写本仓库 `.git/config`；
 * 然后把 `/.bakacoding/` 写进 `.git/info/exclude`。dir 已经是仓库根时抛 repo_exists，什么都不改。
 */
export async function initRepo(
  dir: string,
  init: { identity?: GitIdentity } = {},
  options?: RepoOptions,
): Promise<void> {
  const o = opts(options);
  if (init.identity) assertIdentity(init.identity);
  const abs = resolve(dir);
  if (await ownRepoRoot(abs, o)) throw new RepoFixError("repo_exists");
  await mkdir(abs, { recursive: true });
  // 不依赖 git 2.28 的 `-b`：先 init，再把未出生的 HEAD 指到 main。
  await gitOk(abs, "init", ["init", "-q"], o);
  await gitOk(abs, "symbolic-ref", ["symbolic-ref", "HEAD", `refs/heads/${MAIN_BRANCH}`], o);
  if (init.identity) {
    await gitOk(abs, "config", ["config", "--local", "user.name", init.identity.name.trim()], o);
    await gitOk(abs, "config", ["config", "--local", "user.email", init.identity.email.trim()], o);
  }
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
  const root = await ownRepoRoot(resolve(dir), o);
  if (root === null) throw new RepoFixError("not_git");
  return root;
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
 * 给了 identity 先写进本仓库 `.git/config`；没给、仓库也没配 user.name / user.email 时抛 no_identity（界面在确认框里补填），不用默认名字提交。
 */
export async function initialCommit(
  dir: string,
  what: ({ files: readonly string[] } | { empty: true }) & { identity?: GitIdentity },
  options?: RepoOptions,
): Promise<{ commit: string }> {
  const o = opts(options);
  if (what.identity) assertIdentity(what.identity);
  const root = await requireRoot(dir, o);
  if (await hasCommit(root, o)) throw new RepoFixError("has_commits");
  if (what.identity) {
    await gitOk(root, "config", ["config", "--local", "user.name", what.identity.name.trim()], o);
    await gitOk(root, "config", ["config", "--local", "user.email", what.identity.email.trim()], o);
  }
  if (!(await configured(root, "user.name", o)) || !(await configured(root, "user.email", o)))
    throw new RepoFixError("no_identity");
  let files: string[] = [];
  if (!("empty" in what && what.empty === true)) {
    const req = (what as { files: readonly string[] }).files;
    if (!Array.isArray(req) || req.length === 0 || req.some((f) => typeof f !== "string"))
      throw new RepoFixError("invalid_files");
    const allowed = new Set((await listFiles(root, o)).include);
    files = [...new Set(req)];
    if (files.some((f) => !allowed.has(f))) throw new RepoFixError("invalid_files");
  }
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
  if (!(await hasCommit(root, o))) throw new RepoFixError("no_commits");
  if (await hasMain(root, o)) throw new RepoFixError("main_exists");
  const from =
    (await currentBranch(root, o)) ??
    (await gitOk(root, "rev-parse", ["rev-parse", "HEAD"], o)).trim();
  const head = (await gitOk(root, "rev-parse", ["rev-parse", "HEAD^{commit}"], o)).trim();
  await gitOk(root, "update-ref", ["update-ref", `refs/heads/${MAIN_BRANCH}`, head, ""], o);
  return { from };
}
