import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiffSchema, type Diff, type DiffFile } from "@bakacoding/types";
import { git, GitError } from "./git.js";
import type { CheckResult, MergeResult, PrProvider } from "./provider.js";
import type { PrRecord, PrStore } from "./store.js";

export interface LocalPrProviderOptions {
  store: PrStore;
  /** open 时用来求 base_sha 的基线分支，默认 main */
  baseBranch?: string;
  /** 提交身份，默认 BakaCoding <bakacoding@localhost> */
  author?: { name: string; email: string };
  now?: () => Date;
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

export class LocalPrProvider implements PrProvider {
  readonly kind = "local" as const;
  private readonly store: PrStore;
  private readonly baseBranch: string;
  private readonly author: { name: string; email: string };
  private readonly now: () => Date;
  private seq = 0;

  constructor(opts: LocalPrProviderOptions) {
    this.store = opts.store;
    this.baseBranch = opts.baseBranch ?? "main";
    this.author = opts.author ?? { name: "BakaCoding", email: "bakacoding@localhost" };
    this.now = opts.now ?? (() => new Date());
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

  async open(ticket_id: string, worktree_path: string, branch: string): Promise<string> {
    const head = await this.revParse(worktree_path, branch);
    const base = (await git(worktree_path, ["merge-base", this.baseBranch, head])).stdout.trim();
    const existing = (await this.store.list()).length;
    const pr_id = `local-${ticket_id}-${existing + ++this.seq}`;
    const ts = this.now().toISOString();
    await this.store.put({
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

  async diff(pr_id: string): Promise<Diff> {
    const rec = await this.mustGet(pr_id);
    const head =
      rec.status === "open" || rec.status === "conflict"
        ? await this.revParse(rec.worktree_path, rec.branch)
        : rec.head_sha;
    const cwd = rec.worktree_path;
    const range = [rec.base_sha, head];
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
    return DiffSchema.parse({ base_sha: rec.base_sha, head_sha: head, files });
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
    const cwd = rec.worktree_path;
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
            `Merge ${pr_id} (${rec.ticket_id}) into ${target}`,
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
    await this.store.put({
      ...rec,
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

  async sync(): Promise<void> {}

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
    return r;
  }

  private async revParse(cwd: string, rev: string): Promise<string> {
    return (await git(cwd, ["rev-parse", "--verify", `${rev}^{commit}`])).stdout.trim();
  }
}
