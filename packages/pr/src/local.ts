import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DiffSchema, type Diff, type DiffFile } from "@bakacoding/types";
import { git, GitError } from "./git.js";
import {
  INTEGRATION_BRANCH,
  type CheckResult,
  type SyncChange,
  type MergeResult,
  type PrProvider,
} from "./provider.js";
import { assertPrRecord, type PrRecord, type PrStore, type TicketPrRecord } from "./store.js";

export interface LocalPrProviderOptions {
  store: PrStore;
  /** open 时用来求 base_sha 的基线分支，默认 main */
  baseBranch?: string;
  /** 提交身份，默认 BakaCoding <bakacoding@localhost> */
  author?: { name: string; email: string };
  now?: () => Date;
  /** 集成分支所在仓库（任一 worktree 路径均可）；openIntegration 需要 */
  repo?: string;
}

export class PrNotFoundError extends Error {
  constructor(pr_id: string) {
    super(`PR 不存在：${pr_id}`);
    this.name = "PrNotFoundError";
  }
}

export class CommitPatchError extends Error {
  constructor(
    message: string,
    readonly cause: GitError,
  ) {
    super(message);
    this.name = "CommitPatchError";
  }
}

const STATUS: Record<string, DiffFile["status"]> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  T: "modified",
  C: "added",
};

/** commitWorktree：worktree 里没有任何改动。 */
export class NoChangesError extends Error {
  constructor(
    readonly ticket_id: string,
    readonly worktree_path: string,
  ) {
    super(`${ticket_id} 的 worktree 没有改动可提交：${worktree_path}`);
    this.name = "NoChangesError";
  }
}

/** commitWorktree：找不到对应的 ticket 记录，或当前分支与记录不符。 */
export class WorktreeMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeMismatchError";
  }
}

/** close：已合并的记录不能关闭。 */
export class PrAlreadyMergedError extends Error {
  constructor(pr_id: string) {
    super(`PR 已合并，不能关闭：${pr_id}`);
    this.name = "PrAlreadyMergedError";
  }
}

export class LocalPrProvider implements PrProvider {
  readonly kind = "local" as const;
  private readonly store: PrStore;
  private readonly baseBranch: string;
  private readonly author: { name: string; email: string };
  private readonly now: () => Date;
  private readonly repo: string | undefined;
  private seq = 0;
  /** 串行化 openIntegration，避免并发调用建出两条记录 */
  private integrationLock: Promise<unknown> = Promise.resolve();

  constructor(opts: LocalPrProviderOptions) {
    this.store = opts.store;
    this.baseBranch = opts.baseBranch ?? "main";
    this.author = opts.author ?? { name: "BakaCoding", email: "bakacoding@localhost" };
    this.now = opts.now ?? (() => new Date());
    this.repo = opts.repo;
  }

  private identityEnv(): NodeJS.ProcessEnv {
    const { name, email } = this.author;
    return {
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
    };
  }

  async commitPatch(ticket_id: string, worktree_path: string, patch: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "bc-patch-"));
    const file = join(dir, "change.patch");
    try {
      await writeFile(file, patch.endsWith("\n") ? patch : `${patch}\n`);
      await git(worktree_path, ["apply", "--index", "--whitespace=nowarn", file]);
      try {
        await git(worktree_path, ["commit", "-m", `${ticket_id}: apply patch`], {
          env: this.identityEnv(),
        });
      } catch (err) {
        // 提交失败（含 hook 拒绝）：撤回补丁，不留提交，错误信息带上 hook 输出
        await git(worktree_path, ["apply", "-R", "--index", "--whitespace=nowarn", file]).catch(
          () => undefined,
        );
        const e = err as GitError;
        throw new CommitPatchError(
          `${ticket_id} 提交失败：${[e.stdout, e.stderr].join("\n").trim()}`,
          e,
        );
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    return (await git(worktree_path, ["rev-parse", "HEAD"])).stdout.trim();
  }

  async commitWorktree(ticket_id: string, worktree_path: string): Promise<string> {
    const wt = resolve(worktree_path);
    const rec = (await this.store.list())
      .map(assertPrRecord)
      .filter(
        (r): r is TicketPrRecord =>
          r.kind === "ticket" &&
          r.ticket_id === ticket_id &&
          resolve(r.worktree_path) === wt &&
          (r.status === "open" || r.status === "conflict"),
      )
      .at(-1);
    if (!rec)
      throw new WorktreeMismatchError(`${ticket_id} 在 ${worktree_path} 没有未结束的 PR 记录`);
    const cur = await git(worktree_path, ["symbolic-ref", "-q", "--short", "HEAD"], {
      allowCodes: [1],
    });
    if (cur.code !== 0 || cur.stdout.trim() !== rec.branch)
      throw new WorktreeMismatchError(
        `${ticket_id} 的 worktree 当前分支是 ${cur.stdout.trim() || "（分离 HEAD）"}，记录里是 ${rec.branch}`,
      );
    await git(worktree_path, ["add", "-A"]);
    const staged = await git(worktree_path, ["diff", "--cached", "--quiet"], { allowCodes: [1] });
    if (staged.code === 0) throw new NoChangesError(ticket_id, worktree_path);
    try {
      await git(worktree_path, ["commit", "-q", "-m", `${ticket_id}: apply worktree changes`], {
        env: this.identityEnv(),
      });
    } catch (err) {
      // 提交失败（含 hook 拒绝）：撤回暂存，工作区文件原样保留
      await git(worktree_path, ["reset", "-q"]).catch(() => undefined);
      const e = err as GitError;
      throw new CommitPatchError(
        `${ticket_id} 提交失败：${[e.stdout, e.stderr].join("\n").trim()}`,
        e,
      );
    }
    return (await git(worktree_path, ["rev-parse", "HEAD"])).stdout.trim();
  }

  async close(pr_id: string, reason: string): Promise<void> {
    const rec = await this.mustGet(pr_id);
    if (rec.status === "merged") throw new PrAlreadyMergedError(pr_id);
    if (rec.status === "closed") return;
    await this.store.put({
      ...rec,
      status: "closed",
      closed_by: "bakacoding",
      close_reason: reason,
      updated_ts: this.now().toISOString(),
    });
  }

  async open(ticket_id: string, worktree_path: string, branch: string): Promise<string> {
    const head = await this.revParse(worktree_path, branch);
    const base = (await git(worktree_path, ["merge-base", this.baseBranch, head])).stdout.trim();
    const existing = (await this.store.list()).length;
    const pr_id = `local-${ticket_id}-${existing + ++this.seq}`;
    const ts = this.now().toISOString();
    await this.store.put({
      kind: "ticket",
      pr_id,
      ticket_id,
      worktree_path,
      branch,
      base_branch: this.baseBranch,
      base_sha: base,
      head_sha: head,
      status: "open",
      created_ts: ts,
      updated_ts: ts,
    });
    return pr_id;
  }

  openIntegration(branch: string = INTEGRATION_BRANCH, target: string = "main"): Promise<string> {
    const run = this.integrationLock.then(() => this.openIntegrationLocked(branch, target));
    this.integrationLock = run.catch(() => undefined);
    return run;
  }

  private async openIntegrationLocked(branch: string, target: string): Promise<string> {
    const cwd = this.repo;
    if (!cwd) throw new Error("openIntegration 需要 LocalPrProviderOptions.repo");
    const records = (await this.store.list()).map(assertPrRecord);
    const live = records.find(
      (r) =>
        r.kind === "integration" &&
        r.branch === branch &&
        r.base_branch === target &&
        (r.status === "open" || r.status === "conflict"),
    );
    if (live) return live.pr_id;

    const tgt = await this.ensureBranch(cwd, branch, target);
    const head = await this.revParse(cwd, branch);
    const base = (await git(cwd, ["merge-base", tgt, head])).stdout.trim();

    let n = records.filter((r) => r.kind === "integration").length + 1;
    while (await this.store.get(`local-integration-${n}`)) n++;
    const pr_id = `local-integration-${n}`;
    const ts = this.now().toISOString();
    await this.store.put({
      kind: "integration",
      pr_id,
      repo_path: cwd,
      branch,
      base_branch: target,
      base_sha: base,
      head_sha: head,
      status: "open",
      created_ts: ts,
      updated_ts: ts,
    });
    return pr_id;
  }

  async diff(pr_id: string): Promise<Diff> {
    const rec = await this.mustGet(pr_id);
    const cwd = cwdOf(rec);
    const live = rec.status === "open" || rec.status === "conflict";
    const head = live ? await this.revParse(cwd, rec.branch) : rec.head_sha;
    // 集成分支会一直前进：未结束时 base 也现算
    const base =
      live && rec.kind === "integration"
        ? (await git(cwd, ["merge-base", rec.base_branch, head])).stdout.trim()
        : rec.base_sha;
    const range = [base, head];
    const ns = (await git(cwd, ["diff", "-M", "--name-status", "-z", ...range])).stdout;
    const num = (await git(cwd, ["diff", "-M", "--numstat", "-z", ...range])).stdout;

    const entries: { status: DiffFile["status"]; path: string; old?: string }[] = [];
    const t = ns.split("\0");
    for (let i = 0; i < t.length && t[i];) {
      const code = t[i++]!.charAt(0);
      if (code === "R" || code === "C") {
        const old = t[i++]!;
        entries.push({ status: STATUS[code]!, path: t[i++]!, old });
      } else {
        entries.push({ status: STATUS[code] ?? "modified", path: t[i++]! });
      }
    }

    const counts = new Map<string, { a: number; d: number }>();
    const n = num.split("\0");
    for (let i = 0; i < n.length && n[i];) {
      const [a, d, p] = n[i++]!.split("\t");
      const path = p === "" ? (i++, n[i++]!) : p!; // 重命名：空路径后跟 old\0new
      counts.set(path, { a: a === "-" ? 0 : Number(a), d: d === "-" ? 0 : Number(d) });
    }

    const files: DiffFile[] = [];
    for (const e of entries) {
      const paths = e.old ? [e.old, e.path] : [e.path];
      const patch = (await git(cwd, ["diff", "-M", ...range, "--", ...paths])).stdout;
      const c = counts.get(e.path) ?? { a: 0, d: 0 };
      files.push({ path: e.path, status: e.status, additions: c.a, deletions: c.d, patch });
    }
    return DiffSchema.parse({ base_sha: base, head_sha: head, files });
  }

  /**
   * 用 merge-tree 算结果（快进或 commit-tree 生成合并提交），再落到 target：
   * - target 在某 worktree 被 checkout 且干净：在该 worktree 里 merge --ff-only；
   * - checkout 且有未提交改动：不合并，返回 target_dirty；
   * - 未被 checkout：update-ref（带旧值校验）。
   */
  async merge(pr_id: string, target: string): Promise<MergeResult> {
    const rec = await this.mustGet(pr_id);
    if (rec.status === "merged" || rec.status === "closed")
      throw new Error(`PR 已${rec.status === "merged" ? "合并" : "关闭"}：${pr_id}`);
    const cwd = cwdOf(rec);
    const head = await this.revParse(cwd, rec.branch);
    const tgt = await this.revParse(cwd, target);
    const ref = `refs/heads/${target}`;

    const isAncestor =
      (await git(cwd, ["merge-base", "--is-ancestor", tgt, head], { allowCodes: [1] })).code === 0;
    let sha: string;
    let ff: boolean;
    if (isAncestor) {
      sha = head;
      ff = true;
    } else {
      const mt = await git(
        cwd,
        ["merge-tree", "--write-tree", "--name-only", "--no-messages", tgt, head],
        { allowCodes: [1] },
      );
      const lines = mt.stdout.split("\n").filter(Boolean);
      if (mt.code === 1) {
        await this.store.put({ ...rec, status: "conflict", updated_ts: this.now().toISOString() });
        return { merged: false, conflict: true, conflicted_files: lines.slice(1) };
      }
      sha = (
        await git(
          cwd,
          [
            "commit-tree",
            lines[0]!,
            "-p",
            tgt,
            "-p",
            head,
            "-m",
            `Merge ${pr_id} (${rec.kind === "ticket" ? rec.ticket_id : rec.branch}) into ${target}`,
          ],
          { env: this.identityEnv() },
        )
      ).stdout.trim();
      ff = false;
    }
    const wt = await this.findCheckout(cwd, ref);
    if (wt) {
      const dirty = (await git(wt, ["status", "--porcelain", "--untracked-files=no"])).stdout;
      if (dirty.trim()) {
        return { merged: false, conflict: false, reason: "target_dirty", worktree_path: wt };
      }
      try {
        await git(wt, ["merge", "--ff-only", "-q", sha]);
      } catch (err) {
        // 未跟踪文件会被覆盖：视同 target_dirty，记录状态不变
        if (err instanceof GitError && /untracked working tree files/.test(err.stderr)) {
          return { merged: false, conflict: false, reason: "target_dirty", worktree_path: wt };
        }
        throw err;
      }
    } else {
      await git(cwd, ["update-ref", ref, sha, tgt]);
    }
    // 集成记录合并后冻结：base_sha 记为合并时的 merge-base，之后 diff 用记录值
    const base_sha =
      rec.kind === "integration"
        ? (await git(cwd, ["merge-base", tgt, head])).stdout.trim()
        : rec.base_sha;
    await this.store.put({
      ...rec,
      base_sha,
      head_sha: head,
      status: "merged",
      merged_into: target,
      merge_sha: sha,
      updated_ts: this.now().toISOString(),
    });
    return { merged: true, sha, fast_forward: ff };
  }

  async checks(pr_id: string): Promise<CheckResult[]> {
    await this.mustGet(pr_id);
    return [];
  }

  async sync(): Promise<SyncChange[]> {
    return [];
  }

  /**
   * 分支不存在时从 target 建出（update-ref，不 checkout；空旧值保证只在不存在时创建）。
   * 返回 target 当前提交。
   */
  async ensureBranch(cwd: string, branch: string, target: string): Promise<string> {
    const tgt = await this.revParse(cwd, target);
    const ref = `refs/heads/${branch}`;
    const exists =
      (await git(cwd, ["show-ref", "--verify", "--quiet", ref], { allowCodes: [1] })).code === 0;
    if (!exists) await git(cwd, ["update-ref", ref, tgt, ""]);
    return tgt;
  }

  private async findCheckout(cwd: string, ref: string): Promise<string | undefined> {
    const out = (await git(cwd, ["worktree", "list", "--porcelain"])).stdout;
    let path: string | undefined;
    for (const line of out.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice(9);
      else if (line === `branch ${ref}`) return path;
    }
    return undefined;
  }

  private async mustGet(pr_id: string): Promise<PrRecord> {
    const r = await this.store.get(pr_id);
    if (!r) throw new PrNotFoundError(pr_id);
    return assertPrRecord(r);
  }

  private async revParse(cwd: string, rev: string): Promise<string> {
    return (await git(cwd, ["rev-parse", "--verify", `${rev}^{commit}`])).stdout.trim();
  }
}

function cwdOf(rec: PrRecord): string {
  return rec.kind === "ticket" ? rec.worktree_path : rec.repo_path;
}
