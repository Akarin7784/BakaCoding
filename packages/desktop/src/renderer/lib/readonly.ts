// UI-08：只读模式的文案（§4.7）。横幅一句人话原因，详情弹层列脱敏后的错误名、信息、错误码、cause。
import type { DesktopBackendStatus } from "../../shared/api.js";

export const READONLY_COPY = {
  bannerPrefix: "只读模式：",
  details: "查看详情",
  reconnect: "重新连接",
  reconnecting: "连接中…",
  composerPlaceholder: "只读模式下不能发消息",
  decideDisabled: "只读模式下不能裁决",
  mergeMainDisabled: "只读模式下不能合入 main",
  exportDisabled: "只读模式下不能导出",
} as const;

/** 横幅上的一句原因。 */
export function readonlyReason(s: DesktopBackendStatus): string {
  if (s.mode === "readonly") return s.reason?.trim() || "后端没有启动";
  if (s.storage?.lease_lost) return "数据库被其他程序接管，后端已停止写入";
  return "后端没有启动";
}

export interface DetailRow {
  label: string;
  value: string;
}

/** 详情弹层的各行（已脱敏，主进程给的原样显示）。 */
export function readonlyDetailRows(s: DesktopBackendStatus): DetailRow[] {
  const rows: DetailRow[] = [{ label: "原因", value: readonlyReason(s) }];
  const e = s.error;
  if (e) {
    rows.push({ label: "错误名", value: e.name });
    rows.push({ label: "信息", value: e.message || "—" });
    if (e.code) rows.push({ label: "错误码", value: e.code });
    if (e.cause) rows.push({ label: "起因", value: `${e.cause.name}：${e.cause.message}` });
  }
  if (s.storage?.lease_lost) rows.push({ label: "存储", value: "租约丢失" });
  if (s.storage && s.storage.ingest_failures > 0)
    rows.push({ label: "写库失败", value: `${s.storage.ingest_failures} 次` });
  return rows;
}

/** 「复制详情」的纯文本。 */
export function readonlyDetailText(s: DesktopBackendStatus): string {
  return readonlyDetailRows(s)
    .map((r) => `${r.label}：${r.value}`)
    .join("\n");
}

/**
 * 只读原因对应的一键修复（UI-03，`docs/ui-design.md` §4.1）：按主进程给的错误码路由——
 * 组合根 RepoNotReadyError 的 `no_commits` / `no_main`（错误名必须对上），以及「不是 Git 仓库」的 `not_git`。
 * 修复入口要等仓库修复的 IPC 定下来才接上；这里只给出该去哪一项。
 */
export type RepoFixRoute = "init_repo" | "initial_commit" | "create_main";

export function repoFixRoute(s: DesktopBackendStatus): RepoFixRoute | null {
  if (s.mode !== "readonly" || !s.error) return null;
  const { name, code } = s.error;
  if (code === "not_git") return "init_repo";
  if (name !== "RepoNotReadyError") return null;
  if (code === "no_commits") return "initial_commit";
  if (code === "no_main") return "create_main";
  return null;
}
