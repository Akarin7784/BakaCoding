# @bakacoding/scheduler

模块 9 调度器与合并队列：写入范围逻辑锁、依赖排序、冲突检测、反压、interface_changed 事件。

T-035 已实现合并队列和反压信号（`createScheduler`），接口和行为见 docs/modules.md「9.」一节的「合并队列与反压信号」。T-039 加了派单、写入范围锁（`lock`）与独占区域、写入范围申请回复、编码槽位、闲时 `deferred`、`stop()` 取消信号，见同一节的「派单、写入范围锁、编码槽位」。T-048 起写入范围锁先展开花括号（`src/{a,b}.ts` 与 `src/a.ts` 重叠），独占区域另认「末段模式能写到区域里的具体文件名」的范围（`src/**/*.json` 落在 `**/package.json`），见 `expandBraces` / `inExclusiveZone`。

T-038：不再订阅 `write_scope_requested`、不发 granted / denied（答复归 8）；8 对范围外的越界写申请调 `extendScope(ticket_id, scope)` 重新加锁（失败发 `escalated(scope_lock_failed)`）。`submit({ …, high_risk })` 记下 8 打的高风险标记，`snapshot()` 每项带 `high_risk`，只打标不扣留。合并成功后收尾出错时状态保持 `merged`，另发 `escalated(merged_but)`。默认独占区域以 `@bakacoding/types` 的 `DEPENDENCY_MANIFEST_GLOBS` 开头。`isUnsafeScope` 转调模块 4 的 `isUnsafeGlob`（`@deprecated`）。

T-041b：`replaceDependency(old_id, new_ids)` 把在途单 `depends_on` 里被重拆取代的单原位换成新单（去重、跳过自己和终态单），返回改过的单号；`adopt` 写 `merge_queued` 失败时撤登记、放锁、不入队，原样抛错。

T-041c：高风险闸门 `holdHighRisk`（默认关，只打标照常合并；组合根固定打开）。打开后 `high_risk` 单扣在合并队列里（不挡后面的单、锁照占），`releaseHighRisk` 放行（按 `pr_id` 绑定，冲突复投换新 PR 重新扣）、`rejectHighRisk` 拒绝（先关 PR 再发 `escalated(high_risk_rejected)`）；`onHighRiskHeld` 在扣住某 PR 时调一次；`snapshot()` 带 `held_high_risk`；`pending_prs.high_risk_held` 和 `onBackpressurePaused` 用于反压暂停通知。

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
