// UI-07d：设置 › 项目——已导入项目列表（名称 + 仓库路径）、二次确认后移除、打开所在文件夹。
// 列表来自 project:list（模块 2 的 listProjects），移除后重新取列表，不靠事件流。
import { useCallback, useEffect, useState } from "react";
import { FolderOpen, Trash2 } from "lucide-react";
import type { BakaDesktopApi, DesktopProjectRow } from "../../shared/api";
import { PROJECT_COPY } from "../lib/projectSettings";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDangerButton,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

export type ProjectListApi = Pick<
  BakaDesktopApi,
  "listProjects" | "removeProject" | "openProjectFolder"
>;

export function ProjectList({
  api,
  readonly = false,
}: {
  api: ProjectListApi;
  readonly?: boolean;
}) {
  const [rows, setRows] = useState<DesktopProjectRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<DesktopProjectRow | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!api.listProjects) return;
    try {
      const r = await api.listProjects();
      if (r.ok) {
        setRows(r.projects);
        setError(null);
      } else setError(r.reason);
    } catch {
      setError(PROJECT_COPY.loadFailed);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const confirmRemove = async () => {
    if (!pending || !api.removeProject) return;
    setBusy(true);
    try {
      const r = await api.removeProject(pending.project_id);
      if (!r.ok) setError(r.reason);
      else setError(null);
    } catch {
      setError(PROJECT_COPY.removeFailed);
    } finally {
      setBusy(false);
      setPending(null);
      await load();
    }
  };

  const openFolder = async (id: string) => {
    if (!api.openProjectFolder) return;
    try {
      const r = await api.openProjectFolder(id);
      setError(r.ok ? null : r.reason);
    } catch {
      setError(PROJECT_COPY.loadFailed);
    }
  };

  if (!api.listProjects) return null;
  return (
    <div data-testid="project-list">
      <h3 className="mb-1 text-xs text-muted-foreground">{PROJECT_COPY.title}</h3>
      {error && (
        <p role="alert" className="mb-2 text-danger" data-testid="project-error">
          {error}
        </p>
      )}
      {rows === null && !error && <p className="text-muted-foreground">{PROJECT_COPY.loading}</p>}
      {rows && rows.length === 0 && (
        <p className="text-muted-foreground" data-testid="project-empty">
          {PROJECT_COPY.empty}
        </p>
      )}
      {rows && rows.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {rows.map((p) => (
            <li
              key={p.project_id}
              data-testid={`project-row-${p.project_id}`}
              className="flex items-center gap-3 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{p.name}</p>
                <p
                  className={
                    p.repo_path
                      ? "text-xs break-all text-muted-foreground"
                      : "text-xs text-muted-foreground italic"
                  }
                  data-testid="project-path"
                >
                  {p.repo_path || PROJECT_COPY.noPath}
                </p>
              </div>
              <Button
                variant="secondary"
                size="sm"
                aria-label={`${PROJECT_COPY.openFolder}：${p.name}`}
                disabled={!p.repo_path || !api.openProjectFolder}
                onClick={() => void openFolder(p.project_id)}
              >
                <FolderOpen strokeWidth={1.5} />
                {PROJECT_COPY.openFolder}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                aria-label={`${PROJECT_COPY.remove}：${p.name}`}
                title={readonly ? PROJECT_COPY.readonly : undefined}
                disabled={readonly || !api.removeProject}
                onClick={() => setPending(p)}
              >
                <Trash2 strokeWidth={1.5} />
                {PROJECT_COPY.remove}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Dialog open={!!pending} onOpenChange={(o) => !o && !busy && setPending(null)}>
        <DialogContent data-testid="project-remove-confirm">
          <DialogHeader>
            <DialogTitle>{pending && PROJECT_COPY.confirmTitle(pending.name)}</DialogTitle>
            <DialogDescription>{PROJECT_COPY.confirmBody}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" disabled={busy} onClick={() => setPending(null)}>
              {PROJECT_COPY.confirmCancel}
            </Button>
            <DialogDangerButton
              data-testid="project-remove-ok"
              disabled={busy}
              onClick={() => void confirmRemove()}
            >
              {PROJECT_COPY.confirmOk}
            </DialogDangerButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
