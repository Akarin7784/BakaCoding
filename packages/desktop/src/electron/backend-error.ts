// UI-08：只读详情（docs/ui-design.md §4.7）——把后端起不来时 catch 到的错误整理成可下发的形状。
// 错误名只留标识符字符；信息、一层 cause 先遮仓库路径和其他绝对路径，再换 env 里像密钥的值、走 3 的 light 脱敏、截断。
import type { DesktopBackendError } from "../shared/api.js";
import { sanitizeReloadReason } from "./backend-switcher.js";
import { sanitizeErrorName } from "./sync-state.js";

/** 信息上限（码点）；渲染进程整段显示在详情弹层里。 */
export const BACKEND_ERROR_MESSAGE_MAX = 2000;
/** 错误码只认 Node 风格的标识符（ENOENT、ERR_xxx、SQLITE_BUSY）。 */
const ERROR_CODE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

function codeOf(e: unknown): string | undefined {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "string" && ERROR_CODE.test(c) ? c : undefined;
}

export function backendErrorDetail(
  e: unknown,
  repoRoot: string,
  env: Readonly<Record<string, string | undefined>> = {},
): DesktopBackendError {
  const clean = (m: string) => sanitizeReloadReason(m, repoRoot, env, BACKEND_ERROR_MESSAGE_MAX);
  if (!(e instanceof Error)) return { name: "Error", message: clean(String(e)) };
  const out: DesktopBackendError = { name: sanitizeErrorName(e.name), message: clean(e.message) };
  const code = codeOf(e);
  if (code) out.code = code;
  const cause = (e as { cause?: unknown }).cause;
  if (cause !== undefined && cause !== null) {
    out.cause =
      cause instanceof Error
        ? { name: sanitizeErrorName(cause.name), message: clean(cause.message) }
        : { name: "Error", message: clean(String(cause)) };
  }
  return out;
}
