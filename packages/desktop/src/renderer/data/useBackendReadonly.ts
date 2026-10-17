// T-077：后端是否只读（backend:status 的 mode）。只读标签只在这时显示；取不到按非只读。
import { useEffect, useState } from "react";
import type { BakaDesktopApi } from "../../shared/api.js";

export function useBackendReadonly(
  api: Pick<BakaDesktopApi, "getBackendStatus"> | undefined,
): boolean {
  const [readonly, setReadonly] = useState(false);
  useEffect(() => {
    if (!api?.getBackendStatus) return;
    let alive = true;
    api.getBackendStatus().then(
      (s) => alive && setReadonly(s.mode === "readonly"),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [api]);
  return readonly;
}
