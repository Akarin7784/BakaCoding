// T-077：后端是否只读（backend:status 的 mode）。取不到按非只读。
// UI-08 起由 useBackendStatus 统一取（含定时刷新、租约丢失）；这里保留给只关心布尔值的地方。
import type { BakaDesktopApi } from "../../shared/api.js";
import { useBackendStatus } from "./useBackendStatus";

export function useBackendReadonly(
  api: Pick<BakaDesktopApi, "getBackendStatus"> | undefined,
): boolean {
  return useBackendStatus(api).readonly;
}
