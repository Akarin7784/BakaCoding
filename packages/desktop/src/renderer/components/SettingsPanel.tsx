// T-072：只读设置页——当前仓库、环境变量是否已设（只显示名字）、本地 / GitHub 模式。
// UI-03b：主进程有 secret:* 时密钥那几行换成可保存 / 清除的密钥项，并能打开模型设置向导（测试连接）。
import { useState } from "react";
import type { BakaDesktopApi } from "../../shared/api";
import { ArrowLeft, Wand2 } from "lucide-react";
import {
  DESKTOP_SECRET_NAMES,
  type DesktopSecretName,
  type DesktopSettings,
} from "../../shared/api";
import { WIZARD_COPY } from "../lib/secretItem";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import { ModelSetupWizard, type WizardApi } from "./ModelSetupWizard";
import { SecretItem } from "./SecretItem";
import { Button } from "./ui/button";
import { ThemeSwitcher } from "./ThemeSwitcher";

const isEditableSecret = (n: string): n is DesktopSecretName =>
  (DESKTOP_SECRET_NAMES as readonly string[]).includes(n);

export const SETTINGS_MODE_LABEL: Record<DesktopSettings["mode"], string> = {
  github: "GitHub 模式",
  local: "本地模式",
  readonly: "只读",
};

export function SettingsPanel({
  settings,
  error,
  onBack,
  embedded = false,
  api,
  desktopApi,
}: {
  settings: DesktopSettings | null;
  error?: string | null;
  onBack: () => void;
  /** UI-02：放在设置弹层里时不画「返回」，关闭由弹层负责 */
  embedded?: boolean;
  /** UI-03b：密钥项和测试连接；没有（旧版 preload / 测试）时只读显示 */
  api?: WizardApi;
  /** T-130：诊断导出面板需要完整 preload API；没有（旧版 preload / 浏览器预览）时整块不显示 */
  desktopApi?: BakaDesktopApi;
}) {
  const [wizardOpen, setWizardOpen] = useState(false);
  const editable = !!api?.secretStatus;
  const secrets = settings?.env.filter((e) => !e.name.startsWith("BAKACODING_")) ?? [];
  const others = settings?.env.filter((e) => e.name.startsWith("BAKACODING_")) ?? [];
  const row = (e: { name: string; set: boolean }) => (
    <li key={e.name} className="flex gap-3" data-testid={`env-${e.name}`}>
      <code className="w-56 shrink-0">{e.name}</code>
      <span className={e.set ? "text-foreground" : "text-muted-foreground"}>
        {e.set ? "已设" : "未设"}
      </span>
    </li>
  );
  return (
    <section aria-label="设置" className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2">
        {!embedded && (
          <Button variant="secondary" size="sm" aria-label="返回" onClick={onBack}>
            <ArrowLeft strokeWidth={1.5} />
            返回
          </Button>
        )}
        <span className="text-sm font-medium" data-testid="settings-title">
          {settings?.mode === "readonly" ? "设置（只读）" : "设置"}
        </span>
      </header>
      <div className="space-y-5 overflow-y-auto px-4 py-4 text-sm">
        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
        <div>
          <h3 className="mb-1 text-xs text-muted-foreground">主题</h3>
          <ThemeSwitcher />
        </div>
        {!settings && !error && <p className="text-muted-foreground">读取中…</p>}
        {settings && (
          <>
            <div>
              <h3 className="mb-1 text-xs text-muted-foreground">当前仓库</h3>
              <p data-testid="settings-repo" className="break-all">
                {settings.repo ?? "未设置"}
              </p>
            </div>
            <div>
              <h3 className="mb-1 text-xs text-muted-foreground">PR 模式</h3>
              <p data-testid="settings-mode">{SETTINGS_MODE_LABEL[settings.mode]}</p>
            </div>
            <div>
              <h3 className="mb-1 text-xs text-muted-foreground">
                {editable ? "密钥" : "密钥（环境变量，只显示是否已设）"}
              </h3>
              {editable && api ? (
                <div className="flex flex-col gap-4">
                  {secrets
                    .filter((e) => isEditableSecret(e.name))
                    .map((e) => (
                      <SecretItem key={e.name} api={api} name={e.name as DesktopSecretName} />
                    ))}
                  {secrets.some((e) => !isEditableSecret(e.name)) && (
                    <ul className="space-y-1">
                      {secrets.filter((e) => !isEditableSecret(e.name)).map(row)}
                    </ul>
                  )}
                  {api.testProvider && (
                    <div>
                      <Button variant="secondary" size="sm" onClick={() => setWizardOpen(true)}>
                        <Wand2 strokeWidth={1.5} />
                        {WIZARD_COPY.open}
                      </Button>
                    </div>
                  )}
                </div>
              ) : (
                <ul className="space-y-1">{secrets.map(row)}</ul>
              )}
            </div>
            <div>
              <h3 className="mb-1 text-xs text-muted-foreground">路径（环境变量）</h3>
              <ul className="space-y-1">{others.map(row)}</ul>
            </div>
            <p className="text-xs text-muted-foreground">
              改环境变量后要完全关掉程序再打开才生效。
            </p>
            {desktopApi && (
              <DiagnosticsPanel api={desktopApi} readonly={settings?.mode === "readonly"} />
            )}
          </>
        )}
      </div>
      {api && wizardOpen && (
        <ModelSetupWizard open={wizardOpen} onOpenChange={setWizardOpen} api={api} />
      )}
    </section>
  );
}
