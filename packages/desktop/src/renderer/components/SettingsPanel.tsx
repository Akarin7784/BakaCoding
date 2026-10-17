// T-072：只读设置页——当前仓库、环境变量是否已设（只显示名字）、本地 / GitHub 模式。
import { ArrowLeft } from "lucide-react";
import type { DesktopSettings } from "../../shared/api";
import { Button } from "./ui/button";
import { ThemeSwitcher } from "./ThemeSwitcher";

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
}: {
  settings: DesktopSettings | null;
  error?: string | null;
  onBack: () => void;
  /** UI-02：放在设置弹层里时不画「返回」，关闭由弹层负责 */
  embedded?: boolean;
}) {
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
                密钥（环境变量，只显示是否已设）
              </h3>
              <ul className="space-y-1">{secrets.map(row)}</ul>
            </div>
            <div>
              <h3 className="mb-1 text-xs text-muted-foreground">路径（环境变量）</h3>
              <ul className="space-y-1">{others.map(row)}</ul>
            </div>
            <p className="text-xs text-muted-foreground">
              改环境变量后要完全关掉程序再打开才生效。
            </p>
          </>
        )}
      </div>
    </section>
  );
}
