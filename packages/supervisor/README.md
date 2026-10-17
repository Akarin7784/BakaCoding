# @bakacoding/supervisor

模块 10 主管：用户唯一对接方，拆单、处理上报、审集成分支、合入 main。接口约定见 [docs/modules.md「10.」](../../docs/modules.md)。

## T-040：对话与拆单

`createSupervisor(deps)` 返回 `{ chat, split, start, createManualTicket, loadTicket }`；另导出 `validateWriteScope`、`SPLIT_MAX_ATTEMPTS`（3）和相关类型。上报处理、重拆计数、高风险 PR、装配、重启接管在 T-041；集成分支审查、合入 main、主管待办指标在 T-042。

- **依赖全部注入**（`SupervisorDeps`）：1 的 `call`、3 的 `getConfig`（`roles.supervisor`）和 `promptTemplate("supervisor")`、2 的存取（`listProjects`、`listDecisions`、`saveDecision`、`registerRequirement`、`saveTicket`、`getTicket`、`listTickets`）、9 的 `enqueue`、总线 `publish` / `subscribe`、`targetHead`、可选 `listFiles`、`notifyUser`。
- **存储（T-055）**：`deps.storage` 是 `Pick<Storage, "listProjects" | "listDecisions" | "saveDecision" | "registerRequirement" | "saveTicket" | "getTicket" | "listTickets">`，全部同步，可直接传 `openStorage()` 的返回值。需求单的结构化字段 `{ write_scope, interfaces, depends_on, priority, kind, origin, trace }` 写在 `saveTicket` 的 `fields` 里（8 回写权限清单时不带 `fields`，不会冲掉）；读回时按 10 的格式校验。
- **`fields` 为 null、不合格式或写入范围复查不过**（T-055 之前的旧单、库里损坏、被改过；写入范围按本单来源用 `validateWriteScope` 再查一遍，如 split 单存了 `**`）：`loadTicket` 经注入的 `publish` 发 `ticket_warning { code: "fields_invalid" }`（发失败只记警告），记一条警告「…不能续跑，需要重拆或人工处理」，返回 `undefined`，**不按整仓 `**` 兜底续跑**（那会把写权限放宽到整个仓库）。8 按「单不存在」报错、9 转上报，由 T-041 决定重拆还是交用户。这类单的单号在重拆时仍算本项目已有单号，但不提供 trace。
- **提示词**：模板来自注入的 `promptTemplate("supervisor")`，本包不带默认模板；本包只在模板后追加输出格式说明 `OUTPUT_SPEC.chat` / `OUTPUT_SPEC.split`（包内常量，与 7 的 `OUTPUT_SPEC` 同一约定；格式只在代码里，`prompts/supervisor.md` 不写），再接不可信区块（项目、决策记忆、已有单号、文件清单、上报反馈、用户原文，统一用 `wrapUntrusted` 包装）。
- **模型输出不可信**：对话输出和拆单输出都用 `.strict()` 的 zod schema 解析（多一个字段即无效），拆单再做语义校验。

### 写入范围规则（`validateWriteScope`）

| 错误码 | 条件 | split 单 | manual / test 单 |
|---|---|---|---|
| `write_scope_missing` | 没给或为空 | 无效，整批退回 | 按 `["**"]`，发 `ticket_warning(write_scope_defaulted)` |
| `write_scope_trailing_slash` | 以 `/` 结尾 | 无效（写成 `lib/**`，不自动改写） | 同左 |
| `write_scope_unsafe` | 4 的 `isUnsafeGlob` 为真 | 无效 | 同左 |
| `write_scope_whole_repo` | 第一段不是字面量（含 `* ? [ ] { } ( ) ! + @`）：`**`、`**/*`、`*`、`*/**`、`{**,x}`、`?(**)`、`[!_]**`、`**/package.json` 等，都可能写到整个仓库 | 无效（v1 不开白名单） | 按 `["**"]`，发警告 |
| `write_scope_bare_directory` | 字面路径是基线上的目录（需 `listFiles`） | 无效（写成 `dir/**`） | 同左 |

通配字符集 `* ? [ ] { } ( ) ! + @` 在本包 `validate.ts` 里自己定义（不从 4 引），`validate.charset.test.ts` 从 4（T-054 `SCOPE_WILDCARD`）和 8（T-053 `SCOPE_REQUEST_WILDCARD`）源码里抠出正则、逐个可打印 ASCII 字符比对，保证三处一致。是否整仓不依赖 `isUnsafeGlob`（它不拦整仓通配）。

拆单另查 `interfaces_missing`（必填，可为 `[]`）、`interface_unsafe`、`depends_on_unknown`（只能指本批次 key 或本项目已有单号）、`depends_on_cycle`、`output_invalid`（JSON 或 schema 不合格、key 重复）。任一张不合法整批退回，最多调 `SPLIT_MAX_ATTEMPTS` 次模型；仍不合法就不建单。同一批次写入范围重叠不判无效，交给 9 的锁。

### 对话里的项目

界面传了 `project_id` 就用它；否则看原文是否字面提到且只提到一个项目（项目名或 id）；项目名 / id 的匹配忽略大小写：纯 ASCII 的按词边界（`ui` 不匹配「rebuild the login page」），含非 ASCII 字符的（如中文名）按子串；少于 2 个字符的名字不参与匹配。都没有且只有一个项目时直接用。后两种情况回复里写明「按项目 X 处理」。多个项目没说清时每次都追问，并暂存这条需求。

下一条回复只用项目名认领暂存的需求：界面传了 `project_id` 就用它；否则原文里恰好提到一个项目才认领。提到多个项目（如「加到官网，别加到应用」）或一个都没提到（如「第一个吧」）时不认领、再问一次（`ask_project`），暂存的需求保留，不调模型、不建单。去掉项目名后剩下的内容如果还有实际内容（去掉标点和「是 / 就 / 吧 / 项目」等虚词后至少 2 个字），就当一条新消息照常处理（意图判断、定项目、拆单），不丢掉顺带提的新需求。两条的回复文字拼接、单号合并；新消息还要追问项目时 `kind` 为 `ask_project`，新需求进暂存。

已知缺口：1:1 历史 v1 不持久化（暂存的需求只在本进程）；意图判断那次调用也预生成 `requirement_id`（1/2/3 要求必填），不是需求的消息也会留下一个未登记的需求号。追问项目后，去掉项目名和虚词仍剩至少 2 个字就当新消息处理，判断较粗，可能误判。未注入 `listFiles` 时不查裸目录；`persistAndDispatch` 入队中途抛错会半批入队；`pending` 是全进程共用变量，并发会抢（v1 只有一对一对话，可接受）。
