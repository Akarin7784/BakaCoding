# @bakacoding/scheduler

模块 9 调度器与合并队列：写入范围逻辑锁、依赖排序、冲突检测、反压、interface_changed 事件。

T-035 已实现合并队列和反压信号（`createScheduler`），接口和行为见 docs/modules.md「9.」一节的「合并队列与反压信号」。写入范围锁、编码槽位和派单在 T-039。

```ts
const scheduler = createScheduler({
  bus,
  createPr: ({ eventContext }) => createPrProvider({ ...prOpts, publish: bus.publish, eventContext }),
  config,
  budgetState: () => budget.budgetState(),
  tickets: { setStatus: (id, status) => /* 写 2 的 tickets.status */ undefined },
  worktrees: { create: (id, base, n) => wt.createWorktree(id, base, n), cleanup: (p) => wt.cleanup(p) },
  subAgent, // 8：resubmitConflict / reReview
});
await scheduler.start();
```

5、7、8 还没接上：8 的 `resubmitConflict` / `reReview` 由调用方注入，测试里用 mock。
