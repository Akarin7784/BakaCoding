# @bakacoding/supervisor

模块 10 主管：用户唯一对接方，拆单、处理上报、审集成分支、合入 main。接口约定见 [docs/modules.md「10.」](../../docs/modules.md)。

## T-040：对话与拆单

`createSupervisor(deps)` 返回 `{ chat, split, start, createManualTicket, loadTicket }`；另导出 `validateWriteScope`、`SPLIT_MAX_ATTEMPTS`（3）和相关类型。上报处理、重拆计数、高风险 PR、装配、重启接管在 T-041；集成分支审查、合入 main、主管待办指标在 T-042。

- **依赖全部注入**（`SupervisorDeps`）：1 的 `call`、3 的 `getConfig`（`roles.supervisor`）和 `promptTemplate("supervisor")`、2 的存取（`listProjects`、`listDecisions`、`saveDecision`、`registerRequirement`、`saveTicket`、`getTicket`、`listTickets`）、9 的 `enqueue`、总线 `publish` / `subscribe`、`targetHead`、可选 `listFiles`、`notifyUser`。
- **存储约定**：需求单的结构化字段（`write_scope`、`interfaces`、`depends_on`、`priority`、`kind`、`origin`、`trace`）按基础层存储小单的约定写进 tickets 表的可选 JSON 列，`getTicket` / `listTickets` 读回，旧数据为 `null`。本包不直接依赖模块 2 的实现，测试用内存实现。
- **提示词**：模板来自注入的 `promptTemplate("supervisor")`，本包不带默认模板；本包只在模板后追加输出格式说明（JSON 字段约定），再接不可信区块（项目、决策记忆、已有单号、文件清单、上报反馈、用户原文，统一用 `wrapUntrusted` 包装）。
- **模型输出不可信**：对话输出和拆单输出都用 `.strict()` 的 zod schema 解析（多一个字段即无效），拆单再做语义校验。

### 写入范围规则（`validateWriteScope`）

| 错误码 | 条件 | split 单 | manual / test 单 |
|---|---|---|---|
| `write_scope_missing` | 没给或为空 | 无效，整批退回 | 按 `["**"]`，发 `ticket_warning(write_scope_defaulted)` |
| `write_scope_trailing_slash` | 以 `/` 结尾 | 无效（写成 `lib/**`，不自动改写） | 同左 |
| `write_scope_unsafe` | 4 的 `isUnsafeGlob` 为真 | 无效 | 同左 |
| `write_scope_whole_repo` | `**`、`**/*` 等整仓写法 | 无效 | 按 `["**"]`，发警告 |
| `write_scope_bare_directory` | 字面路径是基线上的目录（需 `listFiles`） | 无效（写成 `dir/**`） | 同左 |

拆单另查 `interfaces_missing`（必填，可为 `[]`）、`interface_unsafe`、`depends_on_unknown`（只能指本批次 key 或本项目已有单号）、`depends_on_cycle`、`output_invalid`（JSON 或 schema 不合格、key 重复）。任一张不合法整批退回，最多调 `SPLIT_MAX_ATTEMPTS` 次模型；仍不合法就不建单。同一批次写入范围重叠不判无效，交给 9 的锁。

### 对话里的项目

界面传了 `project_id` 就用它；否则看原文是否字面提到且只提到一个项目（项目名或 id）；都没有且只有一个项目时直接用。后两种情况回复里写明「按项目 X 处理」。多个项目没说清时每次都追问，并暂存这条需求，下一条说清项目就接着处理。1:1 历史 v1 不持久化。
