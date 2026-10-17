// T-067：把 9 的 syncState() 变成可下发给渲染进程的形状——错误信息脱敏 + 截断，只读时给出不可用原因。
import { redact } from "@bakacoding/config-budget";
import type { SyncState } from "@bakacoding/scheduler";
import type { DesktopSyncState } from "../shared/api.js";

/** 主进程下发前 last_error.message 的上限（渲染进程再按约 500 字预览截断）。 */
export const SYNC_ERROR_MESSAGE_MAX = 4000;
/** 错误名只允许标识符字符，最多 80 字。 */
const ERROR_NAME_MAX = 80;
/** 环境变量名像密钥的，值不允许出现在下发内容里。 */
const SECRET_ENV_NAME = /(TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;
/** 太短的值不当密钥替换（避免把常见词误换掉）。 */
const SECRET_ENV_MIN_LEN = 6;

/** 把 env 里像密钥的变量值换成 `[REDACTED:变量名]`，再走 3 的 light 脱敏，最后截断。 */
export function sanitizeSyncErrorMessage(
  message: string,
  env: Readonly<Record<string, string | undefined>> = {},
  max = SYNC_ERROR_MESSAGE_MAX,
): string {
  let out = message;
  const entries = Object.entries(env)
    .filter(
      (e): e is [string, string] =>
        SECRET_ENV_NAME.test(e[0]) && typeof e[1] === "string" && e[1].length >= SECRET_ENV_MIN_LEN,
    )
    // 长值先换，避免短值是长值子串时换残
    .sort((a, b) => b[1].length - a[1].length);
  for (const [name, value] of entries) {
    out = out.split(value).join(`[REDACTED:${name}]`);
  }
  out = redact(out, "light").text;
  // 按码点截断，不拆代理对
  const cps = Array.from(out);
  return cps.length > max ? `${cps.slice(0, max).join("")}…` : out;
}

export function sanitizeErrorName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_$.]/g, "").slice(0, ERROR_NAME_MAX);
  return cleaned || "Error";
}

/** live：拷一份 9 的 SyncState，错误信息脱敏截断；不改 9 的接口。 */
export function toDesktopSyncState(
  state: SyncState,
  env: Readonly<Record<string, string | undefined>> = {},
): DesktopSyncState {
  return {
    available: true,
    enabled: state.enabled,
    ...(state.disabled_reason !== undefined && { disabled_reason: state.disabled_reason }),
    last_ok_at: state.last_ok_at,
    last_error: state.last_error
      ? {
          at: state.last_error.at,
          name: sanitizeErrorName(state.last_error.name),
          message: sanitizeSyncErrorMessage(state.last_error.message, env),
        }
      : null,
    consecutive_failures: state.consecutive_failures,
    rate_limited_until: state.rate_limited_until,
    next_at: state.next_at,
  };
}

export function unavailableSyncState(reason: string | undefined): DesktopSyncState {
  return {
    available: false,
    reason: reason ? `只读模式：${reason}` : "只读模式：后端未接线",
  };
}

/**
 * 主进程把 catch 到的错误变成一句话（T-077）：泛化的 `Error` 不写名字，只给信息；
 * 具体错误名（ConfigError 等）经 sanitizeErrorName 过滤后写成「名字：信息」。信息仍需调用方脱敏。
 */
export function errorDetail(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const name = sanitizeErrorName(e.name);
  return name === "Error" ? e.message : `${name}：${e.message}`;
}
