# BakaCoding 总开发进度

> 上次更新时 main：`11c867d` · main 上测试：22 个测试文件、244 个测试全部通过 · 更新日期：2026-10-17（UTC+8）
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

  class M0,M2,M6,M11,M12,T done
  class M3,M4,M7 doing
  class M1,M5,M8,M9,M10 todo
```

图例：绿色 = 已完成，黄色 = 进行中，灰色 = 未开始。

- 0 事件总线：T-003 已合入。总线的 `initialSeq` 和订阅队列上限随 T-005（模块 2）在 #19 合入，记在 T-005 名下。
- 共享类型包不算 13 个功能模块之一，单列出来。
- 8、9、10（编排层）的第二批需求单还没拆，所以显示未开始。

## 需求单

状态取值：未开始 / 开发中 / 待评审 / 已合入。

| 单号 | 内容 | 模块 | 负责人 | 状态 | PR | 合入提交 |
| --- | --- | --- | --- | --- | --- | --- |
| T-001 | 共享类型：事件、权限清单、LedgerStore 与 zod schema | 共享类型包 | 基础层开发 | 已合入 | #3 | `56cfaca` |
| T-002 | 读配置与读密钥接口（getConfig / validate / getSecret），补齐示例配置 | 3 | 基础层开发 | 已合入 | #5 | `adf612a` |
| T-003 | 事件总线 publish / subscribe | 0 | 基础层开发 | 已合入 | #13 | `ea51630` |
| T-004 | 模型接入层 call / capabilities / rateLimitState | 1 | 基础层开发 | 未开始 | — | — |
| T-005 | SQLite（WAL）与事件落库；另含总线 `initialSeq`、订阅队列上限、`DiagnosticsSource` 移入 types、modules.md 公共字段措辞 | 2 | 基础层开发 | 已合入 | #19 | `95cd3f3` |
| T-006 | 预算台账 recordCost / budgetState | 3 | 基础层开发 | 已合入 | #23 | `14c1698` |
| T-007 | 脱敏函数 redact（light / full） | 3 | 基础层开发 | 已合入 | #6 | `4f20ce0` |
| T-008 | 项目导入与提示词模板 importProject / promptTemplate | 3 | 基础层开发 | 未开始 | — | — |
| T-009 | 工作区 createWorktree / cleanup | 4 | 基础层开发 | 已合入 | #7 | `cdb1ed7` |
| T-010 | 受限文件工具 read / write / edit / glob / grep | 4 | 基础层开发 | 未开始 | — | — |
| T-011 | 三级权限与写入范围申请 applyPermissions（含权限清单写入接口） | 4 | 基础层开发 | 未开始 | — | — |
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
| T-028 | 模块 6 补接口：`commitWorktree`（提交 worktree 全部改动）、`close`（`closed_by` / `close_reason`，sync 不把自己关的当手动关闭） | 6 | 执行层开发 | 已合入 | #25 | `4a2ce07` |
| T-030 | 模块 7 评审池：`review` / `backlog`、CI 失败直接判不过、主管兼任、复投粘性与限流跳过、输出解析重试、`review_backlog` 事件；评审结论类型进 `@bakacoding/types` | 7 | 执行层开发 | 待评审 | 待开 | — |

8、9、10（编排层开发）的第二批需求单还没拆。

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
