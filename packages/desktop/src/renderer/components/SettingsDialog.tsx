// UI-02 设置弹层外壳（§4.6）：居中 880×600，Ctrl+, 或左栏底部齿轮打开。
// UI-07a：里面是左侧 7 个标签（SettingsPanel embedded）；模型 / 预算的可编辑表单在 UI-07b / UI-07c。
import type { BakaDesktopApi, DesktopSettings } from "../../shared/api";
import type { WizardApi } from "./ModelSetupWizard";
import { SettingsPanel } from "./SettingsPanel";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";

export function SettingsDialog({
  open,
  onOpenChange,
  settings,
  error,
  api,
  desktopApi,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: DesktopSettings | null;
  error?: string | null;
  /** UI-03b：密钥项 / 模型设置向导 */
  api?: WizardApi;
  /** T-130：诊断导出面板需要完整 preload API */
  desktopApi?: BakaDesktopApi;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="flex h-[min(600px,calc(100vh-2rem))] w-[880px] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[880px]"
      >
        <DialogTitle className="sr-only">设置</DialogTitle>
        <DialogDescription className="sr-only">
          通用、项目、模型、预算、密钥、诊断、关于
        </DialogDescription>
        <SettingsPanel
          settings={settings}
          error={error ?? null}
          embedded
          {...(api && { api })}
          {...(desktopApi && { desktopApi })}
          onBack={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
