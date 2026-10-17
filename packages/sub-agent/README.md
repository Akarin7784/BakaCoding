# @bakacoding/sub-agent

模块 8 副 Agent：一单一个，写编码提示词、发起评审、驱动复投，评审通过后交给合并队列（模块 9）。接口见 [docs/modules.md](../../docs/modules.md)「8.」一节。

```ts
import { createSubAgent, eventLogResubmitHistory } from "@bakacoding/sub-agent";

const subAgent = createSubAgent({
  getConfig, // 模块 3 的配置（roles.coder.effort / resubmit_effort、pipeline.resubmit_limits.review）
  coder, // 模块 5：createCoderPool(...)
  review: (input) => reviewPool.review(input), // 模块 7
  pr, // 模块 6：open / commitWorktree / diff
  budgetState: (id) => budget.budgetState(id), // 模块 3
  rounds: { save: (r) => storage.savePrRecord(r) }, // 模块 2
  tickets: { setStatus }, // 写 TicketStatus（只写到 merge_queued，之后归 9）
  resubmitHistory: eventLogResubmitHistory(storage), // 评审复投计数跨重启（从 2 的事件日志数）
  worktreeRoot: join(repoRoot, ".bakacoding", "worktrees"), // 4 的 worktree 根目录，越界路径直接拒绝
  worktrees: { create: (id, base, n) => worktreeManager.createWorktree(id, base, n) }, // 模块 4
  submit: (input) => scheduler.submit(input), // 模块 9
  publish: (e) => bus.publish(e), // 模块 0
});

const outcome = await subAgent.handle(ticket);
// { kind: "merge_queued" | "escalated" | "requeue_budget", ... }
```

- 复投（评审不过、编码池 `gave_up` / `turn_limit` / 没改动 / 提交失败）都在同一 worktree、同一 PR 上进行，计入评审复投计数；超过 `pipeline.resubmit_limits.review` 上报。
- 当日预算用完不上报、不计复投，返回 `requeue_budget` 和续跑凭据，第二天用 `resume(ticket, token)` 续跑。
- 7 的复投成员持久化：`createRoundAssignmentStore({ rounds: storageRoundSource(storage) })`（T-045 起按单号走 2 的 `listPrRounds`，不再需要 `projectOf`）。
