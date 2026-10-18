# BakaCoding 总开发进度

> 上次更新时 main：`0d132e8` · main 上测试：122 个测试文件 / 2270 个测试（2202 过 + 61 失败 + 7 skip）；Windows 本机确定性失败 47 条 / 19 文件（`docs/test-baseline.md`，T-125 跟踪） · 更新日期：2026-10-18（UTC+8）
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

  class M0,M1,M2,M3,M4,M5,M6,M7,M8,M9,M11,T done
  class M10 done
  class M12 doing
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
| T-041a | 模块 10 组装根 `@bakacoding/app`（8 / 9 / 10 共用一条总线）、重启接管 `takeOver`（派单沿用已开的 PR；已在合并队列的单经模块 9 新增的 `adopt` 接回；`fields_invalid` 的单不接回、只发一次警告） | 10、9 | 编排层开发 | 已合入 | #62 | `694bddb` |
| T-041b | 模块 10 上报处理和重拆（已重拆次数 ≥ 上限（默认 2）时不再重拆，`budget_exceeded` 直接交用户；重拆前先关旧 PR、失败重试；需求原文入库；重启补跑上报处理、下游挂起；含模块 9 `replaceDependency`、`adopt` 写状态失败回滚，组合根恢复 `extendScope` 扩出的范围；写入范围首尾空白条目报错） | 10、9 | 编排层开发 | 已合入 | #65 | `30d3248` |
| T-041c | 模块 10 高风险 PR 裁决（含模块 9 高风险闸门，组合根固定打开）：用户放行 / 拒绝（`decideHighRisk`，按 pr_id 绑定，`stale_pr` 等带码错误），拒绝经 041b 的 `closeTicketPr` 关 PR（关失败记 `unconfirmed`、重试）并发 `escalated(high_risk_rejected)`、不重拆；冲突复投换新 PR 重新扣；`pendingHighRisk()` 带理由、命中文件、链接；8 评审前的 diff 绑定 head、交出前 head 变了重判；依赖文件一律按文件名匹配；重启接管按 diff 补判高风险（diff 出错按高风险）、重新扣住并通知用户；反压暂停时通知写明其中等裁决的高风险 PR 数；含模块 8 导出 `isDependencyFile` / `isHighRiskDiffFile`（删除的依赖文件按路径算、改名一律算）、桌面端 `high_risk_rejected` 文案 | 10、9、8、12 | 编排层开发 | 已合入 | #66 | `ff2fc4f` |
| T-042 | 模块 10：集成分支审查 / 合入 main、主管待办指标（项目级 backlog 事件） | 10、组合根、types | 编排层开发 | 已合入 | #72 | `9ed4d7c` |
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
| T-050 | 模块 12：需求单上显示 `ticket_warning`（项目群顶部「需求单提示」、PR 行提示图标，`write_scope_defaulted` / `fields_invalid` 配中文文案，不认识的代码原样显示，项目对不上的进「未归属」）；`isMergedBut` 同时认 `reason === "merged_but"` 和旧的 `detail` 前缀；顺带收窄 T-056 的 `fields` 断言、补按时间范围导出 | 12 | 界面与诊断开发 | 已合入 | #60 | `f056254` |
| T-061 | 模块 9 合并循环丢触发：循环体退出后、收尾前进来的触发（如 `sync()` 返回后立刻 `submit`）会丢，单子停在 `merge_queued`；改为运行中被触发置标记、收尾时补跑一轮，选单跳过后台任务进行中的单（不再从队里拿掉） | 9 | 执行层开发 | 已合入 | #61 | `11bf642` |
| T-058 | 模块 2：prStore 凭据检查收窄，`ssh://git@`、`https://user@` 放行；`user:token@`（含 `%3A`、无斜杠、嵌在文字里）、像 token 或长串十六进制 / base64 的用户名（任何 scheme）、查询参数和 `#` 片段里的 token 照样整条拒写；顺带 T-057 的三个小点（正常读到后清掉警告记录、`warn` 抛错不影响读取、注释归位）；`closed_by` 早已在 `PR_STRUCTURAL_FIELDS` 里，补一条测试锁住，接口不变 | 2 | 基础层开发 | 已合入 | #58 | `adc43ba` |
| T-059 | 模块 3：带凭据 URL 的判断抽成模块 3 导出的 `isCredentialUrl`，2 的 prStore 拒写和 `redact` 的 `url_credentials` 规则共用，两边和 11 跑同一份 `CREDENTIAL_CASES`；`ghp_` / `github_pat_` / `glpat-` 任何位置都遮；`redact` 去掉平方级回溯（邮箱、内网主机名、env 变量名、私钥、IPv6 加上限或改线性扫描），超长主机名照样遮；接口新增 `isCredentialUrl`、`credentialUrlRanges`、`CREDENTIAL_CASES` | 3 | 基础层开发 | 已合入 | #63 | `61f5af3` |
| T-060 | 模块 11 端到端回归：改用模块 3 的 `CREDENTIAL_CASES`，应拒的用例把带凭据文本放进上报详情和群消息，断言导出的诊断包里任何文件都找不到密文、事件确实在包里；应放行的用例详情里不出现 `[REDACTED:url_credentials]`；清单非空；40 位十六进制用户名判为 `url_credentials`；5 种 10 万字符详情的导出各在 500ms 内 | 11 | 界面与诊断开发 | 已合入 | #64 | `4c739e8` |
| T-063 | 模块 12 / 组合根：`createDefaultDeps` 按仓库组装默认 AppDeps；`acquireWriterLock`（writer.lock）；桌面主进程 `startBackend` 接线 assemble/takeOver，失败退回只读；`backend:status` / `supervisor:notify` 缓冲；假数据 `main_merge` 改为 `supervisor` | 12、组合根 | 界面与诊断开发 | 已合入 | #69 | `5459682` |
| T-062 | 模块 12：高风险 PR 放行和拒绝的界面与 IPC（接 pendingHighRisk / decideHighRisk，stale_pr 时提示「PR 已更新，请重新查看」）；警告列表最多显示约 50 条，其余显示 +N；detail 截断，按单号加警告码去重；requirement_truncated / pr_close_failed / high_risk_reject_not_applied / takeover_skipped 配中文文案；诊断导出补按需求、按时间段两种范围的拒绝用例和 include_full_repo，耗时上限放宽到 2s | 12 | 界面与诊断开发 | 已合入 | #73 | `a7401c1` |
| T-064 | 模块 9：定时 sync() 加限流退避 + 对账；拒绝只关指定 PR；adopt 发现已合入按手动合入；独占区用 isDependencyFile | 9、10、组合根 | 编排层开发 | 已合入 | #70 | `080f6b8` |
| T-065 | 模块 6 / types：DiffFile 加可选 old_path，6 用 git diff -M 时填上旧路径；模块 8 `isHighRiskDiffFile` 新旧路径都检查，041c 的改名兜底（renamed 一律当高风险）收窄成只看依赖文件（没有 old_path 的改名仍算）；依赖文件名不区分大小写（仍按整个文件名匹配）；模块 10 高风险证据的命中文件改成 `{ path, old_path? }` | 6、8、10 | 执行层开发 | 已合入 | #67 | `e5c17b5` |
| T-066 | 模块 6：sync 中途出错也带出已收集变化；close PATCH 失败时 GET 远程状态（已合入不记 closed）；merge 加可选 expected_head；checks 翻页并读 commit status；模块 7 发 review_backlog/supervisor_backlog 时 requirement_id、ticket_id 写 null，trace 新开 | 6、7 | 执行层开发 | 已合入 | #68 | `a51e022` |
| T-067 | 模块 12：接 syncState()（状态展示 + 鉴权停 / 限流提示）；IPC `sync:state` / `sync:state-update`，错误信息脱敏 + 截断，只读返回不可用 | 12 | 界面与诊断开发 | 已合入 | #74 | `d4f3c9e` |
| T-068 | 模块 3：`redact` 10 万字符输入的耗时上限从 500ms 放宽到 2s（和 T-062 诊断用例一致）；以 main 旧正则为基准的邮箱随机对比提高比对下限（≥320），另按含 2 个及以上 `.`（≥140）、含 `-`（≥75）分开计数各设下限 | 3 | 基础层开发 | 已合入 | #77 | `37a99b3` |
| T-069 | 模块 6：check-runs 翻页以 total_count 为准，不再遇到本页不足 100 条就停 | 6 | 执行层开发 | 已合入 | #76 | `4e518fd` |
| T-070 | 模块 10：高风险待裁决不计入主管待办（去掉与 9 `pending_pr_limit` 的反压双计） | 10 | 编排层开发 | 已合入 | #75 | `61716e3` |
| T-071 | 模块 12：桌面端接入主管对话，新增 IPC `supervisor:chat` 转给 10 的 `chat()`；渲染全部 5 种回复（answer / ask_project / decision_saved / dispatched / split_failed）；只读 / 未接线 / chat() 抛错返回 ok:false，原因脱敏 + 截断后显示；等待中禁用发送，一次只发一条 | 12 | 界面与诊断开发 | 已合入 | #79 | `3305a79` |
| T-072 | 模块 12：导入项目（`project:import`：git 仓库 + config/models.json / pricing.json 检查，3 的 validate / loadPricing 校验；忙时拒绝；拆旧后端、在新仓库重新组装、3 的 importProject 发 project_created；路径记在 userData）；「导出」接 11 诊断包（`diagnostics:export`，最近 24 小时，默认存到下载目录）；只读设置页（`settings:get`，后端只读时 mode 为 readonly，显示「只读」）；设了 BAKACODING_CONFIG 时导入改为校验它指向的文件并在结果里写明；选中项目时也能和主管对话并带 project_id；对话记录移出组件、主进程串行 chat()；T-071 评审跟进（脱敏测试、错误名过滤、按码点截断）；#82 评审跟进：新仓库失败时用原仓库重组、再失败进只读且如实说明，失败后保留渲染就绪，导出路径按真实路径 + path.relative 判断（win32 不区分大小写），拆后端的退订 / sync 停止有测试，导入支持 `--config`（优先于 BAKACODING_CONFIG）、空 BAKACODING_CONFIG 按未设；复查跟进：导出路径不做词法规范化、目标是符号链接（含悬空）就拒绝、只取 dirname 的真实路径、复制用 COPYFILE_EXCL，新后端已运行但导入失败时仍记下路径 | 12 | 界面与诊断开发 | 已合入 | #82 | `4bb0a33` |
| T-073 | 模块 12 打包：Windows x64 免安装 zip（electron-builder，`package:win` / `package:linux`），版本 1.0.0-preview；`electron` 固定 43.8.0（ABI 148），better-sqlite3 用 12.12.0 官方 electron-v148 预编译包，原生模块 asarUnpack | 12 | 界面与诊断开发 | 已合入 | #80 | `46d7a2d` |
| T-074 | 模块 12：修 IPC handler 参数下标（Electron 第一个参数是 event），high-risk:decide 拿错参数；测试 fake ipc 先传 event，锁住所有带参数的通道 | 12 | 界面与诊断开发 | 已合入 | #81 | `d996617` |
| T-075 | 桌面 exe 图标（`packages/desktop/build/icon.ico`，16–256 多尺寸，极简机器人） | 12 | 界面与诊断开发 | 已合入 | #83 | `f072c29` |
| T-076 | 模块 6：本地模式合入默认集成分支前，分支不存在就从基线分支（baseBranch，默认 main；与 openIntegration / GitHub 模式同一约定，不取工作树 HEAD）建出 `bakacoding/integration`，修新仓库第一张单 `merge_error` 进人工介入；`ensureBranch` 幂等、并发安全（update-ref 空旧值，失败重读），本地 `merge` 同实例串行；新增 4/6/9 真实 git 的派单到合入测试；顺带补已知缺口 2 的测试 | 6 | 执行层开发 | 已合入 | #86 | `de3782b` |
| T-077 | 模块 12 界面小修：报错前缀只出现一次、不露出 `Error：`（主进程 `errorDetail`、界面 `failureText`，兼容 Electron remote method 包装）；只读时导出先拒绝、不弹保存框；设置页标题和项目群 / 未归属的「只读」标签只在后端只读时显示 | 12 | 界面与诊断开发 | 已合入 | #84 | `b4a3745` |
| T-078 | 模块 4：`.git/info/exclude` 改为排除整个 `/.bakacoding/`（数据库等运行文件不再出现在 git status）；旧版只写了 `/.bakacoding/worktrees/` 的仓库补一行、旧行保留；已有等价规则不重复写；跟进：新增 `ensureBakacodingIgnored(dir)`（经 `@bakacoding/app` 再导出），12 的 `startBackend` 在拿写入锁、建库之前对仓库根调用，失败只记 warn、不挡启动 | 4 | 基础层开发 | 已合入 | #85、#87 | `3bb713c`、`30d31cd` |
| T-079 | 组合根 `targetHead` 改读集成分支 `bakacoding/integration`（不读检出的 HEAD，修用户在功能分支上时未合入提交漏进集成分支、单 2 基线缺单 1 改动）；集成分支还没建时退回基线分支（组合根唯一来源，同一个值传给 6 的 baseBranch，默认 main），连基线分支都没有才退回 HEAD；9 / 10 接口不变，只改 `scheduler/types.ts` 注释；补组合根单测和 4/6/9 真实 git 两张单先后合入测试 | 9 | 编排层开发 | 已合入 | #88 | `adb682b` |
| T-080 | 文档：README 重写（1.0.0-preview 的 Windows 下载与运行、桌面端用法、环境变量、v1 已知限制、第三方声明 lucide ISC）；`docs/images/` 加三张实机截图（主界面、同步状态行、导出诊断包）；整体设计（md / html）状态句改为 v1 已实现，worktree 排除说明改为 `.git/info/exclude` 排除整个 `/.bakacoding/`；整体设计和模块文档的密钥说明改为只从环境变量读（不读 `config/secrets.local.json`）。只改文档，main `dd266a4`，测试仍为 73 个文件 / 1570 个 | 文档 | 界面与诊断开发 | 已合入 | #89 | `dd266a4` |
| T-082 | 模块 4：新增通用接口 `ensureExcludeLines(dir, lines)`（经 `@bakacoding/app` 再导出，供 T-081 写 `/config/*.json`）；`ensureBakacodingIgnored` 改为调用它，行为不变；判断规则是否已存在改按 git 语义（行首空格算数、行尾未转义空格不算、CRLF 视同 LF），修掉 `trim()` 把行首空格当成等价的问题；modules.md 同步。main `2a4dba5`，测试 73 个文件 / 1578 个 | 4 | 基础层开发 | 已合入 | #90 | `2a4dba5` |
| T-081 | 导入缺配置时「用默认模板创建」：新 IPC `project:createDefaultConfig`（无参数，目录由主进程记住，每次导入 / 用完即清）；只补缺的文件、不覆盖、`--config` 时只建 pricing.json、符号链接 / 非 git 仓库拒绝；exclude 行经 `ensureExcludeLines`（T-082，main.ts 注入真实实现，只写本次新建的文件）；缺失清单只说一遍并提示模板位置；界面内容区「缺配置」横幅 +「用默认模板创建」按钮（原因走 toast）；UI-03b 起不是 Git 仓库不进 `missing`，失败结果带 `notGit` / `envConfigMissing`，都不给按钮 | 12 | 界面与诊断开发 | 已合入 | #91 | `226362e` |
| T-126 | 模块 12：T-081 评审 P2 清尾：`project:createDefaultConfig` 创建配置 / 写 `.git/info/exclude` 的报错只留错误码（fs 报错的 message 带绝对路径，不再拼进界面提示）；`modules.md` §12 措辞对齐（补完后内容校验仍不过时，提醒并进失败原因）；已知缺口登记 11/12 三条（右面板动态空壳、诊断导出只有 24 小时一键、设置弹层缺可编辑标签） | 12 | 界面与诊断开发 | 已合入 | #155 | `ec3d9dc` |
| UI-01 | 模块 12 设计 token、主题、字体与基础组件（`docs/ui-design.md` §5、§6，`01b15dd`）：§5.1 浅 / 深两套 OKLCH 颜色 token（danger 红与 accent 蓝分开，错误提示改用 danger）；主题跟随系统 / 浅 / 深，偏好存 localStorage，写到 `<html data-theme>`，设置页加主题切换；字体西文 Inter（随包 latin / latin-ext 子集，OFL）+ Segoe UI Variable / 微软雅黑 UI，正文 14px，代码字体栈；间距、圆角、阴影、动效 token，尊重减少动态效果；按钮只留 primary / secondary / danger 三种（34 / 28 高），danger 只能经确认框的 `DialogDangerButton` 用；补 shadcn 组件 Dialog、DropdownMenu、Tooltip、Toast（sonner）、Tabs、Input、Select、Switch、ScrollArea、Collapsible、Command；`StatusIcon`（9 个状态 → lucide 图标，§5.2）；文案表 `lib/copy.ts`（merged「已合入」、合入 main「已合入 main」、复投「重写」），测试搜 `packages/desktop/src` 不得出现旧叫法；新依赖 `radix-ui`、`sonner`、`cmdk`、`@fontsource-variable/inter`；IPC 与布局不变。main `e44f4a5`，测试 78 个文件 / 1619 个 | 12 | 界面与诊断开发 | 已合入 | #93 | `e44f4a5` |
| T-085 | 模块 9 单子状态变更事件：`@bakacoding/types` 新增 `ticket_status_changed`（`project_id`、`from`（可为 null）、`to`，`ticket_id` 必填，只加不改）；组合根的 `tickets.setStatus`（8 和 9 写状态都经它）在写库成功、且状态真的变了之后发一条，同状态重复写、写库抛错、找不到单、新建单子都不发，发布失败只记警告；trace 取单子 `fields.trace`；8、9、10 的代码和接口不动；modules.md 事件清单和「组合根」一节同步。main `1824b12`，测试 81 个文件 / 1678 个 | 9 | 编排层开发 | 已合入 | #99 | `1824b12` |
| T-095 | 根目录 `pnpm typecheck` 在干净检出上报 TS6310：根脚本是 `tsc -b --noEmit`，而 TypeScript project references 要求被引用项目能写出声明文件，CLI 的 `--noEmit` 会关掉整张依赖图的 emit；最小修复是把根 `typecheck` 改成 `tsc -b`（与 `build` 相同，会写出 dist）。干净检出（`pnpm install`、无先验 build）根目录 typecheck 通过；回滚 `--noEmit` 后 TS6310 复现；`pnpm build` / `test` / `lint` / `format:check` / `pnpm -r typecheck` 不受影响。README 开发者指南同步说明。 | 工具链 / 12 | 界面与诊断开发 | 已合入 | #96 | `fe8207c` |
| T-093 | 界面：IPC `backend:reload` / `backend:reconnect`（同一仓库停起后端，复用 `BackendSwitcher` 的拆旧 / 组装；只在没有编码、评审、合并队列中的单、也没有主管对话在途时执行，否则排队（只等排队时在途的单，防饿死）、空闲后自动重载；退出时不泄漏新后端；重复请求合并；起不来退只读，原因去掉绝对路径和密钥值；`backend:status` 加可选 `reload` 进度；预算当日已用从台账恢复）；modules.md §12 同步。main `d2899c5`，测试 79 个文件 / 1639 个 | 12 | 界面与诊断开发 | 已合入 | #95 | `d2899c5` |
| T-086 | 模块 4：新增仓库检查与修复组（`docs/ui-design.md` §4.1、§7，经 `@bakacoding/app` 再导出，界面只调用）：`checkRepo(dir)` 只读逐项检查 git / commit / main / ignored（code `not_git` / `no_commits` / `no_main` / `not_ignored`，`no_main` 带 `current`，与 T-084 同名；dir 必须本身是仓库根），身份只回是否已配；`initRepo` 建目录、`git init`、HEAD 指向 main，身份只写本仓库 `.git/config`，再写 exclude；`listInitialCommitFiles` 列确认框文件，默认排除 `.env` 类、私钥类（同 `isProtectedPath`，`.env.example` 不排除）和 `.bakacoding/`；`initialCommit` 只在无提交时执行，只提交 include 里列出的文件（混进别的整体拒绝），可空提交，用临时索引建树、不跑 hooks，提交到 main 并重置暂存区；`createMainBranch` 从当前 HEAD 只新建 main，不切换、不改名、不删；所有 git 调用带超时，失败抛 `RepoFixError { code }`，文案不含路径和 git 原始输出；modules.md 同步。main `42795c2`，测试 81 个文件 / 1670 个 | 4 | 基础层开发 | 已合入 | #97 | `42795c2` |
| T-096 | 组合根 `app.stop()` 改成返回 `Promise<void>`，等 `scheduler.stop()` 等异步收尾结束后再关库（现在 `assemble.ts:597` 是同步的，不等 promise）；属于 app 接口改动，接口先在群里报；桌面端 switcher 已统一 `await backend.stop()`，不用再改。来源：蓝色大肥鱼评审 #95。排在 T-084、T-085 之后，不阻塞 UI-03 和发版。桌面端退出等待收尾另拆 T-105。main `8359c7f`，测试 95 个文件 / 1826 个 | 组合根 / 9 | 编排层开发 | 已合入 | #114 | `8359c7f` |
| T-097 | 模块 4、6 现有的 `git()` 调用改用 T-086 的 `gitEnv()`，不再继承 `GIT_` 开头的环境变量（T-094 #101 已知缺口）；模块 4 归基础层、模块 6 归执行层，两边各开一个 PR，都补「设了 `GIT_DIR` 不影响目标仓库」的测试。依赖 #97 合入。模块 6（执行层）：`packages/pr` 的 `git()` 本地操作改用 `gitEnv()` 并加 `REPO_GIT_TIMEOUT_MS` 超时（commit 跑 hook 不设超时），fetch / push / ls-remote 等远程操作保持继承环境不变；补 GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE 隔离测试和超时测试。模块 4 顺带：worktree.ts git() 加超时、repo.test GIT_AUTHOR_* 用例改为断言提交作者取自仓库配置、注明 gitEnv 仅用于本地仓库操作。来源：蓝色大肥鱼 2026-10-18。模块 4 #105 合入 `356e158`，模块 6 #109 合入 `aeff1fa`，main `aeff1fa`，测试 86 个文件 / 1755 个 | 4 / 6 | 基础层开发、执行层开发 | 已合入 | #105、#109 | `356e158`、`aeff1fa` |
| T-084 | 组合根：仓库没准备好时启动报明确原因。新增 `RepoNotReadyError`（`code: "no_commits" \| "no_main"`，`no_main` 带当前分支名 `current`，分离 HEAD 时缺省；`message` 中文、不含路径；code 与 4 的 `checkRepo()`（T-086）一致），经 `@bakacoding/app` 导出；`createDefaultDeps` 最先检查（早于密钥检查，失败时不建总线和 9 / 10）；`integrationTargetHead` 去掉退回检出 HEAD 的一档，集成分支和 main 都没有就抛错，只有 master 的仓库启动即进只读，不再等到第一张单合入才失败；8 / 9 / 10 接口不变，桌面端显示原因留给 UI-03；组合根和桌面端测试的临时仓库改用 `git init -b main`；仓库检查和 `targetHead` 调的 git 子进程 env 先剔掉外部所有 `GIT_*` 变量再加 `GIT_TERMINAL_PROMPT=0` / `LC_ALL=C`（#97 评审，用模块 4 的 `gitEnv()`，超时用 `REPO_GIT_TIMEOUT_MS`）；README 已知限制、modules.md 组合根同步。main `18ad5c1`，测试 81 个文件 / 1688 个 | 组合根 | 编排层开发 | 已合入 | #107 | `18ad5c1` |
| T-087 | 模块 3：`writeConfig(path, config)` 校验后原子写入 `models.json`（同目录临时文件 + rename，2 空格缩进、末尾换行），拒绝像密钥的键和值（`redact` light 规则 + 等于当前环境变量密钥），错误不含值和路径，只能写 `models.json`；经 `@bakacoding/app` 再导出；modules.md 同步。main `74e547a`，测试 82 个文件 / 1705 个 | 3 | 基础层开发 | 已合入 | #98 | `74e547a` |
| T-094 | 合入后清理该单的 worktree 和 `bakacoding/<id>-r<n>` 分支：模块 4 `cleanupMerged`（只删已包含在目标分支里的分支、不碰集成分支和远程、Windows 重试 + `fs.rm` 兜底、`-c core.longpaths=true`、用 `gitEnv()`、每条 git 带 `REPO_GIT_TIMEOUT_MS` 超时、从不抛错）与进程内 git 写锁 `withGitWriteLock`（T-086 的 `initRepo` / `initialCommit` / `createMainBranch` 和 6 的 merge 落 target 段也接上），`cleanup` 改逐项处理；模块 9 在 `onMerged` / `applyManualMerge` 发完 `interface_changed` 后后台清理，不卡合并循环、失败只 `onError`；模块 6 `diff` 在 worktree 不在时改用主仓库，提交取不到时用 `merge_sha` 算 `<merge>^1..<merge>`；组合根重启补清理（接管后后台跑，整轮总超时）。main `06a4e60`，测试 85 个文件 / 1749 个 | 4、6、9、组合根 | 执行层开发 | 已合入 | #101 | `06a4e60` |
| T-098 | 模块 3：配置校验与 JSON 解析错误不带原值 | 3 | 基础层开发 | 已合入 | #111 | `cb4e55e` |
| T-099 | 模块 3：价格表、语言清单、项目路径、提示词模板的错误不带原值和完整路径（`loadPricing` 失败抛 `ConfigError`、`loadLanguageManifests` 抛 `ProjectImportError`；读不到只报文件名和错误码，坏 JSON 只报行列号，校验错误同 `validate`；`importProject`、`promptTemplate` 不再拼完整路径和 `String(e)`）。main `824119c`，测试 87 个文件 / 1765 个 | 3 | 基础层开发 | 已合入 | #113 | `824119c` |
| UI-03a | 模块 12 仓库准备（`docs/ui-design.md` §4.1，含 T-100）：IPC `repo:check` / `repo:init` / `repo:list-initial-files` / `repo:initial-commit` / `repo:create-main` 接 4 的检查与修复组（主进程做参数类型校验，`files` 拒绝 `..` 和绝对路径，失败只回 `RepoFixError` 固定文案，写操作成功后自动 `backend:reconnect`，identity 只写本仓库 `.git/config`）；项目准备页（git → commit → main → ignored 逐项检查，前一项不过后面灰掉，写操作先确认，首次提交确认框列 include / excluded 并提示暂存会变回未暂存，身份表单只显示缺的字段）+ 只读横幅［准备仓库］入口（按 `repoFixRoute` 路由）；仓库来源是当前目录时不提供初始化和首次提交（`BackendStatus.repoSource`，横幅改为提示先导入项目，主进程写操作回 `cwd_repo`），准备页标题和确认框显示目标文件夹名；只读原因显示 `RepoNotReadyError` 的 message，不是 Git 仓库（含缺配置时）固定提示 `not_git`；T-100：导入检查的 models.json 读不到只报错误码、坏 JSON 只报行列号，价格表用 `ConfigError` 各条；主进程日志（`pendingHighRisk`、写 exclude、组合根 logger / onError）与切换项目失败原因脱敏；modules.md §12 同步。密钥项与模型配置向导留给 UI-03b。main `cff7596`，测试 108 个文件 / 1977 个 | 12 | 界面与诊断开发 | 已合入 | #130 | `cff7596` |
| UI-02 | 模块 12 新布局骨架（`docs/ui-design.md` §2）：左栏 260 / 收起 56（偏好持久化，< 1024 自动收起）、内容区正文最大宽 760、右面板 360 默认关（「概览」暂放原右侧边栏内容，「动态」空壳；< 1200 改覆盖式抽屉）；无边框窗口（Windows / Linux `titleBarOverlay` 保留系统窗口按钮，自绘拖拽区），最小 960×640；新增 IPC `window:theme` 把主题偏好同步到 `nativeTheme.themeSource`、刷新标题栏按钮颜色；全局快捷键 Ctrl+N / K / , / B / .；设置改为弹窗，Command 面板壳子；现有主管对话、项目群、未归属、设置都挂进新骨架，骨架不新增主按钮。main `0728d2f`，测试 92 个文件 / 1806 个 | 12 | 界面与诊断开发 | 已合入 | #103 | `0728d2f` |
| T-104 | 模块 3：`importProject` 对根目录 `stat` / `readdir` 出错也包成 `ProjectImportError`，只报错误码（「项目路径无法访问（EACCES）」「读不到项目目录（EACCES）」），不带路径和原 message（T-099 后续）；modules.md §3 同步。main `2903399`，测试 93 个文件 / 1809 个 | 3 | 基础层开发 | 已合入 | #116 | `2903399` |
| T-101 | 模块 9 / 组合根：`listFiles`、`userMainWorktreeFor` 的 git 调用统一走 repoGit + `gitEnv()` + 超时（T-096 评审跟进）；`repoGit` 挪到内部文件 `repo-git.ts`，加可选 `maxBuffer`，`listFiles` 用 16 MiB。main `5b1ff25`，测试 110 个文件 / 2010 个 | 9 | 编排层开发 | 已合入 | #134 | `5b1ff25` |
| T-102 | 模块 8 + 6：`resubmitConflict` / `reReview` 接收 stop 的 signal；模块 6 GitHub 请求加请求级超时（T-096 已知缺口）；preview.1 之后 | 8 / 6 | 编排层开发、执行层开发 | 待开发 | — | — |
| T-102a | 模块 6：GitHub REST 请求级超时（`GITHUB_REQUEST_TIMEOUT_MS` 30s）+ 各方法 `opts.signal`；finishMerged 缺 `merge_commit_sha` 时沿第一父链找合并提交。main `574ec8a`，测试 110 个文件 / 2019 个 | 6 | 执行层开发 | 已合入 | #135 | `574ec8a` |
| T-102b | 模块 8 / 9：`resubmitConflict` / `reReview` 收可选 `options.signal`，8 原样交给 5、7，中止后抛 `signal.reason`（`reReview` 不再写死 `signal: undefined`）；9 在 `stop()` 时用同一个 signal 中止，被中止的调用不上报、不改状态，留给 takeOver；组合根透传；8 调 6 的 `open` / `commitWorktree` / `diff` 也带 signal（接 T-102a），交出前被中止不写 `merge_queued`、不 submit；modules.md §8、§9 同步，§9 写定收尾时间（带 / 不带 signal 两种情况，复核桌面退出上限 35 秒）。main `e151225`，测试 112 个文件 / 2054 个 | 8 / 9 | 编排层开发 | 已合入 | #136 | `e151225` |
| T-103 | 模块 6：合并重试幂等。本地 `merge` 在锁内读到 target 后先查 head 是否已被 target 包含，是则直接记 merged（`merge_sha` 取把 head 带进 target 的那个提交：快进为 head，非快进为当时的合并提交），不再 commit-tree、不动 target；GitHub `merge` 推分支前先查远程 PR，已合入则不推不 PUT，fetch、快进本地 target 后记 merged（`merge_sha` 用 `merge_commit_sha`），PUT 回 405 / 409 时也回查；接口不变，modules.md §6 同步。来源：编排层分析 2026-10-18，preview.1 之前。main `436fbdf`，测试 96 个文件 / 1831 个 | 6 | 执行层开发 | 已合入 | #117 | `436fbdf` |
| T-105 | 模块 12 桌面端退出和收尾等 stop 结束（T-096 评审跟进）：`before-quit` 里 `preventDefault`，等 `BackendSwitcher.stop()` 结束再 `app.quit()`，上限 `QUIT_STOP_TIMEOUT_MS` = `REPO_GIT_TIMEOUT_MS` + 5 s，超时写一条固定 warn（不带路径、不带原始错误）后退出，只 stop 一次、自己发起的退出放行（判断抽成 `quit-guard.ts`）；后端 `stop()` / 启动失败的 `cleanupPartial` 先 `await app.stop()` 再 dispose、关库、放写锁，`stop()` 重复调用返回同一个 Promise；`window:theme` 失败一律回固定文案「主题设置失败」，不传原始错误（取代 UI-08 的脱敏透传）；`window-theme.json` 改原子写（同目录临时文件 + rename，失败删临时文件）；modules.md §12 和组合根一节同步。preview.1 之前。main `ad3fa49`，测试 103 个文件 / 1879 个 | 12 | 界面与诊断开发 | 已合入 | #122 | `ad3fa49` |
| UI-08 | 模块 12 状态与反馈（`docs/ui-design.md` §3、§4.7、§4.8；基于已合入的 UI-02 #103）：只读横幅「只读模式：原因」+ 查看详情（`backend:status` 新增脱敏后的 `error`：错误名 / 信息 / 错误码 / 一层 cause）+ 重新连接（接 T-093 `backend:reconnect`）；只读时输入框、裁决、合入 main、导出禁用并说明；操作结果改右下角 toast（错误不消失、可复制详情）；左栏底部全局状态点 + 状态卡（后端、同步、数据库、待处理、未归属并入）；右面板抽屉改 Radix Dialog（焦点移入 / 困住 / 归还，`--overlay` 遮罩）；窗口按钮留位优先用 Window Controls Overlay；主进程记住主题偏好，启动建窗口前读出，标题栏不闪；`window:theme` 失败原因脱敏（改固定文案见 T-105）。main `9ffac04`，测试 101 个文件 / 1866 个 | 12 | 界面与诊断开发 | 已合入 | #119 | `9ffac04` |
| T-088 | 模块 3：界面保存密钥 `setUserSecret` / `clearUserSecret` / `secretStatus`（`secrets.ts`）：写 `HKCU\Environment` 并更新 `process.env`（`getSecret` 照旧读 `process.env`，保存后立即生效）；标记文件 `secret-markers.json`（`userData` 下）存 `{ source, saved_at, last4? }`，`last4` 只在保存时、值 ≥ 8 位才记；末 4 位对不上或变量没了时清标记；标记写失败回滚 HKCU 和 `process.env`；清除只清自己存的（`not_owned` / `not_set`）；密钥值不回传、不进日志 / 事件 / 标记文件；modules.md §3 同步。IPC 在 UI-03b。main `1b34694`，测试 104 个文件 / 1904 个 | 3 | 基础层开发 | 已合入 | #126 | `1b34694` |
| T-107 | 模块 3：给 `powershellUserEnv()` 补测试（T-088 #126 评审跟进）：挪到内部文件 `secrets-powershell.ts`；mock `spawn` 断言启动参数和脚本文本里没有密钥值、值只在 stdin 里；名字拼进脚本前按白名单再核一次，不在白名单直接拒、不启动 PowerShell；Windows 默认路径（不注入 `userEnv`）保存再清除全程同样断言；接口不变，modules.md §3 同步。UI-03b 之前合入。main `7419998`，测试 105 个文件 / 1912 个 | 3 | 基础层开发 | 已合入 | #128 | `7419998` |
| T-089 | 模块 1：`testConnection({ provider, model? })`（界面 `provider:test`，IPC 在 UI-03b）：只发一个极小请求（`max_tokens: 1`、关思考、不重试），经 `reserve` 预占并计入台账，记在主管名下（`role: "supervisor"`、`requirement_id: "provider_test"`、`ticket_id: null`，不加新角色）；预算不够返回 `budget_exhausted`、不发请求，不报成连接失败；其余失败按 `no_secret` / `auth_failed` / `quota_exhausted` / `rate_limited` / `network` / `config_error` / `http_error` 返回，不抛错；modules.md §1 同步。main `529d67c`，测试 109 个文件 / 1992 个 | 1 | 基础层开发 | 已合入 | #132 | `529d67c` |
| T-108 | 模块 4：`initRepo` / `initialCommit` 的 `identity` 改成 `{ name?, email? }`，至少给一项，只写给了的那几项、只写本仓库 `.git/config`，报错仍是固定文案；并入 N2：`initialCommit` 先校验文件和身份再写 `.git/config`，拒绝时不改配置，补回滚测试；modules.md §4 同步。main `0374bb3`，测试 109 个文件 / 2003 个 | 4 | 基础层开发 | 已合入 | #133 | `0374bb3` |
| UI-03b | 模块 12 模型配置：密钥项、向导、「测试连接」；`secret:*` 和 `provider:test` IPC（UI-07 复用）；依赖 T-088（#126）、T-089（#132）、T-108（#133），都已合入。main `d019cff`，测试 114 个文件 / 2099 个 | 12 | 界面与诊断开发 | 已合入 | #143 | `d019cff` |
| T-106 | 模块 12 退出时显示「正在退出」（T-105 跟进）：主进程开始退出收尾时经新 IPC `app:quitting`（主进程 → 渲染进程，不带内容）通知一次，窗口已销毁就跳过、不影响退出；preload `onQuitting`；渲染进程在内容区标题栏下显示中性横幅 + 转圈，固定文案「正在退出…」，不是遮罩；Windows / Linux 点关闭时窗口先不关，等收尾结束统一关，重复点关闭不重复发起（`createWindowCloseHandler`）；`backend-switcher.ts` 来源不明的占位后端重连按 cwd 解析补注释和测试（#130 评审小项）；modules.md §12 同步。main `c691bf2`，测试 112 个文件 / 2038 个 | 12 | 界面与诊断开发 | 已合入 | #137 | `c691bf2` |
| T-110 | 模块 6：远程 git 超时（`REMOTE_GIT_TIMEOUT_MS` 120s）+ git 接 signal（远程 / 本地只读立刻 kill，写命令只在执行前检查，只读加 `--no-optional-locks`）；`GitTimeoutError`；close 回查不吞取消；收回 `mergeCommitContaining` 公开导出；输出上限与 execFile 一致（每流 64 MiB，超出 kill 报错）。main `dc573d5`，测试 115 个文件 / 2126 个 | 6 | 执行层开发 | 已合入 | #145 | `dc573d5` |
| T-111 | 模块 1：`testConnection` 补测试（T-089 评审跟进）：请求途中取消抛 AbortError、记一条 `ABORTED` 台账并释放预占；401 报错带密钥时台账事件里没有密钥；429 记入全局退避状态；modules.md §1 写明测试连接遇到 429 会触发全局退避。只加测试和文档，不改行为。main `6b11d11`，测试 112 个文件 / 2057 个；跟进 #141（`5906e4c`）：modules.md §1 改为 429 只记入共享退避状态、不阻塞后续请求，补「退避期内再测照常发出」测试，main `5906e4c`，测试 112 个文件 / 2058 个 | 1 | 基础层开发 | 已合入 | #139、#141 | `6b11d11`、`5906e4c` |
| T-112 | 模块 9：9 调 6 的 `merge` / `sync` / `close` ×2 / `diff` ×2 都带 `stop()` 的 signal（T-102b #136 评审跟进），被中止时原样抛 `signal.reason`，不上报、不改状态；sync 中止前已处理的变化照常应用；T-102b 用例名「C3」「C4」改成描述性名字；modules.md §9「收尾要多久」去掉 150 秒 / 记录数 × 30 秒，复核桌面退出 35 秒不用改；合入后取 diff 被中止时靠 `merge_followup` 标记由 takeOver 补发 `interface_changed`（9 / 10 / 组合根可选接口追加，已批准）。main `918c49d`，测试 116 个文件 / 2179 个 | 9 | 编排层开发 | 已合入 | #144 | `918c49d` |
| T-109 | 界面：`App.status.test` 重新连接失败用例偶发失败（flaky），定位并修稳（UI-03a #130 评审跟进）。根因：sonner 点 action 默认关掉 toast（200ms 后卸载），「复制详情」把错误 toast 关了，末尾断言能否通过取决于测试是否在 200ms 内跑完；`notifyError` 的复制按钮 `preventDefault`，复制后错误 toast 留着，测试改看 `data-removed` 标记、不靠时间。另补退出组合测试：stop 挂住 + 收尾中点关闭 + 到 `QUIT_STOP_TIMEOUT_MS` 放行窗口、只退出一次（假计时器）。main `aae7037`，测试 115 个文件 / 2127 个 | 12 | 界面与诊断开发 | 已合入 | #147 | `aae7037` |
| T-114 | 模块 3 / 4：配置向导（T-113）的底层支持：3 新增 `writePricing(path, pricing, opts?)` 与 `WRITABLE_PRICING_FILE`（只写 `pricing.json`，`PricingSchema` 校验 + 像密钥的值检查，和 `writeConfig` 共用原子写入）；4 新增 `nested_repo`：`checkRepo` 的 git 项、`initRepo`（不建目录、不 init）和提交类修复都识别「在另一个 Git 仓库里面」，`rev-parse` 失败时逐层 lstat 找 `.git`。main `10d9e00`，测试 116 个文件 / 2149 个 | 3、4 | 基础层开发 | 已合入 | #148 | `10d9e00` |
| T-122 | 模块 7：`review()` 的 signal 也透传给 6 的 `checks` / `diff`（6 的 T-102a / T-110 起支持请求级超时与取消）；`ReviewPrSource.checks` / `diff` 加可选 `{ signal }`，给了 signal 才传第二参、没给仍只传 `pr_id`；在途中止由 6 抛 `signal.reason`、7 原样抛，6 没理会 signal、取消后才返回时 7 丢弃结果并抛，两种情况都不再读 diff / 不调模型；补 5 条测试；modules.md §7 同步 | 7 | 执行层开发 | 已合入 | #158 | `b620fdc` |
| T-125 | Windows 测试基线（新增 `docs/test-baseline.md`）：测量时 main `10ac6e3`（118 文件 / 2205 测试）；全量并发跑 163 条失败，串行交叉验证后确定性失败 **55 条 / 21 文件**（其余 108 条为 5s 超时 / EBUSY 负载噪声，不计入）；#170 起按 T-123 实测更新为 **47 条 / 19 文件**（全量 122 文件 / 2268 条 = 2200 过 + 61 失败 + 7 skip）；固化门禁三条（build/typecheck/lint/format:check 全绿、受影响包串行对比、新增失败=0）与平台守卫按模块分摊清单，消除进度在本文件登记 | 全模块 / 测试基线 | 审查官 | 已合入 | #160、#170 | `60b9a66`、`0d132e8` |
| T-115 | 模块 9：写入范围 glob 支持 `[...]` 字符类（语义同 minimatch）。锁的重叠判定、代表路径、独占区域判定都按字符类处理：`[abc]` / `[a-c]` / `[!a]` / `[^a]` 能匹配的字面量判为重叠（`src/[ab].ts` 与 `src/a.ts` 不再同时派），代表路径取字符类里能匹配的字符（`src/[p]ackage.json` 判进独占区域）；未闭合的 `[`、空类和非法字符类（如 `[z-a]` 反向区间）按字面量、四个入口都不抛（评审 P1，避免 `tryLock` 每轮重抛卡住调度）；补 D16 / D17 / D18 调度用例（`[z-a]`、`[a-\d]` 各一条：`dispatchOnce` 正常返回该单、再 kick 不重复派不重复抛），modules.md §9 同步。main `10ac6e3`，本单新增 7 条测试（`scheduler.test.ts` 158 条全过），受影响包 `packages/scheduler` 串行 2 文件 / 160 条全过 | 9 | 编排层开发 | 已合入 | #157 | `4b113e8` |
| T-118 | 模块 2：保留期自动清理（已知缺口：`purgeExpired()` 全仓没有生产调用方，30 天保留期从不生效）。`openStorage` 新增 `purge_interval_ms`（默认 24 小时，0 关闭）：打开写库先清一次（补停机期间过期数据），之后定时清；定时器 `unref()`、`close()` 清掉；失败只经 `logger.warn` 记日志、不挡启动；只读连接不自动清理；`purgeExpired()` 接口和语义不变。评审 P1 跟进：两条定时器用例改用假计时器（`advanceTimersByTimeAsync`），新增 unref 断言（spy `setInterval` 抓 60 秒句柄、`hasRef() === false`）。遗留：生产 `openStorage` 未传 `retention_days`，配置值接线要 12/组合根把 `loadConfig` 挪到 `openStorage` 之前，建议另开跟随单 | 2 | 基础层开发 | 已合入 | #156 | `2ca7a99` |
| T-127 | 模块 12：右面板「动态」标签（UI-04～06 最小一块）：接现有 `group_message` 做 Agent 活动流——头像 +「发送方 → 接收方 · 类型 · 时间」、超 3 行折叠、按单过滤、贴底自动滚 /「回到最新」、底部状态行（取快照 `prs` 的在跑单）、空状态；未读小点：面板关着或停在概览时来新消息，标签与标题栏右面板开关亮小点，打开动态即已读，按项目记已读、切项目不误亮；P2 评审跟进：切项目时 `setTicketFilter("all")` 重置（保留防御性 `effectiveTicketFilter`），强调色收口到 `ActivityDot` 组件。如实登记的偏差：桌面端 `UI_EVENT_TYPES` 白名单还没有 T-085 `ticket_status_changed`，本单不改后端，状态行暂用快照 `prs`；`group_message` 没有 receiver 字段，接收方按类型推。renderer 34 文件 / 225 条全过；`packages/desktop` 串行 514 条 = 502 过 + 11 条 T-125 基线失败 + 1 skip | 12 | 界面与诊断开发 | 已合入 | #159 | `cb52c7e` |
| T-121 | 模块 6：`diff` 加复制检测 `-C`（已知缺口：6 用 `git diff -M` 不带 `-C`，复制出来的文件查不出旧路径）。本地三处 git 调用（name-status / numstat / patch）统一 `-M -C`；复制文件按 `status: "added"` + `old_path` 报（`STATUS` 已有 `C → added` 映射），`DiffSchema` 不加 `copied` 枚举、types 零改动；新增内部 `patchBlockOf`，只保留目标路径的 patch 块（`-M -C -- <源> <目标>` 会同时输出源文件块）；只检测本 diff 里改动过的源文件，不加 `--find-copies-harder`；补 3 条真实 git 用例（100% 复制 / 部分复制带 hunk / 未改源复制不检出）；modules.md §6 同步。`packages/pr` 串行 7 文件 / 159 条 = 146 过 + 13 条 T-125 基线失败，新增失败 0 | 6 | 执行层开发 | 已合入 | #161 | `60274be` |
| T-116 | 模块 9：等锁防饿死（已知缺口：大写入范围的单等锁时可能一直被小范围单抢先）。新增并导出 `LOCK_WAIT_AGING_ROUNDS = 2`；`Entry.lock_wait_rounds` 登记 0、`tryLock` 失败 +1、派出 / 离开 pending / 出队三处清 0；`dispatchOnce` 的候选单若与「已等 ≥2 轮且未派出」的 pending 单锁冲突（`scopesOverlap`）则本轮让路，等待者须 pending、依赖 ready、非预算续跑、未被 offpeak 压住；无等待者时派单顺序、返回值、并发、反压逐字节不变；补 4 条用例（顺序回归、D19 防饿死、D20 不冲突不让路、D21 多 aged 等待者按入队序），测试从导出常量取轮数；modules.md §9 同步。`packages/scheduler` 串行 163 过 + 1 条 T-079 已登记 flaky，新增失败 0 | 9 | 编排层开发 | 已合入 | #162 | `5d558e6` |
| T-128 | 模块 12：生产 `openStorage` 不传 `retention_days`（T-118 遗留，`diagnostics.retention_days` 配置值接不进模块 2，30 天保留期只能按默认清）。`startBackend` 把配置存在性检查 + `loadConfig` 提到 `openStorage` 之前，`retention_days` 取 `config.diagnostics.retention_days` 显式传入（模块 2 的 `StorageOptions.retention_days` 已存在，接口不动）；配置缺失 / 坏 JSON 在建库前抛 `ConfigError`，`cleanupPartial()` 对 storage 可空、不泄漏锁也不留半成品库；测试钉住「没配显式传 30、配 7 传 7」和「缺配置 / 坏 JSON 不调 `openStorage`、不生成库文件」；modules.md §2 / §12 同步。`packages/desktop` 串行 53 文件 / 516 条 = 504 过 + 11 条 T-125 基线失败 + 1 skip，新增失败 0 | 12 | 界面与诊断开发 | 已合入 | #163 | `f44c45b` |
| T-119 | 模块 4：`isUnsafeGlob` 的 `..` 判定收窄到路径段（已知缺口：任何含 `..` 都判不安全，`a..b.txt` / `src/a..b.ts` 这类合法文件名进不了权限清单、也不能申请越界写）。只有 `..` 作为完整路径段才不安全；整段 `..`、组内（花括号 / extglob / 字符类）的 `..`、`.` 段、空段、绝对路径、盘符、反斜杠、`!` / `#`、组里 `/`、备选 `.` 仍全部拒绝（宁严勿宽）；`packages/sub-agent/src/permissions.test.ts` 同步移掉 ESCAPES 里 `src/a..b` 一条并加两条断言（跨模块测试改动，已在群报备）；补 `a..b.txt` 安全、组内 `..` 仍不安全、能申请扩大范围用例；modules.md §4 同步。受影响包 `workspace + sub-agent + scheduler` 串行 491 条 = 470 过 + 17 条基线失败 + 4 skip，新增失败 0 | 4 | 基础层开发 | 已合入 | #164 | `140d1a4` |
| T-123 | 模块 6：Windows 超时 / 中止 / 输出超限结束整棵进程树（已知缺口：T-110 起 `kill` 只杀直接子进程，ssh 等孙进程会残留）。新增 `endProcessTree()`：Windows 走 `taskkill /PID <pid> /T /F`（stdio ignore、windowsHide、unref，taskkill 起不来才退回 `child.kill()`），POSIX 保持 SIGTERM → 5s → SIGKILL 逐字节不变；`kill()` 三条路径都接上；测试新增 2 条 Windows 用例（git 经 sh 别名派生 node 孙进程，超时 / abort 各一条断言孙进程被结束、不残留，`finally` 兜底 taskkill）；modules.md §6 / §9 同步。`packages/pr` 串行 161 条 = 147 过 + 14 失败（11 条负载噪声单文件复跑转绿、3 条与 T-125 基线同名同数）→ 新增失败 0；`git-timeout.test.ts` 22/22 全绿，T-125 基线里该项目 7 条 EBUSY 消失 | 6 | 执行层开发 | 已合入 | #165 | `b9459e5` |
| T-117 | 模块 10：重启接管失败单的下游不再一直 `waiting`（已知缺口：`takeOver` 里 adopt / enqueue 失败只进 `report.failed`，`blockedBy` 只看 `escalated` / `fields_invalid`，失败单的下游照样交 9，9 不认识依赖 → 永远 `waiting`）。接回顺序改成按依赖拓扑交付（DFS + 栈防环，无依赖边时仍「先 adopt 再 enqueue」原序）；失败单记 `failedIds`，直接 / 间接下游本轮不交 9、进 `held`（`blocked_by` 直接依赖）并 `holdOnce` 通知一次，下次接管重试成功后照常接回；补 3 条用例（adopt 失败→下游 held 且父先子后、二次接管不重复通知且恢复后接回、enqueue 失败且子单排序更早时仍先父后子）；modules.md §10 同步。`packages/supervisor` 串行 4 文件 / 105 条全过，新增失败 0 | 10 | 编排层开发 | 已合入 | #166 | `8974181` |
| T-120 | 模块 4：`checkRepo` 识别仓库默认分支，去掉「只支持 main」的 v1 限制（a 单）。识别顺序：`origin/HEAD`（本地有同名分支且有提交）→ 本地 `main` → 当前检出分支（有提交）→ null；`main` 项语义改为「有可用的默认分支」，`no_main` 时 `current` / 分支名截断 / 不含路径 / 只读 / `gitEnv` / 超时都保持；新增 `default_branch` 字段，空仓库、not_git、nested 路径为 null；补 3 条默认分支用例；modules.md §4 同步。遗留（b 单，已报备）：组合根 `create-default-deps` 仍硬编码 `main`、12 层只读横幅 / 准备页文案仍是「main 分支」，按 b1（组合根 + 6 集成分支起点）/ b2（12 层文案）跟随。`packages/workspace` 串行 190 条 = 171 过 + 15 条基线失败 + 4 skip，新增失败 0 | 4 | 基础层开发 | 已合入 | #167 | `ef3f5cf` |
| T-131 | 模块 6：`diff` 复制块按解引号后的路径匹配（T-121 评审 P2，中文 / 空格 / 引号文件名）。新增 `unquoteGitPath`（`\nnn` 八进制、`\"` / `\\` / `\n` / `\t` 等转义、代理对）与 `blockTargetIs`（普通 / 空格名快速路径 + 解引号路径兼容 `core.quotePath` 两种取值），解不出时仍安全 fallback 整段；同单带上 T-123 两条 P2：`taskkill` 改绝对路径 `%SystemRoot%\System32\taskkill.exe`（拿不到 env 才退回命令名，起不来仍回退 `child.kill()`）、Windows 用例时间余量放宽到 8s / 12s / per-test 40s；补中文文件名复制用例（patch 只留复制块、不含源文件改动），普通 diff 路径不变；modules.md §6 记引号 / 换行文件名的已知局限。`packages/pr` 串行 163 条 = 160 过 + 3 条基线失败，新增失败 0；`git-timeout.test.ts` 22/22 全绿 | 6 | 执行层开发 | 已合入 | #168 | `6629892` |

编排层第二批需求单为 T-035～T-042；T-044、T-045、T-047 是执行层跟进单；T-046 由编排层改派给执行层。

### 已知缺口

- 模块 2 / 11（T-055）：需求单 `fields` 按设计原样存取、不脱敏，诊断包导出永远不能原样带上 `fields`。已由 T-056 的回归测试锁住。
- 已解决（T-116）：大写入范围的单等锁时不会一直被小范围单抢先——等锁 ≥2 轮的 pending 单与冲突新单让路；无等待者时派单顺序不变。
- 模块 9（T-039）：`priority: deferred` 只看闲时开关，不看预算紧张程度。
- 模块 8（T-038）：接口变更说明（interface notes）v1 不持久化：只在进程内存和预算暂停的 `ResumeToken.interface_notes` 里，进程重启后还没带给编码池的说明会丢。
- 模块 9：文件名本身带通配的独占区域（如 `**/*.d.ts`、`**/*.lock`）判断时仍只取一个代表路径，可能漏判。
- 已解决（T-115）：模块 9 的写入范围 glob 已按 minimatch 语义处理 `[...]` 字符类（锁的重叠判定、代表路径、独占区域判定），未闭合的 `[` 按字面量。
- 已解决（T-119）：`isUnsafeGlob` 只把 `..` 作为完整路径段才判不安全，`a..b.txt` / `src/a..b.ts` 这类文件名可以写进权限清单、也能申请扩大写入范围；整段 `..`、组内（花括号 / extglob / 字符类）的 `..`、`.` 段、空段、绝对路径、盘符、反斜杠、`!` / `#`、组里 `/` 仍全部拒绝。
- 模块 8（T-038 评审 / T-053）：文件名自带 `[]()*` 等字符（如 `app/[id]/page.tsx`）无法临时申请，需拆单时放进 `write_scope`。
- 模块 10（T-040）：意图判断调用也预生成 requirement_id（模块 1/2/3 的台账、call_log 和 call_completed 都要求必填），要改需另开单动 1/2/3 接口和迁移；不是需求的 1:1 消息也会在调用日志和台账里留下一个未登记的需求号。
- 模块 10（T-040）：追问项目后，去掉项目名和虚词仍剩至少 2 个字就当新消息处理，判断较粗，可能误判。
- 模块 10（T-040）：未注入 `listFiles` 时不查裸目录；`persistAndDispatch` 入队中途抛错会半批入队；`pending` 是全进程共用变量，并发会抢（v1 只有一对一对话，可接受）。
- 模块 10（T-040）：1:1 历史 v1 不持久化：主管只通过注入的 `notifyUser` 回 1:1，追问项目时暂存的需求只在本进程内存里，重启即丢。
- 模块 9（T-046）：用户在 GitHub 手动合并而 GitHub 没给合法的 `merge_commit_sha`（40 位小写十六进制）时，不发 `interface_changed`（不用 `targetHead()` 兜底），只调 `onError`。
- 模块 9（T-046）：合并日志不持久化，重启后不从 2 恢复（`TicketRecord.merge` 没有 sha 和改动文件），重启后基线定不了的单按 T-035 保守重审。
- 模块 9（T-046）：没补发成功的 `interface_changed` 待补发列表只在进程内，重启即丢。
- 模块 10（T-041b，Q-E）：重启补跑上报处理在 `takeOver` 里同步做，每次启动最多 5 张，其余进 `held`、通知用户，下次启动再补；上报很多时要重启多次才处理完。
- 模块 10（T-041b，Q-G）：重拆时不清被取代单的旧 worktree，留在磁盘上。
- 模块 10（T-041b）：旧单的 `write_scope` 里有首尾空白条目的，T-041b 起 `loadTicket` 复查不过，按 `fields_invalid` 处理（不接回、要人工重拆）。
- 模块 10（T-041b）：关旧 PR 的重试（30 秒、2 分钟、10 分钟）只在进程内，进程退出即停；重启时从关旧 PR 这一步接着做，但重试计数从头算。
- 模块 10（T-041b）：`notifyUser` 失败只记警告，那条通知就丢了（上报处理的标记照常写，重启不会重发）。
- 模块 10（T-041b）：没有需求原文（`requirement_text`）的旧单上报后不能自动重拆，只交用户。
- 已解决（T-062）：12 有高风险 PR 放行 / 拒绝界面与 IPC（`pendingHighRisk` / `decideHighRisk`）；没人裁决的高风险 PR 仍一直扣着（安全的默认）。
- 模块 9 / 10（T-041c，Q-4）：放行只在进程内，不跨重启；重启后重新扣住、通知用户再放行一次。
- 模块 9（T-041c，Q-7）：被扣着的高风险单一直占着写入范围锁（依赖清单属于独占区域，会挡住别的依赖类单），也算进 `pending_prs`，扣多了会触发反压暂停（暂停通知里写明其中几张在等裁决）。
- 已解决（T-064）：9 有定时 `sync()`（默认 60s）+ 对账；GitHub 上手动合并 / 关闭被扣的 PR 一轮内生效。
- 模块 8 / 组合根（T-041c）：重启补判取 diff 出错也按高风险，可能误扣。
- 已解决（T-065）：6 的 DiffFile 带 `old_path` 后，8 / 组合根带 `old_path` 的改名只在新旧路径有一个是依赖文件时才算高风险，不再一律算；没有 `old_path` 的改名（旧数据）仍按兜底算高风险。
- 已解决（T-121）：6 的 `diff` 统一 `-M -C`，复制出来的文件按 `added` + `old_path` 报（不加 `--find-copies-harder`，`DiffFile.status` 仍没有 `copied` 枚举）。
- 已解决（T-064 N6 + T-065）：9 的 `inExclusiveZone` 经 8 的 `isDependencyFile`；T-065 合入后依赖文件名不区分大小写，`Package.json` 也算独占区域。
- 模块 10（T-041c）：高风险通知「同一 PR 只通知一次」、待裁决清单 `pendingHighRisk()` 都只在进程内，重启后重新通知一次。
- 模块 10（T-041c）：拒绝后关 PR 失败（`high_risk_close.state = unconfirmed`）的重试只在进程内；重启后不接着重试，PR 可能一直开着，要用户到 GitHub 上关。
- 模块 9（T-041c，v1 接受）：依赖文件按文件名匹配后，任意子目录的 `package.json` / 锁文件都算独占区域，碰到它们的单不能并行（monorepo 各子包改依赖的单只能排队），并发降低。
- 模块 10（T-041c）：拒绝时关 PR 之后 9 的拒绝没生效（PR 中途换了，`stale_pr`）：发 `ticket_warning(high_risk_reject_not_applied)`、通知用户「PR 已关、裁决未生效」，要用户对新 PR 重新裁决，不自动重试。
- 已解决（T-064）：拒绝时 `already_merged` 仍抛错留给用户看集成分支；定时 sync / 对账会把扣着的单记成 `merged` 并放锁。`adopt` 找不到 open PR 但有 merged 记录时按手动合入处理（B2）。
- 组合根（T-041a → T-041b）：依赖已上报（未被取代）或 `fields_invalid` 的单，T-041b 起重启时进 `held`、通知用户一次；依赖接管失败（`failed`）的单仍不进 `held`，9 不认识它，依赖它的单会一直 `waiting`。
- 模块 9（T-041a）：`adopt` 接回的单复投数是估的：评审复投数从 0 记起（9 只用它报上报的 `resubmit_counts`，8 的复投上限按事件日志算），冲突复投数按 worktree 轮次估。
- 组合根（T-041a）：`fields_invalid` 的「只通知一次」只在同一进程内去重；每次重启都会再发一条 `ticket_warning(fields_invalid)`，跨重启去重由桌面端做（T-062，按单号 + 警告码去重）。
- 组合根（T-041a / T-063）：一次组装对应一个仓库（v1）；T-063 起 12 的主进程已接 `assemble`。
- 组合根（T-041a）：派单查当前 PR 用 2 的 `prStore().list()` 全量过滤，PR 记录多时偏慢（v1 可接受）。
- 已解决（T-053）：中途写入范围申请里的路径曾按 glob 原样批准，文件名本身带通配符（如 `docs/**`）会批成整个目录可写；现在申请路径带通配字符一律拒绝。
- 已解决（T-038）：合并成功后收尾出错（`merged_but`）不再把 `merged` 改成 `escalated`，状态保持 `merged` 并另发 `escalated(merged_but)`。
- 已解决（T-048，#47）：写入范围重叠判断展开花括号（`src/{a,b}.ts` 与 `src/a.ts` 算重叠），独占区域按多个代表路径判断（`src/**/*.json` 命中 `**/package.json`）。

- 模块 9（T-064）：定时同步只在进程内；重启后 `takeOver` 结束、`startSyncLoop` 之后才开始，停机期间变化在第一轮补上。
- 已解决（T-067）：模块 9（T-064，Q-4）定时同步失败只进 `syncState()` / `onError`、不通知用户；桌面端已经 IPC `sync:state` 显示同步状态，鉴权停 / 限流 / 连续失败在界面上可见（仍不推通知）。
- 模块 9（T-064，Q-5）：还在 8 手里（没 `submit`）的单的 PR 被用户在 GitHub 合入 / 关闭时，9 不处理，等 8 交出后由合并报错上报。
- 模块 9（T-064，Q-2）：账号级限流窗口只挡定时同步，不挡合并循环和显式 `sync()`。
- 模块 9（T-064，Q-7）：独占区域只对依赖文件走 `isDependencyFile` 不区分大小写；在不区分大小写的文件系统上，非依赖文件只有大小写不同时仍可能被并行写。
- 已解决（T-066）：6 的 sync 中途出错也带出已收集变化；close PATCH 失败时 GET 远程（已合入不误标 closed）。
- 模块 10（T-064，Q-8）：关 PR 的重试仍然只在进程内。

- 已解决（T-066 + T-042）：6 的 `merge` 已支持 `expected_head`；10 的 `mergeMain` 合入时传入当前 head。
- 已解决（T-042）：9 对 `SyncPartialError` 先应用 `changes`，限流退避 / 鉴权停定时同步看 `cause`。
- 已解决（T-070）：高风险待裁决只计入 9 的待合并 PR 数（`pending_pr_limit`），不再计入主管待办 `supervisor_backlog.pending`，两条反压不再重复触发；主管待办照样经 `pendingHighRisk()` 展示。
- 模块 10（T-042）：`INTEGRATION_DIFF_MAX_CODEPOINTS` = 200000，待实测。
- 已解决（T-066）：7 / 10 发 `review_backlog` / `supervisor_backlog` 时 `requirement_id` / `ticket_id` 为 null，trace 新开。
- 模块 12（T-067）：测试没锁住脱敏顺序（先把环境变量里的密钥值替换成 `[REDACTED:变量名]`，再跑 `redact(text, "light")`），也没锁住 `serveSyncState` 的 `clearInterval`。定时器要等应用退出才停，关窗口时不停；没有窗口时会跳过，没有危害。不开单。
- 已补测试（T-076）：模块 6 check-runs 响应里没有 `total_count` 时，按已收到的条数算，当页之后不再翻页（行为不变，只补测试）。
- 模块 12（T-073）：桌面端暂用 Electron 43.8.0（better-sqlite3 尚无 Electron 44/ABI 149 预编译），上游出了再升。
- 模块 12（T-073）：开发用 better-sqlite3 12.11.1，打包用 12.12.0 electron-v148 预编译（lib/ 逐字节相同，仅 SQLite 版本不同）。
- 已解决（T-127）：右面板「动态」标签已接 `group_message`（按单过滤、滚动、折叠、未读小点、状态行）；T-085 `ticket_status_changed` 仍未进桌面端 `UI_EVENT_TYPES` 白名单，状态行暂用快照 `prs`，等 UI-05 步骤条统一接。
- 模块 11 / 12（UI-09）：诊断导出只有「最近 24 小时」一键入口；按单张单 / 需求 / 时间段选择、`eval_task` 人工补填、SWE-bench JSONL 导出都还没接（11 的接口已支持，T-126 登记）。
- 模块 12（UI-07）：设置弹层目前只有只读设置 + 密钥 + 模型向导；设计稿 7 个标签里的通用 / 项目 / 模型 / 预算 / 诊断 / 关于和可编辑写回（`writeConfig` / `writePricing` + reload 排队）未做（T-126 登记）。

- 模块 10（T-117 后）：未注入 `adopt` 的 `awaiting_adopt` 场景，失败单的下游仍会交 9 卡 `waiting`（同类缺口的未覆盖分支）；成环时可能子先父、环内失败的下游已先交付，交 9 处理。

### 不对应需求单的 PR

| 内容 | PR | 合入提交 |
| --- | --- | --- |
| 骨架：TS monorepo（pnpm workspace，14 个包） | #1 | `d5f921f` |
| 文档：整体设计 v3.1 接口决定 | #2 | `edb0fe7` |
| 文档：modules.md 模块 11 接口约定 | #12 | `4120b0d` |
| 文档：总开发进度（本文件）；整体设计 §18 schema 版本改为 v1.1 | #17 | `205a37d` |
| 仓库基础设施：pnpm 12 `allowBuilds`（新 worktree 直接 install 可编译 better-sqlite3）+ `.gitattributes` 统一 LF 检出（T-124） | #153 | `10ac6e3` |

## 更新规则

- 代码 PR 不需要改本文件（2026-10-18 起）：单号、模块、测试数写在 PR body，避免多张 PR 同时改本文件末尾的行互相冲突。
- 合并人（蓝色大肥鱼）合入后统一出 bookkeeping PR：补各行「已合入 / PR 编号 / 合入提交」，并更新文件头的 main 哈希、测试数和日期。
- 没有登记的 PR 不算完成；进度以 PR 与合入提交为准。
