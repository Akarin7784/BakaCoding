// @vitest-environment jsdom
// UI-05d：decide 把拒绝理由原样当 detail 传给现有 decideHighRisk（不加新接口）。
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BakaDesktopApi } from "../../shared/api";
import { usePendingHighRisk } from "./usePendingHighRisk";

function apiOf() {
  return {
    getPendingHighRisk: vi.fn(async () => []),
    onPendingHighRisk: vi.fn(() => () => undefined),
    decideHighRisk: vi.fn(async () => ({
      ok: true as const,
      result: { decision: "reject" as const, result: "rejected" as const },
    })),
  };
}

describe("usePendingHighRisk.decide", () => {
  it("拒绝理由作为第 4 个参数 detail 传出", async () => {
    const api = apiOf();
    const { result } = renderHook(() => usePendingHighRisk(api as unknown as BakaDesktopApi));
    await expect(result.current.decide("T-1", "pr-1", "reject", "不要")).resolves.toEqual({
      ok: true,
    });
    expect(api.decideHighRisk).toHaveBeenCalledWith("T-1", "pr-1", "reject", "不要");
  });

  it("放行不带 detail（undefined）", async () => {
    const api = apiOf();
    const { result } = renderHook(() => usePendingHighRisk(api as unknown as BakaDesktopApi));
    await result.current.decide("T-1", "pr-1", "release");
    expect(api.decideHighRisk).toHaveBeenCalledWith("T-1", "pr-1", "release", undefined);
  });
});
