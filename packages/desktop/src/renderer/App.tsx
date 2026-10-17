import { useCallback, useState } from "react";
import { Download, FolderOpen } from "lucide-react";
import type { BakaDesktopApi, DesktopPendingHighRisk, DesktopSyncState } from "../shared/api";
import { ConversationList, type Selection } from "./components/Sidebar";
import { SupervisorChat } from "./components/SupervisorChat";
import { ProjectGroup } from "./components/ProjectGroup";
import { RightPanel } from "./components/RightPanel";
import { UnattributedPanel } from "./components/Escalations";
import { HighRiskPanel } from "./components/HighRiskPanel";
import { SyncStatus } from "./components/SyncStatus";
import { useDesktopData } from "./data/useDesktopData";
import { usePendingHighRisk } from "./data/usePendingHighRisk";
import { useSyncState } from "./data/useSyncState";
import { useProjectActions } from "./data/useProjectActions";
import { useBackendReadonly } from "./data/useBackendReadonly";
import { SettingsDialog } from "./components/SettingsDialog";
import { CommandPalette } from "./components/CommandPalette";
import { TitleBar } from "./components/TitleBar";
import { RightPanelShell, type RightPanelTab } from "./components/RightPanelShell";
import { AgentIcon } from "./components/AgentIcon";
import { Button } from "./components/ui/button";
import { useLayout } from "./lib/useLayout";
import { windowControlsInset } from "./lib/layout";
import { useShortcuts } from "./lib/shortcuts";
import * as mock from "./mock/data";
import type {
  EscalationView,
  FlashCallSummary,
  ProjectView,
  SupervisorMessage,
  TicketWarningView,
} from "./mock/types";

export interface AppProps {
  projects?: ProjectView[];
  supervisorMessages?: SupervisorMessage[];
  flashCalls?: Record<string, FlashCallSummary>;
  /** 找不到所属项目的上报（T-049）。 */
  unattributed?: EscalationView[];
  /** 找不到所属项目的 ticket_warning（T-050）。 */
  unattributedWarnings?: TicketWarningView[];
  /** 测试注入的待裁决高风险清单（T-062）；有 api 时以主进程为准。 */
  pendingHighRisk?: DesktopPendingHighRisk[];
  /** 测试注入的定时同步状态（T-067）；有 api 时以主进程为准。 */
  syncState?: DesktopSyncState;
  /** 数据来源；默认取 preload 暴露的 window.bakacoding，传 null 强制用假数据。 */
  api?: BakaDesktopApi | null;
  /** 导入成功后重新加载界面（T-072）；测试注入 */
  onReload?: () => void;
}

function dbNotice(db: NonNullable<ReturnType<typeof useDesktopData>>["db"]): string | null {
  if (!db || db.state === "ok") return null;
  if (db.state === "missing") return `还没有找到数据库：${db.path}`;
  return `数据库打不开：${db.message}`;
}

export function App(props: AppProps) {
  const api = props.api === undefined ? globalThis.window?.bakacoding : (props.api ?? undefined);
  const live = useDesktopData(api);
  const projects = props.projects ?? live?.projects ?? mock.projects;
  const flashCalls = props.flashCalls ?? live?.flashCalls ?? mock.flashCalls;
  const unattributed = props.unattributed ?? live?.unattributed ?? [];
  const unattributedWarnings = props.unattributedWarnings ?? live?.unattributedWarnings ?? [];
  // 主管对话的历史还没有落库来源，接入真实数据时先从空对话开始。
  const supervisorMessages = props.supervisorMessages ?? (live ? [] : mock.supervisorMessages);
  const highRisk = usePendingHighRisk(api, props.pendingHighRisk ?? []);
  const syncState = useSyncState(api, props.syncState ?? null);
  const actions = useProjectActions(api, props.onReload);
  const backendReadonly = useBackendReadonly(api);
  const layout = useLayout();
  const inset = windowControlsInset(api?.platform);

  const [selection, setSelection] = useState<Selection>({ kind: "supervisor" });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [panelTab, setPanelTab] = useState<RightPanelTab>("overview");
  const [lastProjectId, setLastProjectId] = useState<string | undefined>(
    projects[0]?.project.payload.project_id,
  );

  const select = (s: Selection) => {
    setSelection(s);
    if (s.kind === "project") setLastProjectId(s.projectId);
  };
  const currentId =
    selection.kind === "project"
      ? selection.projectId
      : (lastProjectId ?? projects[0]?.project.payload.project_id);
  const current = projects.find((p) => p.project.payload.project_id === currentId);
  const notice = live ? dbNotice(live.db) : null;
  const showProject = selection.kind === "project" && current !== undefined;

  // 当前视图相关的高风险单优先；主管页显示全部
  const panelItems =
    selection.kind === "project" && current
      ? highRisk.items.filter((i) => i.project_id === current.project.payload.project_id)
      : highRisk.items;

  /** Ctrl+N：回到主管对话并把光标放进输入框（新需求只能在主管对话里提，§3） */
  const newRequirement = useCallback(() => {
    setSelection({ kind: "supervisor" });
    setTimeout(() => {
      globalThis.document
        ?.querySelector<HTMLTextAreaElement>('[data-composer="supervisor"]')
        ?.focus();
    }, 0);
  }, []);
  const openSettings = () => void actions.openSettings();

  useShortcuts(
    {
      newRequirement,
      commandPalette: () => setPaletteOpen((o) => !o),
      settings: openSettings,
      toggleSidebar: layout.toggleSidebar,
      toggleRightPanel: layout.toggleRightPanel,
    },
    api?.platform,
  );

  const readonlyTag = backendReadonly ? (
    <span className="text-xs font-normal text-muted-foreground" data-testid="readonly-tag">
      只读
    </span>
  ) : null;
  const title =
    selection.kind === "unattributed" ? (
      <>
        <span className="truncate">未归属</span>
        {readonlyTag}
      </>
    ) : showProject ? (
      <>
        <span className="truncate"># {current.project.payload.name}</span>
        {readonlyTag}
      </>
    ) : (
      <>
        <AgentIcon supervisor />
        <span>主管</span>
      </>
    );
  // 主管页的导入 / 导出放在标题栏（都是次按钮；每屏最多一个主按钮，§5.3）
  const titleActions =
    selection.kind === "supervisor" || !current ? (
      <>
        {api && (
          <Button
            variant="secondary"
            size="sm"
            aria-label="导入项目"
            disabled={actions.busy !== null}
            onClick={() => void actions.importProject()}
          >
            <FolderOpen strokeWidth={1.5} />
            {actions.busy === "import" ? "导入中…" : "导入项目"}
          </Button>
        )}
        <Button
          variant="secondary"
          size="sm"
          aria-label="导出诊断包"
          disabled={actions.busy !== null}
          onClick={() => void actions.exportDiagnostics()}
        >
          <Download strokeWidth={1.5} />
          {actions.busy === "export" ? "导出中…" : "导出"}
        </Button>
      </>
    ) : null;

  const panelDocked = layout.rightPanelOpen && !layout.drawer;

  return (
    <div className="flex h-screen min-h-0 bg-background text-foreground">
      <ConversationList
        projects={projects}
        unattributedCount={unattributed.length + unattributedWarnings.length}
        selection={selection}
        onSelect={select}
        collapsed={layout.sidebarCollapsed}
        onToggleCollapsed={layout.toggleSidebar}
        onNewRequirement={newRequirement}
        onOpenSettings={openSettings}
        insetLeft={inset.left}
      />
      <main aria-label="内容区" className="flex min-h-0 min-w-0 flex-1 flex-col">
        <TitleBar
          title={title}
          actions={titleActions}
          rightPanelOpen={layout.rightPanelOpen}
          onToggleRightPanel={layout.toggleRightPanel}
          insetRight={panelDocked ? 0 : inset.right}
        />
        {notice && (
          <div
            role="status"
            className="border-b border-border px-4 py-1 text-xs text-muted-foreground"
          >
            {notice}
          </div>
        )}
        {syncState && <SyncStatus state={syncState} />}
        {actions.notice && (
          <div
            role={actions.notice.tone === "error" ? "alert" : "status"}
            data-testid="action-notice"
            className={
              actions.notice.tone === "error"
                ? "border-b border-border px-4 py-1 text-xs text-danger break-all"
                : "border-b border-border px-4 py-1 text-xs text-muted-foreground break-all"
            }
          >
            {actions.notice.text}
          </div>
        )}
        <HighRiskPanel items={panelItems} onDecide={highRisk.decide} />
        {selection.kind === "unattributed" ? (
          <UnattributedPanel
            escalations={unattributed}
            warnings={unattributedWarnings}
            readonly={backendReadonly}
            showHeader={false}
          />
        ) : showProject ? (
          <>
            <ProjectGroup
              view={current}
              calls={flashCalls}
              readonly={backendReadonly}
              showHeader={false}
            />
            {/* 选中项目时也能和主管说话，消息带上这个项目（T-072） */}
            <SupervisorChat
              compact
              initial={supervisorMessages}
              api={api}
              projectId={current.project.payload.project_id}
            />
          </>
        ) : (
          <SupervisorChat
            showHeader={false}
            initial={supervisorMessages}
            busy={actions.busy}
            api={api}
          />
        )}
      </main>
      <RightPanelShell
        open={layout.rightPanelOpen}
        drawer={layout.drawer}
        onClose={() => layout.setRightPanelOpen(false)}
        tab={panelTab}
        onTabChange={setPanelTab}
        insetRight={inset.right}
        overview={
          current ? (
            <RightPanel
              view={current}
              onOpenTopic={(rid) => {
                select({ kind: "project", projectId: current.project.payload.project_id });
                if (layout.drawer) layout.setRightPanelOpen(false);
                setTimeout(
                  () =>
                    document.getElementById(`topic-${rid}`)?.scrollIntoView({ behavior: "smooth" }),
                  0,
                );
              }}
            />
          ) : null
        }
      />
      <SettingsDialog
        open={actions.settingsOpen}
        onOpenChange={(o) => (o ? openSettings() : actions.closeSettings())}
        settings={actions.settings}
        error={actions.settingsError}
      />
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        projects={projects}
        actions={{
          goSupervisor: () => select({ kind: "supervisor" }),
          goProject: (id) => select({ kind: "project", projectId: id }),
          newRequirement,
          openSettings,
          toggleSidebar: layout.toggleSidebar,
          toggleRightPanel: layout.toggleRightPanel,
        }}
      />
    </div>
  );
}
