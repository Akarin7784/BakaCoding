import type { Diff, PrStatus } from "@bakacoding/types";

/** 默认集成分支名（v1 写死，不设配置项）。 */
export const INTEGRATION_BRANCH = "bakacoding/integration";

/** 各方法的可选调用参数（T-102a）。`signal` 中止时抛 `signal.reason`，不改记录。 */
export interface PrCallOptions {
  signal?: AbortSignal;
}

/** 已中止的 signal 要抛的错：`signal.reason`，没有则抛名为 AbortError 的错误（与 5 / 7 / 8 一致）。 */
export function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const e = new Error("已取消");
  e.name = "AbortError";
  return e;
}

export type MergeResult =
  | { merged: true; sha: string; fast_forward: boolean }
  | { merged: false; conflict: true; conflicted_files: string[] }
  /** target 在某个 worktree 里被 checkout 且有未提交改动，未合并，记录状态不变 */
  | { merged: false; conflict: false; reason: "target_dirty"; worktree_path: string }
  /**
   * GitHub 拒绝合并且本地无文本冲突（分支保护、必需的 check 未通过等）。记录状态不变；
   * 6 不上报，由 9 发 escalated(github_manual)（可带 detail），且不复投。
   */
  | { merged: false; conflict: false; reason: "merge_blocked"; detail: string };

/** CI check 结果。本地实现永远返回空数组。 */
export interface CheckResult {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | null;
  url?: string;
}

export interface PrProvider {
  readonly kind: "local" | "github";
  /** 在 worktree 当前分支上 git apply + commit，返回新提交 sha。 */
  commitPatch(
    ticket_id: string,
    worktree_path: string,
    patch: string,
    opts?: PrCallOptions,
  ): Promise<string>;
  /**
   * 把 worktree 里的全部改动（git add -A，含新增和删除）提交到当前分支，返回新提交 sha。
   * worktree 必须对应一条未结束的 ticket 记录且当前分支一致；没有改动抛 NoChangesError。
   */
  commitWorktree(ticket_id: string, worktree_path: string, opts?: PrCallOptions): Promise<string>;
  open(
    ticket_id: string,
    worktree_path: string,
    branch: string,
    opts?: PrCallOptions,
  ): Promise<string>;
  /**
   * 把集成分支作为一条 PR 记录打开（默认 INTEGRATION_BRANCH → main）。分支不存在时从 target 建出；
   * 同一对 (branch, target) 只保留一条未结束（open / conflict）的记录，重复调用返回已有 pr_id。
   */
  openIntegration(branch?: string, target?: string, opts?: PrCallOptions): Promise<string>;
  /** 集成记录未结束时每次现算：base_sha = merge-base(target, branch)，head_sha = branch 当前 HEAD。 */
  diff(pr_id: string, opts?: PrCallOptions): Promise<Diff>;
  /**
   * 冲突不抛错，返回 { merged: false, conflict: true }，由模块 9 决定复投。
   * `opts.expected_head`（可选，T-066）：合并前校验分支 HEAD；不一致抛 ExpectedHeadMismatchError。
   * GitHub 实现把该值作为 merge API 的 `sha`；本地实现用 `rev-parse` 比对。
   */
  merge(
    pr_id: string,
    target: string,
    opts?: { expected_head?: string; signal?: AbortSignal },
  ): Promise<MergeResult>;
  /**
   * 读 CI 结果。GitHub：翻页拉齐全部 check-runs，并合并 commit status（combined statuses）。
   * 本地实现永远返回空数组。
   */
  checks(pr_id: string, opts?: PrCallOptions): Promise<CheckResult[]>;
  /**
   * 由 BakaCoding 关闭 PR：记录标 closed，写 closed_by: "bakacoding" 和 close_reason；不发上报。
   * 已 merged 抛错；已 closed 幂等。GitHub 实现有 remote 时同时关闭远程 PR。
   */
  close(pr_id: string, reason: string, opts?: PrCallOptions): Promise<void>;
  /**
   * 把远端状态同步回本地记录，返回状态有变化的记录；本地实现永远返回 []。
   * GitHub：中途出错时，若已收集到变化，抛 SyncPartialError（带 `changes`），调用方应先应用再处理 cause；
   * 无已收集变化则抛原始错误。
   */
  sync(opts?: PrCallOptions): Promise<SyncChange[]>;
}

/** sync() 返回的一条状态变化。 */
export interface SyncChange {
  pr_id: string;
  from: PrStatus;
  to: PrStatus;
  /** to 为 "merged" 时 GitHub 返回的合并提交 sha（merge_commit_sha）；拿不到时缺省。本地 provider 不填。 */
  merge_sha?: string;
}

export type GetSecret = (name: string) => string | undefined | Promise<string | undefined>;
export interface Logger {
  warn(message: string): void;
}

/** sync() 中途出错但已落库部分变化（T-066 B1）。调用方应先应用 `changes`，再按 `cause` 处理错误。 */
export class SyncPartialError extends Error {
  readonly changes: SyncChange[];
  override readonly cause: unknown;
  constructor(changes: SyncChange[], cause: unknown) {
    const n = changes.length;
    const msg =
      cause instanceof Error
        ? `sync 中途出错，已收集 ${n} 条变化：${cause.message}`
        : `sync 中途出错，已收集 ${n} 条变化：${String(cause)}`;
    super(msg);
    this.name = "SyncPartialError";
    this.changes = changes;
    this.cause = cause;
  }
}

/** merge() 的 expected_head 与当前分支 HEAD 不一致（T-066 C1）。 */
export class ExpectedHeadMismatchError extends Error {
  readonly code = "expected_head_mismatch" as const;
  constructor(
    readonly pr_id: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`PR ${pr_id} 的 head 与 expected_head 不一致：期望 ${expected}，实际 ${actual}`);
    this.name = "ExpectedHeadMismatchError";
  }
}
