// T-077：报错文案去噪。界面上的失败提示统一走 failureText：动作前缀只出现一次，不露出 `Error：` / Electron 的 remote method 包装。

/** Electron ipcRenderer.invoke 抛错时的包装：`Error invoking remote method 'x': Error: ...` */
const REMOTE_WRAP = /^Error invoking remote method '[^']*':\s*/;
/** 泛化错误名前缀（`Error: ` / `Error：`）；具体错误名（ConfigError 等）保留 */
const GENERIC_ERROR = /^Error\s*[:：]\s*/;

/** 去掉 remote method 包装和泛化的 `Error:` 前缀（可能叠了几层）。 */
export function stripErrorNoise(text: string): string {
  let cur = text.trim();
  for (;;) {
    const next = cur.replace(REMOTE_WRAP, "").replace(GENERIC_ERROR, "").trimStart();
    if (next === cur) return cur;
    cur = next;
  }
}

/** `${prefix}：${reason}`，reason 先去噪，并去掉它自己已经带的同一前缀（不重复）。 */
export function failureText(prefix: string, reason: string): string {
  let r = stripErrorNoise(reason);
  const head = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:：]\\s*`);
  for (;;) {
    const next = stripErrorNoise(r.replace(head, ""));
    if (next === r) break;
    r = next;
  }
  return r ? `${prefix}：${r}` : prefix;
}
