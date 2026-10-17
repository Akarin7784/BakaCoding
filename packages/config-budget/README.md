# @bakacoding/config-budget

模块 3 配置与预算：加载校验配置、读取 API key、预算台账、脱敏函数、项目导入、提示词模板。

## 配置（T-002）

- `getConfig(path)`：读取 JSON 配置并用严格 zod schema 校验（未知字段报错），失败抛 `ConfigError`，进程不应启动。
- `validate(raw) → string[]`：返回错误列表，空数组表示通过。
- `getSecret("DEEPSEEK_API_KEY" | "GITHUB_TOKEN")`：只从环境变量读取，缺失时报错；值不写日志、不进配置。

结构见 `config/models.example.json`：

| 字段 | 说明 |
| --- | --- |
| `roles.supervisor` | **必填**，`effort` 固定 `max` |
| `roles.review_board` | 整个评审组；`members` 不含主管，默认 2 个 `high`；事件/台账里的 `reviewer` 指单个成员 |
| `roles.sub_agent` | 默认 `high` |
| `roles.coder` | 默认 `low`，`resubmit_effort` 默认 `["low","high","high"]` |
| `budget.daily_micro_usd` | **必填**，每日预算，整数微美元（1 USD = 1,000,000）；示例中的 5000000（5 美元）只是示例，不是推荐值 |
| `budget.per_ticket_ratio` / `offpeak_preference` | 默认 0.05 / `false` |
| `pipeline.concurrency_max` / `concurrency_hard_max` | 同时处于**编码阶段**的需求单数（默认 8 / 64），等待评审或合并的单不占槽位 |
| `backpressure.*`、`diagnostics.retention_days` | 默认值取自整体设计 §10、§14 |

示例配置不再含 `effort_map`：思考档位到服务商字段的映射以模块 1 的服务商能力表为准。

## 预算台账（T-006）

- `createBudget({ budget, pricing, ledger, now? })`：`budget` 取配置里的 `budget` 段，`ledger` 是启动时注入的 `LedgerStore`（模块 2 实现，本包不依赖存储）。
- `attach(bus, { onError })`：订阅 `call_completed` 记一笔，`entry_id` 取 `event_id`（重放不重复计费），闲时按事件 `ts` 用 `isOffpeak` 判断；落库失败交给 `onError`（默认 `console.error`），不抛给总线。
- `recordCost(entry)`：手工补记一条 `LedgerEntry`。
- `budgetState(ticket_id?)`：当日（UTC）上限、已花、复投、剩余、`daily_exhausted`，每单上限（每日预算 × `per_ticket_ratio`，向下取整），按角色分列，`offpeak_now`、`offpeak_preference`；传 `ticket_id` 时另带该单累计花费（含复投、不分日期）和 `exhausted`。已花 ≥ 上限即 exhausted。另带进行中调用的预占额（`reserved_today_micro_usd`，单的 `reserved_micro_usd`）。
- `reserve({ ticket_id, amount_micro_usd })`：模块 1 每次调用前预占。已花 + 其他调用的预占 ≥ 每日或每单上限时返回 `{ ok: false, scope }`，否则记下并返回 `release()`。本次预占额不参与自己的判断，所以最多超出一个进行中调用的费用。预占与释放串行执行；预占只在进程内存里。
- `computeCost(pricing, model, tokens, at)`：缓存命中输入、未命中输入、输出分别按单价计，按调用时刻选高峰或闲时价，向上取整到微美元；模型不在 `pricing.json` 里直接报错。

## 项目导入（T-008）

- `importProject(path, opts?)`：只读不写，不要求是 git 仓库。返回 `{ project_id, name, path, language, languages, manifests, has_github_remote }`。
  - 语言：只看项目根目录下的清单文件，按 [`prompts/languages.json`](prompts/languages.json) 的顺序匹配（`*.ext` 按后缀），第一个命中的是主语言，都没命中为 `unknown`。例如有 `tsconfig.json` 是 TypeScript，只有 `package.json` 是 JavaScript。
  - GitHub 远程：读 `.git/config`（worktree 跟 `gitdir` 和 `commondir` 找到主仓库），任一 `[remote]` 的 `url` 指向 github.com（https、ssh、`git@github.com:` 写法）即为 `true`。
  - `project_id` 是名称 slug 加真实路径 sha256 的前 8 位，同一路径（含经符号链接）重复导入得到同一个 id，2 落库时 `INSERT OR IGNORE`。名称会进 id：同一路径传不同的 `name`，得到的 `project_id` 也不同。
  - 项目可能来自不可信压缩包：`.git`、`gitdir:` 文件、`commondir`、`config` 都用非阻塞方式打开，要求是普通文件且不超过 1 MiB（`GIT_META_MAX_BYTES`），命名管道、设备、`/dev/zero` 符号链接、超大文件一律当作没有远程。
  - 传 `publish`（通常是 `(e) => bus.publish(e)`）时发 `project_created`，`requirement_id`、`ticket_id` 为 `null`；`trace` 不传就新开一条。本包不依赖总线。
- 路径不存在或不是目录报 `ProjectImportError`，不发事件。

## 提示词模板（T-008）

- `promptTemplate(role, opts?)`：读 `prompts/<role>.md`（`supervisor`、`reviewer`、`sub_agent`、`coder`）。每次调用都读文件，去 BOM、换行统一 LF、去首尾空白，同样的文件跨平台逐字节相同；5 按内容哈希缓存公共前缀，所以改模板后下一单自动生效。
- `reviewer` 模板带 `{{input}}`，7 的 `buildPrompt` 替换它；模板里没有时 7 把输入接在末尾。
- `architecture_constraints`：给了非空数组时加一节「## 项目架构约束」，放在 `{{input}}` 前面（没有占位符就接在末尾），供 7 带上与 5 公共前缀同一份的项目约束。`coder` 不用传，5 自己拼。
- 约束里字面的 `{{input}}` 会先反复去掉直到不再变化（`{{in{{input}}put}}` 也去干净），免得 7 替换占位符时把不可信输入塞进约束这一节。
- `dir` 可指向自定义模板目录；`logger` 接收警告（默认 `console`）。未知角色或读不到文件报 `PromptTemplateError`。

## 脱敏与凭据检查（T-059）

- `redact(text, "light" | "full")`：light 遮 key / token / Bearer / env 密钥 / 邮箱 / 私钥 / URL 凭据；full 另遮 home 路径、IP、内网主机名。所有规则都是线性的（重复次数有上限，或改成逐段扫描），10 万字符的输入在 500ms 内。
  - `url_credentials` 与 `isCredentialUrl` 同一套判定，只遮凭据那一段（userinfo、`?` / `#` 之后；解析不了的遮 `://` 之后全部）。
  - `github_token`（`ghp_` / `gho_` / `ghu_` / `ghs_` / `ghr_`、`github_pat_`）和 `gitlab_token`（`glpat-`）不管前面紧挨着什么都遮。
  - 邮箱逐个 `@` 扫：向左按 `[A-Za-z0-9._%+-]` 扩到上一处匹配或上一个 `@`，向右按 `[A-Za-z0-9.-]` 扩、去掉末尾的 `.` 和 `-`，以 2 个及以上字母的顶级域结尾就遮；最后一段像 `com-2` 时取开头的字母（至少 2 个且后面紧跟 `-`）截在那里再遮；不设长度上限。
  - 内网主机名最多 16 段起匹配，再从匹配处往前整条遮掉。
  - 私钥只有 BEGIN 没有 END 时遮到文末。
- `isCredentialUrl(s)`：字符串是不是（或里面有没有）带凭据的 URL，宁可误拒不漏放。模块 2 的 prStore 拒写调它。
- `CREDENTIAL_CASES`：2、3、11 共用的用例表，见 `src/credential-cases.ts`。假 token 运行时拼出，源码里没有完整 token。
