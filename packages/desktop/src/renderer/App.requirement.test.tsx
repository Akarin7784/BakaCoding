// @vitest-environment jsdom
// UI-05c：需求页从路由 #requirement=<id> 打开；顶部高风险横条照旧；左栏选别的就离开需求页。
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { App } from "./App";
import { REQUIREMENT_PAGE_COPY, STEPPER_COPY } from "./lib/copy";
import { parseRequirementHash, requirementHash } from "./lib/requirementRoute";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("需求页入口（路由）", () => {
  it("hash 解析 / 生成", () => {
    expect(parseRequirementHash(requirementHash("req 1"))).toBe("req 1");
    expect(parseRequirementHash("#other")).toBeNull();
    expect(parseRequirementHash("#requirement=")).toBeNull();
  });

  it("#requirement=req-2 打开需求页并渲染该需求的 TicketStepper；点主管离开", () => {
    window.location.hash = requirementHash("req-2");
    render(<App api={null} />);
    expect(screen.getByRole("region", { name: REQUIREMENT_PAGE_COPY.label })).toBeTruthy();
    expect(screen.getByRole("group", { name: STEPPER_COPY.label("T-2") })).toBeTruthy();
    expect(screen.queryByRole("group", { name: STEPPER_COPY.label("T-1") })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /主管/ }));
    expect(screen.queryByRole("region", { name: REQUIREMENT_PAGE_COPY.label })).toBeNull();
    expect(window.location.hash).toBe("");
  });

  it("hashchange 也能打开", () => {
    render(<App api={null} />);
    expect(screen.queryByRole("region", { name: REQUIREMENT_PAGE_COPY.label })).toBeNull();
    window.location.hash = requirementHash("req-1");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    return screen.findByRole("region", { name: REQUIREMENT_PAGE_COPY.label });
  });
});
