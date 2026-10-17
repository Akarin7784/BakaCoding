// 空状态（§1「每个页面都要有空状态」）：一个图标、一句话，可带一个次按钮。
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function EmptyState({
  icon: Icon,
  title,
  children,
}: {
  icon?: LucideIcon;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div
      data-testid="empty-state"
      className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center text-sm text-muted-foreground"
    >
      {Icon && <Icon size={20} strokeWidth={1.5} aria-hidden />}
      <p>{title}</p>
      {children}
    </div>
  );
}
