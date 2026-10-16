import { useState } from "react";
import { ConversationList, type Selection } from "./components/Sidebar";
import { SupervisorChat } from "./components/SupervisorChat";
import { ProjectGroup } from "./components/ProjectGroup";
import { RightPanel } from "./components/RightPanel";
import * as mock from "./mock/data";
import type { FlashCallSummary, ProjectView, SupervisorMessage } from "./mock/types";

export interface AppProps {
  projects?: ProjectView[];
  supervisorMessages?: SupervisorMessage[];
  flashCalls?: Record<string, FlashCallSummary>;
}

export function App({
  projects = mock.projects,
  supervisorMessages = mock.supervisorMessages,
  flashCalls = mock.flashCalls,
}: AppProps) {
  const [selection, setSelection] = useState<Selection>({ kind: "supervisor" });
  const [sidebarOpen, setSidebarOpen] = useState(false); // 默认关闭
  const [lastProjectId, setLastProjectId] = useState(projects[0]?.project.payload.project_id);

  const select = (s: Selection) => {
    setSelection(s);
    if (s.kind === "project") setLastProjectId(s.projectId);
  };
  const currentId = selection.kind === "project" ? selection.projectId : lastProjectId;
  const current = projects.find((p) => p.project.payload.project_id === currentId);

  return (
    <div className="flex h-screen bg-background text-foreground">
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
  );
}
