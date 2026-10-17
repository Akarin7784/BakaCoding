import type { AssignmentStore, MaybePromise } from "./types.js";

/** 一轮 PR 记录里 7 用到的字段（模块 2 `RoundRecord` 在结构上满足它）。 */
export interface RoundReviewer {
  round: number;
  /** 这一轮由谁评审：成员 id、`"supervisor"`，或 `null`（CI 失败没调模型 / 旧记录） */
  reviewer?: string | null;
}

/** 按单号读这张单已保存的各轮 PR 记录（顺序不限）；没有记录返回空数组。 */
export type RoundSource = (ticket_id: string) => MaybePromise<readonly RoundReviewer[]>;

export interface RoundAssignmentStoreOptions {
  rounds: RoundSource;
  logger?: { warn(message: string): void };
}

/**
 * 持久化的复投成员记录（T-034）：从模块 2 的 PR 轮次 `reviewer` 字段恢复上一轮的评审成员，
 * 进程重启后复投的单仍交给原成员。
 *
 * - `get`：先看本进程 `set` 过的值（评审刚返回、8 还没写轮次记录的空档），再从轮次记录里
 *   按轮次从新到旧取第一个非空的 `reviewer`。`null`（CI 失败没调模型）跳过，沿用更早一轮的成员，
 *   和内存实现「CI 失败不写记录」一致；`"supervisor"` 原样返回，由 7 按现有规则判断（主管仍兼任就交回主管，
 *   已配了成员就换人）。
 * - `set`：只记在本进程内存里；轮次记录由 8 用评审结果的 `reviewer` 写，7 不写 PR 记录。
 * - 读轮次出错时记一条 warn 并返回 `undefined`（退回按负载分配），不让评审失败。
 */
export function createRoundAssignmentStore(opts: RoundAssignmentStoreOptions): AssignmentStore {
  const logger = opts.logger ?? console;
  const recent = new Map<string, string>();
  return {
    async get(ticket_id) {
      const hit = recent.get(ticket_id);
      if (hit !== undefined) return hit;
      let rounds: readonly RoundReviewer[];
      try {
        rounds = await opts.rounds(ticket_id);
      } catch (e) {
        logger.warn(
          `[bakacoding/review-pool] 读 ${ticket_id} 的 PR 轮次记录失败，复投改按负载分配：${String(e)}`,
        );
        return undefined;
      }
      const latest = [...rounds]
        .sort((a, b) => b.round - a.round)
        .find((r) => typeof r.reviewer === "string" && r.reviewer.length > 0);
      return latest?.reviewer ?? undefined;
    },
    set(ticket_id, member_id) {
      recent.set(ticket_id, member_id);
    },
  };
}

/** 模块 2 存储里 7 用到的读方法（`Storage` / `ReadonlyStorage` 在结构上满足它）。 */
export interface RoundQuery {
  /** 该单全部轮次，按轮次升序；单不存在返回空数组（T-011）。 */
  listPrRounds(ticket_id: string): readonly RoundReviewer[];
}

/**
 * 用模块 2 的 `listPrRounds(ticket_id)` 读轮次（T-045）：直接按单号查，写入连接和只读连接都能用；
 * 单不存在时 2 返回空数组，视为没有记录。读出错原样抛出，由 `createRoundAssignmentStore` 记 warn 并退回按负载分配。
 */
export function storageRoundSource(storage: RoundQuery): RoundSource {
  return (ticket_id) => storage.listPrRounds(ticket_id);
}
