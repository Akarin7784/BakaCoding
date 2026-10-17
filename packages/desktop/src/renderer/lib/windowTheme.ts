// UI-02：把主题偏好同步给主进程（window:theme），主进程据此设 nativeTheme.themeSource、刷新标题栏按钮颜色。
// 只在偏好变化时发（跟随系统时系统深浅变化由主进程自己的 nativeTheme "updated" 处理）。
import type { BakaDesktopApi } from "../../shared/api";
import type { ThemeStore } from "./useTheme";

export function syncWindowTheme(
  store: ThemeStore,
  api: Pick<BakaDesktopApi, "setWindowTheme"> | undefined,
): () => void {
  const send = api?.setWindowTheme;
  if (!send) return () => {};
  let last = store.get().preference;
  const push = (pref: typeof last) => {
    // 失败（旧主进程没有这个通道等）只影响标题栏颜色，不打扰用户
    send(pref).catch(() => {});
  };
  push(last);
  return store.subscribe(() => {
    const pref = store.get().preference;
    if (pref === last) return;
    last = pref;
    push(pref);
  });
}
