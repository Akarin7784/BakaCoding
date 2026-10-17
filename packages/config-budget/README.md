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
