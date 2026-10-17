# @bakacoding/sub-agent

模块 8 副 Agent：一单一个，写编码提示词、发起评审、驱动复投，评审通过后交给合并队列（模块 9）。接口见 [docs/modules.md](../../docs/modules.md)「8.」一节。

```ts
import {
  createSubAgent,
  eventLogGrantedScopes,
  eventLogResubmitHistory,
  storageTicketPermissions,
} from "@bakacoding/sub-agent";

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
  permissions: storageTicketPermissions(storage), // 每单权限清单以 2 的需求单记录为准（T-048）
  grantedScopes: eventLogGrantedScopes(storage), // 已批准范围的持久来源：读回清单重新裁剪时保留它们
  scopeRequests: { bus }, // 可选：越界写申请透传给 5/4，批准的范围写回需求单记录（批准方归 T-038）
});

const outcome = await subAgent.handle(ticket);
// { kind: "merge_queued" | "escalated" | "requeue_budget", ... }
```

- 复投（评审不过、编码池 `gave_up` / `turn_limit` / 没改动 / 提交失败）都在同一 worktree、同一 PR 上进行，计入评审复投计数；超过 `pipeline.resubmit_limits.review` 上报。
- 当日预算用完不上报、不计复投，返回 `requeue_budget` 和续跑凭据，第二天用 `resume(ticket, token)` 续跑。
- 7 的复投成员持久化：`createRoundAssignmentStore({ rounds: storageRoundSource(storage) })`（T-045 起按单号走 2 的 `listPrRounds`，不再需要 `projectOf`）。
- 每单权限清单（T-048）：第一次编码前按单上的建议和 `write_scope` 生成（超出写入范围的写权限降为只读并记日志），写进 2 的需求单记录；之后每次调编码池和评审前都从记录读。批准的写入范围用 `recordGrantedScope` 或经 `scopeRequests` 自动写回。同一单不能同时有两个 `runTicket`（4 的登记表按 `ticket_id` 释放），8 在进程内守住。
