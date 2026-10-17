// shadcn/ui Toast（sonner）。操作结果放右下角，5 秒消失；错误不自动消失（§3、§4.7）。
// 跟随当前主题（useTheme），颜色用 token。
import { Toaster as Sonner, toast, type ToasterProps } from "sonner";
import { useTheme } from "../../lib/useTheme";

/** 普通提示停留时长（§3：5 秒）。错误提示用 toastError，不自动消失。 */
export const TOAST_DURATION_MS = 5000;

export function Toaster(props: ToasterProps) {
  const { resolved } = useTheme();
  return (
    <Sonner
      theme={resolved}
      position="bottom-right"
      duration={TOAST_DURATION_MS}
      toastOptions={{
        classNames: {
          toast:
            "!rounded-xl !border !border-border !bg-popover !text-foreground !shadow-popover !font-sans !text-sm",
          description: "!text-muted-foreground",
          error: "!text-danger",
        },
      }}
      {...props}
    />
  );
}

/** 错误 toast：不自动消失，需要用户关掉。 */
export function toastError(message: string, options?: Parameters<typeof toast.error>[1]) {
  return toast.error(message, { duration: Infinity, closeButton: true, ...options });
}

export { toast };
