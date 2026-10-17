# @bakacoding/scheduler

模块 9 调度器与合并队列：写入范围逻辑锁、依赖排序、冲突检测、反压、interface_changed 事件。

T-035 已实现合并队列和反压信号（`createScheduler`），接口和行为见 docs/modules.md「9.」一节的「合并队列与反压信号」。T-039 加了派单、写入范围锁（`lock`）与独占区域、写入范围申请回复、编码槽位、闲时 `deferred`、`stop()` 取消信号，见同一节的「派单、写入范围锁、编码槽位」。

```ts
const scheduler = createScheduler({
  bus,
  createPr: ({ eventContext }) => createPrProvider({ ...prOpts, publish: bus.publish, eventContext }),
  config,
  targetHead: () => git(repo, ["rev-parse", INTEGRATION_BRANCH]), // 目标分支当前 HEAD
  budgetState: () => budget.budgetState(),
  tickets: { setStatus: (id, status) => /* 写 2 的 tickets.status */ undefined },
  worktrees: { create: (id, base, n) => wt.createWorktree(id, base, n), cleanup: (p) => wt.cleanup(p) },
  subAgent, // 8：handle（注入后自动派单）/ resubmitConflict / reReview / resume
});
await scheduler.start();
```

配置 `backpressure.pending_pr_limit` 默认 16（`config/models.example.json` 里也是 16）：默认值 16 没有实测依据，待实测后再定。JSON 不能写注释，说明放在这里和 modules.md §9。

8 由调用方注入（组合根按单号把 `SchedulerTicket` 补全成 8 要的 `SubAgentTicket`），测试里用 mock。
