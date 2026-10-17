import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const WORKTREES_DIR = ".bakacoding/worktrees";
/** 排除整个 .bakacoding/（worktree、数据库等运行数据都在这里），T-078。 */
const IGNORE_LINE = "/.bakacoding/";
/** 已等价覆盖整个目录的写法；旧版写的 `/.bakacoding/worktrees/` 不算，需补新行。 */
const COVERING_LINES = [".bakacoding/", "/.bakacoding", ".bakacoding"];
const TICKET_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface WorktreeInfo {
  path: string;
  branch: string;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

function assertTicket(ticket_id: string): void {
  if (!TICKET_RE.test(ticket_id) || ticket_id.includes("..")) {
    throw new Error(`非法 ticket_id：${JSON.stringify(ticket_id)}`);
  }
}

/**
 * 按 git 读 exclude / .gitignore 的规则归一化一行（T-082）：去掉行尾未转义的空格（`\\ ` 结尾的空格保留），
 * 行首空格照 git 的语义保留；空行和 `#` 开头的注释行返回 null。
 */
export function normalizeIgnoreLine(line: string): string | null {
  let end = line.length;
  let lastSpace = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === " ") {
      if (lastSpace === -1) lastSpace = i;
    } else {
      lastSpace = -1;
      if (c === "\\") i++; // 转义：下一个字符（包括空格）原样保留
    }
  }
  if (lastSpace !== -1) end = lastSpace;
  const out = line.slice(0, end);
  if (out === "" || out.startsWith("#")) return null;
  return out;
}

/** 一条要写进 exclude 的规则：`line` 是要追加的写法，`equivalents` 里任一写法已存在也算已有。 */
export type ExcludeRule = string | { line: string; equivalents?: readonly string[] };

/**
 * 确保 dir 所在仓库的 `.git/info/exclude` 里有 lines 里的每条规则（T-082）；缺哪条按顺序追加哪条，
 * 已有的行不动、不重排、不删。是否已存在按 git 语义比较（见 normalizeIgnoreLine）。exclude 文件位置用
 * `git rev-parse --git-common-dir` 定位，worktree 里调用也写进主仓库。原文件末尾没有换行时先补一个。
 * dir 不是 git 仓库时返回 false、不抛错；规则为空、含换行或是注释时抛 TypeError；写文件失败照常抛错。
 */
export async function ensureExcludeLines(
  dir: string,
  lines: readonly ExcludeRule[],
): Promise<boolean> {
  const rules = lines.map((r) => {
    const rule = typeof r === "string" ? { line: r, equivalents: [] } : r;
    const forms = [rule.line, ...(rule.equivalents ?? [])].map((l) => {
      const n = /[\r\n]/.test(l) ? null : normalizeIgnoreLine(l);
      if (n === null) throw new TypeError(`exclude 规则不合法：${JSON.stringify(l)}`);
      return n;
    });
    return { line: rule.line, forms };
  });
  let commonDir: string;
  try {
    const root = await git(resolve(dir), "rev-parse", "--show-toplevel");
    commonDir = resolve(root, await git(root, "rev-parse", "--git-common-dir"));
  } catch {
    return false;
  }
  const exclude = join(commonDir, "info", "exclude");
  await mkdir(join(commonDir, "info"), { recursive: true });
  const cur = existsSync(exclude) ? await readFile(exclude, "utf8") : "";
  const have = new Set(
    cur.split(/\r?\n/).flatMap((l) => {
      const n = normalizeIgnoreLine(l);
      return n === null ? [] : [n];
    }),
  );
  const add: string[] = [];
  for (const r of rules) {
    if (r.forms.some((f) => have.has(f))) continue;
    add.push(r.line);
    have.add(r.forms[0]!);
  }
  if (add.length === 0) return true;
  await appendFile(exclude, `${cur && !cur.endsWith("\n") ? "\n" : ""}${add.join("\n")}\n`);
  return true;
}

/**
 * 把 `/.bakacoding/` 写进 dir 所在仓库的 .git/info/exclude（T-078，T-082 起经 ensureExcludeLines）；
 * 幂等，旧行保留。dir 不是 git 仓库时返回 false、不抛错；写文件失败照常抛错。导入 / 启动时在建数据库之前调用。
 */
export async function ensureBakacodingIgnored(dir: string): Promise<boolean> {
  return ensureExcludeLines(dir, [{ line: IGNORE_LINE, equivalents: COVERING_LINES }]);
}

/** 每单 worktree 管理：路径 <repo>/.bakacoding/worktrees/<ticket_id>-r<n>，分支 bakacoding/<ticket_id>-r<n>。 */
export class WorktreeManager {
  private constructor(readonly repoRoot: string) {}

  static async open(dir: string): Promise<WorktreeManager> {
    return new WorktreeManager(await git(resolve(dir), "rev-parse", "--show-toplevel"));
  }

  /** 把整个 `.bakacoding/` 写进 .git/info/exclude（不改用户跟踪的 .gitignore）；幂等，旧行保留。 */
  async ensureIgnored(): Promise<void> {
    if (!(await ensureBakacodingIgnored(this.repoRoot)))
      throw new Error(`不是 git 仓库：${this.repoRoot}`);
  }

  async createWorktree(
    ticket_id: string,
    base_commit: string,
    resubmit_index = 0,
  ): Promise<WorktreeInfo> {
    assertTicket(ticket_id);
    if (!Number.isInteger(resubmit_index) || resubmit_index < 0)
      throw new Error("resubmit_index 须为非负整数");
    const sha = await git(this.repoRoot, "rev-parse", "--verify", `${base_commit}^{commit}`);
    await this.ensureIgnored();
    const name = `${ticket_id}-r${resubmit_index}`;
    const path = join(this.repoRoot, WORKTREES_DIR, name);
    const branch = `bakacoding/${name}`;
    if (existsSync(path)) throw new Error(`worktree 已存在：${path}`);
    await mkdir(join(this.repoRoot, WORKTREES_DIR), { recursive: true });
    // 新 worktree 只含已提交内容，不带入未跟踪文件（如密钥）。
    await git(this.repoRoot, "worktree", "add", "-b", branch, path, sha);
    return { path, branch };
  }

  async list(): Promise<WorktreeInfo[]> {
    const out = await git(this.repoRoot, "worktree", "list", "--porcelain");
    const res: WorktreeInfo[] = [];
    let path = "";
    for (const line of out.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice(9);
      else if (line.startsWith("branch refs/heads/bakacoding/"))
        res.push({ path, branch: line.slice(18) });
    }
    return res.filter((w) => this.isManaged(w.path));
  }

  private isManaged(p: string): boolean {
    const rel = relative(join(this.repoRoot, WORKTREES_DIR), p);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  }

  /** 按 ticket_id（清掉该单所有轮次）或 worktree 路径清理：删 worktree 和对应分支。 */
  async cleanup(ticketIdOrPath: string): Promise<string[]> {
    const all = await this.list();
    const byPath = ticketIdOrPath.includes("/") || ticketIdOrPath.includes("\\");
    if (!byPath) assertTicket(ticketIdOrPath);
    const targets = byPath
      ? all.filter((w) => resolve(w.path) === resolve(ticketIdOrPath))
      : all.filter((w) => /^bakacoding\/(.+)-r\d+$/.exec(w.branch)?.[1] === ticketIdOrPath);
    for (const w of targets) {
      await git(this.repoRoot, "worktree", "remove", "--force", w.path);
      await git(this.repoRoot, "branch", "-D", w.branch);
    }
    await git(this.repoRoot, "worktree", "prune");
    return targets.map((w) => w.path);
  }
}
