// UI-06c：右面板 Git 区文案。
import type { DesktopGitStatusResult } from "../../shared/api.js";

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
