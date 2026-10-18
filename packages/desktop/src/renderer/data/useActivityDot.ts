// T-127：右面板「动态」标签的小点（§4.5.1）。
// 规则：面板关着时有新消息才亮；打开动态标签即视为看过。按项目分别记最后看过哪条，
// 切项目不会把另一个项目的旧消息当新消息。第一次看到某个项目时的历史消息不算新消息。
import { useEffect, useState } from "react";
import type { ProjectView } from "../mock/types";

export function useActivityDot(
  project: ProjectView | undefined,
  viewingActivity: boolean,
): boolean {
  const [seen, setSeen] = useState<Record<string, string | null>>({});
  const projectId = project?.project.payload.project_id;
  const latest = project?.messages.at(-1)?.event_id ?? null;

  useEffect(() => {
    if (!projectId) return;
    // 正在看动态，或第一次看到这个项目：把当前最新一条记为已读
    if (viewingActivity || !(projectId in seen)) {
      setSeen((s) => (s[projectId] === latest ? s : { ...s, [projectId]: latest }));
    }
  }, [projectId, latest, viewingActivity, seen]);

  if (!projectId || !(projectId in seen)) return false;
  return !viewingActivity && seen[projectId] !== latest;
}
