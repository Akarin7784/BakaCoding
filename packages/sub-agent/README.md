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
  scopeRequests: { bus }, // 可选：越界写申请经 5/4 发来，由 8 审批并答复（与 publish 用同一条总线）
  scheduler: { extendScope: (id, scope) => scheduler.extendScope(id, scope) }, // 可选：范围外的申请交 9 加锁（T-038）
});
const detach = subAgent.attach(bus); // 订阅 interface_changed（T-038）

const outcome = await subAgent.handle(ticket);
// { kind: "merge_queued" | "escalated" | "requeue_budget", ... }
```

- 复投（评审不过、编码池 `gave_up` / `turn_limit` / 没改动 / 提交失败）都在同一 worktree、同一 PR 上进行，计入评审复投计数；超过 `pipeline.resubmit_limits.review` 上报。
- 当日预算用完不上报、不计复投，返回 `requeue_budget` 和续跑凭据，第二天用 `resume(ticket, token)` 续跑。
- 7 的复投成员持久化：`createRoundAssignmentStore({ rounds: storageRoundSource(storage) })`（T-045 起按单号走 2 的 `listPrRounds`，不再需要 `projectOf`）。
- 每单权限清单（T-048）：第一次编码前按单上的建议和 `write_scope` 生成（超出写入范围的写权限降为只读、不安全的写权限丢掉、不安全的只读改成 deny，并记日志），写进 2 的需求单记录；之后每次调编码池和评审前都从记录读。批准的写入范围由 8 审批通过、发完 `write_scope_granted` 后自动写回（`recordGrantedScope` 只在包内用，不从 index 导出；同包测试从 `src/internal.ts` 导入）。同一单不能同时有两个 `runTicket`（4 的登记表按 `ticket_id` 释放），8 在进程内守住。
- 越界写审批（T-038）：8 是 `write_scope_requested` 的唯一答复方。不安全的路径直接拒（不交 9）；被清单显式 deny 的拒；落在 `write_scope` ∪ 已批准范围里的直接批；范围外的交 `scheduler.extendScope`，成功才批。所有批准都先发 `write_scope_granted` 事件再写回需求单记录（需求单记录不加列）。
- 接口变更（T-038）：`attach(bus)` / `onInterfaceChanged(e)` 收 9 的 `interface_changed`，给受影响的单记一条说明，下一次编码时接在 feedback 后面（5 包成不可信区块）；评审期间收到且本单还没交给 9 时，交出前再评审一次，不计复投。预算暂停时说明进 `ResumeToken.interface_notes`（v1 不写 2）。
- 高风险（T-038）：需求单 `kind: "dependency"` 或 diff 改了依赖清单 / 锁文件（`DEPENDENCY_MANIFEST_GLOBS`）时，给 7、9 和结果都带 `high_risk: true`，只打标不扣留。
