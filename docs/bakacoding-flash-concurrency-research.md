# Flash 模型并发编码：性能影响研究与 项目负责人 原始流水线评估

> 研究时间：2026-10-17（UTC+8）。只写查到的事实，每条附来源；查不到的明确写「查不到」。
> 「官方」= 服务商自己的文档；「第三方」= 评测机构、个人实测或博客，可信度低一档，仅作参考。
> 本文是研究，不改计划文档 `bakacoding-analysis-and-design.md`。

## 0. 结论先行

1. **单个 Flash 模型的并发上限一般不是瓶颈。** DeepSeek `deepseek-flash` 每账号并发上限 2500（官方），qwen-flash 北京区 30,000 RPM / 10M TPM（官方）。个人项目真正先碰到的是本机资源（worktree、构建、测试进程）、预算和**评审吞吐**。智谱是例外：官方不公开数值，第三方实测 Flash 类免费模型并发很低。
2. **限流按账号 / 项目算，不按 key。** DeepSeek、Gemini、百炼官方都这样写；智谱有第三方实测佐证。多开 key 不能提高并发。
3. **低档位 / 非思考模式在编码上明显掉分。** DeepSeek 官方公布的 V4-Flash 数据：LiveCodeBench 非思考 55.2，High 88.4，Max 91.6；SWE-bench Verified 是 73.7 / 78.6 / 79.0。`low` 档**查不到**公开 benchmark。
4. **项目负责人 流水线的瓶颈在「两级串行评审 + 每单一个 PR 顺序合并」，不在编码池。** 业界经验一致：并行 agent 的上限是「被接受的评审量」，不是能开多少会话。
5. **建议**：编码池保持并发；评审层改成「先自动检查、后模型评审」，A/B 两审并发或抽样；合并走合并队列；拆单时保证写入范围不重叠；固定提示词前缀，提高缓存命中率。

## 1. 主流 Flash / 快速模型的限流、速度、价格

### 1.1 DeepSeek（`deepseek-flash` = DeepSeek-V4.1-Flash）
- **并发**：每账号 2500 并发（`deepseek-v4-pro` 是 500）。一个请求从发出到响应完成都算一个并发。按账号计算，与用哪个 API key 无关；超过即返回 HTTP 429。扩容可申请，不额外收费。来源（官方）：https://api-docs.deepseek.com/quick_start/rate_limit
- **排队行为**：请求发出后可能要等一会儿；等待期间非流式返回空行，流式返回 `: keep-alive`；**10 分钟内未开始推理，服务器关闭连接**。来源同上（官方）。
- **`user_id` 隔离**：可按 `user_id` 隔离 KVCache 和调度；普通用户所有 `user_id` 合并计算并发。来源同上（官方）。
- **RPM / TPM**：官方页面只给并发数，**查不到** RPM / TPM 数值。
- **价格（每百万 token，美元）**：输入缓存命中 $0.003（闲时）/ $0.006（高峰）；输入未命中 $0.15 / $0.3；输出 $0.6 / $1.2。闲时价是高峰价的一半；高峰为周一到周五 UTC 01:00–04:00 和 06:00–10:00，即北京时间 09:00–12:00 和 14:00–18:00，中国法定节假日除外。上下文 1M，最大输出 384K。来源（官方）：https://api-docs.deepseek.com/quick_start/pricing/
- **缓存**：硬盘缓存默认开启。后续请求与已持久化的「缓存前缀单元」**完全匹配**才算命中；系统会自动识别多个请求的公共前缀并持久化。缓存构建需要几秒；尽力而为，不保证命中；不用后数小时到数天清除。响应里的 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` 可以查看命中情况。来源（官方）：https://api-docs.deepseek.com/guides/kv_cache
- **思考档位**：原生 `low / high / max`；默认开启思考、默认 `high`；`minimal` 映射到 low，`medium` / `xhigh` 映射到 high。可用 `thinking.type=disabled` 关闭思考（非思考模式）。来源（官方）：https://api-docs.deepseek.com/guides/thinking_mode/
- **输出速度**（第三方，Artificial Analysis，基于 DeepSeek 官方 API）：V4.1 Flash（Max）175.9 tokens/s，首 token 1.17s，端到端响应 15.38s；V4.1 Flash（非思考）162.8 tokens/s。来源：https://artificialanalysis.ai/models/deepseek-v4-1-flash 、https://artificialanalysis.ai/models/deepseek-v4-1-flash-non-reasoning 。`low` 档速度**查不到**。另外该页称其「very verbose」，输出 token 偏多，会抵消一部分速度和价格优势。

### 1.2 千问（阿里云百炼 qwen-flash）
- **限流**：华北2（北京）30,000 RPM、10,000,000 TPM；新加坡 / 弗吉尼亚 600 RPM、5,000,000 TPM。快照版 qwen-flash-2025-07-28 在北京区仅 60 RPM、1,000,000 TPM。来源（官方）：https://www.alibabacloud.com/help/zh/model-studio/qwen-flash
- **限流规则**：按主账号合并计算；除 RPM / TPM 外，**请求频率短时间激增也会触发稳定性保护**（报错 `Request rate increased too quickly`），即使总量没到上限。429 是限流，403 是配额耗尽。充值不提高限流。Batch API 不受限流。来源（官方）：https://www.alibabacloud.com/help/zh/model-studio/rate-limit
- **动态限流**：部分模型的 TPM 按月消费分档；表中 qwen3.8-flash 在一档（月消费不超过 10 万元）为 500 万 TPM，百炼托管的 deepseek-v4.1-flash 为 120 万 TPM。来源（官方）：https://help.aliyun.com/zh/model-studio/quota-management
- **速度**（第三方）：Qwen3.8-Flash-Next 51.1 tokens/s，首 token 2.16s。来源：https://artificialanalysis.ai/models/comparisons/deepseek-v4-1-flash-vs-qwen3-8-flash-next
- **价格与缓存**：本次**未查到**具体单价页（官方说明按上下文长度阶梯计费），需要另行核实。

### 1.3 智谱（GLM Flash / Air）
- **并发**：官方不公开固定数值，按账户、模型、用户权益等级动态分配；高峰期有动态限流；在控制台「速率限制」页查看；通用 API 可申请提额，Coding Plan 不支持申请。来源（官方）：https://docs.bigmodel.cn/cn/api/rate-limit
- **第三方实测**：glm-4.5-air 单 key 约 10 并发开始零星 429；Flash 免费模型仅低并发未压测；**20 个 key 共享同一账号并发额度，多 key 不提高吞吐**；平台倾向排队而不是直接拒绝。来源（第三方，个人实测）：https://richertunes.github.io/ai-proxy/model-concurrency-findings/
- **模型状态**：GLM-4.5-Flash 已于 2026-01-30 下线，请求自动路由到 GLM-4.7-Flash；支持 `thinking.type` 开关。来源（官方）：https://docs.bigmodel.cn/cn/guide/models/free/glm-4.5-flash
- **速度和价格**：**未查到**。

### 1.4 Gemini Flash（参照）
- 限流维度为 RPM、输入 TPM、RPD，**按项目计，不按 API key**；任一维度超限即报错；具体数值要在 AI Studio 查看，官方说明「不保证、实际容量可能变化」。另有按消费额的限流，以 10 分钟滚动窗口计（Tier 1 $10、Tier 2 $50、Tier 3 $200），触发时返回 `429 RESOURCE_EXHAUSTED`。Batch API 单独限流。来源（官方）：https://ai.google.dev/gemini-api/docs/rate-limits
- 速度和价格本次未查。

### 1.5 并发时延迟变化
- **查不到**任何服务商公开的「并发数 vs 延迟」曲线。能确认的只有机制：DeepSeek 超限直接 429、限内可能排队（keep-alive，10 分钟未开始推理就断开）；百炼有突发保护；智谱高峰期动态限流。高峰期降速没有官方量化数据。

## 2. 同一 key / 同一模型多路并发的实际影响
- **多 key 无效**：DeepSeek、Gemini（按项目）、百炼（按主账号）官方都明确限额不按 key 算；智谱有第三方实测佐证。项目负责人 设计中「共用同一个 Flash 模型 / API」在限额上等同于「一个账号一个池」。
- **429 的来源**：并发超限（DeepSeek）、RPM / TPM 超限或突发激增（百炼）、消费速率超限（Gemini）、平台高峰动态限流（智谱）。
- **对策**（官方建议加通用做法）：协调器统一限流（令牌桶），所有池任务共享；遇 429 指数退避加抖动；**平滑放量**，避免一次启动 N 个任务（百炼的突发保护）；把成本敏感任务放到闲时（DeepSeek 闲时半价）；可选按服务商分池叠加额度（百炼官方示例：限流后改用备用模型）。

## 3. 低思考档位 / 非思考模式对编码质量的影响
- DeepSeek 官方 V4-Flash 模型卡（https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash）：

| 基准 | 非思考 | High | Max |
|---|---|---|---|
| LiveCodeBench Pass@1 | 55.2 | 88.4 | 91.6 |
| SWE-bench Verified | 73.7 | 78.6 | 79.0 |
| SWE-bench Pro | 49.1 | 52.3 | 52.6 |
| SWE Multilingual | 69.7 | 70.2 | 73.3 |

  注：模型卡标的是 V4-Flash；当前 API 的 `deepseek-flash` 是 V4.1-Flash（见定价页），V4.1 对应的分档成绩**查不到**。都是厂商自报，第三方复现情况未知。
- **解读**：仓库级修复（SWE-bench）上，非思考比 High 低约 5 个百分点；算法型（LiveCodeBench）差距很大。说明「需求单越清楚、越局部，低档越能胜任」；涉及算法和推理的任务，低档风险高。
- **`low` 档**：官方**没有公开** benchmark。有一个第三方 API 复现脚本记录了 low 档请求的 token 行为，但没有质量评分：https://github.com/chatdeepai/deepseek-api-reproducible-tests/blob/main/thinking-mode/live-results-summary.csv 。BakaCoding 要用 low 档，需要自己在样例任务上实测（属于后续工作，本文不设计）。

## 4. 并发代码生成对合并冲突、评审瓶颈的影响与业界实践
- **评审是天花板**：「吞吐上限是被接受的评审量，而不是能启动多少模型会话」；建议在途任务数不超过可评审的 diff 数，并通过单一集成队列合并。来源（第三方指南）：https://continuumcode.ai/guides/multi-agent-development/ 。同类观点：https://superset.sh/parallel-coding-agents 、https://www.sankara.net/ai/effective-coding-agents/book/html/ch-15-coordinating-multiple-agents.html
- **worktree 只隔离文件**：不隔离端口、数据库、缓存、密钥、外部服务，也挡不住语义冲突（来源同上）。
- **冲突数据**（第三方汇总，引 arXiv:2607.04697）：不同 agent 的 PR 对，冲突率约为同一 agent 的两倍；84.4% 的冲突文件是源代码，锁文件和清单只占 3.9%；约 42% 的冲突是结构性的（修改 / 删除 26.8%，同时新增 15.1%），比内容冲突更难解。建议按文件所有权分区、加预留锁，只有高重叠时才串行。来源：https://agentpatterns.ai/workflows/concurrent-agent-pr-merge-conflicts/
- **事前调度优于事后检测**：论文把并行 agent 协调视为调度问题。开工前按声明范围分区，按「生产者 → 消费者」依赖顺序合并；文中实验显示调度方案相比仅检测，冲突明显减少。来源（论文，未同行评审情况未知）：https://arxiv.org/html/2610.07261
- **Claude Code**：subagent 是给父会话跑隔离上下文的子任务并返回摘要；agent teams 有 lead、共享任务列表和互相通信；真正的并行实现通道是各自 worktree 的独立会话。来源（第三方转述）：https://continuumcode.ai/guides/multi-agent-development/ 。Codex 并行任务、Devin、OpenHands 的官方并行实践本次**未逐一核实**。
- **合并队列**：GitHub merge queue 让通过检查的 PR 进入 FIFO 队列；对「目标分支最新 + 前面排队的 PR」构造临时合并组并跑 CI，通过才合并；失败、冲突或超时就出队。来源（官方）：https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue

## 5. 评估 项目负责人 原始流水线

**原设计**：共用同一个 Flash 模型 / API → 每张需求单新开一个临时 Flash 代理，写完即销毁 → 副 Agent A 评审 → 副 Agent B 二审 → 开 PR → 下一轮。

### 5.1 短生命周期代理（写完即销毁）
| 方面 | 优点 | 风险 / 代价 |
|---|---|---|
| 状态隔离 | 每单上下文干净，不受上一单的错误假设和过期信息污染；失败可以直接丢弃重来 | 跨单经验（比如「这个仓库测试要这样跑」）要靠外部知识库传递，不能靠会话 |
| 上下文冷启动 | — | 每次要重新读项目规范、相关代码；输入 token 主要来自这里 |
| 缓存命中 | DeepSeek 缓存按**前缀**匹配、跨请求共享，**与代理是否销毁无关**，命中只取决于请求前缀是否一致（官方 kv_cache 文档） | 如果每个临时代理的系统提示词、项目上下文顺序不固定，或把需求单内容放在前面，前缀就对不上、命不中；缓存还要几秒构建，同时启动的一批请求可能都命不中 |
| 并发 | 无共享状态，天然适合并发 | 同时启动太多会触发突发限流（百炼）或并发上限 |

结论：短生命周期设计**可取**，前提是把「稳定的公共前缀（系统提示 + 项目规范 + 公共代码摘要）」放在最前、需求单放在最后，并让协调器平滑放量。

### 5.2 两级串行评审是否成为瓶颈
设 λ 为需求单到达（编码完成）速率，A、B 的平均评审时长分别为 T_A、T_B，A 和 B 各有 c_A、c_B 个可并发的评审实例：
- 评审层能处理的最大速率 μ = min(c_A / T_A, c_B / T_B)。
- 当 λ > μ 时，队列长度随时间线性增长，大约每单位时间增加 (λ − μ)。编码池越快，堆积越快。
- 原设计里 A、B 各只有一个（c_A = c_B = 1），且「A 审完才给 B」，单单评审延迟 = T_A + T_B，吞吐被 1 / max(T_A, T_B) 锁死。编码池开多大都没用。
- 评审用的模型如果比编码慢（思考档位更高、输入是整个 diff 加上下文），T_A、T_B 往往大于单单编码时间，原设计**几乎一定**会在评审处堆积。这里没有实测数字，是由公式推出的结构性结论。

### 5.3 每单一个 PR 的合并顺序与冲突
- 并发产出的 PR 都基于旧基线；先合的会让后合的过期，需要 rebase、重跑检查，甚至产生结构性冲突（见第 4 节数据）。
- 原设计中「审完开 PR → 下一轮」没有定义合并顺序、rebase 后是否重审，也没有依赖顺序（接口先于调用方）。

### 5.4 改进建议
1. **自动检查在前**：Flash 产出后先跑确定性检查（编译、lint、类型检查、单测、写入范围校验），不过的直接打回，不消耗评审模型。
2. **评审并发化**：A、B 改为评审池（c > 1），不再是单个实例；B 二审可以改为与 A **并行**，或只对高风险单（改公共接口、改独占区域、diff 大）做二审，其余抽样。
3. **合并队列**：所有通过评审的单进入单一合并队列，按依赖顺序合并；每次基于最新主干 rebase 并重跑检查；冲突时在新基线上重派给池，而不是让评审层手工解决。
4. **拆单避冲突**：需求单声明写入范围，调度器保证并发单互不重叠；公共类型、锁文件、迁移这类独占区域串行处理。
5. **背压**：评审队列长度超过阈值时，编码池自动降并发，避免产出堆积、基线过期。
6. **前缀缓存**：固定提示词模板与上下文顺序，用 `prompt_cache_hit_tokens` 监控命中率；成本敏感的批量编码排到 DeepSeek 闲时。
7. **限流治理**：统一令牌桶、429 指数退避加抖动、启动时逐步放量。

### 5.5 单 key（单账号）限流下的合理并发数估算
记：
- C_max：服务商并发上限（DeepSeek 为账号级并发数）。
- RPM_max、TPM_max：每分钟请求数和 token 上限（百炼、Gemini 等）。
- r：单个池任务每分钟发出的请求数（多轮工具调用的代理大于 1）。
- t：单个池任务每分钟消耗的 token（输入 + 输出，按服务商口径）。
- L：单个请求平均在途时长（分钟）。
- W：本机能同时承载的 worktree / 构建 / 测试进程数。
- B：每分钟可承受的花费；p：单任务每分钟花费（按缓存命中率加权的单价估算）。
- μ_review：评审层吞吐（单 / 分钟）；T_code：单张需求单的平均编码时长（分钟）。

则：

```
N_api    = min( C_max / (r × L) ,  RPM_max / r ,  TPM_max / t )   # 只计算该服务商实际有的那几项
N_local  = W
N_budget = B / p
N_review = μ_review × T_code          # 编码产出速率 N / T_code 不应超过评审吞吐
N        = floor( min(N_api, N_local, N_budget, N_review) × s )     # s 为安全系数，如 0.7–0.8，留给重试和突发
```

其中 N_review 这一项通常最小，也最容易被忽略。所有参数都应在运行时实测后再填，本文不给数值。

## 6. 查不到 / 待核实清单
- DeepSeek 的 RPM / TPM 数值、`low` 档的速度与 benchmark、V4.1-Flash 分档成绩。
- 各服务商在并发压力下的延迟变化曲线、高峰降速数据。
- qwen-flash 的价格与缓存计费细节；GLM Flash / Air 的速度、价格和官方并发数值。
- Codex 并行任务、Devin、OpenHands 的官方并行实践文档（本次只引用了第三方汇总）。
