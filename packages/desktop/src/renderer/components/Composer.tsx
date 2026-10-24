// UI-04b：主管对话输入框（docs/ui-design.md §4.2、§6 自建 Composer）。
// 底部圆角框（radius 16）：左下项目 chip（DropdownMenu，含「不指定」），右下 ArrowUp 发送按钮。
// Enter 发送，Shift+Enter 换行；输入法组字中的 Enter 不发送。
import { ArrowUp, Check, ChevronDown, FolderGit2 } from "lucide-react";
import type { DesktopProjectRow } from "../../shared/api";
import { COMPOSER_COPY } from "../lib/copy";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

export interface ComposerProps {
  value: string;
  onChange: (v: string) => void;
  /** 按发送或 Enter；内容为空 / 只读时不会调 */
  onSend: () => void;
  /** chip 可选的项目（来自 project:list） */
  projects: readonly Pick<DesktopProjectRow, "project_id" | "name">[];
  /** 当前选中的项目；undefined =「不指定」 */
  projectId: string | undefined;
  onProjectChange: (id: string | undefined) => void;
  /** 只读：输入框、chip、发送都禁用 */
  readonly?: boolean;
  /** 等上一条回复：仍可打字，但不能发 */
  pending?: boolean;
  placeholder?: string;
  /** 透传给 textarea 的 data-composer（Ctrl+L 聚焦用） */
  composerId?: string;
  /** 发送按钮的 title（只读时说明原因） */
  sendTitle?: string;
}

export function Composer({
  value,
  onChange,
  onSend,
  projects,
  projectId,
  onProjectChange,
  readonly = false,
  pending = false,
  placeholder = COMPOSER_COPY.placeholder,
  composerId,
  sendTitle,
}: ComposerProps) {
  const empty = value.trim() === "";
  const canSend = !readonly && !pending && !empty;
  const selected = projects.find((p) => p.project_id === projectId);
  const chipText = projectId ? (selected?.name ?? projectId) : COMPOSER_COPY.noProject;
  const send = () => {
    if (canSend) onSend();
  };

  return (
    <div
      data-testid="composer"
      className="flex flex-col gap-2 rounded-[16px] border border-border bg-background px-3 pb-2 pt-3 focus-within:border-ring"
    >
      <textarea
        aria-label={COMPOSER_COPY.inputLabel}
        data-composer={composerId}
        rows={2}
        placeholder={placeholder}
        disabled={readonly}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
        className="max-h-48 min-h-10 w-full resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
      />
      <div className="flex items-center justify-between gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild disabled={readonly}>
            <button
              type="button"
              aria-label={COMPOSER_COPY.chipLabel}
              data-testid="composer-chip"
              className={cn(
                "inline-flex max-w-[16rem] items-center gap-1 rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-50",
                projectId && "text-foreground",
              )}
            >
              <FolderGit2 className="size-3.5 shrink-0" strokeWidth={1.5} />
              <span className="truncate">{chipText}</span>
              <ChevronDown className="size-3 shrink-0" strokeWidth={1.5} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top">
            {projects.map((p) => (
              <DropdownMenuItem key={p.project_id} onSelect={() => onProjectChange(p.project_id)}>
                <Check
                  className={cn(p.project_id !== projectId && "invisible")}
                  strokeWidth={1.5}
                />
                <span className="truncate">{p.name}</span>
              </DropdownMenuItem>
            ))}
            {projects.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem onSelect={() => onProjectChange(undefined)}>
              <Check className={cn(projectId !== undefined && "invisible")} strokeWidth={1.5} />
              {COMPOSER_COPY.noProject}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          size="icon"
          aria-label={COMPOSER_COPY.send}
          title={sendTitle}
          disabled={!canSend}
          onClick={send}
          className="size-8 rounded-full"
        >
          <ArrowUp strokeWidth={2} />
        </Button>
      </div>
    </div>
  );
}
