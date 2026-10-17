# @bakacoding/app

组合根（T-041a）：不是功能模块。`assemble(deps)` 把 0 事件总线、2 存储、3 配置 / 预算、6 PR 与编排层 8 / 9 / 10 装到**同一条总线**上，并在启动时调 10 的 `takeOver()` 做重启接管。接口约定见 [docs/modules.md「组合根」](../../docs/modules.md)。

- 1、5、7、4 的 worktree 由调用方建好传进来；1 的 `call_completed`、3 的台账 `budget.attach` 用返回的 `App.bus` 接。
- 重启后派单沿用 2 里已开的 PR（`HandleOptions.pr_id` / `worktree`），不重复开 PR（PD §12）。
- 已知缺口：已在合并队列里的单要等 9 的 `adopt`（TODO，T-061 合入后）；上报补处理在 T-041b；高风险闸门在 T-041c。
