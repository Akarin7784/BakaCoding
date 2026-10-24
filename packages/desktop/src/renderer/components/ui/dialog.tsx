// shadcn/ui Dialog（radix-ui）。设置弹层、确认框用它（§4.6、§1「写用户仓库必须确认」）。
// 危险按钮只在这里提供（DialogDangerButton），页面上不出现危险样式的按钮（§5.3）。
import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { X } from "lucide-react";
import { cn } from "../../lib/utils";
import { buttonVariants } from "./button";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogPortal = DialogPrimitive.Portal;
export const DialogClose = DialogPrimitive.Close;

export function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      className={cn(
        "fixed inset-0 z-50 bg-overlay data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out",
        className,
      )}
      {...props}
    />
  );
}

export function DialogContent({
  className,
  children,
  showClose = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & { showClose?: boolean }) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        className={cn(
          "fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100vh-2rem)] w-full max-w-[calc(100%-2rem)] overflow-y-auto -translate-x-1/2 -translate-y-1/2 gap-4 rounded-2xl border border-border bg-popover p-6 text-sm text-foreground shadow-popover sm:max-w-md",
          "data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out focus:outline-none",
          className,
        )}
        {...props}
      >
        {children}
        {showClose && (
          <DialogPrimitive.Close
            aria-label="关闭"
            className="absolute top-4 right-4 rounded-md p-1 text-muted-foreground transition-colors hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <X size={16} strokeWidth={1.5} aria-hidden />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

export function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-1.5 pr-6", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex justify-end gap-2", className)} {...props} />;
}

export function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn("text-base font-semibold", className)} {...props} />;
}

export function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

/** 确认框里的危险操作按钮（删除、覆盖等）。整个界面只有这里能拿到 danger 样式。 */
export function DialogDangerButton({
  className,
  size,
  type = "button",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { size?: "default" | "sm" }) {
  return (
    <button
      type={type}
      data-variant="danger"
      className={cn(buttonVariants({ variant: "danger", size }), className)}
      {...props}
    />
  );
}
