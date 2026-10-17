// UI-02 Ctrl+K 搜索 / 跳转外壳（§2）：先能跳到主管、各项目，和几个常用动作；搜需求留给 UI-05。
import { FolderGit2, PanelLeft, PanelRight, Plus, Settings } from "lucide-react";
import { SHORTCUT_LABEL } from "../lib/shortcuts";
import { AgentIcon } from "./AgentIcon";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "./ui/command";
import type { ProjectView } from "../mock/types";

export interface CommandPaletteActions {
  goSupervisor: () => void;
  goProject: (projectId: string) => void;
  newRequirement: () => void;
  openSettings: () => void;
  toggleSidebar: () => void;
  toggleRightPanel: () => void;
}

export function CommandPalette({
  open,
  onOpenChange,
  projects,
  actions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: ProjectView[];
  actions: CommandPaletteActions;
}) {
  const run = (fn: () => void) => () => {
    onOpenChange(false);
    fn();
  };
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="搜索与跳转">
      <CommandInput placeholder="搜索或跳转…" aria-label="搜索或跳转" />
      <CommandList>
        <CommandEmpty>没有匹配的结果</CommandEmpty>
        <CommandGroup heading="跳转">
          <CommandItem value="主管" onSelect={run(actions.goSupervisor)}>
            <AgentIcon supervisor />
            主管
          </CommandItem>
          {projects.map((p) => (
            <CommandItem
              key={p.project.payload.project_id}
              value={`项目 ${p.project.payload.name}`}
              onSelect={run(() => actions.goProject(p.project.payload.project_id))}
            >
              <FolderGit2 strokeWidth={1.5} aria-hidden />
              {p.project.payload.name}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="操作">
          <CommandItem value="新需求" onSelect={run(actions.newRequirement)}>
            <Plus strokeWidth={1.5} aria-hidden />
            新需求
            <CommandShortcut>{SHORTCUT_LABEL.newRequirement}</CommandShortcut>
          </CommandItem>
          <CommandItem value="设置" onSelect={run(actions.openSettings)}>
            <Settings strokeWidth={1.5} aria-hidden />
            设置
            <CommandShortcut>{SHORTCUT_LABEL.settings}</CommandShortcut>
          </CommandItem>
          <CommandItem value="收起或展开左栏" onSelect={run(actions.toggleSidebar)}>
            <PanelLeft strokeWidth={1.5} aria-hidden />
            收起 / 展开左栏
            <CommandShortcut>{SHORTCUT_LABEL.toggleSidebar}</CommandShortcut>
          </CommandItem>
          <CommandItem value="打开或关闭右面板" onSelect={run(actions.toggleRightPanel)}>
            <PanelRight strokeWidth={1.5} aria-hidden />
            打开 / 关闭右面板
            <CommandShortcut>{SHORTCUT_LABEL.toggleRightPanel}</CommandShortcut>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
