# @bakacoding/config-budget

模块 3 配置与预算：加载校验配置、读取 API key、预算台账、脱敏函数、项目导入、提示词模板。

## 配置（T-002）

- `getConfig(path)`：读取 JSON 配置并用严格 zod schema 校验（未知字段报错），失败抛 `ConfigError`，进程不应启动。
- `validate(raw) → string[]`：返回错误列表，空数组表示通过。
- `getSecret("DEEPSEEK_API_KEY" | "GITHUB_TOKEN")`：只从环境变量读取，缺失时报错；值不写日志、不进配置。

结构见 `config/models.example.json`：

| 字段 | 说明 |
| --- | --- |
| `roles.supervisor` | **必填**，`effort` 固定 `max` |
| `roles.review_board` | 整个评审组；`members` 不含主管，默认 2 个 `high`；事件/台账里的 `reviewer` 指单个成员 |
| `roles.sub_agent` | 默认 `high` |
| `roles.coder` | 默认 `low`，`resubmit_effort` 默认 `["low","high","high"]` |
| `budget.daily_micro_usd` | **必填**，每日预算，整数微美元（1 USD = 1,000,000）；示例中的 5000000（5 美元）只是示例，不是推荐值 |
| `budget.per_ticket_ratio` / `offpeak_preference` | 默认 0.05 / `false` |
| `pipeline.concurrency_max` / `concurrency_hard_max` | 同时处于**编码阶段**的需求单数（默认 8 / 64），等待评审或合并的单不占槽位 |
| `backpressure.*`、`diagnostics.retention_days` | 默认值取自整体设计 §10、§14 |

示例配置不再含 `effort_map`：思考档位到服务商字段的映射以模块 1 的服务商能力表为准。

## 预算台账（T-006）

- `createBudget({ budget, pricing, ledger, now? })`：`budget` 取配置里的 `budget` 段，`ledger` 是启动时注入的 `LedgerStore`（模块 2 实现，本包不依赖存储）。
- `attach(bus, { onError })`：订阅 `call_completed` 记一笔，`entry_id` 取 `event_id`（重放不重复计费），闲时按事件 `ts` 用 `isOffpeak` 判断；落库失败交给 `onError`（默认 `console.error`），不抛给总线。
- `recordCost(entry)`：手工补记一条 `LedgerEntry`。
- `budgetState(ticket_id?)`：当日（UTC）上限、已花、复投、剩余、`daily_exhausted`，每单上限（每日预算 × `per_ticket_ratio`，向下取整），按角色分列，`offpeak_now`、`offpeak_preference`；传 `ticket_id` 时另带该单累计花费（含复投、不分日期）和 `exhausted`。已花 ≥ 上限即 exhausted。另带进行中调用的预占额（`reserved_today_micro_usd`，单的 `reserved_micro_usd`）。
- `reserve({ ticket_id, amount_micro_usd })`：模块 1 每次调用前预占。已花 + 其他调用的预占 ≥ 每日或每单上限时返回 `{ ok: false, scope }`，否则记下并返回 `release()`。预占与释放串行执行；预占只在进程内存里。
- `computeCost(pricing, model, tokens, at)`：缓存命中输入、未命中输入、输出分别按单价计，按调用时刻选高峰或闲时价，向上取整到微美元；模型不在 `pricing.json` 里直接报错。
