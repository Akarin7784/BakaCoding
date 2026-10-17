# @bakacoding/review-pool

模块 7 评审池：按负载分配评审成员，以 diff + 需求单 + 精简摘要给出评审结论。

## 复投成员记录（T-034）

`AssignmentStore` 默认是内存实现，进程重启后丢失。要跨重启保留，用 `createRoundAssignmentStore({ rounds: storageRoundSource(storage) })`：

- `get(ticket_id)`：先看本进程 `set` 过的值；没有就读模块 2 的 PR 轮次记录，按轮次从新到旧取第一个非空的 `reviewer`。
  - `null`（CI 失败、没调模型的那轮）跳过，沿用更早一轮的成员。
  - `"supervisor"` 原样返回：主管仍兼任就交回主管；已配了成员就找不到，按负载换人。
  - 成员已不在配置里或被限流，同样按负载换人。
  - 读轮次出错时记一条 warn，退回按负载分配，评审照常进行。
- `set` 只记在本进程内存：轮次记录由模块 8 用评审结果的 `reviewer` 写，7 不写 PR 记录。
- `storageRoundSource(storage)`（T-045）调模块 2 的 `listPrRounds(ticket_id)` 按单号读轮次，不再需要 `projectOf`。写入连接（`openStorage`）和只读连接（`openStorageReadonly`）都能传；单不存在时 2 返回空数组，当作没有记录。

## 取消（T-044）

- `review({ …, signal? })` 调模型时把 `{ signal }` 作为模块 1 `call()` 的第 7 个参数传下去，没给 signal 就只传 6 个参数；`deps.call` 可以直接传 `gateway.call`。解析不了换人重试的那次也传。
- 调模型中途取消：模块 1 中止请求（`call_completed.error.code = ABORTED`）并抛 `AbortError`，7 改抛 `signal.reason`，释放成员、不写 `AssignmentStore`、不再重试。
- `review({ …, high_risk? })`（T-038）：8 判定的高风险单（依赖类单）传 `high_risk: true`，评审提示词最前面加一段「## 高风险单（系统说明）」，放在所有不可信区块之外；`false` 或不给时提示词与之前逐字相同。
- 进入前已中止、排队时中止的行为不变（见 `docs/modules.md` 第 7 节）。
- 评审是单轮调用，不涉及思考内容回传。
