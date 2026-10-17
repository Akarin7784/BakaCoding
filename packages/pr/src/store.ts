import type { PrStatus } from "@bakacoding/types";

export type { PrStatus };

/** 本地 PR 记录。集成分支也可作为一种记录（后续单）。 */
export interface PrRecord {
  pr_id: string;
  ticket_id: string;
  worktree_path: string;
  branch: string;
  base_branch: string;
  /** open 时 base_branch 与 branch 的 merge-base */
  base_sha: string;
  /** open 时 branch 的 HEAD；merge 时更新为实际合入的提交 */
  head_sha: string;
  status: PrStatus;
  merged_into?: string;
  merge_sha?: string;
  /** 以 Z 结尾的 UTC 时间 */
  created_ts: string;
  updated_ts: string;
}

/** 由模块 2 实现；本包只依赖这个接口。 */
export interface PrStore {
  get(pr_id: string): Promise<PrRecord | undefined>;
  put(record: PrRecord): Promise<void>;
  list(): Promise<PrRecord[]>;
}

export class InMemoryPrStore implements PrStore {
  private readonly records = new Map<string, PrRecord>();
  get(pr_id: string): Promise<PrRecord | undefined> {
    const r = this.records.get(pr_id);
    return Promise.resolve(r ? { ...r } : undefined);
  }
  put(record: PrRecord): Promise<void> {
    this.records.set(record.pr_id, { ...record });
    return Promise.resolve();
  }
  list(): Promise<PrRecord[]> {
    return Promise.resolve([...this.records.values()].map((r) => ({ ...r })));
  }
}
