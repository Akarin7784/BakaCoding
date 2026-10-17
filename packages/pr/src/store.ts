import type { PrStatus } from "@bakacoding/types";

export type { PrStatus };

interface PrRecordBase {
  pr_id: string;
  branch: string;
  base_branch: string;
  /** 单张 PR：open 时 base_branch 与 branch 的 merge-base；集成记录：open 或 merge 时的值，diff 不用它 */
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

/** 单张需求单的 PR 记录。 */
export interface TicketPrRecord extends PrRecordBase {
  kind: "ticket";
  ticket_id: string;
  worktree_path: string;
}

/** 集成分支作为一条 PR 记录（branch 为集成分支，base_branch 为 target）。不带 ticket_id / worktree_path。 */
export interface IntegrationPrRecord extends PrRecordBase {
  kind: "integration";
  /** 跑 git 用的仓库目录（来自 LocalPrProviderOptions.repo） */
  repo_path: string;
}

/** 本地 PR 记录，按 kind 区分。 */
export type PrRecord = TicketPrRecord | IntegrationPrRecord;
export type PrRecordKind = PrRecord["kind"];

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
