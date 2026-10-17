// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useBackendReadonly } from "./useBackendReadonly";

describe("useBackendReadonly（T-077）", () => {
  it.each([
    ["readonly", true],
    ["live", false],
  ] as const)("mode=%s → %s", async (mode, want) => {
    const api = { getBackendStatus: async () => ({ mode }) };
    const { result } = renderHook(() => useBackendReadonly(api));
    await waitFor(() => expect(result.current).toBe(want));
  });
});
