import type { Diff } from "@bakacoding/types";

/** 默认集成分支名（v1 写死，不设配置项）。 */
export const INTEGRATION_BRANCH = "bakacoding/integration";

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
  /**
   * 把集成分支作为一条 PR 记录打开（默认 INTEGRATION_BRANCH → main）。分支不存在时从 target 建出；
   * 同一对 (branch, target) 只保留一条未结束（open / conflict）的记录，重复调用返回已有 pr_id。
   */
  openIntegration(branch?: string, target?: string): Promise<string>;
  /** 集成记录未结束时每次现算：base_sha = merge-base(target, branch)，head_sha = branch 当前 HEAD。 */
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
