// UI-06c：右面板 Git 区文案。
import type { DesktopGitStatusResult, DesktopSyncState } from "../../shared/api.js";
import { describeSyncState, formatClock, SYNC_AUTH_STOPPED_HINT } from "./sync-labels";

export const GIT_COPY = {
  detached: "分离 HEAD（不在任何分支上）",
  loading: "正在读取 Git 状态…",
} as const;

export function gitCurrentLabel(r: Extract<DesktopGitStatusResult, { ok: true }>): string {
  return r.current_branch === null ? `当前 ${GIT_COPY.detached}` : `当前 ${r.current_branch}`;
}

export function gitAheadLabel(r: Extract<DesktopGitStatusResult, { ok: true }>): string {
  return `集成 ${r.integration_branch}（领先 main ${r.ahead}）`;
}

/** Git 区同步错误的固定文案（不透出 last_error 原文）。 */
export const GIT_SYNC_ERROR_TEXT = {
  auth: SYNC_AUTH_STOPPED_HINT,
  rateLimited: "同步触发限流，稍后自动重试",
  failed: "同步失败，稍后自动重试",
} as const;

export interface GitSyncView {
  /** 「上次同步：…」；同步状态不可用为 null */
  lastSync: string | null;
  /** 出错时的固定提示；正常为 null */
  error: string | null;
}

/** Git 区只看最后一次成功同步时间 + 出错时一句固定提示。 */
export function gitSyncView(state: DesktopSyncState | null): GitSyncView {
  if (!state || !state.available) return { lastSync: null, error: null };
  const lastSync = `上次同步：${state.last_ok_at ? formatClock(state.last_ok_at) : "还没有成功过"}`;
  const v = describeSyncState(state);
  const error =
    v.tone === "error"
      ? GIT_SYNC_ERROR_TEXT.auth
      : v.tone === "warn"
        ? v.label === "限流退避中"
          ? GIT_SYNC_ERROR_TEXT.rateLimited
          : GIT_SYNC_ERROR_TEXT.failed
        : null;
  return { lastSync, error };
}
