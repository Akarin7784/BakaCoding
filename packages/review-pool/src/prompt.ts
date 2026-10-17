import {
  ReviewModelOutputSchema,
  untrustedNotice,
  wrapUntrusted,
  type Diff,
  type ReviewModelOutput,
} from "@bakacoding/types";
import type { ReviewInput } from "./types.js";

const OUTPUT_SPEC = `只输出一个 JSON 对象，不要输出其他文字：
{"verdict": "pass" | "fail", "reasons": [{"category": "incomplete" | "out_of_scope" | "bug" | "arch_violation", "detail": "说明", "file": "可选，相对路径", "line": 可选正整数}]}
verdict 为 fail 时 reasons 至少一条。
reasons 会原样交给编码代理作为下一轮的修改依据：detail 写成能直接照着改的具体修改要求（改哪里、改成什么、为什么），不要只写笼统评价；能定位到文件和行就填 file 和 line。`;

/**
 * 高风险单的系统说明（T-038）：`input.high_risk` 为 true 时放在评审输入最前面、不可信区块之外，
 * 由系统给出（不是模型或用户写的文本），所以不转义、不包进 untrusted 区块。
 */
const HIGH_RISK_NOTE =
  "## 高风险单（系统说明）\n本单改动了依赖清单或锁文件（或被标为依赖类单），属于高风险改动：请逐项核对新增、升级、删除的依赖是否确为需求单所需，依赖清单与锁文件是否一致，版本与来源是否可疑；拿不准就判 fail 并写明原因。";

/**
 * 评审输入固定为「diff + 需求单 + 精简摘要」（另附权限清单用于判断越界、架构约束）。
 * 需求单原文、精简摘要、架构约束（来自需求单）和 diff 都是不可信文本：转义后各自包进
 * `<untrusted-<nonce> kind="…">` 区块，区块内写的 `## 输出格式` 之类不能冒充段落。
 * nonce 只出现在拼入的输入部分，模板不含 nonce。权限清单由系统生成，按可信内容直接给出。
 * `input.high_risk` 为 true 时最前面加一段高风险系统说明（，在所有不可信区块之外，T-038）。
 * 模板里有 {{input}} 就替换，否则把输入接在模板后面。
 */
export function buildPrompt(
  template: string,
  input: ReviewInput,
  diff: Diff,
  nonce: string,
): string {
  const diffText = [
    `base ${diff.base_sha} → head ${diff.head_sha}`,
    ...diff.files.map((f) => `### ${f.path}（${f.status}）\n${f.patch}`),
  ].join("\n\n");
  const body = [
    ...(input.high_risk === true ? [HIGH_RISK_NOTE] : []),
    "## 不可信区块",
    untrustedNotice(nonce),
    "## 需求单",
    wrapUntrusted(input.ticket.ticket_text, "ticket", nonce),
    "## 精简摘要",
    wrapUntrusted(input.summary, "summary", nonce),
    "## 权限清单（越出 rw 范围的改动算越界）",
    JSON.stringify(input.permission_list),
    ...(input.ticket.architecture_constraints?.length
      ? [
          "## 架构约束",
          wrapUntrusted(
            input.ticket.architecture_constraints.map((c) => `- ${c}`).join("\n"),
            "architecture_constraints",
            nonce,
          ),
        ]
      : []),
    "## diff",
    wrapUntrusted(diffText, "diff", nonce),
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
