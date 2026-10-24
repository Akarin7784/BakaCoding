import { useCallback, useMemo, useState } from "react";
import { Download, FolderOpen } from "lucide-react";
import type {
  BakaDesktopApi,
  DesktopPendingHighRisk,
  DesktopSupervisorMessage,
  DesktopSyncState,
  TicketView,
  UiEvent,
} from "../shared/api";
import { ConversationList, type Selection } from "./components/Sidebar";
import { SupervisorChat } from "./components/SupervisorChat";
import { ProjectPage } from "./components/ProjectPage";
import { listRequirements, requirementName } from "./lib/requirementList";
import { RightPanel } from "./components/RightPanel";
import { UnattributedPanel } from "./components/Escalations";
import { RequirementPage } from "./components/RequirementPage";
import { useRequirementRoute } from "./lib/requirementRoute";
import { REQUIREMENT_MENU_COPY as M, REQUIREMENT_PAGE_COPY, TICKET_LIST_COPY } from "./lib/copy";
import { EmptyState } from "./components/EmptyState";
import { useDesktopData } from "./data/useDesktopData";
import { usePendingHighRisk } from "./data/usePendingHighRisk";
import { useSyncState } from "./data/useSyncState";
import { useGitStatus } from "./data/useGitStatus";
import { usePoolState } from "./data/usePoolState";
import { poolRowOf } from "./lib/poolState";
import type { PoolLive } from "./components/RightPanel";
import { useProjectActions } from "./data/useProjectActions";
import { useBackendStatus } from "./data/useBackendStatus";
import { useQuitting } from "./data/useQuitting";
import { QuittingBanner } from "./components/QuittingBanner";
import { ReadonlyBanner } from "./components/ReadonlyBanner";
import { MissingConfigBanner } from "./components/MissingConfigBanner";
import { StatusDot } from "./components/StatusDot";
import { attentionItems, globalLevel, runningCount } from "./lib/globalStatus";
import { describeSyncState } from "./lib/sync-labels";
import { notifyError, notifyOk } from "./lib/notify";
import { needsImportFirst, READONLY_COPY, repoFixRoute, repoSourceWritable } from "./lib/readonly";
import { PREP_COPY } from "./lib/repoPrep";
import { RepoPrepPage } from "./components/RepoPrepPage";
import { useWindowControlsInset } from "./lib/useWindowControlsInset";
import { SettingsDialog } from "./components/SettingsDialog";
import { CommandPalette } from "./components/CommandPalette";
import { TitleBar } from "./components/TitleBar";
import { RightPanelShell, type RightPanelTab } from "./components/RightPanelShell";
import { ActivityFeed } from "./components/ActivityFeed";
import { useActivityDot } from "./data/useActivityDot";
import { AgentIcon } from "./components/AgentIcon";
import { Button } from "./components/ui/button";
import { useLayout } from "./lib/useLayout";
import { useShortcuts } from "./lib/shortcuts";
import * as mock from "./mock/data";
import { failureText } from "../shared/error-text";
import { attentionOf } from "./lib/attention";
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
  /** 测试注入的快照单子 / 事件（UI-05c 需求页）；有 api 时以主进程为准。 */
  tickets?: TicketView[];
  events?: UiEvent[];
  /** 测试 / 截图注入「正在退出」（T-106）；有 api 时以主进程的 app:quitting 为准。 */
  quitting?: boolean;
}

export function App(props: AppProps) {
  const api = props.api === undefined ? globalThis.window?.bakacoding : (props.api ?? undefined);
  const live = useDesktopData(api);
  const projects = props.projects ?? live?.projects ?? mock.projects;
  // UI-05e：项目页不再平铺项目群消息，闪调摘要暂不展示（flashCalls 入参保留，待定，见 PR 开放问题）
  const unattributed = props.unattributed ?? live?.unattributed ?? [];
  const unattributedWarnings = props.unattributedWarnings ?? live?.unattributedWarnings ?? [];
  // UI-05c：需求页的数据——当前状态只看快照 tickets，事件只给标记 / 时间线
  const tickets = props.tickets ?? live?.tickets ?? mock.tickets;
  const events = useMemo<UiEvent[]>(
    () => props.events ?? live?.events ?? mock.projects.flatMap((p) => p.messages as UiEvent[]),
    [props.events, live?.events],
  );
  // 主管对话的历史还没有落库来源，接入真实数据时先从空对话开始。
  const supervisorMessages = useMemo(
    () => toStoredMessages(props.supervisorMessages ?? (live ? [] : mock.supervisorMessages)),
    [props.supervisorMessages, live],
  );
  const highRisk = usePendingHighRisk(api, props.pendingHighRisk ?? []);
  const syncState = useSyncState(api, props.syncState ?? null);
  // UI-06c：Git 区随快照（tickets 引用变）和同步状态更新重新取，不轮询
  const gitStatus = useGitStatus(api, live?.events, live?.tickets, syncState);
  // UI-06b：编码池状态随快照刷新（live 对象一变就重取），不轮询
  const poolResult = usePoolState(api, live);
  const poolLive = useMemo<PoolLive | null>(
    () =>
      poolResult === null
        ? null
        : poolResult.ok
          ? { ok: true, row: poolRowOf(poolResult.state, tickets) }
          : poolResult,
    [poolResult, tickets],
  );
  const backend = useBackendStatus(api);
  /** UI-03a：项目准备页（从只读横幅「准备仓库」进来，占内容区；左栏选别的就关掉） */
  const [prepOpen, setPrepOpen] = useState(false);
  // UI-03b：导入的文件夹还没准备好时直接进准备页
  const actions = useProjectActions(api, props.onReload, undefined, () => {
    setSelection({ kind: "supervisor" });
    setPrepOpen(true);
    void backend.refresh();
  });
  const quitting = useQuitting(api, props.quitting ?? false);
  const backendReadonly = backend.readonly;
  const [reconnecting, setReconnecting] = useState(false);
  const layout = useLayout();
  const inset = useWindowControlsInset(api?.platform);

  const [selection, setSelection] = useState<Selection>({ kind: "supervisor" });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [panelTab, setPanelTab] = useState<RightPanelTab>("overview");
  /** UI-06a：主管对话里右面板跟随输入框 chip 选中的项目（不再回退到最后一个项目） */
  const [chatProjectId, setChatProjectId] = useState<string | undefined>(undefined);
  /** UI-06a：从右面板单列表点进需求页时选中的单 */
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);

  /** UI-05c：需求页走路由 #requirement=<id>（左栏的需求列表留给 05e，「查看需求」按钮留给 05f） */
  const [requirementId, openRequirement] = useRequirementRoute();
  const select = (s: Selection) => {
    setPrepOpen(false);
    openRequirement(null);
    setSelectedTicketId(null);
    setSelection(s);
  };
  const currentId =
    selection.kind === "project"
      ? selection.projectId
      : selection.kind === "supervisor"
        ? chatProjectId
        : undefined;
  const current = projects.find((p) => p.project.payload.project_id === currentId);
  const showProject = selection.kind === "project" && current !== undefined;
  // T-127：动态标签的小点——面板开着且停在动态标签才算已读（§4.5.1）
  const viewingActivity = layout.rightPanelOpen && panelTab === "activity";
  const activityDot = useActivityDot(current, viewingActivity);

  // UI-05d：左栏红点（高风险待裁决 / 有单上报）
  const attention = useMemo(() => attentionOf(tickets, highRisk.items), [tickets, highRisk.items]);
  // UI-05e：左栏每个项目下的需求列表（和项目页同一套排序 / 命名）
  const sidebarRequirements = useMemo(
    () =>
      Object.fromEntries(
        projects.map((p) => {
          const pid = p.project.payload.project_id;
          return [pid, listRequirements(pid, tickets, events, attention.requirements)];
        }),
      ),
    [projects, tickets, events, attention.requirements],
  );
  /** UI-05e：左栏 / 项目页点需求：选中所属项目，再打开 #requirement=<id> */
  const openRequirementOf = (projectId: string, rid: string, ticketId: string | null = null) => {
    setPrepOpen(false);
    setSelection({ kind: "project", projectId });
    setSelectedTicketId(ticketId);
    openRequirement(rid);
  };

  /** UI-05f：「已派单」卡片「查看需求」：快照里找得到所属项目就一并选中 */
  const viewRequirement = (rid: string) => {
    const pid = tickets.find((t) => t.requirement_id === rid)?.project_id;
    if (pid) openRequirementOf(pid, rid);
    else {
      setPrepOpen(false);
      setSelectedTicketId(null);
      openRequirement(rid);
    }
  };
  /** UI-05f：需求页追问 / 需要你处理：回主管对话，草稿带上下文（只填不发），光标放进输入框 */
  const [chatPrefill, setChatPrefill] = useState<string | null>(null);
  const clearPrefill = useCallback(() => setChatPrefill(null), []);
  const askSupervisor = (text: string) => {
    setPrepOpen(false);
    openRequirement(null);
    setSelectedTicketId(null);
    setSelection({ kind: "supervisor" });
    setChatPrefill(text);
    setTimeout(() => {
      globalThis.document
        ?.querySelector<HTMLTextAreaElement>('[data-composer="supervisor"]')
        ?.focus();
    }, 0);
  };
  const requirementNameOf = (rid: string) => {
    const first = tickets
      .filter((t) => t.requirement_id === rid)
      .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))[0];
    return first ? requirementName(first.title) || rid : rid;
  };

  /** Ctrl+N：回到主管对话并把光标放进输入框（新需求只能在主管对话里提，§3） */
  const newRequirement = useCallback(() => {
    // UI-05g：也清掉 #requirement 路由，否则需求页还盖在主管对话上
    openRequirement(null);
    setSelection({ kind: "supervisor" });
    setTimeout(() => {
      globalThis.document
        ?.querySelector<HTMLTextAreaElement>('[data-composer="supervisor"]')
        ?.focus();
    }, 0);
  }, [openRequirement]);
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
  const prepRoute = backend.status ? repoFixRoute(backend.status) : null;
  const canPrepare = !!api?.checkRepo;
  // 来源是当前工作目录（评审 B1）时不显示准备页（即使之前开着）
  const showPrep = prepOpen && canPrepare && !!backend.status && repoSourceWritable(backend.status);
  const showRequirement = !showPrep && requirementId !== null;
  const title = showPrep ? (
    <span className="truncate">{PREP_COPY.title}</span>
  ) : showRequirement ? (
    <>
      <span className="truncate">{REQUIREMENT_PAGE_COPY.label}</span>
      {readonlyTag}
    </>
  ) : selection.kind === "unattributed" ? (
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
    showPrep || showRequirement ? null : selection.kind === "supervisor" || !current ? (
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
          disabled={actions.busy !== null || backendReadonly}
          title={backendReadonly ? READONLY_COPY.exportDisabled : undefined}
          onClick={() => void actions.exportDiagnostics()}
        >
          <Download strokeWidth={1.5} />
          {actions.busy === "export" ? "导出中…" : "导出"}
        </Button>
      </>
    ) : null;

  const panelDocked = layout.rightPanelOpen && !layout.drawer;

  // UI-08 全局状态点（§4.8）
  const unattributedCount = unattributed.length + unattributedWarnings.length;
  const syncView = syncState ? describeSyncState(syncState) : null;
  const statusInput = {
    projects,
    readonly: backendReadonly,
    dbError: live?.db?.state === "error",
    syncAlert: syncView?.tone === "error" || syncView?.tone === "warn",
    pendingHighRisk: highRisk.items.length,
    unattributed: unattributedCount,
  };
  const level = globalLevel(statusInput);

  /** 只读横幅「重新连接」（§4.7，接 T-093 的 backend:reconnect） */
  const reconnect = api?.reconnectBackend
    ? async () => {
        if (reconnecting) return;
        setReconnecting(true);
        try {
          const r = await api.reconnectBackend();
          if (r.state === "reloaded") notifyOk("已重新连接");
          else if (r.state === "queued")
            notifyOk(
              r.waitingTickets > 0
                ? `还有 ${r.waitingTickets} 张单在进行中，完成后自动重新连接`
                : "主管还在回复，完成后自动重新连接",
            );
          else notifyError(failureText("重新连接失败", r.reason));
        } catch {
          notifyError("重新连接失败：和主进程通信失败，请重试");
        } finally {
          setReconnecting(false);
          await backend.refresh();
        }
      }
    : undefined;

  return (
    <div className="flex h-screen min-h-0 bg-background text-foreground">
      <ConversationList
        projects={projects}
        status={
          <StatusDot
            level={level}
            backend={backend.status}
            db={live?.db}
            attention={attentionItems(statusInput)}
            running={runningCount(projects)}
            unattributed={unattributedCount}
            onOpenUnattributed={() => select({ kind: "unattributed" })}
            collapsed={layout.sidebarCollapsed}
          />
        }
        selection={selection}
        onSelect={select}
        attention={attention.projects}
        requirements={sidebarRequirements}
        requirementAttention={attention.requirements}
        currentRequirement={showRequirement ? requirementId : null}
        onOpenRequirement={openRequirementOf}
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
          rightPanelDot={activityDot && !layout.rightPanelOpen}
          insetRight={panelDocked ? 0 : inset.right}
        />
        {quitting && <QuittingBanner />}
        {/* T-081：只缺配置时给一行「缺配置」横幅 + 用默认模板创建（§3：页面横幅带操作按钮） */}
        {actions.canCreateDefaultConfig && (
          <MissingConfigBanner
            busy={actions.busy !== null}
            onCreate={() => void actions.createDefaultConfig()}
          />
        )}
        {backendReadonly && backend.status && (
          <ReadonlyBanner
            status={backend.status}
            reconnecting={reconnecting}
            {...(reconnect && { onReconnect: () => void reconnect() })}
            {...(canPrepare && prepRoute && !showPrep && { onPrepare: () => setPrepOpen(true) })}
            {...(api &&
              needsImportFirst(backend.status) && {
                onImport: () => void actions.importProject(),
              })}
          />
        )}
        {showPrep && api ? (
          <RepoPrepPage
            api={api}
            route={prepRoute}
            onBack={() => setPrepOpen(false)}
            onFixed={() => backend.refresh()}
          />
        ) : showRequirement ? (
          <RequirementPage
            requirementId={requirementId}
            selectedTicketId={selectedTicketId}
            tickets={tickets}
            events={events}
            api={api}
            highRisk={highRisk.items}
            onDecideHighRisk={highRisk.decide}
            readonly={backendReadonly}
            onEscalationAction={(tid) =>
              askSupervisor(M.escalationDraft(tid, requirementNameOf(requirementId)))
            }
            onAsk={() => askSupervisor(M.askDraft(requirementNameOf(requirementId), requirementId))}
            onExport={(scope) => void actions.exportDiagnostics({ scope })}
            exportBusy={actions.busy === "export"}
          />
        ) : selection.kind === "unattributed" ? (
          <UnattributedPanel
            escalations={unattributed}
            warnings={unattributedWarnings}
            readonly={backendReadonly}
            showHeader={false}
          />
        ) : showProject ? (
          <>
            {/* UI-05e：项目页 = 需求列表总览（§4.3），点开进需求页 */}
            <ProjectPage
              view={current}
              tickets={tickets}
              events={events}
              attention={attention.requirements}
              onOpenRequirement={(rid) =>
                openRequirementOf(current.project.payload.project_id, rid)
              }
              onNewRequirement={newRequirement}
            />
            {/* 选中项目时也能和主管说话，消息带上这个项目（T-072） */}
            <SupervisorChat
              compact
              initial={supervisorMessages}
              api={api}
              projectId={current.project.payload.project_id}
              readonly={backendReadonly}
              onOpenRequirement={viewRequirement}
              requirementNameOf={requirementNameOf}
            />
          </>
        ) : (
          <SupervisorChat
            showHeader={false}
            initial={supervisorMessages}
            busy={actions.busy === "create-config" ? "import" : actions.busy}
            api={api}
            readonly={backendReadonly}
            onOpenRequirement={viewRequirement}
            requirementNameOf={requirementNameOf}
            prefill={chatPrefill}
            onPrefillUsed={clearPrefill}
            onChipProjectChange={setChatProjectId}
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
        activityDot={activityDot}
        activity={<ActivityFeed project={current} tickets={tickets} />}
        overview={
          current ? (
            <RightPanel
              view={current}
              readonly={backendReadonly}
              pool={poolLive}
              tickets={tickets}
              {...(api?.getGitStatus ? { gitStatus, sync: syncState } : {})}
              exportBusy={actions.busy === "export"}
              onOpenTicket={(rid, tid) => {
                openRequirementOf(current.project.payload.project_id, rid, tid);
                if (layout.drawer) layout.setRightPanelOpen(false);
              }}
              onExportTicket={(tid) =>
                void actions.exportDiagnostics({ scope: { kind: "ticket", ticket_id: tid } })
              }
            />
          ) : projects.length > 0 ? (
            <EmptyState title={TICKET_LIST_COPY.noProject} />
          ) : null
        }
      />
      <SettingsDialog
        open={actions.settingsOpen}
        onOpenChange={(o) => (o ? openSettings() : actions.closeSettings())}
        settings={actions.settings}
        error={actions.settingsError}
        {...(api?.secretStatus && { api })}
        {...(api && { desktopApi: api })}
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

/** 假数据 / 测试注入的消息转成存储形状（UI-04a：对话记录统一用 2 / 10 的 SupervisorMessage）。 */
function toStoredMessages(list: readonly SupervisorMessage[]): DesktopSupervisorMessage[] {
  return list.map((m) => ({
    message_id: m.id,
    project_id: null,
    role: m.from,
    kind: m.from === "supervisor" ? "answer" : null,
    content: m.content,
    requirement_id: null,
    ticket_ids: [],
    created_at: Date.parse(m.ts) || 0,
  }));
}
