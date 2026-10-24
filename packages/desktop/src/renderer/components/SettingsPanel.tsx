// T-072：只读设置页——当前仓库、环境变量是否已设（只显示名字）、本地 / GitHub 模式。
// UI-03b：主进程有 secret:* 时密钥那几行换成可保存 / 清除的密钥项，并能打开模型设置向导（测试连接）。
// UI-07a：放在设置弹层里（embedded）时改成左侧 7 个标签（§4.6）；单独使用时仍是原来的一整页。
// UI-07b：「模型」标签换成可编辑的 ModelSettings（settings:config-get / settings:save）。
import { useState, type ReactNode } from "react";
import type { BakaDesktopApi } from "../../shared/api";
import {
  ArrowLeft,
  Cpu,
  FolderGit2,
  Info,
  KeyRound,
  SlidersHorizontal,
  Stethoscope,
  Wallet,
  Wand2,
} from "lucide-react";
import {
  DESKTOP_SECRET_NAMES,
  type DesktopSecretName,
  type DesktopSettings,
} from "../../shared/api";
import { WIZARD_COPY } from "../lib/secretItem";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import { ModelSettings } from "./ModelSettings";
import { ModelSetupWizard, type WizardApi } from "./ModelSetupWizard";
import { SecretItem } from "./SecretItem";
import { SettingsAbout } from "./SettingsExtras";
import { Button } from "./ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
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
  const loading = !settings && !error && <p className="text-muted-foreground">读取中…</p>;
  const errorAlert = error && (
    <p role="alert" className="text-danger">
      {error}
    </p>
  );
  const theme = (
    <div>
      <h3 className="mb-1 text-xs text-muted-foreground">主题</h3>
      <ThemeSwitcher />
    </div>
  );
  const project = settings && (
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
    </>
  );
  const wizardButton = editable && api?.testProvider && (
    <div>
      <Button variant="secondary" size="sm" onClick={() => setWizardOpen(true)}>
        <Wand2 strokeWidth={1.5} />
        {WIZARD_COPY.open}
      </Button>
    </div>
  );
  const secretsBlock = (withWizard: boolean) =>
    settings && (
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
            {withWizard && wizardButton}
          </div>
        ) : (
          <ul className="space-y-1">{secrets.map(row)}</ul>
        )}
      </div>
    );
  const paths = settings && (
    <>
      <div>
        <h3 className="mb-1 text-xs text-muted-foreground">路径（环境变量）</h3>
        <ul className="space-y-1">{others.map(row)}</ul>
      </div>
      <p className="text-xs text-muted-foreground">改环境变量后要完全关掉程序再打开才生效。</p>
    </>
  );
  const diagnostics = desktopApi && (
    <DiagnosticsPanel api={desktopApi} readonly={settings?.mode === "readonly"} />
  );
  const header = (
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
  );
  const wizard = api && wizardOpen && (
    <ModelSetupWizard open={wizardOpen} onOpenChange={setWizardOpen} api={api} />
  );

  if (embedded) {
    const tab = (value: string, label: string, icon: ReactNode, content: ReactNode) => ({
      value,
      label,
      icon,
      content,
    });
    const tabs = [
      tab(
        "general",
        "通用",
        <SlidersHorizontal strokeWidth={1.5} />,
        <>
          {theme}
          <div>
            <h3 className="mb-1 text-xs text-muted-foreground">语言</h3>
            <p data-testid="settings-language">简体中文</p>
          </div>
        </>,
      ),
      tab(
        "project",
        "项目",
        <FolderGit2 strokeWidth={1.5} />,
        <>
          {loading}
          {project}
          {paths}
        </>,
      ),
      tab(
        "model",
        "模型",
        <Cpu strokeWidth={1.5} />,
        <>
          <ModelSettings {...(desktopApi && { api: desktopApi })} />
          {wizardButton}
        </>,
      ),
      tab(
        "budget",
        "预算",
        <Wallet strokeWidth={1.5} />,
        <p className="text-muted-foreground">
          每日预算、单张单上限、闲时偏好的设置在后续版本提供。
        </p>,
      ),
      tab(
        "secrets",
        "密钥",
        <KeyRound strokeWidth={1.5} />,
        <>
          {loading}
          {secretsBlock(false)}
        </>,
      ),
      tab(
        "diagnostics",
        "诊断",
        <Stethoscope strokeWidth={1.5} />,
        diagnostics ?? <p className="text-muted-foreground">没有连接主进程，不能导出诊断包。</p>,
      ),
      tab(
        "about",
        "关于",
        <Info strokeWidth={1.5} />,
        <SettingsAbout {...(desktopApi && { api: desktopApi })} />,
      ),
    ];
    return (
      <section aria-label="设置" className="flex min-h-0 min-w-0 flex-1 flex-col">
        {header}
        <Tabs
          defaultValue="general"
          orientation="vertical"
          className="flex min-h-0 flex-1"
          data-testid="settings-tabs"
        >
          <TabsList aria-label="设置分类" className="w-40 shrink-0 border-r border-border p-2">
            {tabs.map((t) => (
              <TabsTrigger key={t.value} value={t.value} className="justify-start">
                {t.icon}
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
          {tabs.map((t) => (
            <TabsContent
              key={t.value}
              value={t.value}
              className="min-w-0 flex-1 space-y-5 overflow-y-auto px-5 py-4 text-sm"
            >
              {errorAlert}
              {t.content}
            </TabsContent>
          ))}
        </Tabs>
        {wizard}
      </section>
    );
  }

  return (
    <section aria-label="设置" className="flex min-w-0 flex-1 flex-col">
      {header}
      <div className="space-y-5 overflow-y-auto px-4 py-4 text-sm">
        {errorAlert}
        {theme}
        {loading}
        {settings && (
          <>
            {project}
            {secretsBlock(true)}
            {paths}
            {diagnostics}
          </>
        )}
      </div>
      {wizard}
    </section>
  );
}
