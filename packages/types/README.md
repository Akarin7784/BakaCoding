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

## 角色命名

- 配置 `roles.review_board` 指**整个评审组**（`members[]` 为评审池成员，不含主管）。
- 事件与台账中的 `role: "reviewer"` 指评审组中的**单个成员**。
- 其余角色与配置同名：`supervisor`、`sub_agent`、`coder`。
