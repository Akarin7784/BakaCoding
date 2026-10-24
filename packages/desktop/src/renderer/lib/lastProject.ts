// UI-04b：主管输入框项目 chip「上次用的项目」偏好，和 UI-02 左栏偏好一样存在渲染进程 localStorage。
import { safeLocalStorage } from "./theme";

export const LAST_PROJECT_STORAGE_KEY = "bakacoding.lastProject";
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** 读：没存、空串或 storage 抛错都当「不指定」（undefined）。 */
export function readLastProject(
  storage: StorageLike | undefined = safeLocalStorage(),
): string | undefined {
  try {
    return storage?.getItem(LAST_PROJECT_STORAGE_KEY) || undefined;
  } catch {
    return undefined;
  }
}

/** 写：undefined =「不指定」，删掉记录；写失败不抛。 */
export function writeLastProject(
  projectId: string | undefined,
  storage: StorageLike | undefined = safeLocalStorage(),
): void {
  try {
    if (projectId) storage?.setItem(LAST_PROJECT_STORAGE_KEY, projectId);
    else storage?.removeItem(LAST_PROJECT_STORAGE_KEY);
  } catch {
    // 只是下次启动回到「不指定」
  }
}
