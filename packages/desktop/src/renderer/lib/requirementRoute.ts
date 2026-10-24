// UI-05c：需求页的路由 `#requirement=<id>`。入口只要求「左栏或路由能打开」；
// 左栏需求列表（05e）、「查看需求」按钮（05f）之后都只需要调 openRequirement(id) / 改 hash。
import { useCallback, useEffect, useState } from "react";

const PREFIX = "#requirement=";

export function parseRequirementHash(hash: string | undefined): string | null {
  if (!hash?.startsWith(PREFIX)) return null;
  const id = decodeURIComponent(hash.slice(PREFIX.length)).trim();
  return id ? id : null;
}

export function requirementHash(id: string): string {
  return PREFIX + encodeURIComponent(id);
}

export function useRequirementRoute(): [string | null, (id: string | null) => void] {
  const loc = globalThis.window?.location;
  const [id, setId] = useState<string | null>(() => parseRequirementHash(loc?.hash));
  useEffect(() => {
    const w = globalThis.window;
    if (!w) return;
    const on = () => setId(parseRequirementHash(w.location.hash));
    w.addEventListener("hashchange", on);
    return () => w.removeEventListener("hashchange", on);
  }, []);
  const open = useCallback((next: string | null) => {
    setId(next);
    const w = globalThis.window;
    if (!w) return;
    const want = next === null ? "" : requirementHash(next);
    if (w.location.hash === want || (next === null && !w.location.hash)) return;
    if (next === null) w.history.replaceState(null, "", w.location.pathname + w.location.search);
    else w.location.hash = want;
  }, []);
  return [id, open];
}
