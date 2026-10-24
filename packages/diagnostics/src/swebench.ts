import type { DiagPackage, DiagTicket } from "./schema.js";

/**
 * SWE-bench 实例字段（https://github.com/SWE-bench/SWE-bench docs/guides/datasets.md）。
 * FAIL_TO_PASS / PASS_TO_PASS 与官方数据集一致，为 JSON 编码的字符串列表。
 */
export interface SweBenchInstance {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  version: string;
  patch: string;
  test_patch: string;
  created_at: string;
  FAIL_TO_PASS: string;
  PASS_TO_PASS: string;
  environment_setup_commit: string;
  hints_text: string;
}

function finalPatch(pkg: DiagPackage, t: DiagTicket): string {
  const last = t.rounds.at(-1);
  if (!last) return "";
  return pkg.raw_files.find((f) => f.path === last.diff_file)?.content ?? "";
}

/**
 * 把诊断包转成 SWE-bench 风格 JSONL：只转带 eval_task 的单（标记进评测集、人工补填过的单）。
 * 输入是已脱敏的包，输出不会再引入原文。
 *
 * T-159：诊断包不含对话和提示词原文，ticket_text 只有摘要，所以 problem_statement 一律为空串。
 * 题面须由用户从自己本地的日志（本机存储里的需求单原文）补上；复现也需要用户自己的本地日志。
 */
export function toSweBenchJsonl(pkg: DiagPackage): string {
  const repo = pkg.manifest.repo ?? pkg.manifest.project_id;
  return pkg.tickets
    .filter((t) => t.eval_task !== undefined)
    .map((t): SweBenchInstance => {
      const task = t.eval_task!;
      return {
        instance_id: `${pkg.manifest.project_id}__${t.ticket_id}`,
        repo,
        base_commit: t.base_commit,
        // 题面不在包里：须由用户从本地日志补填（见上方说明）。
        problem_statement: "",
        version: "",
        patch: finalPatch(pkg, t),
        test_patch: task.test_patch ?? "",
        created_at: t.created_at,
        FAIL_TO_PASS: JSON.stringify(task.test_names),
        PASS_TO_PASS: JSON.stringify(task.pass_to_pass ?? []),
        environment_setup_commit: t.base_commit,
        hints_text: "",
      };
    })
    .map((x) => `${JSON.stringify(x)}\n`)
    .join("");
}
