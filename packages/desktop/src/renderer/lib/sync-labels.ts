// T-067：9 的定时同步状态（syncState()）在界面上的文案。
import type { DesktopSyncState } from "../../shared/api.js";
import { stripErrorNoise } from "../../shared/error-text.js";

export const SYNC_AUTH_STOPPED_HINT = "鉴权失败，同步已停止，请检查 GITHUB_TOKEN";

export type SyncTone = "ok" | "warn" | "error" | "muted";

export interface SyncStatusView {
  tone: SyncTone;
  /** 一行状态：同步运行中 / 同步已停止 / 限流退避中 / 同步失败 / 同步未运行 / 同步状态不可用 */
  label: string;
  /** 中文提示（鉴权停、限流、普通失败、只读原因）；没有为 null */
  hint: string | null;
  /** 上次成功（本地时间）；没有为 null */
  lastOk: string | null;
  /** 下次尝试（本地时间 + 相对时长）；没在跑为 null */
  next: string | null;
  /** 最近一次错误的详情（错误名：信息），主进程已脱敏；没有为 null */
  errorDetail: string | null;
}

/** 毫秒 → 「X 秒」「X 分 Y 秒」「X 小时 Y 分」；负数按 0。 */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m} 分 ${rs} 秒` : `${m} 分钟`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h} 小时 ${rm} 分` : `${h} 小时`;
}

/** ISO 时刻 → 本地时间（24 小时制）；解析失败原样返回。 */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", { hour12: false });
}

function msUntil(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t - now;
}

export function describeSyncState(
  state: DesktopSyncState,
  now: number = Date.now(),
): SyncStatusView {
  if (!state.available) {
    return {
      tone: "muted",
      label: "同步状态不可用",
      hint: state.reason,
      lastOk: null,
      next: null,
      errorDetail: null,
    };
  }
  const lastOk = state.last_ok_at ? formatClock(state.last_ok_at) : null;
  const nextMs = msUntil(state.next_at, now);
  const next =
    state.next_at && nextMs !== null
      ? `${formatClock(state.next_at)}（${formatDuration(nextMs)}后）`
      : null;
  const errorDetail = state.last_error
    ? state.last_error.name === "Error"
      ? stripErrorNoise(state.last_error.message)
      : `${state.last_error.name}：${stripErrorNoise(state.last_error.message)}`
    : null;

  if (state.disabled_reason === "auth") {
    return {
      tone: "error",
      label: "同步已停止",
      hint: SYNC_AUTH_STOPPED_HINT,
      lastOk,
      next: null,
      errorDetail,
    };
  }

  const rlMs = msUntil(state.rate_limited_until, now);
  const rateLimitedNow = rlMs !== null && rlMs > 0;
  const lastWasRateLimit = state.last_error?.name === "GithubRateLimitError";
  if (rateLimitedNow || (lastWasRateLimit && state.consecutive_failures > 0)) {
    // 重试时刻：取限流窗口结束和下一轮里较晚的那个
    const waits = [rateLimitedNow ? rlMs : null, nextMs].filter(
      (x): x is number => x !== null && x > 0,
    );
    const wait = waits.length ? Math.max(...waits) : null;
    const hint =
      wait !== null ? `触发限流，将在 ${formatDuration(wait)}后重试` : "触发限流，稍后重试";
    return { tone: "warn", label: "限流退避中", hint, lastOk, next, errorDetail };
  }

  if (state.last_error && state.consecutive_failures > 0) {
    const hint =
      nextMs !== null
        ? `同步失败（连续 ${state.consecutive_failures} 次），将在 ${formatDuration(nextMs)}后重试`
        : `同步失败（连续 ${state.consecutive_failures} 次）`;
    return { tone: "warn", label: "同步失败", hint, lastOk, next, errorDetail };
  }

  if (state.enabled) {
    return { tone: "ok", label: "同步运行中", hint: null, lastOk, next, errorDetail: null };
  }
  return { tone: "muted", label: "同步未运行", hint: null, lastOk, next: null, errorDetail: null };
}
