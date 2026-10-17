// shadcn/ui Input。高度与按钮一致（34），圆角 8（§5.3、§5.4）。
import * as React from "react";
import { cn } from "../../lib/utils";

export function Input({ className, type = "text", ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      className={cn(
        "h-[34px] w-full min-w-0 rounded-md border border-border bg-transparent px-3 text-sm transition-colors placeholder:text-muted-foreground focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-danger",
        className,
      )}
      {...props}
    />
  );
}
