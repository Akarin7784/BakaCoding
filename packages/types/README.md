# @bakacoding/types

T-001：各模块共享的类型与 zod schema。只含 schema 与常量，不含其他运行时逻辑。

- 事件公共字段与 `EventMap`（`docs/modules.md`「事件清单」+ `review_backlog`）
- `CallCtx`、`Effort`、`PermissionList`（默认拒绝）
- `LedgerStore` 接口（模块 2 实现，注入模块 3）
- `Diff`

## token 计数约定

`call_completed.payload.tokens.input` 是全部输入 token，**包含** `cache_hit_input`；
未命中输入 = `input - cache_hit_input`。schema 校验 `cache_hit_input <= input`。

`interface_changed` 的公共字段 `ticket_id` 必须非 null（合并成功的单）。

`ticket_warning`（T-040）：所有单级警告都用它，公共字段 `ticket_id` 必须非 null，载荷 `{ project_id, code, detail }`；`code` 取 `TICKET_WARNING_CODES`，只加不改：`write_scope_defaulted`（手动 / 测试单按整仓 `**` 处理）、`fields_invalid`（需求单结构化字段缺失、损坏或不合格式，不能续跑）、`requirement_truncated`（T-041b：需求原文超过 20000 码点，存进字段时截断，每批一条）、`pr_close_failed`（T-041b：重拆前关旧 PR 失败，确认旧 PR 已关或不存在前不重拆；T-041c 起也用于拒绝高风险 PR 后关 PR 失败）、`high_risk_reject_not_applied`（T-041c：拒绝高风险 PR 时已关或试图关 PR，但 9 的拒绝没生效，如 PR 中途换了）。

## 角色命名

- 配置 `roles.review_board` 指**整个评审组**（`members[]` 为评审池成员，不含主管）。
- 事件与台账中的 `role: "reviewer"` 指评审组中的**单个成员**。
- 其余角色与配置同名：`supervisor`、`sub_agent`、`coder`。
