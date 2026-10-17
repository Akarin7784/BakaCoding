// UI-03b：密钥项与测试连接的 IPC（docs/ui-design.md §4.6 / §7.1，modules.md §12；UI-07 复用）。
// secret:status / secret:set / secret:clear 只调 3 的 secretStatus / setUserSecret / clearUserSecret，
// provider:test 只调当前后端的 testConnection（组合根同一个网关）。
// 渲染进程传的参数先在这里做类型校验；失败只回固定码和固定中文文案（shared/secret-text.ts）。
// 密钥值只在 secret:set 这一次调用里经过这里：不回传、不写日志、不进错误信息（这里从不拼 e.message）。
import {
  clearUserSecret as clearUserSecretDefault,
  SECRET_NAMES,
  secretStatus as secretStatusDefault,
  setUserSecret as setUserSecretDefault,
  type SecretDeps,
  type SecretName,
} from "@bakacoding/config-budget";
import type {
  DesktopProviderTestCode,
  DesktopProviderTestResult,
  DesktopReloadResult,
  DesktopSecretClearResult,
  DesktopSecretFailure,
  DesktopSecretSetResult,
  DesktopSecretStatus,
  DesktopSecretStatusResult,
} from "../shared/api.js";
import { PROVIDER_TEST_TEXT, SECRET_FAILURE_TEXT } from "../shared/secret-text.js";
import type { BackendTestResult } from "./backend.js";

export interface SecretFns {
  secretStatus: typeof secretStatusDefault;
  setUserSecret: typeof setUserSecretDefault;
  clearUserSecret: typeof clearUserSecretDefault;
}

export const DEFAULT_SECRET_FNS: SecretFns = {
  secretStatus: secretStatusDefault,
  setUserSecret: setUserSecretDefault,
  clearUserSecret: clearUserSecretDefault,
};

export interface SecretProviderDeps {
  /** 交给 3 的 deps：env（默认 process.env）、markerPath（main 传 userData 下的 secret-markers.json）、测试注入 userEnv */
  secretDeps: SecretDeps;
  backend: {
    status(): { mode: "live" | "readonly" };
    testConnection(target: { provider: string; model?: string }): Promise<BackendTestResult>;
    /** 后端只读时保存密钥后重新连接（同 backend:reconnect） */
    reconnect(): Promise<DesktopReloadResult>;
  };
  fns?: Partial<SecretFns>;
}

/** 密钥值的类型上限（字符）；内容（空白、换行、NUL、4096）再由 3 校验 */
export const MAX_SECRET_INPUT = 4096;
/** 服务商 / 模型名：配置里的键名，只认这些字符 */
const TARGET_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function secretFailure(code: DesktopSecretFailure["code"]): DesktopSecretFailure {
  return { ok: false, code, reason: SECRET_FAILURE_TEXT[code] };
}

export function providerFailure(
  code: DesktopProviderTestCode,
  status?: number,
): DesktopProviderTestResult {
  return {
    ok: false,
    code,
    reason: PROVIDER_TEST_TEXT[code],
    ...(status !== undefined && Number.isInteger(status) && { status }),
  };
}

/** `{ name }`：name 必须是 3 的 SECRET_NAMES 之一 */
export function parseSecretName(v: unknown): SecretName | null {
  if (!isObj(v)) return null;
  const { name } = v;
  return typeof name === "string" && (SECRET_NAMES as readonly string[]).includes(name)
    ? (name as SecretName)
    : null;
}

/** `{ provider, model? }`：配置键名那样的短字符串；多余字段丢掉 */
export function parseProviderTarget(v: unknown): { provider: string; model?: string } | null {
  if (!isObj(v)) return null;
  const { provider, model } = v;
  if (typeof provider !== "string" || !TARGET_NAME.test(provider)) return null;
  if (model !== undefined && (typeof model !== "string" || !TARGET_NAME.test(model))) return null;
  return { provider, ...(model !== undefined && { model: model as string }) };
}

/** 3 的状态原样，只挑这三个字段（system 来源 3 本来就不给 last4，这里再防一层） */
function pickStatus(s: {
  set: boolean;
  source: "bakacoding" | "system" | null;
  last4?: string;
}): DesktopSecretStatus {
  return {
    set: !!s.set,
    source: s.source === "bakacoding" || s.source === "system" ? s.source : null,
    ...(s.source === "bakacoding" &&
      typeof s.last4 === "string" &&
      /^[\x21-\x7e]{4}$/.test(s.last4) && { last4: s.last4 }),
  };
}

const SET_CODES = new Set(["invalid_value", "unsupported_platform", "write_failed"]);
const CLEAR_CODES = new Set(["not_owned", "not_set", "unsupported_platform", "write_failed"]);
const TEST_CODES: ReadonlySet<string> = new Set<DesktopProviderTestCode>([
  "budget_exhausted",
  "no_secret",
  "auth_failed",
  "quota_exhausted",
  "rate_limited",
  "network",
  "config_error",
  "http_error",
]);

export interface SecretProviderHandlers {
  status(arg: unknown): Promise<DesktopSecretStatusResult>;
  set(arg: unknown): Promise<DesktopSecretSetResult>;
  clear(arg: unknown): Promise<DesktopSecretClearResult>;
  test(arg: unknown): Promise<DesktopProviderTestResult>;
}

/** 四个通道的处理函数（从不抛过 IPC；任何异常都只回固定文案，不带原始信息）。 */
export function secretProviderHandlers(deps: SecretProviderDeps): SecretProviderHandlers {
  const fns: SecretFns = { ...DEFAULT_SECRET_FNS, ...deps.fns };
  const readStatus = async (name: SecretName): Promise<DesktopSecretStatus> =>
    pickStatus(await fns.secretStatus(name, deps.secretDeps));
  return {
    async status(arg) {
      const name = parseSecretName(arg);
      if (!name) return secretFailure("invalid_name");
      try {
        return { ok: true, status: await readStatus(name) };
      } catch {
        return secretFailure("failed");
      }
    },
    async set(arg) {
      const name = parseSecretName(arg);
      if (!name) return secretFailure("invalid_name");
      const value = (arg as Record<string, unknown>).value;
      if (typeof value !== "string" || value.length === 0 || value.length > MAX_SECRET_INPUT)
        return secretFailure("invalid_value");
      try {
        const r = await fns.setUserSecret(name, value, deps.secretDeps);
        if (!r.ok) return secretFailure(SET_CODES.has(r.reason) ? r.reason : "failed");
      } catch {
        return secretFailure("failed");
      }
      let status: DesktopSecretStatus;
      try {
        status = await readStatus(name);
      } catch {
        status = { set: true, source: "bakacoding" };
      }
      if (deps.backend.status().mode !== "readonly") return { ok: true, status };
      let reload: DesktopReloadResult;
      try {
        reload = await deps.backend.reconnect();
      } catch {
        reload = { state: "failed", reason: "重新连接失败" };
      }
      return { ok: true, status, reload };
    },
    async clear(arg) {
      const name = parseSecretName(arg);
      if (!name) return secretFailure("invalid_name");
      try {
        const r = await fns.clearUserSecret(name, deps.secretDeps);
        if (!r.ok) return secretFailure(CLEAR_CODES.has(r.reason) ? r.reason : "failed");
        return { ok: true, status: await readStatus(name) };
      } catch {
        return secretFailure("failed");
      }
    },
    async test(arg) {
      const target = parseProviderTarget(arg);
      if (!target) return providerFailure("invalid_target");
      try {
        const r = await deps.backend.testConnection(target);
        if (r.ok) {
          const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
          return { ok: true, latency_ms: n(r.latency_ms), cost_micro_usd: n(r.cost_micro_usd) };
        }
        if (r.reason === "unavailable") return providerFailure("unavailable");
        const code = TEST_CODES.has(r.reason) ? (r.reason as DesktopProviderTestCode) : "failed";
        return providerFailure(code, "status" in r ? r.status : undefined);
      } catch {
        return providerFailure("failed");
      }
    },
  };
}
