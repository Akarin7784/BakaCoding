// @vitest-environment jsdom
// UI-05c：需求页从路由 #requirement=<id> 打开；顶部高风险横条照旧；左栏选别的就离开需求页。
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { App } from "./App";
import { HIGH_RISK_CARD_COPY, REQUIREMENT_PAGE_COPY, STEPPER_COPY } from "./lib/copy";
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

// UI-05d：高风险卡片进需求页、顶部横条保留兜底、左栏项目红点。
describe("UI-05d 需求页高风险 + 左栏红点", () => {
  const pending = [
    {
      ticket_id: "T-2",
      project_id: "p-todo",
      pr_id: "pr-7",
      reasons: ["dependency_file" as const],
      files: [{ path: "package.json" }],
      files_more: 0,
      held_at: "2026-10-24T02:30:00Z",
    },
  ];

  it("需求页里有本需求的高风险卡片，顶部横条照旧在", () => {
    window.location.hash = requirementHash("req-2");
    render(<App api={null} pendingHighRisk={pending} />);
    expect(screen.getByRole("region", { name: HIGH_RISK_CARD_COPY.label })).toBeTruthy();
    expect(screen.getByTestId("high-risk-panel")).toBeTruthy();
  });

  it("别的需求页没有这张卡片", () => {
    window.location.hash = requirementHash("req-1");
    render(<App api={null} pendingHighRisk={pending} />);
    expect(screen.queryByRole("region", { name: HIGH_RISK_CARD_COPY.label })).toBeNull();
  });

  it("左栏：有待裁决的项目带红点，没有时不带", () => {
    render(<App api={null} pendingHighRisk={pending} />);
    expect(screen.getByRole("button", { name: /baka-todo\s*（需要你处理）/ })).toBeTruthy();
    expect(screen.getAllByTestId("attention-dot")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "baka-blog" })).toBeTruthy();
    cleanup();
    render(<App api={null} pendingHighRisk={[]} />);
    expect(screen.queryByTestId("attention-dot")).toBeNull();
  });
});
