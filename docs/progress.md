# BakaCoding 总开发进度

> 上次更新时 main：`e44f4a5` · main 上测试：78 个测试文件、1619 个测试全部通过 · 更新日期：2026-10-18（UTC+8）
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
| UI-01 | 模块 12 设计 token、主题、字体与基础组件（`docs/ui-design.md` §5、§6，`01b15dd`）：§5.1 浅 / 深两套 OKLCH 颜色 token（danger 红与 accent 蓝分开，错误提示改用 danger）；主题跟随系统 / 浅 / 深，偏好存 localStorage，写到 `<html data-theme>`，设置页加主题切换；字体西文 Inter（随包 latin / latin-ext 子集，OFL）+ Segoe UI Variable / 微软雅黑 UI，正文 14px，代码字体栈；间距、圆角、阴影、动效 token，尊重减少动态效果；按钮只留 primary / secondary / danger 三种（34 / 28 高），danger 只能经确认框的 `DialogDangerButton` 用；补 shadcn 组件 Dialog、DropdownMenu、Tooltip、Toast（sonner）、Tabs、Input、Select、Switch、ScrollArea、Collapsible、Command；`StatusIcon`（9 个状态 → lucide 图标，§5.2）；文案表 `lib/copy.ts`（merged「已合入」、合入 main「已合入 main」、复投「重写」），测试搜 `packages/desktop/src` 不得出现旧叫法；新依赖 `radix-ui`、`sonner`、`cmdk`、`@fontsource-variable/inter`；IPC 与布局不变。main `e44f4a5`，测试 78 个文件 / 1619 个 | 12 | 界面与诊断开发 | 已合入 | #93 | `e44f4a5` |
| T-095 | 根目录 `pnpm typecheck` 在干净检出上报 TS6310：根脚本是 `tsc -b --noEmit`，而 TypeScript project references 要求被引用项目能写出声明文件，CLI 的 `--noEmit` 会关掉整张依赖图的 emit；最小修复是把根 `typecheck` 改成 `tsc -b`（与 `build` 相同，会写出 dist）。干净检出（`pnpm install`、无先验 build）根目录 typecheck 通过；回滚 `--noEmit` 后 TS6310 复现；`pnpm build` / `test` / `lint` / `format:check` / `pnpm -r typecheck` 不受影响。README 开发者指南同步说明。 | 工具链 / 12 | 界面与诊断开发 | 待评审 | #96 | |
| T-093 | 界面：IPC `backend:reload` / `backend:reconnect`（同一仓库停起后端，复用 `BackendSwitcher` 的拆旧 / 组装；只在没有编码、评审、合并队列中的单时执行，有在途单排队、空闲后自动重载；重复请求合并；起不来退只读，原因去掉绝对路径和密钥值；`backend:status` 加可选 `reload` 进度；预算当日已用从台账恢复）；modules.md §12 同步 | 12 | 界面与诊断开发 | 待评审 |  |  |

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
- 模块 6 / 8（T-065）：6 用 `git diff -M`、不带 `-C`，复制检测用不到（复制出来的文件按 `added` 报、不带 `old_path`，原文件还在，不影响高风险判定）；`DiffFile.status` 也没有 `copied`。
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
