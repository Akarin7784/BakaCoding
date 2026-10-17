# @bakacoding/storage

模块 2 存储与事件日志：SQLite（WAL，驱动 `better-sqlite3`），单一写入者租约，幂等键，重启可恢复。

```ts
import { createEventBus } from "@bakacoding/event-bus";
import { openStorage } from "@bakacoding/storage";

const storage = openStorage({ path: ".bakacoding/bakacoding.db", retention_days: config.diagnostics.retention_days });
const bus = createEventBus({ initialSeq: storage.nextSeq() }); // 重启后 seq 接着编
storage.attach(bus, { onError: (f) => log.error(f) }); // "*" 订阅全部事件落库；失败不会悄悄吞掉
storage.health(); // { ok, lease_lost, closed, ingest_failures, last_failure? }
// 注入：模块 3 用 storage.ledger（LedgerStore），模块 11 用 storage.diagnosticsSource()（DiagnosticsSource）
```

- **单一写入者**：打开时抢租约（默认 30 秒，持有期间自动续），别人持有未过期的租约时抛 `StorageLeaseError`；每次写入都确认租约还在自己手里，被接管后再写也抛这个错。拿租约和所有写入都用 `BEGIN IMMEDIATE`，两个进程同时打开时按 `busy_timeout`（5 秒）排队等写锁，不会中途报 `SQLITE_BUSY`。`close()` 释放租约。
- **落库失败可见**：经 `attach` 落库失败（租约丢了、seq 冲突、事件不合法）时调用 `onError`（默认 `console.error`），并计入 `health()`：`ok` 变成 `false`，`ingest_failures` 加一，`last_failure` 记下事件和原因；租约丢失另有 `lease_lost`。
- **seq 唯一**：`events.seq` 有唯一索引；同一个 `event_id` 重放照常幂等，不同事件占同一个 seq 抛 `StorageSeqConflictError`。
- **幂等**：事件按 `event_id`、台账按 `entry_id`、PR 记录按 `(ticket_id, round)`、合并结果按 `ticket_id` 去重或覆盖，重放安全。
- **PR 记录**：`prStore()` 在结构上满足模块 6 的 `PrStore`（不依赖模块 6 的包），按 `pr_id` 覆盖写，写进去和读出来一字不差；轻脱敏只检查不改写，任一字段疑似含密钥就拒绝写入；`kind` 单独成列原样存回，只能是 `ticket` / `integration`，缺了或不对都拒绝写入。
- **轻脱敏**：落库前对事件 payload 里的字符串、提示词和输出、需求单原文、上下文片段、PR 记录、决策记忆调用模块 3 的 `redact(text, "light")`。
- **事件**：全部进 `events` 表并带 `trace_id` / `span_id` / `parent_span_id`；`call_completed` 另写 `call_log`（提示词和输出只存这里）；`project_created` 建项目和群记录；`group_message` 存群消息并登记需求所属项目；两个积压事件存待办指标。
- **按项目过滤**：事件公共字段不带 `project_id`，靠需求所属项目（`saveTicket`、`registerRequirement` 会覆盖；群消息只在需求还没登记时登记，不覆盖已有归属）在查询时关联，登记晚于事件也能查到。
- **时间**：时间列另存一份 UTC 毫秒数（`ts_ms`、`created_at_ms`），时间范围、排序和清理截止点都按毫秒比较，带不带毫秒都不会排错；时间参数不合法报 `RangeError`。`queryEvents` 的 `limit` 必须是正整数。
- **保留期**：`purgeExpired()` 把超过 `retention_days` 的调用的提示词和输出清掉，只留统计和输出前 200 字的摘要（查出来 `prompt` 为空串、`output` 为摘要）；`markForEvalSet(ticket_id)` 的单永久保留。
- **表结构升级**：`src/schema.sql.ts` 按 `PRAGMA user_version` 依次执行，只加不改；v2（T-022）给旧库加毫秒列并回填，加 `events.seq` 唯一索引（旧库若已有重复 seq，升级会失败并停在 v1，不会悄悄丢数据）。
