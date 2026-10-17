# @bakacoding/review-pool

模块 7 评审池：按负载分配评审成员，以 diff + 需求单 + 精简摘要给出评审结论。

## 复投成员记录（T-034）

`AssignmentStore` 默认是内存实现，进程重启后丢失。要跨重启保留，用 `createRoundAssignmentStore({ rounds: storageRoundSource(storage, projectOf) })`：

- `get(ticket_id)`：先看本进程 `set` 过的值；没有就读模块 2 的 PR 轮次记录，按轮次从新到旧取第一个非空的 `reviewer`。
  - `null`（CI 失败、没调模型的那轮）跳过，沿用更早一轮的成员。
  - `"supervisor"` 原样返回：主管仍兼任就交回主管；已配了成员就找不到，按负载换人。
  - 成员已不在配置里或被限流，同样按负载换人。
  - 读轮次出错时记一条 warn，退回按负载分配，评审照常进行。
- `set` 只记在本进程内存：轮次记录由模块 8 用评审结果的 `reviewer` 写，7 不写 PR 记录。
- `storageRoundSource` 调模块 2 的 `query({ project_id, ticket_id })`。模块 2 目前只能按项目查单，所以 `projectOf(ticket_id)` 要由调用方提供；查不到项目时当作没有记录。
