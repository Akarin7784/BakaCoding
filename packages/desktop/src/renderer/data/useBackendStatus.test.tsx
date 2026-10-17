// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopBackendStatus } from "../../shared/api";
import { useBackendStatus } from "./useBackendStatus";

afterEach(() => cleanup());

describe("useBackendStatus（UI-08）", () => {
  it("定时再取：运行中掉成只读也能发现", async () => {
    let s: DesktopBackendStatus = { mode: "live" };
    const getBackendStatus = vi.fn(async () => s);
    const { result } = renderHook(() => useBackendStatus({ getBackendStatus }, 20));
    await waitFor(() => expect(result.current.status).toEqual({ mode: "live" }));
    expect(result.current.readonly).toBe(false);
    s = { mode: "readonly", reason: "库被其他进程占用（StorageLeaseError）" };
    await waitFor(() => expect(result.current.readonly).toBe(true));
  });

  it("卸载后不再取", async () => {
    const getBackendStatus = vi.fn(async () => ({ mode: "live" }) as DesktopBackendStatus);
    const { unmount } = renderHook(() => useBackendStatus({ getBackendStatus }, 10));
    await waitFor(() => expect(getBackendStatus).toHaveBeenCalled());
    unmount();
    const n = getBackendStatus.mock.calls.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(getBackendStatus.mock.calls.length).toBe(n);
  });

  it("取不到按非只读；没有 api 不取", async () => {
    const getBackendStatus = vi.fn(async () => {
      throw new Error("ipc");
    });
    const { result } = renderHook(() => useBackendStatus({ getBackendStatus }, 0));
    await waitFor(() => expect(getBackendStatus).toHaveBeenCalled());
    expect(result.current.readonly).toBe(false);
    expect(renderHook(() => useBackendStatus(undefined)).result.current.status).toBeNull();
  });
});
