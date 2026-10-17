// T-072：导入项目 / 导出诊断包 / 只读设置的界面状态。
import { useState } from "react";
import type { BakaDesktopApi, DesktopSettings } from "../../shared/api.js";

export interface ProjectActions {
  busy: "import" | "export" | null;
  /** 一行结果提示；error 用 role=alert */
  notice: { tone: "ok" | "error"; text: string } | null;
  settingsOpen: boolean;
  settings: DesktopSettings | null;
  settingsError: string | null;
  importProject(): Promise<void>;
  exportDiagnostics(): Promise<void>;
  openSettings(): Promise<void>;
  closeSettings(): void;
}

const IPC_FAILED = "和主进程通信失败，请重试";

export function useProjectActions(
  api: BakaDesktopApi | undefined,
  /** 导入成功后重新加载界面（新仓库的快照、通知回放）；测试注入 */
  reload: () => void = () => globalThis.location?.reload(),
): ProjectActions {
  const [busy, setBusy] = useState<ProjectActions["busy"]>(null);
  const [notice, setNotice] = useState<ProjectActions["notice"]>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const unavailable = () => setNotice({ tone: "error", text: "没有连接主进程，不能操作" });

  return {
    busy,
    notice,
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
          setNotice({ tone: "ok", text: `已导入项目「${r.project.name}」：${r.project.path}` });
          reload();
        } else if (!r.canceled) {
          const missing = r.missing?.length ? `缺少：${r.missing.join("、")}。` : "";
          setNotice({ tone: "error", text: `导入失败：${missing}${r.reason ?? ""}` });
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
        else if (!r.canceled) setNotice({ tone: "error", text: `导出失败：${r.reason}` });
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
