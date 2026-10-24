// UI-07a：设置弹层「关于」标签：版本号、commit、运行时版本。
// 「诊断」标签直接复用 DiagnosticsPanel（导出、打开数据目录、最近一次启动错误详情都在里面）。
import { useEffect, useState } from "react";
import type { BakaDesktopApi, DesktopAbout } from "../../shared/api";

const Row = ({ label, value, testId }: { label: string; value: string; testId: string }) => (
  <li className="flex gap-3">
    <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
    <code data-testid={testId} className="break-all">
      {value}
    </code>
  </li>
);

/** 关于：版本号、commit、运行时版本（app:about，不带路径）。 */
export function SettingsAbout({ api }: { api?: Pick<BakaDesktopApi, "getAbout"> }) {
  const [about, setAbout] = useState<DesktopAbout | null | undefined>(undefined);
  useEffect(() => {
    if (!api?.getAbout) return;
    let live = true;
    api
      .getAbout()
      .then((a) => live && setAbout(a))
      .catch(() => live && setAbout(null));
    return () => {
      live = false;
    };
  }, [api]);
  const unknown = "未知";
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-medium">BakaCoding</h3>
        <p className="text-xs text-muted-foreground">多智能体自动开发桌面版</p>
      </div>
      {!api?.getAbout || about === null ? (
        <p className="text-muted-foreground">没有连接主进程，读不到版本信息。</p>
      ) : about === undefined ? (
        <p className="text-muted-foreground">读取中…</p>
      ) : (
        <ul className="space-y-1">
          <Row label="版本" value={about.version ?? unknown} testId="about-version" />
          <Row label="commit" value={about.commit ?? unknown} testId="about-commit" />
          <Row label="Electron" value={about.runtime.electron ?? unknown} testId="about-electron" />
          <Row label="Chromium" value={about.runtime.chrome ?? unknown} testId="about-chrome" />
          <Row label="Node.js" value={about.runtime.node ?? unknown} testId="about-node" />
        </ul>
      )}
    </div>
  );
}
