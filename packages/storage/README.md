# @bakacoding/storage

模块 2 存储与事件日志：SQLite（WAL，驱动 `better-sqlite3`），单一写入者租约，幂等键，重启可恢复。

```ts
import { createEventBus } from "@bakacoding/event-bus";
import { openStorage } from "@bakacoding/storage";

const storage = openStorage({ path: ".bakacoding/bakacoding.db", retention_days: config.diagnostics.retention_days });
const bus = createEventBus({ initialSeq: storage.nextSeq() }); // 重启后 seq 接着编
storage.attach(bus); // "*" 订阅全部事件落库
// 注入：模块 3 用 storage.ledger（LedgerStore），模块 11 用 storage.diagnosticsSource()（DiagnosticsSource）
```

- **单一写入者**：打开时抢租约（默认 30 秒，持有期间自动续），别人持有未过期的租约时抛 `StorageLeaseError`；每次写入都确认租约还在自己手里，被接管后再写也抛这个错。`close()` 释放租约。
- **幂等**：事件按 `event_id`、台账按 `entry_id`、PR 记录按 `(ticket_id, round)`、合并结果按 `ticket_id` 去重或覆盖，重放安全。
- **PR 记录**：`prStore()` 在结构上满足模块 6 的 `PrStore`（不依赖模块 6 的包），按 `pr_id` 覆盖写；`kind`（`ticket` / `integration`）单独成列原样存回，缺 `kind` 的记录直接拒绝写入。
- **轻脱敏**：落库前对事件 payload 里的字符串、提示词和输出、需求单原文、上下文片段、PR 记录、决策记忆调用模块 3 的 `redact(text, "light")`。
- **事件**：全部进 `events` 表并带 `trace_id` / `span_id` / `parent_span_id`；`call_completed` 另写 `call_log`（提示词和输出只存这里）；`project_created` 建项目和群记录；`group_message` 存群消息并登记需求所属项目；两个积压事件存待办指标。
- **按项目过滤**：事件公共字段不带 `project_id`，靠需求所属项目（`saveTicket`、群消息自动登记，或 `registerRequirement`）在查询时关联，登记晚于事件也能查到。
- **保留期**：`purgeExpired()` 把超过 `retention_days` 的调用的提示词和输出清掉，只留统计和输出前 200 字的摘要（查出来 `prompt` 为空串、`output` 为摘要）；`markForEvalSet(ticket_id)` 的单永久保留。
- **表结构升级**：`src/schema.sql.ts` 按 `PRAGMA user_version` 依次执行，只加不改。
