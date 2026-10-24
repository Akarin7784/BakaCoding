# @bakacoding/diagnostics

模块 11 诊断包导出：按单/需求/时间段导出脱敏诊断包，可导出 SWE-bench 风格 JSONL。

- `export({ project_id, scope, include_full_repo }, deps) → zip_path`（`export` 是保留字，代码里也叫 `exportPackage`）。
- 一个包只放一个项目；`scope` 为 `{ kind: "ticket", ticket_id }`、`{ kind: "requirement", requirement_id }` 或 `{ kind: "time_range", from, to }`。
- 所有内容（JSONL、原始文件、文件路径）都过模块 3 的 `redact(text, "full")`；`redaction_report.json` 只记「规则名 → 命中次数」。
- 默认只带每轮 diff 和上下文片段；`include_full_repo: true` 才带 `repo/`。
- `.env` 类文件默认整个不进包：任何一段路径是 `.env`、`.env.*`、`.envrc` 或 `.envrc.*`（大小写不敏感）。完整仓库和上下文片段都适用；manifest 只记个数（完整仓库 `excluded_env_files`，上下文片段 `excluded_context_env_files`），不记路径。
- `diff_file`、`context_files`、`manifest.files` 与 zip 条目名逐字一致，不做二次脱敏。
- **诊断包不含对话和提示词原文**（T-159，schema v1.2）。下列字段在完整脱敏之前换成摘要 `{ "len": 码点数, "hmac": "HMAC-SHA256(salt, UTF-8 原文) 的十六进制" }`：
  - 事件：`call_completed` 的 `prompt` / `output`（成功、失败、取消的调用都算）、`group_message.content`、`interface_changed.summary`、`escalated.detail`、`ticket_warning.detail`、`write_scope_requested.reason` / `write_scope_denied.reason`（清单见 `digest.ts` 的 `EVENT_TEXT_FIELDS`）；
  - 单子：`ticket_text`、`decomposition_summary`、每轮 `fail_reasons` 的每一条、`review_comments`。
  - salt 每个包导出时 `crypto.randomBytes(32)` 生成，只在内存里，用完即弃，**不写进包**；同一包内同文同 hmac（可看出两处是不是同一段话），不同包之间不能对照。`manifest.text_digest` 写明这一方式，不含 salt。
  - 照常保留：diff、上下文片段、完整仓库（代码）、路径和 glob、CI、`eval_task`、`project_created.name`、错误码、各种 id 和枚举。没有带原文导出的选项。
- `toSweBenchJsonl(package)`：只转人工补填过 `eval_task` 的单。`problem_statement` 一律为空串：包里没有题面，题面须由用户从自己本地的日志补上；复现同样需要用户自己的本地日志。

zip 结构（schema `bakacoding-diag/v1.2`；`readPackage` 也能读 `bakacoding-diag/v1` / `v1.1` 旧包，旧包的文本字段仍是字符串）：

```
manifest.json            schema、项目、范围、文件清单、统计、text_digest 说明
events.jsonl             范围内的事件（对话 / 提示词等文本字段为摘要）
tickets.jsonl            每张单：需求原文和拆单摘要（均为摘要）、结果标签、权限清单、各轮评审、合并结果、CI、费用、eval_task
costs.jsonl              按单汇总的费用（复投单列）
redaction_report.json    规则名 → 命中次数
raw/<ticket>/r<n>.diff   每轮 diff
raw/<ticket>/context/…   上下文片段
repo/…                   完整仓库（仅勾选时）
```

## 数据源（T-024）

`DiagnosticsSource` 定义在 `@bakacoding/types`，由模块 2 的 `storage.diagnosticsSource()` 实现（modules.md 11：模块 2 写适配器实现）。用法：

```ts
const storage = openStorage({ path: ".bakacoding/bakacoding.db" });
const zip_path = await exportPackage(
  { project_id, scope },
  { source: storage.diagnosticsSource(), out_dir },
);
```

- 按项目过滤在存储层完成（事件按 `project_id` 或需求所属项目）；`time_range` 按 `ts_ms` / `created_at_ms` 比较，两端都包含，ISO 时间带不带毫秒都可以。
- 存储里的数据落库前已做轻脱敏，导出时照常再做完整脱敏。

存储没有、所以诊断包里也没有的数据（不补造）：

- **完整仓库**：存储不存仓库文件，适配器不提供 `repoFiles`；勾选 `include_full_repo` 会直接报错。
- **超过保留期的调用**：只剩摘要，`prompt` 为空串，`output` 为摘要。
- **没有归属项目的事件**：需求没登记到项目（没有 `saveTicket`、群消息或 `registerRequirement`）、事件自身也不带 `project_id` 时，按项目查不到。
- **eval_task**：按设计不落库，由 `deps.eval_tasks` 传入。
- **费用**：按包内 `call_completed` 事件汇总，不读存储的台账表。
- 拆单摘要、结果标签、CI check、合并结果：只有写入方保存过才有，否则字段缺省。

## 需求单 `fields` 不进包（T-056）

模块 2 的需求单结构化字段 `fields` 按设计不脱敏，所以诊断包不带它：存储的 `diagnosticsSource()` 不读出这一列，`buildPackage` 也只按字段白名单拼 `DiagTicket`，不展开整条记录。`storage-source.test.ts` 里有回归测试，两道各测一次；存储那道按单子、需求、时间范围三种范围各导一次（时间范围由 T-050 补上），并检查 `tickets.jsonl` 里每条记录都没有 `fields` 键。
