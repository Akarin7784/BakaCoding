// UI-08：操作结果统一走右下角 toast（§3、§4.7）：成功 5 秒消失；错误不自动消失，带「复制详情」。
import { toast, toastError } from "../components/ui/sonner";

export const COPY_DETAIL = "复制详情";

export async function copyText(text: string): Promise<boolean> {
  try {
    await globalThis.navigator?.clipboard?.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function notifyOk(text: string): void {
  toast.success(text);
}

/** 错误提示：标题一句话，详情（默认同标题）可复制。 */
export function notifyError(text: string, detail: string = text): void {
  toastError(text, {
    action: {
      label: COPY_DETAIL,
      onClick: () => {
        void copyText(detail).then((ok) => {
          if (ok) toast("已复制");
        });
      },
    },
  });
}
