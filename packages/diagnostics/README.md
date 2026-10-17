# @bakacoding/diagnostics

模块 11 诊断包导出：按单/需求/时间段导出脱敏诊断包，可导出 SWE-bench 风格 JSONL。

- `export({ project_id, scope, include_full_repo }, deps) → zip_path`（`export` 是保留字，代码里也叫 `exportPackage`）。
- 一个包只放一个项目；`scope` 为 `{ kind: "ticket", ticket_id }`、`{ kind: "requirement", requirement_id }` 或 `{ kind: "time_range", from, to }`。
- 所有内容（JSONL、原始文件、文件路径）都过模块 3 的 `redact(text, "full")`；`redaction_report.json` 只记「规则名 → 命中次数」。
- 默认只带每轮 diff 和上下文片段；`include_full_repo: true` 才带 `repo/`。
- `.env` 类文件默认整个不进包：任何一段路径是 `.env`、`.env.*`、`.envrc` 或 `.envrc.*`（大小写不敏感）。完整仓库和上下文片段都适用；manifest 只记个数（完整仓库 `excluded_env_files`，上下文片段 `excluded_context_env_files`），不记路径。
- `diff_file`、`context_files`、`manifest.files` 与 zip 条目名逐字一致，不做二次脱敏。
- `toSweBenchJsonl(package)`：只转人工补填过 `eval_task` 的单。

zip 结构（schema `bakacoding-diag/v1.1`；`readPackage` 也能读 `bakacoding-diag/v1` 旧包）：

```
manifest.json            schema、项目、范围、文件清单、统计
events.jsonl             范围内的事件
tickets.jsonl            每张单：原文、拆单摘要、结果标签、权限清单、各轮评审、合并结果、CI、费用、eval_task
costs.jsonl              按单汇总的费用（复投单列）
redaction_report.json    规则名 → 命中次数
raw/<ticket>/r<n>.diff   每轮 diff
raw/<ticket>/context/…   上下文片段
repo/…                   完整仓库（仅勾选时）
```

数据源 `DiagnosticsSource` 由模块 2 实现，落地前由调用方注入。
