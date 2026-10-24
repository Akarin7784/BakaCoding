// UI-05c：渲染进程侧的文本脱敏（需求页时间线、事件里的文本都过一遍）。
// - 先走 3 的 redact(…, "light")：密钥值、token、Bearer、邮箱、私钥、URL 凭据（和落库同一套）；
// - 再遮本地路径：POSIX 绝对路径、Windows 盘符路径、`~/…`、`file://…`，和 11 的 redactPaths 同样的前置断言，
//   不误伤 `https://…`、相对路径 `a/b`、日期 `2026/10/24`。
// 11 的 redactPaths 依赖 node:os，渲染进程用不了，这里只保留最常见的几类路径（主进程下发的需求详情已经过完整的 sanitizeChatReason）。
import { redact } from "@bakacoding/config-budget/dist/redact.js";

// 停止字符：空白、引号、括号、ASCII 与全角标点（中文句子里路径后面紧跟「，」「。」时不吞掉后文）
const STOP = String.raw`\s"'\x60<>()\[\]{},;|，。；：、！？（）「」『』《》“”‘’`;
const PATH_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}_.\/\\~\]:])(?:file:\/\/?[^${STOP}]*|~[\\/][^${STOP}]*|[A-Za-z]:\\[^${STOP}]*|\/[\p{L}\p{N}._~@%+=-][^${STOP}]*)`,
  "gu",
);

export const REDACTED_PATH = "[REDACTED:path]";

/** 界面显示前的脱敏：密钥类 + 本地路径。 */
export function redactForView(text: string): string {
  return redact(text, "light").text.replace(PATH_RE, REDACTED_PATH);
}
