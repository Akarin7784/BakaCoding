import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SECRET_NAMES, type SecretName } from "./config.js";
import { powershellUserEnv } from "./secrets-powershell.js";

// T-088：界面保存 / 清除密钥（写 Windows 用户级环境变量 HKCU\Environment）。
// 密钥值只进 HKCU 和 process.env，不回传、不写日志 / 事件 / 标记文件，错误只有错误码。

/** 用户级环境变量的读写；默认实现走 PowerShell（仅 Windows），测试注入假实现。 */
export interface UserEnvStore {
  get(name: SecretName): Promise<string | undefined>;
  set(name: SecretName, value: string): Promise<void>;
  remove(name: SecretName): Promise<void>;
}

export interface SecretDeps {
  /** 本进程环境变量，默认 process.env；`getSecret` 从这里读，所以保存后立即生效。 */
  env?: NodeJS.ProcessEnv;
  /** 标记文件路径；12 传 `join(app.getPath("userData"), SECRET_MARKER_FILE)`。 */
  markerPath?: string;
  /** 默认：Windows 上用 PowerShell 写 HKCU\Environment，其它平台不支持。 */
  userEnv?: UserEnvStore;
  now?: () => Date;
}

export type SecretSource = "bakacoding" | "system";
export interface SecretStatus {
  set: boolean;
  source: SecretSource | null;
  /** 只在来源是 bakacoding、且保存时值长度 ≥ 8 才有。 */
  last4?: string;
}
export type SetSecretResult =
  | { ok: true; last4?: string }
  | { ok: false; reason: "invalid_value" | "unsupported_platform" | "write_failed" };
export type ClearSecretResult =
  | { ok: true }
  | { ok: false; reason: "not_owned" | "not_set" | "unsupported_platform" | "write_failed" };

interface Marker {
  source: "bakacoding";
  saved_at: string;
  last4?: string;
}
type MarkerFile = Partial<Record<SecretName, Marker>>;

export const SECRET_MARKER_FILE = "secret-markers.json" as const;
const MAX_SECRET_LENGTH = 4096;
const LAST4_MIN_LENGTH = 8;

export function defaultSecretMarkerPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.APPDATA ? join(env.APPDATA, "BakaCoding") : join(homedir(), ".bakacoding");
  return join(base, SECRET_MARKER_FILE);
}

function assertName(name: SecretName): void {
  if (!(SECRET_NAMES as readonly string[]).includes(name)) {
    throw new Error("不支持的密钥名");
  }
}

const last4Of = (v: string) => (v.length >= LAST4_MIN_LENGTH ? v.slice(-4) : undefined);

async function readMarkers(path: string): Promise<MarkerFile> {
  try {
    const raw: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: MarkerFile = {};
    for (const n of SECRET_NAMES) {
      const m = (raw as Record<string, unknown>)[n] as Partial<Marker> | undefined;
      if (m && m.source === "bakacoding" && typeof m.saved_at === "string") {
        out[n] = {
          source: "bakacoding",
          saved_at: m.saved_at,
          ...(typeof m.last4 === "string" && m.last4.length === 4 ? { last4: m.last4 } : {}),
        };
      }
    }
    return out;
  } catch {
    // 不存在或损坏都当作没有标记（只影响「来源」显示，不影响 getSecret）。
    return {};
  }
}

/** 同目录临时文件（0600）→ fsync → rename。 */
async function writeMarkers(path: string, markers: MarkerFile): Promise<void> {
  const dir = dirname(path);
  const tmp = join(
    dir,
    `.${SECRET_MARKER_FILE}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  );
  try {
    await mkdir(dir, { recursive: true });
    const fh = await open(tmp, "wx", 0o600);
    try {
      await fh.writeFile(`${JSON.stringify(markers, null, 2)}\n`, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

async function dropMarker(path: string, name: SecretName): Promise<void> {
  const markers = await readMarkers(path);
  if (!markers[name]) return;
  delete markers[name];
  await writeMarkers(path, markers);
}

function resolveDeps(deps: SecretDeps) {
  const env = deps.env ?? process.env;
  const userEnv = deps.userEnv ?? (process.platform === "win32" ? powershellUserEnv() : undefined);
  return {
    env,
    userEnv,
    markerPath: deps.markerPath ?? defaultSecretMarkerPath(),
    now: deps.now ?? (() => new Date()),
  };
}

/**
 * 密钥状态。标记在、变量没了 → 未设置并清标记；标记在但当前值末 4 位对不上（外面改过）→ `system` 并清标记；
 * 来源是 `system` 时不回 `last4`。
 */
export async function secretStatus(name: SecretName, deps: SecretDeps = {}): Promise<SecretStatus> {
  assertName(name);
  const { env, markerPath } = resolveDeps(deps);
  const cur = env[name]?.trim();
  const marker = (await readMarkers(markerPath))[name];
  if (!cur) {
    if (marker) await dropMarker(markerPath, name).catch(() => {});
    return { set: false, source: null };
  }
  if (!marker) return { set: true, source: "system" };
  if (last4Of(cur) !== marker.last4) {
    await dropMarker(markerPath, name).catch(() => {});
    return { set: true, source: "system" };
  }
  return { set: true, source: "bakacoding", ...(marker.last4 ? { last4: marker.last4 } : {}) };
}

/**
 * 保存密钥：写 HKCU → 更新 process.env → 写标记。标记写失败时把 HKCU 和 process.env 恢复原值，返回 `write_failed`。
 * 返回值只有末 4 位（值长度 ≥ 8 时）。
 */
export async function setUserSecret(
  name: SecretName,
  value: string,
  deps: SecretDeps = {},
): Promise<SetSecretResult> {
  assertName(name);
  if (typeof value !== "string") return { ok: false, reason: "invalid_value" };
  const v = value.trim();
  if (!v || v.length > MAX_SECRET_LENGTH || /[\r\n\0]/.test(v)) {
    return { ok: false, reason: "invalid_value" };
  }
  const { env, userEnv, markerPath, now } = resolveDeps(deps);
  if (!userEnv) return { ok: false, reason: "unsupported_platform" };

  let prevUser: string | undefined;
  try {
    prevUser = await userEnv.get(name);
  } catch {
    return { ok: false, reason: "write_failed" };
  }
  const hadProc = Object.prototype.hasOwnProperty.call(env, name);
  const prevProc = env[name];
  const restore = async () => {
    if (hadProc) env[name] = prevProc;
    else delete env[name];
    await (prevUser === undefined ? userEnv.remove(name) : userEnv.set(name, prevUser)).catch(
      () => {},
    );
  };

  try {
    await userEnv.set(name, v);
  } catch {
    await restore();
    return { ok: false, reason: "write_failed" };
  }
  env[name] = v;
  const last4 = last4Of(v);
  try {
    const markers = await readMarkers(markerPath);
    markers[name] = {
      source: "bakacoding",
      saved_at: now().toISOString(),
      ...(last4 ? { last4 } : {}),
    };
    await writeMarkers(markerPath, markers);
  } catch {
    await restore();
    return { ok: false, reason: "write_failed" };
  }
  return last4 ? { ok: true, last4 } : { ok: true };
}

/** 只清 BakaCoding 自己存的那份：来源是系统环境变量时报 `not_owned`，没设置报 `not_set`。 */
export async function clearUserSecret(
  name: SecretName,
  deps: SecretDeps = {},
): Promise<ClearSecretResult> {
  assertName(name);
  const status = await secretStatus(name, deps);
  if (!status.set) return { ok: false, reason: "not_set" };
  if (status.source !== "bakacoding") return { ok: false, reason: "not_owned" };
  const { env, userEnv, markerPath } = resolveDeps(deps);
  if (!userEnv) return { ok: false, reason: "unsupported_platform" };
  try {
    await userEnv.remove(name);
  } catch {
    return { ok: false, reason: "write_failed" };
  }
  delete env[name];
  // 标记删不掉也没关系：变量已经没了，下次 secretStatus 会清掉它。
  await dropMarker(markerPath, name).catch(() => {});
  return { ok: true };
}
