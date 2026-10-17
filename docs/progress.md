# BakaCoding 总开发进度

> 上次更新时 main：`3c85cf8` · main 上测试：46 个测试文件、841 个测试全部通过 · 更新日期：2026-10-17（UTC+8）
>
> 需求单来源：项目助理的第一批需求单草稿（T-001～T-021）；PR 编号和合入提交来自 GitHub PR 记录和 `main` 的提交历史。

## 模块地图

模块和分层以 [功能模块](modules.md) 为准。模块状态由它名下的需求单推出：名下的单全部合入算已完成；有单在开发、待评审或已合入算进行中；名下还没有单算未开始。

```mermaid
flowchart BT
  subgraph 底层
    M0[0 事件总线]
    M1[1 模型接入层]
    M2[2 存储与事件日志]
    M3[3 配置与预算]
    M4[4 工作区与受限工具层]
  end
  subgraph 执行层
    M5[5 Flash 编码池]
    M6[6 PR 抽象]
    M7[7 评审池]
  end
  subgraph 编排层
    M8[8 副 Agent]
    M9[9 调度器与合并队列]
    M10[10 主管]
  end
  subgraph 外围
    M11[11 诊断包导出]
    M12[12 桌面界面]
  end
  T[共享类型包 @bakacoding/types]

  classDef todo fill:#f1f5f9,stroke:#94a3b8,color:#334155
  classDef doing fill:#fef3c7,stroke:#d97706,color:#78350f
  classDef done fill:#dcfce7,stroke:#16a34a,color:#14532d

  class M0,M1,M2,M3,M4,M5,M6,M7,M8,M9,M11,M12,T done
  class M10 doing
```

图例：绿色 = 已完成，黄色 = 进行中，灰色 = 未开始。

- 0 事件总线：T-003 已合入。总线的 `initialSeq` 和订阅队列上限随 T-005（模块 2）在 #19 合入，记在 T-005 名下。
- 共享类型包不算 13 个功能模块之一，单列出来。
- 5、6、7（执行层）：T-034 / T-043 已合入，T-047 待评审，后续还有 T-044、T-045，算进行中。
- 8、9、10（编排层）的第二批需求单已拆（T-035～T-042）：8、9 有单在开发，算进行中；10 的单还没开工，算未开始。

## 需求单

状态取值：未开始 / 开发中 / 待评审 / 已合入。

| 单号 | 内容 | 模块 | 负责人 | 状态 | PR | 合入提交 |
| --- | --- | --- | --- | --- | --- | --- |
| T-001 | 共享类型：事件、权限清单、LedgerStore 与 zod schema | 共享类型包 | 基础层开发 | 已合入 | #3 | `56cfaca` |
| T-002 | 读配置与读密钥接口（getConfig / validate / getSecret），补齐示例配置 | 3 | 基础层开发 | 已合入 | #5 | `adf612a` |
| T-003 | 事件总线 publish / subscribe | 0 | 基础层开发 | 已合入 | #13 | `ea51630` |
| T-004 | 模型接入层 call / capabilities / rateLimitState；多轮 `chat()`、可选 `signal`、超预算抛 `BudgetExceededError` | 1 | 基础层开发 | 已合入 | #39 | `61eed0c` |
| T-005 | SQLite（WAL）与事件落库；另含总线 `initialSeq`、订阅队列上限、`DiagnosticsSource` 移入 types、modules.md 公共字段措辞 | 2 | 基础层开发 | 已合入 | #19 | `95cd3f3` |
| T-006 | 预算台账 recordCost / budgetState | 3 | 基础层开发 | 已合入 | #23 | `14c1698` |
| T-007 | 脱敏函数 redact（light / full） | 3 | 基础层开发 | 已合入 | #6 | `4f20ce0` |
| T-008 | 项目导入与提示词模板 importProject / promptTemplate | 3 | 基础层开发 | 已合入 | #52 | `633ca0a` |
| T-009 | 工作区 createWorktree / cleanup | 4 | 基础层开发 | 已合入 | #7 | `cdb1ed7` |
| T-010 | 受限文件工具 read / write / edit / glob / grep | 4 | 基础层开发 | 已合入 | #32 | `ece21a5` |
| T-011 | 三级权限与写入范围申请 applyPermissions（含权限清单写入接口）；grep 防回溯、`.env.example` 只读、工具定义深冻结、模块 2 `listPrRounds` | 2、4 | 基础层开发 | 已合入 | #44 | `97c0872` |
| T-012 | PR 抽象接口与本地实现（含 diff 与 commitPatch） | 6 | 执行层开发 | 已合入 | #10 | `b8983a7` |
| T-013 | 桌面界面壳子（三栏 + 假数据） | 12 | 界面与诊断开发 | 已合入 | #9 | `c8f169d` |
| T-014 | 诊断包导出（bakacoding-diag/v1、完整脱敏、SWE-bench JSONL） | 11 | 界面与诊断开发 | 已合入 | #11 | `ea7bfcc` |
| T-015 | 单价表与时段规则 config/pricing.json、isOffpeak | 3 | 基础层开发 | 已合入 | #8 | `71cb65d` |
| T-016 | 模块 6 GitHub 实现（已并入 T-025：merge 补开 open 中途失败的 PR） | 6 | 执行层开发 | 已合入 | #21 | `06cef58` |
| T-017 | TicketStatus 枚举 | 共享类型包 | 编排层开发 | 已合入 | #4 | `2b3238b` |
| T-018 | 集成分支作为一条 PR 记录 | 6 | 执行层开发 | 已合入 | #18 | `e9181f0` |
| T-019 | 界面假数据改用 @bakacoding/types；诊断包排除 .env、diff_file 与 zip 条目一致 | 12、11 | 界面与诊断开发 | 已合入 | #14 | `c3afa67` |
| T-020 | requirement_id 允许为 null（仅项目级事件） | 共享类型包 | 基础层开发 | 已合入 | #15 | `038b91e` |
| T-021 | 诊断包 .env 规则收紧，schema 升到 v1.1；界面假数据 `req-none` 换成 null | 11、12 | 界面与诊断开发 | 已合入 | #16 | `e35e38e` |
| T-022 | 存储层跟进：毫秒时间列、`events.seq` 唯一、落库失败可见、IMMEDIATE 事务、prStore 脱敏与 kind 校验、需求归属不被群消息覆盖、limit 校验 | 2 | 基础层开发 | 已合入 | #20 | `1a11948` |
| T-023 | 桌面界面读取真实事件：主进程只读打开存储，IPC 推快照与增量，preload 只读 API | 12 | 界面与诊断开发 | 已合入 | #22 | `c5efa90` |
| T-024 | 诊断包接存储：`storage.diagnosticsSource()` 作为模块 11 数据源的集成测试与数据缺口说明 | 11 | 界面与诊断开发 | 已合入 | #24 | `94c0624` |
| T-026 | better-sqlite3 升到 12.x（Electron 44 能编过）；存储只读打开 `openStorageReadonly`、`maxSeq`、`nativeBinding`；prStore 结构字段加 `closed_by` | 2 | 基础层开发 | 已合入 | #26 | `11c867d` |
| T-027 | 桌面界面改用存储只读 API：`openStorageReadonly` 替换手写 SQL，按 `maxSeq()` 轮询，库缺失 / 版本不符 / ABI 不符给出可读状态；实测 Electron 窗口显示真实数据（#22 的 ABI 已知问题已解决） | 12 | 界面与诊断开发 | 已合入 | #29 | `21bf2f8` |
| T-028 | 模块 6 补接口：`commitWorktree`（提交 worktree 全部改动）、`close`（`closed_by` / `close_reason`，sync 不把自己关的当手动关闭） | 6 | 执行层开发 | 已合入 | #25 | `4a2ce07` |
| T-029 | 模块 5 Flash 编码池：`createCoderPool` / `runTicket`（返回 `done` / `gave_up` / `turn_limit` / `budget_exceeded`，不返回补丁）、逐字节固定的公共前缀、删 `slots()`；模块 3 配置加 `pipeline.max_turns`（默认 40）；1、3、4 未合入部分先注入；含模块 7 顺手改动：signal、json 代码块优先（#27 评审意见） | 5 | 执行层开发 | 已合入 | #30 | `09cf7fe` |
| T-030 | 模块 7 评审池：`review` / `backlog`、CI 失败直接判不过、主管兼任、复投粘性与限流跳过、输出解析重试、`review_backlog` 事件；评审结论类型进 `@bakacoding/types` | 7 | 执行层开发 | 已合入 | #27、跟进 #28 | `be1fa6f`、`a44d985` |
| T-032 | 模块 5/7 收尾：编码池 feedback 闭合标签转义；公共前缀按内容哈希失效；结束回复解析不了先要求重回一轮，仍不行返回 `gave_up` | 5 | 执行层开发 | 已合入 | #31 | `34df5fc` |
| T-033 | 桌面界面跟进：项目列表改用存储 `listProjects()`（不再从事件收集项目 id）；需求单标题去掉行尾 `\r`（#29 评审意见） | 12 | 界面与诊断开发 | 已合入 | #33 | `59a38d5` |
| T-034 | 模块 5/7 跟进：编码池改用模块 4 的 `FILE_TOOL_DEFINITIONS` / `createTools`（参数 `file_path` / `include`），`changed_files` 读 `file_path`，前缀快照重生成；评审池复投成员记录可持久化（`createRoundAssignmentStore` 读 2 的 PR 轮次 `reviewer`）；不可信标签转义的归一化改为 NFKD 后去掉组合符号（拦 `<` + U+0338 / `≮`） | 5、7 | 执行层开发 | 已合入 | #36 | `9db2a1f` |
| T-035 | 模块 9 合并队列：`createScheduler`（启动时向 6 注入 `eventContext`）、按依赖顺序出队与依赖上报后挂起、冲突复投（新建 `r<n+1>` worktree，新 PR 开出后关旧 PR、清旧 worktree，最多 2 次后上报 `conflict_limit`）、`merge_blocked` 与连续限流超 3 次上报 `github_manual`、基线前进按接口 / 依赖重审不计复投、`sync()` 结果落到 TicketStatus、合并后发 `interface_changed`、反压信号 `backpressureState()`（含每日预算暂停）；模块 3 配置加 `backpressure.pending_pr_limit`（默认 16）；5、7、8、4 先注入 | 9、3 | 编排层开发 | 已合入 | #37 | `569e368` |
| T-036 | 共享类型：`escalated` 上报原因加 `coder_failed`、`budget_exceeded`；桌面界面 `ESCALATION_REASON` 补两条显示文字 | 共享类型包、12 | 编排层开发 | 已合入 | #34 | `29c1d4f` |
| T-037 | 模块 8 副 Agent 主流程 `handle(ticket)`：使用单子的 permission_list、编码池结果处理（`coder_failed` / `budget_exceeded` 上报）、开 PR 与评审、复投、轮次写 `reviewer`、群消息 | 8 | 编排层开发 | 已合入 | #40 | `aa8fb80` |
| T-038 | 模块 8 补充：8 是 `write_scope_requested` 唯一答复方（不安全路径直接拒，范围内直接批，范围外交 9 新增的 `extendScope`；所有批准都先发 `write_scope_granted` 再写回需求单记录，`recordGrantedScope` 改为内部）、订阅 `interface_changed`（`onInterfaceChanged` / `attach`，说明作不可信反馈带给下一次编码，在手的单交出前重审、不计复投，`ResumeToken.interface_notes`）、依赖类单标高风险（`DEPENDENCY_MANIFEST_GLOBS`、需求单 `kind: "dependency"`，`high_risk` 带给 7 / 9 / 结果，模块 7 加 `ReviewInput.high_risk?`）；9 的 `merged_but` 保持 `merged` 并发 `escalated(merged_but)`；8 / 9 的 `isUnsafeGlob` / `isUnsafeScope` 转调模块 4（`@deprecated`）；`clampPermissionList` 不安全的 rw 丢掉、ro 改 deny | 8、9、7 | 编排层开发 | 已合入 | #50 | `ad58693` |
| T-039 | 模块 9 调度器：入队与依赖排序、写入范围锁与独占区、写入范围申请回复、编码槽位、闲时 `deferred`（读 T-035 的反压信号）；另含：预算续跑接派单闸门、冲突复投传 sha 基线、后台出错不覆盖终态、8 的 `reReview` 重启后读 2 的 PR 记录、worktree 根目录软链接逃逸测试、`stop()` 的取消信号经 8 传给 5/7 | 9、8 | 编排层开发 | 已合入 | #45 | `501853a` |
| T-040 | 模块 10 主管：`chat` / `split`（接口声明必填、决策记忆、项目创建告知用户） | 10 | 编排层开发 | 已合入 | #56 | `79bc488` |
| T-041 | 模块 10 上报处理（重拆最多 2 次，`budget_exceeded` 直接交用户）与高风险 PR 裁决 | 10 | 编排层开发 | 未开始 | — | — |
| T-042 | 模块 10 集成分支审查与合入 main、主管待办指标 | 10 | 编排层开发 | 未开始 | — | — |
| T-043 | 不可信文本包装与转义：评审池的需求单 / 摘要 / 架构约束 / diff 与编码池 feedback 统一包进带 nonce 的 `untrusted` 区块；转义前做 NFKC、忽略零宽字符和软连字符；共用函数放 `@bakacoding/types`；nonce 不进编码池公共前缀 | 5、7 | 执行层开发 | 已合入 | #35 | `876cac0` |
| T-044 | 模块 5/7 把 `signal` 透传给模型调用（`runTicket` 加可选 `signal`，调模型前、工具调用前检查取消）；编码池工具轮把上一轮的 `reasoning`（含 `signature`）原样放进 assistant 消息回传 | 5、7 | 执行层开发 | 已合入 | #43 | `d646d20` |
| T-045 | 模块 7 `storageRoundSource` 改用 `listPrRounds(ticket_id)`；模块 5 `runTicket` 结束时释放本单权限清单、加可选 `scope_requests` 透传给 `createTools` | 5、7 | 执行层开发 | 已合入 | #46 | `bbef27a` |
| T-046 | 模块 9：GitHub 手动合并（`sync()` 带 `merge_sha`）也发 `interface_changed`；`onMerged` 写状态 / `saveMergeResult` 失败不挡发事件；`interface_changed` 发失败进进程内待补发列表（单号 + sha 去重，每轮合并前和 `sync()` 时重试，只报一次 `merged_but`）；补发有重入保护；`sync()` 发现的手动合并在合并日志里记空串 sha（基线未知、保守重审），`merge_sha` 校验 40 位十六进制，只用于事件和去重；模块 6 `SyncChange` 加可选 `merge_sha` | 6、9 | 执行层开发 | 已合入 | #59 | `3c85cf8` |
| T-047 | 模块 6 GitHub 实现：`open` 只建本地记录（不推不开 PR），远程 PR 在第一次 `commitWorktree` 后开；`commitWorktree` 只推本单分支并开 / 复用 PR，失败保留本地提交、下次补做；没有提交的记录不开 PR（不 422）；`checks` 用 push 之后的 head sha | 6 | 执行层开发 | 已合入 | #42 | `1d0c4a9` |
| T-048 | 模块 8 每单权限清单：按单上建议和 `write_scope` 生成三级清单（默认拒绝，范围外写权限降为只读并记日志），以 2 的需求单记录为准、每次编码 / 评审前读回，批准的范围写回记录（`recordGrantedScope`，`scopeRequests` 透传给 5 时自动写回）；同一单不并发 `runTicket`；删 `projectOf`；模块 9 写入范围锁展开花括号、独占区域补「末段模式能写到具体文件名」的判断 | 8、9 | 编排层开发 | 已合入 | #47 | `22ec076` |
| T-049 | 桌面界面：找不到项目的 `escalated`（含合并队列的 `unattributed:<pr_id>`）进侧栏「未归属」，显示 PR 号、原因、说明；`merged_but:` 标「代码已进集成分支」 | 12 | 界面与诊断开发 | 已合入 | #41 | `865dd48` |
| T-051 | 模块 4 统一不安全 glob 判定 `isUnsafeGlob`：登记清单、越界写申请、收批准时拒绝 `..` / `.` / 绝对路径等写法 | 4 | 基础层开发 | 已合入 | #48 | `8520898` |
| T-052 | 模块 4 `applyPermissions`：不安全的 ro 条目原位改成 deny（不再丢弃），不安全的 rw 照旧丢掉 | 4 | 基础层开发 | 已合入 | #49 | `2f48868` |
| T-053 | 模块 8：越界写申请任一路径含通配字符（`* ? [ ] { } ( ) ! + @`）整条拒绝（不调 9 的 `extendScope`、不写回、不发 `write_scope_granted`），防止字面名 `docs/**` 被批成整个目录可写 | 8 | 编排层开发 | 已合入 | #51 | `2bea5bf` |
| T-054 | 模块 4 越界写申请：路径带通配字符直接拒绝、不发申请（T-053 的纵深防御） | 4 | 基础层开发 | 已合入 | #53 | `33a38e0` |
| T-055 | 模块 2：`tickets` 加可空 JSON 列 `fields`（v3 迁移），`saveTicket` 可带 `fields`（原样往返不脱敏，不传不覆盖）；新增 `getTicket`、`listTickets`（写入方和只读连接都有）；`listProjects` 带上 `name` | 2 | 基础层开发 | 已合入 | #54 | `7c28cc5` |
| T-056 | 模块 11 回归测试：需求单 `fields` 带标记串，断言导出的诊断包里任何文件都找不到（存储适配器不读出、模块 11 字段白名单不收，两道各测一次） | 11 | 界面与诊断开发 | 已合入 | #55 | `40c5936` |
| T-057 | 模块 2：需求单 `fields` 损坏时同一连接里同一单号只警告一次（不再每次读都警告），接口不变 | 2 | 基础层开发 | 已合入 | #57 | `c4cd336` |
| T-050 | 模块 12：需求单上显示 `ticket_warning`（项目群顶部「需求单提示」、PR 行提示图标，`write_scope_defaulted` / `fields_invalid` 配中文文案，不认识的代码原样显示，项目对不上的进「未归属」）；`isMergedBut` 同时认 `reason === "merged_but"` 和旧的 `detail` 前缀；顺带收窄 T-056 的 `fields` 断言、补按时间范围导出 | 12 | 界面与诊断开发 | 待评审 | — | — |

编排层第二批需求单为 T-035～T-042；T-044、T-045、T-047 是执行层跟进单；T-046 由编排层改派给执行层。

### 已知缺口

- 模块 2 / 11（T-055）：需求单 `fields` 按设计原样存取、不脱敏，诊断包导出永远不能原样带上 `fields`。已由 T-056 的回归测试锁住。
- 模块 9（T-039）：大写入范围的单等锁时没有防饿死，可能一直被小范围的单抢先。
- 模块 9（T-039）：`priority: deferred` 只看闲时开关，不看预算紧张程度。
- 模块 8（T-038）：接口变更说明（interface notes）v1 不持久化：只在进程内存和预算暂停的 `ResumeToken.interface_notes` 里，进程重启后还没带给编码池的说明会丢。
- 模块 9：文件名本身带通配的独占区域（如 `**/*.d.ts`、`**/*.lock`）判断时仍只取一个代表路径，可能漏判。
- 模块 9：写入范围 glob 把 `[...]` 字符类当字面量处理。
- 模块 4 / 8 / 9（T-051）：`isUnsafeGlob` 把任何含 `..` 的 glob 都当不安全（包括 `a..b.txt` 这类文件名），这类路径不能写进权限清单、也不能申请扩大写入范围（v1 宁严勿宽）。
- 模块 8（T-038 评审 / T-053）：文件名自带 `[]()*` 等字符（如 `app/[id]/page.tsx`）无法临时申请，需拆单时放进 `write_scope`。
- 模块 10（T-040）：意图判断调用也预生成 requirement_id（模块 1/2/3 的台账、call_log 和 call_completed 都要求必填），要改需另开单动 1/2/3 接口和迁移；不是需求的 1:1 消息也会在调用日志和台账里留下一个未登记的需求号。
- 模块 10（T-040）：追问项目后，去掉项目名和虚词仍剩至少 2 个字就当新消息处理，判断较粗，可能误判。
- 模块 10（T-040）：未注入 `listFiles` 时不查裸目录；`persistAndDispatch` 入队中途抛错会半批入队；`pending` 是全进程共用变量，并发会抢（v1 只有一对一对话，可接受）。
- 模块 10（T-040）：1:1 历史 v1 不持久化：主管只通过注入的 `notifyUser` 回 1:1，追问项目时暂存的需求只在本进程内存里，重启即丢。
- 模块 9（T-046）：用户在 GitHub 手动合并而 GitHub 没给合法的 `merge_commit_sha`（40 位小写十六进制）时，不发 `interface_changed`（不用 `targetHead()` 兜底），只调 `onError`。
- 模块 9（T-046）：合并日志不持久化，重启后不从 2 恢复（`TicketRecord.merge` 没有 sha 和改动文件），重启后基线定不了的单按 T-035 保守重审。
- 模块 9（T-046）：没补发成功的 `interface_changed` 待补发列表只在进程内，重启即丢。
- 已解决（T-053）：中途写入范围申请里的路径曾按 glob 原样批准，文件名本身带通配符（如 `docs/**`）会批成整个目录可写；现在申请路径带通配字符一律拒绝。
- 已解决（T-038）：合并成功后收尾出错（`merged_but`）不再把 `merged` 改成 `escalated`，状态保持 `merged` 并另发 `escalated(merged_but)`。
- 已解决（T-048，#47）：写入范围重叠判断展开花括号（`src/{a,b}.ts` 与 `src/a.ts` 算重叠），独占区域按多个代表路径判断（`src/**/*.json` 命中 `**/package.json`）。

### 不对应需求单的 PR

| 内容 | PR | 合入提交 |
| --- | --- | --- |
| 骨架：TS monorepo（pnpm workspace，14 个包） | #1 | `d5f921f` |
| 文档：整体设计 v3.1 接口决定 | #2 | `edb0fe7` |
| 文档：modules.md 模块 11 接口约定 | #12 | `4120b0d` |
| 文档：总开发进度（本文件）；整体设计 §18 schema 版本改为 v1.1 | #17 | `205a37d` |

## 更新规则

- 每个 PR 都要在本文件里更新自己那张单的一行：状态改成「待评审」，填上 PR 编号。
- 合并人（蓝色大肥鱼）合入后填合入提交，并更新文件头的 main 哈希、测试数和日期。
- 没有更新本文件的 PR 不合并。
