import { useState } from "react";
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
import { SettingsPanel } from "./components/SettingsPanel";
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

  const [selection, setSelection] = useState<Selection>({ kind: "supervisor" });
  const [sidebarOpen, setSidebarOpen] = useState(false); // 默认关闭
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

  // 当前视图相关的高风险单优先；主管页显示全部
  const panelItems =
    selection.kind === "project" && current
      ? highRisk.items.filter((i) => i.project_id === current.project.payload.project_id)
      : highRisk.items;

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
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
              ? "border-b border-border px-4 py-1 text-xs text-accent break-all"
              : "border-b border-border px-4 py-1 text-xs text-muted-foreground break-all"
          }
        >
          {actions.notice.text}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <ConversationList
          projects={projects}
          unattributedCount={unattributed.length + unattributedWarnings.length}
          selection={selection}
          onSelect={select}
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <HighRiskPanel items={panelItems} onDecide={highRisk.decide} />
          {selection.kind === "unattributed" ? (
            <UnattributedPanel
              escalations={unattributed}
              warnings={unattributedWarnings}
              readonly={backendReadonly}
            />
          ) : actions.settingsOpen ? (
            <SettingsPanel
              settings={actions.settings}
              error={actions.settingsError}
              onBack={actions.closeSettings}
            />
          ) : selection.kind === "supervisor" || !current ? (
            <SupervisorChat
              initial={supervisorMessages}
              busy={actions.busy}
              onOpenSettings={() => void actions.openSettings()}
              onExport={() => void actions.exportDiagnostics()}
              {...(api && { onImport: () => void actions.importProject() })}
              api={api}
              projectId={
                selection.kind === "project" ? current?.project.payload.project_id : undefined
              }
            />
          ) : (
            <>
              <ProjectGroup
                view={current}
                calls={flashCalls}
                sidebarOpen={sidebarOpen}
                readonly={backendReadonly}
                onToggleSidebar={() => setSidebarOpen((o) => !o)}
              />
              {/* 选中项目时也能和主管说话，消息带上这个项目（T-072） */}
              <SupervisorChat
                compact
                initial={supervisorMessages}
                api={api}
                projectId={current.project.payload.project_id}
              />
            </>
          )}
        </div>
        {sidebarOpen && current && selection.kind !== "unattributed" && (
          <RightPanel
            view={current}
            onOpenTopic={(rid) => {
              select({ kind: "project", projectId: current.project.payload.project_id });
              document.getElementById(`topic-${rid}`)?.scrollIntoView({ behavior: "smooth" });
            }}
          />
        )}
      </div>
    </div>
  );
}
