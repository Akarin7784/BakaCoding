// UI-05c / T-154：渲染进程侧的文本脱敏（需求页时间线、事件里的文本都过一遍）。
// - 先走 3 的 redact(…, "light")：密钥值、token、Bearer、邮箱、私钥、URL 凭据（和落库同一套）；
// - 再遮本地路径：直接用 11 的纯函数 redactPathsPure（T-154，与主进程 redactPaths 同一套规则），
//   渲染进程拿不到 home 目录，传空串（home 下的路径照样由 abs_path / windows_path 遮）；
//   打开 fullWidthStop：路径遇到全角标点就停，中文句子里路径后面紧跟「，」「。」时不吞后文（UI-05c 369e7be）。
import { redact } from "@bakacoding/config-budget/dist/redact.js";
import { redactPathsPure } from "@bakacoding/diagnostics/dist/path-redaction-core.js";

/** 界面显示前的脱敏：密钥类 + 本地路径。 */
export function redactForView(text: string): string {
  return redactPathsPure(redact(text, "light").text, { home: "", fullWidthStop: true }).text;
}
