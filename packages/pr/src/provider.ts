import type { Diff } from "@bakacoding/types";

export type MergeResult =
  | { merged: true; sha: string; fast_forward: boolean }
  | { merged: false; conflict: true; conflicted_files: string[] }
  /** target 在某个 worktree 里被 checkout 且有未提交改动，未合并，记录状态不变 */
  | { merged: false; conflict: false; reason: "target_dirty"; worktree_path: string };

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
  commitPatch(ticket_id: string, worktree_path: string, patch: string): Promise<string>;
  open(ticket_id: string, worktree_path: string, branch: string): Promise<string>;
  diff(pr_id: string): Promise<Diff>;
  /** 冲突不抛错，返回 { merged: false, conflict: true }，由模块 9 决定复投。 */
  merge(pr_id: string, target: string): Promise<MergeResult>;
  checks(pr_id: string): Promise<CheckResult[]>;
  sync(): Promise<void>;
}

export type GetSecret = (name: string) => string | undefined | Promise<string | undefined>;
export interface Logger {
  warn(message: string): void;
}
