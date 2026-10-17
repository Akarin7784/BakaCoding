import { useState } from "react";
import type { BakaDesktopApi } from "../shared/api";
import { ConversationList, type Selection } from "./components/Sidebar";
import { SupervisorChat } from "./components/SupervisorChat";
import { ProjectGroup } from "./components/ProjectGroup";
import { RightPanel } from "./components/RightPanel";
import { useDesktopData } from "./data/useDesktopData";
import * as mock from "./mock/data";
import type { FlashCallSummary, ProjectView, SupervisorMessage } from "./mock/types";

export interface AppProps {
  projects?: ProjectView[];
  supervisorMessages?: SupervisorMessage[];
  flashCalls?: Record<string, FlashCallSummary>;
  /** 数据来源；默认取 preload 暴露的 window.bakacoding，传 null 强制用假数据。 */
  api?: BakaDesktopApi | null;
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
  // 主管对话的历史还没有落库来源，接入真实数据时先从空对话开始。
  const supervisorMessages = props.supervisorMessages ?? (live ? [] : mock.supervisorMessages);

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
      <div className="flex min-h-0 flex-1">
        <ConversationList projects={projects} selection={selection} onSelect={select} />
        {selection.kind === "supervisor" || !current ? (
          <SupervisorChat initial={supervisorMessages} />
        ) : (
          <ProjectGroup
            view={current}
            calls={flashCalls}
            sidebarOpen={sidebarOpen}
            onToggleSidebar={() => setSidebarOpen((o) => !o)}
          />
        )}
        {sidebarOpen && current && (
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
