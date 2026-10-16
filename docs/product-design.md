# BakaCoding 笨蛋编程助手 整体设计

版本 3.1（接口决定）· 2026 年 10 月 17 日（UTC+8）· 采用 MIT 协议的开源项目

> 本文是 BakaCoding 的整体设计，依据 [分析与设计](bakacoding-analysis-and-design.md) 和 [设计决策与待办](bakacoding-design-backlog.md) 重写。现阶段只做整体设计，不划分开发切片。**当前处于设计阶段，尚无可运行代码**；性能、规模和效果都需要实测验证。文中不写吞吐、速度、价格数字，配置默认值都是初始值，待实测；需要时引用 [Flash 并发研究](bakacoding-flash-concurrency-research.md) 中带来源的事实。

## 1. 定位

BakaCoding 帮助个人开发者推进大型软件工程。核心是 **Flash 编码池**：多个高速 Flash 模型以低思考档位并发编码。由多个旗舰模型组成评审组：主管模型（必填）负责拆单和最终裁决，其余成员组成评审池，只做 PR 评审。每张需求单配一个副 Agent，负责开 PR、评审和复投。通过评审的 PR 经合并队列有序合并。

对外说法：**评审把关和受控合并，测试与 CI 交给用户现有工具。**

## 2. v1 范围

- **CI 不在 v1 范围内**：用户自行配置 CI 和远程 git。BakaCoding 不跑编译、lint 或测试，也不管 runner。
- v1 中 Flash 和副 Agent 都**不执行代码**。
- 用户仓库配了 CI 时，副 Agent 可以读取 GitHub check 结果（可选），失败算不通过。
- 不做语言适配：导入项目时按清单文件识别语言，结果只作为评审和切单的上下文；没有镜像，也没有测试命令。

## 3. 核心流水线

```
用户 ⇄ 主管 Agent（评审组，主管固定最高思考档）
   │ 拆工程 → 写入范围互不重叠的需求单             ▲ 复投超限的单上报主管重拆（同一需求最多 2 次）
   ▼                                               │
每张需求单 → 一个副 Agent（随需求单水平扩展）
   ├─ 按单设计 Flash 权限 → 临时 Flash 代理（写完即销毁）→ 补丁
   ├─ 推到工作分支并开 PR（或建本地 PR 记录）→ 一次评审
   └─ 不通过 → 带评审意见原地复投（评审不过最多 3 次）
                 │ 通过
                 ▼
     合并队列：排队 → 按依赖顺序 → 合并前检测冲突 → 合入集成分支
     （有冲突就基于最新集成分支复投，最多 2 次；
       基线前进且涉及的接口或依赖有变 → 重新评审，不计复投）
                 │
                 ▼
     合入 main 前：主管审集成分支整体 diff；配了 CI 的须读到集成分支为绿
     合入 main：pipeline.main_merge = user（默认）| supervisor
```

## 4. 需求单

需求单仿照派子任务时的自然语言消息，写清以下内容：

- 目标
- 背景与上下文
- 改动范围
- 完成标准
- 回报内容
- 接口声明（**必填**；来源：[NP-Bench（arXiv 2610.07261）](https://arxiv.org/html/2610.07261)、[Specification Gap（arXiv 2603.24284）](https://ar5iv.labs.arxiv.org/html/2603.24284)）、上下文包
- 优先级 `priority`：`normal`（默认）或 `deferred`，只有 `deferred` 的单走闲时；与闲时开关配合使用（第 13 节）。`priority` 只管排期，与思考档位无关

两类复投计数是运行时状态，记在 PR 记录里，不写进需求单。依赖已合并的需求单才放行。并发需求单的写入范围互不重叠，由调度器用逻辑锁保证，副 Agent 授予 Flash 的写权限必须落在本单写入范围以内（见第 6 节）；依赖清单、锁文件、全局配置、迁移、公共类型属于独占区域，单独排队。

## 5. Flash 编码池

- 每张需求单开一个临时 Flash 代理，写完即销毁。默认思考档 `low`，用户可按项目或单次运行配置；思考档位取值 `off` / `low` / `high` / `max`，角色配置的 `low` / `high` / `max` 直接对应，不使用数值档位；配置字段 `effort` 与服务商无关，取值 `off` / `low` / `high` / `max`；映射由模块 1 的服务商能力表负责：DeepSeek → `output_config.effort`，OpenAI 兼容服务商 → `reasoning_effort`（[serialize.ts](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-alpha.5/packages/llm/llm-deepseek/src/serialize.ts)）；服务商不支持的档位降到最高可用档，并记一条警告，不报错；映射以能力表为准，配置里不设 `effort_map`。
- 默认模型：DeepSeek V4.1-Flash（`deepseek-flash`）。开发阶段所有角色都用 DeepSeek Flash，一个 key 跑通整条流水线（开发配置，不是产品设计，见第 10 节）。
- 并发数 N 按研究文档第 5.5 节的公式计算，默认上限 8，硬上限 64（初始值，待实测）；超过硬上限须用户手动改配置。
- 并发数只计编码阶段的单；PR 等待合并时不占编码槽位。编码槽位统一由调度器（模块 9）管理，编码池本身不设并发上限。
- 每单一个 Git worktree，从确认基线创建，路径为 `.bakacoding/worktrees/<ticket_id>-r<n>`（`n` 为轮次），该目录写进 `.gitignore`。
- 协调器统一用令牌桶限流（由模型接入适配层实现，见第 15 节），令牌桶按账号全局共享，所有 Flash 代理和所有项目合用一个桶，不按 key 分；遇到 429 时指数退避加抖动，启动时平滑放量。服务商限额按账号计算，多开 key 不增加额度（见研究文档第 1–2 节）。
- 提示词把稳定的公共前缀放在前、需求单放在后，以提高前缀缓存命中率。同一项目的系统提示、工具定义、架构约束组成逐字节固定的公共前缀，不放时间戳和单号；DeepSeek 新版缓存须完整匹配前缀单元才算命中（https://api-docs.deepseek.com/guides/kv_cache ）。
- **后备做法**：确需中途改提示时，新内容作为一条 system 消息追加到历史末尾，工具定义只增不改，开头不动，以保留前缀缓存（与 harness 对 V4.1-Flash 的做法一致：[models.ts](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-alpha.5/packages/llm/llm-deepseek/src/models.ts)、[serialize.ts](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-alpha.5/packages/llm/llm-deepseek/src/serialize.ts)）。

## 6. 受限工具层

- **权限清单格式**：三级——读写、只读、拒绝；未列出的一律按拒绝处理（默认全部拒绝）。数据格式为 `[{ glob, level }]`，`level` 取 `rw`（读写）/ `ro`（只读）/ `deny`（拒绝），未匹配任何条目的路径即拒绝（参考 [Copilot CLI 本地沙箱文档](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/understanding-local-sandboxing)）。
- **Flash 的权限由副 Agent 按单现场设计**：副 Agent 读完需求单后决定给哪些工具、可读写哪些文件、能否新建、删除或重命名。写权限只能在本单写入范围以内。Flash 中途需要更多权限时向副 Agent 申请，副 Agent 当场批准或拒绝；但申请的写权限超出本单写入范围时，副 Agent 不能直接批，要交给调度器重新加锁，加锁失败就上报主管。
- **文件工具**（对齐 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（tag dsh-v0.2.1-alpha.5） 完整模式，不以 Minimal 模式为基线；见 [工具目录](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-alpha.5/docs/tool-catalog.md)）：`read`（`file_path`、`offset`、`limit`）、`write`（整文件写）、`edit`（`old_string`、`new_string`、`replace_all`）、`glob`、`grep`，共五个，取代原先的读、写、列目录、搜索四个工具。与「只给基础编码工具、不给 shell」一致。
  - `edit` 为字面量唯一匹配替换：换行统一为 LF 后精确匹配，不做模糊匹配；匹配 0 次报 `FS_EDIT_NOT_FOUND`，匹配多次且未设 `replace_all` 报 `FS_AMBIGUOUS_EDIT`（[fsio.ts](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-alpha.5/packages/fs/fs-local/src/fsio.ts)）。
  - 先读后写与陈旧版本检测：未读过就改报 `FS_NOT_OBSERVED`，读过后文件已变报 `FS_STALE_VERSION`（[error.ts](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-alpha.5/packages/fs/tool-fs/src/error.ts)）。四种错误码和错误文案照搬 harness。
  - 匹配或检查失败时文件不动，错误作为工具结果返回给模型重试。
- **系统外层硬边界**（副 Agent 也不能越过）：只能在本单工作区内；不给 shell、网络、git；密钥和 `.env` 类文件不放行。路径按真实路径解析，处理符号链接。
- 权限清单（含中途的申请、批准和拒绝，每条带时间和理由）写入 PR 记录，评审时一并审查；需记录以供诊断包使用（第 18 节）。
- 依赖类需求单：Flash 只改清单文件，不装包，评审时标为高风险；实际安装由用户自己的 CI 负责。

## 7. 副 Agent 与 PR 抽象

- 一单一个副 Agent：写编码提示词、设计 Flash 权限、开 PR、发起评审、复投。副 Agent 之间不互审。
- **PR 抽象**，一套接口两种实现：
  - 有 GitHub：推到工作分支后直接开真 PR；合并队列轮到且冲突检测通过后，由 BakaCoding 主动在 GitHub 上把 PR 合入集成分支。
  - 没有远程仓库：建本地工作分支，加一条 PR 记录（diff、需求单、评审结论、权限清单、复投计数；每轮的 diff、评审结论、不通过原因和带回的评审意见按轮次保留，需记录以供诊断包使用（第 18 节）），合并就是本地合进集成分支。
  - 接口：Flash 产出的补丁由 PR 抽象 `commitPatch(ticket_id, worktree_path, patch) → sha` 转成 commit；`diff` 返回 `{ base_sha, head_sha, files: [{ path, status, additions, deletions, patch }] }`。
  - GitHub token 由配置与预算模块的 `getSecret("GITHUB_TOKEN")` 读取；读不到时只建本地 PR 记录。
- **本地记录为准**：状态、复投次数、评审结论都以 BakaCoding 自己的记录为准，GitHub PR 只是同步出去的展示和合并通道。两边不一致时以本地为准，差异记入日志。用户在 GitHub 上手动关闭或合并 PR 时，同步回本地，交给主管 Agent 处理。

## 8. 评审与复投

- 每张单的唯一质量闸门是副 Agent 发起的一次评审，对照需求单审 diff：
  - 是否完成需求
  - 是否越出需求单范围
  - 有没有明显 bug
  - 是否违反架构约束
- **评审输入固定**为「diff + 需求单 + 精简摘要」，不带完整仓库。依据 [SWE-PRBench（arXiv 2603.26130）](https://arxiv.org/html/2603.26130v1) 中“精简上下文效果更好”的结论；该基准测的是上一代模型，只采用这一结论。判不过的门槛**待实测**，由诊断包统计评审精度后再定（第 18 节）。
- 原独立验证器已删除，职责并入这次评审。
- **评审模型按负载分配**：评审组中除主管以外的旗舰模型组成评审池，每张单分给当前空闲的模型；同一张单复投后仍由原来的模型评审；被限流的模型自动跳过。评审池全忙或全部被限流时，单子排队等待，不交给主管。
- 不通过就原地复投，把评审意见带回给 Flash；回灌内容先截断，并标注为不可信输入。
- **复投自动升档**（默认开启）：第 1 次复投仍用 `low`，第 2、3 次用 `high`（初始值，待实测）。不自动换模型，换模型由主管决定。
- 复投上限分开计数：评审不过最多 3 次，合并冲突最多 2 次，任一超限就上报主管重拆。同一需求重拆 2 次（`pipeline.resplit_limit`）仍不通过，就停下来交给用户。
- 基线前进后，如果本单涉及的接口或依赖有变化，重新评审一次，不计入复投次数。
- 记录复投率和评审不过的原因。

## 9. 合并队列与反压

- 合并队列只做三件事：排队、按依赖顺序合并、合并前检测冲突。
- 有冲突就基于最新集成分支原地复投；副 Agent 不自己解冲突。
- 没有文本冲突但基线已前进时，按第 8 节判断是否重新评审：涉及的接口或依赖有变化就重评，不计入复投次数。
- 接口按「生产者 → 消费者」排序：接口变更先合，消费方在新基线上开工。
- **接口变更推送**：调度器合并成功后发出 `interface_changed` 事件（新基线、改动的接口列表、摘要、受影响的在途单），副 Agent 订阅：把摘要附进本单下一轮上下文包；本单在受影响列表中（写入范围或接口声明与本次改动有交集）则触发重审。来源：[NP-Bench（arXiv 2610.07261）](https://arxiv.org/html/2610.07261)、[Specification Gap（arXiv 2603.24284）](https://ar5iv.labs.arxiv.org/html/2603.24284)。
- 默认合入集成分支。**合入 main 前的检查**（两种模式都必须先完成）：主管审一遍集成分支的整体 diff；用户仓库配了 CI 的，必须读到集成分支的 check 为绿才能合。
- 合入 main 由配置 `pipeline.main_merge` 决定：
  - `user`（默认）：集成分支攒够并通过上述检查后，主管通知用户自行合入。
  - `supervisor`：检查通过后由主管直接合入 main，合完通知用户。
- **反压**：按评审积压和 API 并发调整编码并发，并记录原因。评审积压由评审池通过 `review_backlog` 事件发给调度器，调度器不直接调用评审池。阈值如下（均为初始值，待实测）：
  - 评审容量 = 评审池成员数 × 每个成员的并发评审数（默认 2）；成员数为 0 时按 1 个成员计算，即容量为 2。
  - 评审积压超过容量 2 倍：编码并发减半；超过 4 倍：暂停派新单。
  - 积压回落到容量以下后，每 5 分钟加 1 个编码槽位，直到回到 N。
  - 主管待办队列（入口、拆单、上报、高风险 PR）也计入反压，积压超过 `pipeline.supervisor_backlog_limit`（默认 10）时暂停派新单。
  - 成本触顶时降并发。

## 10. 评审组与主管模型

- 不设单一主 Agent，由多个旗舰模型组成评审组。正式版要求评审组用旗舰模型，配置里允许换成别的模型。
- **开发阶段配置**（只是开发配置，不是产品设计）：所有角色都用 DeepSeek Flash，靠三样东西区分角色：
  - 思考档位：主管 `max`，评审池和副 Agent `high`，编码池默认 `low`，复投按第 8 节升档。
  - 角色提示词：每个角色各写一套。
  - 权限：只有编码池能写代码；评审池只能读 diff 和需求单；主管负责拆单和裁决，也不写代码。
  - 其他服务商的旗舰模型以后通过适配层补丁接入。
- **项目决策记忆**：主管为每个项目维护一份决策记忆，拆单时附进需求单的上下文包（依据 [NP-Bench（arXiv 2610.07261）](https://arxiv.org/html/2610.07261) 关于决策记忆的结论）。
- **职责划分**：主管负责拆单和最终裁决（成员分歧、上报的单、高风险 PR、合入 main 前的集成分支审查）；评审池成员只做 PR 评审，不拆单。
- **成员数**：默认 1 个主管加 2 个评审池成员（初始值，待实测），可配置；成员数为 0 时由主管兼任评审。
- **必须设置主管模型**：缺失时配置校验报错、不启动；主管固定用最高思考档。模型没有 max 档时用它能用的最高档，启动时提示一次并记入日志，不报错。
- **没有分歧环节**：评审池里每张单只由一个模型评审；上报单由主管裁决，主管的结论就是最终结论。
- **用户只对接主管 Agent**：指提需求和人工介入：新需求、上报单的处理、GitHub 上的手动操作都经过主管，由主管拆单并重新投入编码池。项目导入、设置、Git 侧栏这类配置操作不经过主管，用户直接在界面上做（第 16 节）；导入完成后主管在 1:1 对话里告知用户。
- 副 Agent 模型可配置（`sub_agent`），开发阶段用 DeepSeek Flash `high` 档；它负责写编码提示词和设计 Flash 权限，对质量影响大。
- 配置字段结构（**草案**，下面的模型取值是开发阶段配置，正式版评审组换成旗舰模型；字段名尚未定稿，所有数值都是初始值，待实测；仓库 `config/models.example.json` 已改为新角色结构（`supervisor`、`review_board`、`sub_agent`、`coder`），其余字段尚未写入示例；API key 不写进配置，见第 15 节）。角色平级放在 `roles` 下：`supervisor`、`review_board`、`sub_agent`、`coder`；`review_board.members` 只放评审池成员，主管作为评审组裁决人单独配置。`supervisor` 必填、`effort` 固定 `max`，由模块 3 加载配置时校验。`$schema_version` 为 `bakacoding.model-config.v1`，尚未发布，当前结构即 v1 定义。`pipeline.concurrency_max` / `pipeline.concurrency_hard_max` 限制同时在编码阶段的需求单数，反压调的也是这个数；等待评审和等待合并的单不占编码槽位，由反压按评审积压限制（第 9 节）：

```jsonc
"roles": {
  "supervisor": {                 // 必填；评审组裁决人，单独配置；由模块 3 加载时校验，缺失即报错、不启动
    "provider": "deepseek",
    "model": "deepseek-flash",
    "effort": "max"               // 固定 max；没有 max 档时用最高可用档并提示
  },
  "review_board": {
    "members": [                  // 只放评审池成员，不含主管；默认 2 个；0 个时主管兼任评审
      { "id": "reviewer-1", "provider": "deepseek", "model": "deepseek-flash", "effort": "high" },
      { "id": "reviewer-2", "provider": "deepseek", "model": "deepseek-flash", "effort": "high" }
    ],
    "review_assignment": "least_busy",
    "sticky_on_resubmit": true,
    "skip_rate_limited": true
  },
  "sub_agent": {                  // 可配置；开发阶段为 DeepSeek Flash high
    "provider": "deepseek",
    "model": "deepseek-flash",
    "effort": "high"
  },
  "coder": {                      // 编码池
    "provider": "deepseek",
    "model": "deepseek-flash",
    "effort": "low",
    "resubmit_effort": ["low", "high", "high"]  // 第 1/2/3 次复投的档位
  }
},
"budget": {
  "daily_micro_usd": null,        // 必填，整数微美元；首次运行填写，缺失不启动；不预设默认值，示例仅供参考
  "per_ticket_ratio": 0.05        // 每单上限 = 每日预算 × 5%，含复投
  "offpeak_preference": false     // 闲时开关，默认关；只影响 priority=deferred 的单
},
"backpressure": {
  "reviews_per_member": 2,        // 评审容量 = 成员数 × 本值；0 成员按 1 计，容量为 2
  "halve_at": 2,                  // 积压 > 容量 × 2：编码并发减半
  "pause_at": 4,                  // 积压 > 容量 × 4：暂停派新单
  "recover_step": 1,              // 回落到容量以下后每次加 1 个槽位
  "recover_interval_min": 5
},
"pipeline": {
  "concurrency_max": 8,           // 同时在编码阶段的需求单数上限，N 按公式计算；反压调的也是这个数
  "concurrency_hard_max": 64,     // 超过须手动改配置
  "resubmit_limits": { "review": 3, "conflict": 2 },
  "resplit_limit": 2,             // 同一需求重拆上限，超出交给用户
  "supervisor_backlog_limit": 10,  // 主管积压超过即暂停派新单
  "main_merge": "user"            // user（默认）| supervisor
}
```

## 11. 安全

- Flash 只能在本单工作区内工作，不给 shell、网络、git；密钥和 `.env` 类文件不放行。
- 发给云模型的内容先做脱敏检查；创建 worktree 时不带入未跟踪的密钥文件。
- 仓库文件、评审意见和 check 结果都按不可信输入对待，其中的指令不提升权限。

## 12. 持久化与恢复

- 本机协调服务使用 SQLite（WAL），单一写入者加租约，配合幂等键。
- **事件总线**：模块之间通过进程内事件总线解耦，下层发事件、上层订阅；存储模块订阅全部事件写入事件日志。用到总线不算模块之间的依赖，只有直接调用才算。模块划分和事件清单见 [功能模块](modules.md)（四层共 13 个模块）。
- **总线语义**：进程内异步分发；支持 `*` 通配订阅（存储模块用它订阅全部事件）；span 由发布方生成，`trace_id` 按需求生成。
- **事件格式**：事件类型、常量和 zod schema 放在共享类型包 `@bakacoding/types`（第 15 节）。公共字段（`trace_id`、`span_id`、`parent_span_id`、`ts`、`seq`）放在事件顶层，事件自己的字段放进 `payload`；`ts` 为 ISO 8601 UTC 时间，必须以 `Z` 结尾；`seq` 单调递增。事件里的 `role` 取 `supervisor` / `reviewer` / `sub_agent` / `coder`，`reviewer` 指单个评审成员（配置 `roles.review_board.members[]` 的一项），`review_board` 指整个评审组。完整事件清单见 [功能模块](modules.md)。
- 重启后能识别在途的 Flash 调用、未推送的补丁和已开的 PR，不重复开 PR。
- PR 抽象的本地记录也存在这里。
- 每单的基线 commit 和上下文包要保存到可复现为止，合并结果（是否冲突、基线是否变化、是否重新评审、最终是否合入）和读到的 CI check 结果也要落库；需记录以供诊断包使用（第 18 节）。

## 13. 成本与预算

- **每日预算必填**：不预设默认值，示例仅供参考；首次运行时必须填写，和主管模型一样，缺了就不启动。
- 每单上限默认为每日预算的 5%（初始值，待实测），含复投的花费；每单另设输出上限。
- 触顶时降并发。
- **闲时偏好开关** `budget.offpeak_preference`：默认关；打开后预算紧张时，`priority=deferred` 的单优先等到闲时再跑，由调度器读开关和优先级决定（DeepSeek 闲时价格为高峰的一半：https://api-docs.deepseek.com/quick_start/pricing ）。v1 只做这一个开关。
- 费用台账按缓存命中/未命中、闲时/高峰分开计价（DeepSeek 命中与未命中、闲时与高峰价格不同，同上链接）。
- 费用台账按需求单（含复投）、副 Agent、评审组分列；每次调用的费用也要单独记，并标明是否属于复投，需记录以供诊断包使用（第 18 节）。
- **金额单位**：费用一律用整数微美元（1 美元 = 1,000,000 微美元）；每日预算字段为 `budget.daily_micro_usd`。
- **单价表**：单价和优惠时段放在 `config/pricing.json`，数值取自 DeepSeek 官方价格页（https://api-docs.deepseek.com/quick_start/pricing ），文件内注明链接和查阅日期。规则：`peak_hours_utc` 为 `[["01:00","04:00"],["06:00","10:00"]]`，只在周一至周五生效；`cn_public_holidays` 为 `["YYYY-MM-DD"]` 列表，按北京时间的日期认定，列表里的日子全天算闲时；该列表人工维护，每一年都写明来源（国务院办公厅发布的放假通知）；列表里缺的日子按高峰价算；`source` 字段写价格页原文和查阅时间（价格页原文：周一至周五 UTC 01:00–04:00、06:00–10:00 为高峰，不含中国法定节假日；其余时间含周末和中国法定节假日全天为闲时）。
- **台账落库**：台账通过共享类型包中的 `LedgerStore` 接口落库（条目用对应调用事件的 `event_id` 做幂等键，按 UTC 日期汇总），由存储模块实现，启动时注入给配置与预算模块，后者不直接依赖存储模块。模型接入层每次调用前先查 `budgetState()`。
- 成本主要由并发数、单张需求单的输入上下文和复投次数决定。

## 14. 日志与观测

结构化事件日志记录每次调用的角色、模型、档位、完整提示词和输出、token、缓存命中、耗时、结果、是否因限流重试，以及主管拆单时的推理摘要。其中角色、完整提示词和输出、限流重试、推理摘要是新增项，需记录以供诊断包使用（第 18 节）。日志还记录反压决策原因、本地与 GitHub 记录的差异。每张单从需求单到合并全程可追溯。事件经事件总线写入事件日志（第 12 节）。

- **追踪字段**：每个事件带 `trace_id`、`span_id`、`parent_span_id`，一个需求对应一条 trace，每张单是其中一个 span。字段命名向 OpenTelemetry GenAI 语义约定靠拢；该约定仍处于 Development 阶段，只做映射，不直接采用（https://opentelemetry.io/docs/specs/semconv/gen-ai/ ）。

- **落库前轻脱敏**：写入日志前先去掉 key、`.env` 内容和疑似密钥；导出诊断包时再做完整脱敏（第 18 节）。
- **保留期限**：完整提示词和输出默认保留 30 天（`diagnostics.retention_days`，初始值，待实测，可配置）；过期后只留摘要和统计（token、费用、结论）。用户标为“收进评测集”的单永久保留。

```jsonc
"diagnostics": {                  // 草案
  "retention_days": 30            // 完整提示词和输出的保留天数；收进评测集的单不受限
}
```

## 15. 技术栈与执行环境

- 技术栈：React + TypeScript 界面，Node.js + TypeScript 本机协调服务，SQLite + WAL，桌面壳 Electron。
- 桌面界面：壳子模板用 electron-vite-react（https://github.com/electron-vite/electron-vite-react ），组件用 shadcn/ui（https://ui.shadcn.com ），图标用 lucide（https://github.com/lucide-icons/lucide ）。
- 不采纳 Vercel AI SDK：模型调用由模型接入适配层负责，避免出现两套模型接入层。
- 执行环境：默认本机 Git worktree（见 `config/execution.example.json`）。
- **模型接入适配层**：按协议做适配，v1 先实现 Anthropic 兼容和 OpenAI 兼容两种协议；DeepSeek 默认走 Anthropic 兼容接口 `https://api.deepseek.com/anthropic`（与 harness 一致，见 [config.ts](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-alpha.5/packages/llm/llm-deepseek/src/config.ts)），OpenAI 兼容留作备选。官方代码 Agent 评测使用 DeepSeek Harness（[NVIDIA 模型卡](https://build.nvidia.com/deepseek-ai/deepseek-v4.1-flash/modelcard)）。新服务商以补丁形式加配置接入，不改核心。限流、计费和思考档位映射都放在适配层。
- **服务商能力表**：适配层为每个服务商维护一张能力表，负责把配置字段 `effort` 映射到各服务商字段（DeepSeek → `output_config.effort`，OpenAI 兼容服务商 → `reasoning_effort`），记录兼容接口忽略的字段，思考档位映射到 `output_config.effort`，不依赖 `cache_control` 和 `budget_tokens`，需要串行调用工具时由本地保证（例如 DeepSeek 的 Anthropic 兼容接口忽略 `budget_tokens`、`cache_control` 等：https://api-docs.deepseek.com/guides/anthropic_api ）。
- **代码复用许可**：可搬 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（tag dsh-v0.2.1-alpha.5） 的 MIT 代码（`applyLiteralEdit` / `countOccurrences`、文件工具 schema 与错误文案、DeepSeek 请求序列化和档位逻辑），保留其版权和许可声明，并在 NOTICE 中注明来源和 tag dsh-v0.2.1-alpha.5（仓库尚无代码，搬代码时再建 NOTICE）。harness 中 MPL-2.0 许可的组件不引入。
- **模块划分**：四层共 13 个模块，含模块 0 事件总线，见 [功能模块](modules.md)。
- **工程结构**：TypeScript monorepo（pnpm workspace），每个模块一个包，另有共享类型包 `@bakacoding/types`（只依赖 zod，放事件类型、常量和 zod schema，所有模块包都依赖它）。测试用 vitest，lint 用 eslint，格式用 prettier。各角色提示词模板放在 `packages/config-budget/prompts/`。
- **配置校验**：配置 JSON 里不加注释字段；schema 严格校验，遇到未知字段直接报错。示例配置中的预算是示例值，说明写在 README 的配置章节和 zod 的 `.describe()` 里。
- **模型调用上下文**：模型接入层的 `call()` 带必填参数 `ctx: { role, requirement_id, ticket_id | null, is_resubmit, trace }`；主管等没有单号的调用 `ticket_id` 填 `null`。
- **API key**：优先从环境变量 `DEEPSEEK_API_KEY` 读取；本地配置文件 `config/secrets.local.json` 只作备选，该文件必须写进 `.gitignore`。key 不写进仓库，也不写进配置示例。读密钥统一用配置与预算模块的 `getSecret(name)`，目前读 `DEEPSEEK_API_KEY` 和 `GITHUB_TOKEN`。

## 16. 界面

界面只做对话，分三栏（项目导入、设置、Git 侧栏这类配置操作直接在界面上做，不经过主管，见第 10 节）：左栏是对话列表，中间是当前对话，右侧边栏默认关闭。

```
| 左栏          | 中间                     | 右侧边栏（默认关闭，跟随当前群）
|---------------|--------------------------|-------------------------------
| [主 Agent]    | 当前选中的对话           | 编码池：并发·限流·反压（一行）
| -- 项目群 --  |                          | -- Git（本项目）--
| # 项目 A      | 主管 1:1：可发消息       | 当前分支 / 集成分支状态
| # 项目 B      |   + 设置入口             | [合入 main]（main_merge=user）
|               | 项目群：只读             | -- PR 列表（本项目）--
|               |   ▸ 需求 1（话题，可折叠）| PR 状态 · 复投次数 → 需求话题
|               |   ▸ 需求 2               |
```

- **主管 1:1 对话**：左栏最上面是主 Agent（即主管）的图标，点开进入对话。这是用户唯一能发消息的地方（提需求和人工介入），与“用户只对接主管 Agent”一致（第 10 节）。1:1 对话不分项目，提需求时说清楚是哪个项目，没说的由主管来问。
- **项目群**：用户在界面上直接导入项目；导入完成后开一个群，主管在 1:1 里告知用户。群名用项目名，排在主管图标下方。群里是主管和这个项目所有副 Agent 的对话。
  - 按需求分组：每个需求一条可折叠的话题，派单、副 Agent 回报、评审结论、复投记录都归在对应话题里。
  - 用户只能看、不能发消息，要插手就回主管对话里说。Flash 调用的细节默认折叠在对应副 Agent 的消息里。
- **中间区域**：显示当前选中的对话。
- **右侧边栏**（默认关闭），跟着当前选中的群，只显示这个项目的内容；在 1:1 对话里打开时，显示最近操作过的项目。打开后分两块：
  - Git 区：当前分支、集成分支状态、合入 main 的入口（`main_merge=user` 时用这个入口）。
  - PR 列表：每条显示状态和复投次数，点开跳到所在群里对应的需求话题。
- **编码池状态**（并发、限流、反压）不单独做页面，放在右侧边栏顶部，占一行。
- **配置**：做成主管对话里的设置入口，不单独做配置页。
- **诊断包导出入口**：右侧边栏 PR 列表（单张需求单）和主管对话（单张单、一个需求或某个时间段），见第 18 节。
- **视觉风格**：简约、极简；Agent 图标用简约设计的机器人。
  - 颜色：中性色为主，只用一种强调色，强调色只用来标状态（运行、复投、冲突、已合并）；不用渐变，不用装饰性阴影。
  - 分区：靠留白和细分隔线，不堆叠卡片；默认跟随系统的深色 / 浅色模式。
  - 图标：统一线性风格；主管和副 Agent 用同一个简约机器人图标，主管多一个小标记区分（如头顶一颗星）。
  - 动效：只保留状态变化时的淡入淡出。

## 17. 主要风险

- **R1（待实测）**：低档位、不能执行代码的 Flash，加上一次模型评审，能否产出合格代码？v1 不跑测试和 CI，质量全压在评审上。官方没有公开 `low` 档的编码 benchmark；非思考模式在 SWE-bench Verified 上比 High 低约 5 个百分点（V4-Flash 官方数据，见研究文档第 3 节）。这些公开评测用的是上一代模型，结论不能直接套到 V4.1-Flash 上；V4.1-Flash 官方报告（[技术报告](https://arxiv.org/pdf/2609.19969.pdf)、[HF 模型卡](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash)）没有代码评审类评测；官方编码成绩是最高档测的，我们的评审用 high、编码用 low，实际表现以实测为准。实际评审精度要等诊断包（第 18 节）统计出来后再评估。对策：记录复投率和评审不过的原因；用一个开源 Python 仓库当真实代码（不跑测试），观察复投率、评审质量和冲突率。
- **R2（待实测）**：工具条件与官方评测不同。官方在有 shell 的 Minimal 模式下测（harness [sdk-minimal 配置](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-alpha.5/packages/bundle/sdk-minimal/cordis.patch.yml) 开放持久 bash，关闭文本 read/write/edit），我们不给 shell，官方成绩不能直接当预期；以诊断包（第 18 节）实测为准。
- **拆单质量**：编码池能否并发，取决于主管能否拆出写入范围不重叠、足够小、自洽的需求单。
- **语义冲突**：写入范围不重叠只能防止文本冲突，挡不住语义冲突；靠需求单的接口声明、生产者→消费者排序、基线变化后的重新评审，以及合入 main 前主管审集成分支整体 diff（配了 CI 的须为绿）来缓解；v1 不执行代码，集成分支仍可能出现只有构建才能发现的问题。

## 18. 诊断包导出

用于排查问题和离线分析。离线分析不是验收；现阶段不做验收设计。

- **导出粒度**：单张需求单、一个需求（含它拆出的所有单）、某个时间段。**一个包只放一个项目**：按时间段导出时必须选择项目；跨项目就分别导出多个包，合并评测集交给离线工具。入口在右侧边栏的 PR 列表或主管对话（第 16 节）。
- **包的形式**：一个 zip，内含 JSONL 和原始文件。
- **内容**：
  - 需求单原文，以及主管拆单时的推理摘要。
  - 每次模型调用的角色、模型、档位、完整提示词和输出（超过保留期的只有摘要和统计）、token 数、缓存命中、耗时、是否因限流重试。
  - 副 Agent 给出的权限清单，以及中途的申请、批准和拒绝。
  - 每一轮的 diff、评审结论和不通过原因；复投次数，以及每次复投带回的评审意见。
  - 合并结果：是否冲突、基线是否变化、是否重新评审、最终是否合入。
  - 读到的 CI check 结果（如果有）。
  - 费用：每次调用的费用，按需求单汇总，复投产生的费用单独列出。
  - 基线 commit，以及复现这张单所需的上下文包。
- **离线分析与评测集**：
  - 每张单带一个结果标签：通过、复投后通过、超限上报、被用户否决。
  - 用户可以把某张单标为“收进评测集”，它的完整记录永久保留（第 14 节）。
  - 可选的 `eval_task` 段：用户把单标记进评测集时，在导出界面人工补填测试名列表和运行命令，存在诊断包的 `eval_task` 段里，运行时不额外采集（v1 不跑测试）；GitHub CI check 里有测试名时可预填作参考。可导出为 SWE-bench 风格 JSONL（转换器，格式见 https://github.com/SWE-bench/SWE-bench ）。
  - 提供重放格式：给定基线 commit、需求单和上下文包，用别的模型或档位重跑同一张单，再对比评审结果。复投率和评审质量都从这里统计。
- **安全**：
  - 落库前已做轻脱敏（第 14 节）；导出前再强制完整脱敏，去掉 key、`.env` 内容和疑似密钥（与第 11 节同一套规则）。
  - 默认只带 diff 和上下文片段；带完整仓库须用户勾选。
  - 包里附一份脱敏报告。
- **格式**：带版本号的 schema `bakacoding-diag/v1`；以后只加字段，不破坏旧包。

## 19. 待定事项

v3.0 为设计定稿，设计上没有待定项。原「待项目负责人确认」各项已由设计负责人定为**已定**：

- 已定：追踪字段 `trace_id` / `span_id` / `parent_span_id`，命名向 OpenTelemetry GenAI 约定靠拢（第 14 节）。
- 已定：`eval_task` 段，导出时人工补填，可导出 SWE-bench 风格 JSONL（第 18 节）。
- 已定：闲时开关 `budget.offpeak_preference`（默认关）与需求单 `priority`（`normal` / `deferred`）（第 4、13 节）。
- 已定：公共前缀逐字节固定（第 5 节）；台账按命中/未命中、闲时/高峰分开计价（第 13 节）。
- 已定：每个服务商一张能力表（第 15 节）。
- 已定：接口声明必填、合并成功后发 `interface_changed` 事件把接口变更推送给在途单（第 4、9 节）；主管项目决策记忆（第 10 节）；评审输入固定（第 8 节）；权限清单三级格式、默认全部拒绝（第 6 节）；桌面界面选型（第 15 节）。
- 已定：文件工具五个（§6）、思考档位取值（§5）、DeepSeek 默认走 Anthropic 兼容（§15）、中途改提示后备做法（§5）、harness 代码复用许可规则（§15）。
- 已定（v3.1）：共享类型包、不支持档位降档加警告、去掉 `effort_map`、`call()` 的 `ctx`、`getSecret`、`commitPatch` 与 diff 结构、PR 抽象依赖配置与预算、`review_backlog` 事件与编码槽位由调度器管理、`LedgerStore` 注入、总线语义、`permission_list` 格式、worktree 路径、时间格式与 `seq`、微美元、vitest / eslint / prettier、提示词模板目录、`pricing.json`（第 5、6、7、9、12、13、15 节）。
- 已定：开发阶段只接 DeepSeek，其他服务商以后通过适配层补丁接入。
- 仍待实测（不是设计待定项）：评审判不过的门槛、R1、R2（第 8、17 节）。
- **不跑 SWE-PRBench**：DeepSeek V4.1-Flash 官方资料中没有代码评审类评测，评审精度靠诊断包实测（第 18 节）。
- **不采纳**：Vercel AI SDK，避免出现两套模型接入层。

其余事项（评审组成员数与模型、无 max 档的处理、分歧规则、默认并发数、复投升档、预算、反压阈值）已于 2026-10-17 定为初始值，见上文各节。

### 后续版本（观察项，v1 不做）

- OpenInference（https://github.com/Arize-ai/openinference ）：追踪属性映射。
- SWE-bench-Live（https://github.com/microsoft/SWE-bench-Live ）：借鉴自动搭环境加验证的流水线。
- SWE-bench Pro（https://github.com/scaleapi/SWE-bench_Pro-os ）：发布前作旗舰评审组的能力参照。
- SWE-smith / SWE-Gym（https://github.com/SWE-bench/SWE-smith 、https://github.com/SWE-Gym/SWE-Gym ）：参考轨迹存储格式。
- Inspect（https://inspect.aisi.org.uk/ ）：以后做评测跑分器时可转成它的 sample。
- assistant-ui（https://github.com/assistant-ui/assistant-ui ）：聊天组件，先做原型评估。
- electron-trpc（https://github.com/jsonnull/electron-trpc ）：主进程与渲染进程间的类型安全 IPC。
- `metadata.user_id` 隔离：调用时带上项目或单号，需先细读 DeepSeek 文档相关一节。
- Landlock 内核沙箱：Linux 5.13 起提供的非特权沙箱，可给进程限定能访问的文件路径；以后允许执行代码时用作外层硬边界（[Linux 内核 Landlock 文档](https://docs.kernel.org/userspace-api/landlock.html)）。
- 符号级写锁：把写锁从文件级细化到函数或类级，以减少并发单之间的锁冲突。

## 变更记录

- **v3.1（2026-10-17，接口决定）**：设计负责人拍板的接口细节同步进来：新增共享类型包 `@bakacoding/types`；不支持的思考档位改为降到最高可用档并记警告（§5）；去掉 `effort_map`，映射以能力表为准；`call()` 加必填 `ctx`；每日预算字段改名为 `budget.daily_micro_usd`（整数微美元），配置 schema 严格校验、未知字段报错，`pricing.json` 加节假日规则（`peak_hours_utc`、按北京时间日期认定的 `cn_public_holidays` 人工维护列表、`source`）；读密钥统一为 `getSecret(name)`（`DEEPSEEK_API_KEY`、`GITHUB_TOKEN`）；PR 抽象新增 `commitPatch`，diff 改为带 base/head sha 和逐文件 patch 的结构，无 token 只建本地记录，PR 抽象依赖配置与预算；评审积压改由 `review_backlog` 事件传给调度器，编码槽位由调度器统一管理；台账经 `LedgerStore` 落库并注入；总线异步、支持 `*` 通配、span 由发布方生成；`permission_list` 格式；worktree 路径；事件公共字段放顶层、自有字段放 `payload`，`ts` 为 Z 结尾的 UTC 时间加 `seq`，写入范围事件带 `request_id`，`escalated` 用 `reason` 四种取值，两个积压事件同为 `{ pending, capacity }`，`role` 取值与评审组对应关系写清，金额用整数微美元；vitest / eslint / prettier；提示词模板目录；`config/pricing.json`（§5、§6、§7、§9、§12、§13、§15、§19）。
- **v3.0（2026-10-17，设计定稿）**：原待项目负责人确认的 5 项与设计负责人新拍板的各项全部定为已定：接口声明必填、合并后发 `interface_changed` 推送给在途单（§4、§9）；主管项目决策记忆（§10）；评审输入固定为 diff + 需求单 + 精简摘要，判不过门槛待实测（§8）；权限清单三级格式、默认全部拒绝（§6）；公共前缀逐字节固定、台账分开计价（§5、§13）；服务商能力表（§15）；`eval_task` 导出时人工补填、可导出 SWE-bench JSONL（§18）；追踪字段向 OpenTelemetry GenAI 靠拢（§14）；`priority` 改为 `normal` / `deferred`，与思考档位无关，闲时开关默认关（§4、§13）；桌面界面选型（§15）；文件工具对齐 DeepSeek Harness 的 read/write/edit/glob/grep 与四种错误码（§6）；思考档位 off/low/high/max 写进 `output_config.effort`（§5）；DeepSeek 默认走 Anthropic 兼容接口（§15）；中途改提示的后备做法（§5）；harness MIT 代码复用与 NOTICE 规则、不引入 MPL-2.0（§15）；新增风险 R2（§17）；配置字段 `reasoning_effort` 改名为 `effort`，与服务商无关，由能力表映射（§5、§10、§15）；配置示例 `config/models.example.json` 改为新角色结构（`supervisor`、`review_board`、`sub_agent`、`coder`）；§10 草案改为同一平级结构（去掉 `review_board.supervisor` 嵌套，`coding_pool` 改名 `coder`），主管必填与固定 max 由模块 3 校验；`concurrency_max` / `concurrency_hard_max` 移到 `pipeline` 下，限制同时在编码阶段的需求单数，反压调的也是这个数，等待评审和等待合并的单不占编码槽位，`resubmit_effort` 留在 `roles.coder`。§19 改为已定清单并新增「后续版本」；Vercel AI SDK 不采纳；不跑 SWE-PRBench。
- **v2.6（2026-10-17）**：同步事件总线和 13 个模块（链接到功能模块文档）；令牌桶按账号全局共享；写明配置操作（项目导入、设置、Git 侧栏）不经过主管。R1 风险改为待实测。标为待项目负责人确认：追踪字段、`eval_task`、闲时开关与 `priority`、固定公共前缀、服务商能力表。
- v2.5：新增诊断包导出。v2.4：简化界面。v2.3：开发阶段模型接入。v2.2：定下各项默认值。v2.1：设计评审修订。v2.0：按整体设计重写。

完整决策记录见 [设计决策与待办](bakacoding-design-backlog.md)。
