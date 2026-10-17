import { ReviewModelOutputSchema, type Diff, type ReviewModelOutput } from "@bakacoding/types";
import type { ReviewInput } from "./types.js";

const OUTPUT_SPEC = `只输出一个 JSON 对象，不要输出其他文字：
{"verdict": "pass" | "fail", "reasons": [{"category": "incomplete" | "out_of_scope" | "bug" | "arch_violation", "detail": "说明", "file": "可选，相对路径", "line": 可选正整数}]}
verdict 为 fail 时 reasons 至少一条。
reasons 会原样交给编码代理作为下一轮的修改依据：detail 写成能直接照着改的具体修改要求（改哪里、改成什么、为什么），不要只写笼统评价；能定位到文件和行就填 file 和 line。`;

/**
 * 评审输入固定为「diff + 需求单 + 精简摘要」（另附权限清单用于判断越界、架构约束）。
 * 模板里有 {{input}} 就替换，否则把输入接在模板后面。
 */
export function buildPrompt(template: string, input: ReviewInput, diff: Diff): string {
  const body = [
    "## 需求单",
    input.ticket.ticket_text,
    "## 精简摘要",
    input.summary,
    "## 权限清单（越出 rw 范围的改动算越界）",
    JSON.stringify(input.permission_list),
    ...(input.ticket.architecture_constraints?.length
      ? ["## 架构约束", input.ticket.architecture_constraints.map((c) => `- ${c}`).join("\n")]
      : []),
    "## diff",
    `base ${diff.base_sha} → head ${diff.head_sha}`,
    ...diff.files.map((f) => `### ${f.path}（${f.status}）\n${f.patch}`),
    "## 输出格式",
    OUTPUT_SPEC,
  ].join("\n\n");
  return template.includes("{{input}}")
    ? template.split("{{input}}").join(body)
    : `${template}\n\n${body}`;
}

function tryParse(text: string): ReviewModelOutput | undefined {
  const candidates = [text.trim()];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const c of candidates) {
    try {
      const r = ReviewModelOutputSchema.safeParse(JSON.parse(c));
      if (r.success) return r.data;
    } catch {
      // 不是 JSON，试下一个
    }
  }
  return undefined;
}

/**
 * 解析模型输出，按顺序试：
 * 1. 标了 json 的代码块（多个时取第一个能通过 ReviewModelOutputSchema 校验的）；
 * 2. 其余代码块（未标语言或其他语言），按出现顺序取第一个能通过校验的；
 * 3. 整段文本（整段是 JSON，或取第一个 `{` 到最后一个 `}`）。
 * 都不行返回 undefined（走 7-6 重试）。
 */
export function parseModelOutput(output: string): ReviewModelOutput | undefined {
  const blocks = [...output.matchAll(/```([^\n`]*)\n([\s\S]*?)```/g)].map((m) => ({
    lang: (m[1] ?? "").trim().split(/\s+/)[0]!.toLowerCase(),
    body: m[2] ?? "",
  }));
  const ordered = [
    ...blocks.filter((b) => b.lang === "json"),
    ...blocks.filter((b) => b.lang !== "json"),
  ];
  for (const b of ordered) {
    const r = tryParse(b.body);
    if (r) return r;
  }
  return tryParse(output);
}
