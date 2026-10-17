// UI-02 设置弹层外壳（§4.6）：居中 880×600，Ctrl+, 或左栏底部齿轮打开。
// 7 个标签与可编辑内容在 UI-07；这一版里面放现有的只读设置页 + 主题切换。
import type { DesktopSettings } from "../../shared/api";
import type { WizardApi } from "./ModelSetupWizard";
import { SettingsPanel } from "./SettingsPanel";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";

export function SettingsDialog({
  open,
  onOpenChange,
  settings,
  error,
  api,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: DesktopSettings | null;
  error?: string | null;
  /** UI-03b：密钥项 / 模型设置向导 */
  api?: WizardApi;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="flex h-[min(600px,calc(100vh-2rem))] w-[880px] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[880px]"
      >
        <DialogTitle className="sr-only">设置</DialogTitle>
        <DialogDescription className="sr-only">
          查看当前仓库、模式、密钥是否已设与主题
        </DialogDescription>
        <SettingsPanel
          settings={settings}
          error={error ?? null}
          embedded
          {...(api && { api })}
          onBack={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
