import { homedir } from "node:os";
import {
  PATH_RULES,
  redactPathsPure,
  type PathRedactResult,
  type PathRule,
} from "./path-redaction-core.js";

// T-154：规则和实现都在 path-redaction-core.ts（不依赖 node，渲染进程共用）；这里只补 home 默认值。
export { PATH_RULES, type PathRedactResult, type PathRule };

/** 对一段文本做路径脱敏；`home` 默认取运行时 os.homedir()，测试可注入。`rules` 只给反向检查用。 */
export function redactPaths(
  text: string,
  opts: { home?: string; rules?: readonly PathRule[] } = {},
): PathRedactResult {
  return redactPathsPure(text, { home: opts.home ?? safeHomedir(), rules: opts.rules });
}

function safeHomedir(): string {
  try {
    return homedir();
  } catch {
    return "";
  }
}
