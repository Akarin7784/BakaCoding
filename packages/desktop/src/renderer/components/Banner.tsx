// UI-08：页面横幅（§3、§4.7）。内容区顶部一条，不是小字；只读 / 缺配置这类要你处理的状态用 danger 浅底。
// 按钮都是次按钮（每屏最多一个主按钮，§5.3）。
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/utils";

export function Banner({
  icon: Icon,
  children,
  actions,
  tone = "danger",
  label,
  testId,
}: {
  icon?: LucideIcon;
  children: ReactNode;
  actions?: ReactNode;
  tone?: "danger" | "neutral";
  /** 读屏用的区域名 */
  label: string;
  testId?: string;
}) {
  return (
    <section
      role="region"
      aria-label={label}
      data-testid={testId}
      data-tone={tone}
      className={cn(
        "flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-2 text-sm",
        tone === "danger" ? "bg-danger-soft text-foreground" : "bg-sidebar text-foreground",
      )}
    >
      {Icon && (
        <Icon
          size={16}
          strokeWidth={1.5}
          aria-hidden
          className={cn("shrink-0", tone === "danger" ? "text-danger" : "text-muted-foreground")}
        />
      )}
      <div className="min-w-0 flex-1 break-words">{children}</div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </section>
  );
}
