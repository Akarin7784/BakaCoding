// T-072：导入项目 / 导出诊断包 / 只读设置的界面状态。
// UI-08：结果不再是内容区顶部一行小字，改成右下角 toast（成功 5 秒消失，错误不消失、可复制详情）。
import { useState } from "react";
import type { BakaDesktopApi, DesktopSettings } from "../../shared/api.js";
import { failureText, stripErrorNoise } from "../../shared/error-text.js";
import { notifyError, notifyOk } from "../lib/notify";

export interface ProjectActions {
  busy: "import" | "export" | null;
  settingsOpen: boolean;
  settings: DesktopSettings | null;
  settingsError: string | null;
  importProject(): Promise<void>;
  exportDiagnostics(): Promise<void>;
  openSettings(): Promise<void>;
  closeSettings(): void;
}

const IPC_FAILED = "和主进程通信失败，请重试";
/** UI-03b：导入了还没准备好的文件夹 */
export const IMPORT_NEEDS_PREP = "已导入文件夹，还要先做几步准备（比如初始化 Git）";

/** 操作结果的去处（UI-08：右下角 toast）；测试可注入。 */
export interface ActionNotifier {
  ok(text: string): void;
  error(text: string): void;
}
const toastNotifier: ActionNotifier = { ok: notifyOk, error: (t) => notifyError(t) };

export function useProjectActions(
  api: BakaDesktopApi | undefined,
  /** 导入成功后重新加载界面（新仓库的快照、通知回放）；测试注入 */
  reload: () => void = () => globalThis.location?.reload(),
  notify: ActionNotifier = toastNotifier,
  /** UI-03b：导入的文件夹还要准备（不是 Git 仓库等）：不重载界面，直接进项目准备页 */
  onNeedsPrep?: () => void,
): ProjectActions {
  const [busy, setBusy] = useState<ProjectActions["busy"]>(null);
  const setNotice = (n: { tone: "ok" | "error"; text: string }) =>
    n.tone === "ok" ? notify.ok(n.text) : notify.error(n.text);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const unavailable = () => setNotice({ tone: "error", text: "没有连接主进程，不能操作" });

  return {
    busy,
    settingsOpen,
    settings,
    settingsError,
    async importProject() {
      if (!api?.importProject) return unavailable();
      if (busy) return;
      setBusy("import");
      try {
        const r = await api.importProject();
        if (r.ok) {
          setNotice({
            tone: "ok",
            text: `已导入项目「${r.project.name}」：${r.project.path}${r.note ? `。${r.note}` : ""}`,
          });
          reload();
        } else if ("needsPrep" in r) {
          setNotice({ tone: "ok", text: IMPORT_NEEDS_PREP });
          if (onNeedsPrep) onNeedsPrep();
          else reload();
        } else if (!r.canceled) {
          const missing = r.missing?.length ? `缺少：${r.missing.join("、")}。` : "";
          setNotice({
            tone: "error",
            text: failureText("导入失败", `${missing}${stripErrorNoise(r.reason ?? "")}`),
          });
        }
      } catch {
        setNotice({ tone: "error", text: `导入失败：${IPC_FAILED}` });
      } finally {
        setBusy(null);
      }
    },
    async exportDiagnostics() {
      if (!api?.exportDiagnostics) return unavailable();
      if (busy) return;
      setBusy("export");
      try {
        const r = await api.exportDiagnostics();
        if (r.ok) setNotice({ tone: "ok", text: `诊断包已导出：${r.path}` });
        else if (!r.canceled) setNotice({ tone: "error", text: failureText("导出失败", r.reason) });
      } catch {
        setNotice({ tone: "error", text: `导出失败：${IPC_FAILED}` });
      } finally {
        setBusy(null);
      }
    },
    async openSettings() {
      setSettingsOpen(true);
      setSettingsError(null);
      if (!api?.getSettings) {
        setSettings(null);
        setSettingsError("没有连接主进程，读不到设置");
        return;
      }
      try {
        setSettings(await api.getSettings());
      } catch {
        setSettingsError(`读取设置失败：${IPC_FAILED}`);
      }
    },
    closeSettings: () => setSettingsOpen(false),
  };
}
