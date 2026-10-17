# @bakacoding/app

组合根（T-041a）：不是功能模块。`assemble(deps)` 把 0 事件总线、2 存储、3 配置 / 预算、6 PR 与编排层 8 / 9 / 10 装到**同一条总线**上，并在启动时调 10 的 `takeOver()` 做重启接管。接口约定见 [docs/modules.md「组合根」](../../docs/modules.md)。

- 1、5、7、4 的 worktree 由调用方建好传进来；1 的 `call_completed`、3 的台账 `budget.attach` 用返回的 `App.bus` 接。
- 重启后派单沿用 2 里已开的 PR（`HandleOptions.pr_id` / `worktree`），不重复开 PR（PD §12）；已在合并队列里的单（merge_queued / conflict / re_reviewing）按 PR 记录经 9 的 `adopt` 直接接回，不派单。
- T-041b：10 的 `closeTicketPr` 接 `closeTicketPrs`（先 9 的 `sync()`，再按 2 的 PR 记录判断 / 关闭）、`lastEscalation` 接 `lastEscalationFrom`（事件日志）、`replaceDependency` 接 9 的；`enqueue` / `adopt` 前把事件日志里 `extendScope` 批准过的范围并回 `write_scope`。
- T-041c：9 的高风险闸门固定打开（`AppDeps` 关不掉），9 ↔ 10 接放行 / 拒绝、扣住通知、反压暂停通知；重启接管 `adopt` 前按 6 的 diff 补判高风险（`judgeHighRiskOnTakeover`，diff 出错按高风险）。
- 已知缺口：12 的主进程还没接，T-062 之前放行 / 拒绝只能调 `App.supervisor.decideHighRisk`。

## T-063

- `createDefaultDeps(config, storage, opts)`：按仓库建好默认 `AppDeps`（总线、预算、网关、worktree、编码池、评审池占位 PR、`createPr`）。只建对象；调用方再 `assemble`。
- `acquireWriterLock(dbPath)`：`<库目录>/writer.lock`，见 modules.md「组合根」。

## T-084

- `RepoNotReadyError`：`createDefaultDeps` 最先查仓库，集成分支和 `main` 都没有时抛出，`code` 为 `no_commits`（一次提交都没有）或 `no_main`（带当前分支名 `current`，分离 HEAD 时缺省）；`message` 是中文原因、不含路径。`targetHead()` 不再退回检出的 HEAD。见 modules.md「组合根」。
