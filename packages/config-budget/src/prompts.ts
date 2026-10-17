// T-008：各角色的提示词模板，文件放在 packages/config-budget/prompts/<role>.md。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROLES, type Role } from "@bakacoding/types";

/** 内置模板目录（源码与 dist 下都指向包根的 prompts/）。 */
export const PROMPTS_DIR = fileURLToPath(new URL("../prompts/", import.meta.url));

/** 评审模板里的输入占位符：7 的 buildPrompt 有它就替换，没有就把输入接在模板后面。 */
export const PROMPT_INPUT_PLACEHOLDER = "{{input}}";

export interface PromptTemplateOptions {
  /** 模板目录，默认 PROMPTS_DIR（测试或用户自定义模板时传） */
  dir?: string;
  /**
   * 项目架构约束（与 5 的公共前缀里拼的是同一份）。给了且非空时，作为「## 项目架构约束」一节
   * 放进模板：有 {{input}} 就放在它前面，否则接在模板末尾。约束来自项目配置，按可信文本给出。
   */
  architecture_constraints?: readonly string[];
  /** 警告输出，默认 console */
  logger?: { warn(message: string): void };
}

export class PromptTemplateError extends Error {
  override name = "PromptTemplateError";
}

/**
 * 读取角色的提示词模板。每次调用都读文件（调用方按内容哈希缓存，如 5 的公共前缀）；
 * 换行统一成 LF、去掉 BOM 和首尾空白，保证跨平台逐字节稳定。
 */
export async function promptTemplate(
  role: Role,
  opts: PromptTemplateOptions = {},
): Promise<string> {
  if (!(ROLES as readonly string[]).includes(role)) {
    throw new PromptTemplateError(`未知角色：${String(role)}`);
  }
  const file = join(opts.dir ?? PROMPTS_DIR, `${role}.md`);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (e) {
    throw new PromptTemplateError(`读不到 ${role} 的提示词模板 ${file}：${String(e)}`);
  }
  const template = raw
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (role === "reviewer" && !template.includes(PROMPT_INPUT_PLACEHOLDER)) {
    // 7 会把输入接在末尾，仍可用；这里只提醒
    (opts.logger ?? console).warn(
      `[config-budget] reviewer 模板里没有 ${PROMPT_INPUT_PLACEHOLDER}，评审输入将接在模板末尾`,
    );
  }
  // 约束里字面的 {{input}} 先去掉：否则 7 替换占位符时会把不可信输入塞进约束这一节
  const constraints = (opts.architecture_constraints ?? [])
    .map((c) => stripPlaceholder(c).trim())
    .filter(Boolean);
  if (constraints.length === 0) return template;
  const section = `## 项目架构约束\n${constraints.map((c) => `- ${c}`).join("\n")}`;
  const at = template.indexOf(PROMPT_INPUT_PLACEHOLDER);
  if (at < 0) return `${template}\n\n${section}`;
  const before = template.slice(0, at).trimEnd();
  return `${before}${before ? "\n\n" : ""}${section}\n\n${template.slice(at)}`;
}

/** 反复去掉 `{{input}}`，直到不再变化（`{{in{{input}}put}}` 去一遍后又会拼出新的占位符）。 */
function stripPlaceholder(text: string): string {
  let prev: string;
  do {
    prev = text;
    text = text.split(PROMPT_INPUT_PLACEHOLDER).join("");
  } while (text !== prev);
  return text;
}
