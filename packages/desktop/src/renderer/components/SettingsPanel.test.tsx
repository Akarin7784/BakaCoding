// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { DesktopSettings } from "../../shared/api";
import { SettingsPanel } from "./SettingsPanel";

afterEach(cleanup);

const base: DesktopSettings = {
  repo: "/r",
  env: [
    { name: "DEEPSEEK_API_KEY", set: true },
    { name: "BAKACODING_REPO", set: false },
  ],
  mode: "local",
};

describe("SettingsPanel（T-072）", () => {
  it.each([
    ["readonly", "只读"],
    ["local", "本地模式"],
    ["github", "GitHub 模式"],
  ] as const)("mode=%s 显示「%s」", (mode, label) => {
    render(<SettingsPanel settings={{ ...base, mode }} onBack={() => {}} />);
    expect(screen.getByTestId("settings-mode").textContent).toBe(label);
  });

  it("环境变量只显示已设 / 未设", () => {
    render(<SettingsPanel settings={base} onBack={() => {}} />);
    expect(screen.getByTestId("env-DEEPSEEK_API_KEY").textContent).toContain("已设");
    expect(screen.getByTestId("env-BAKACODING_REPO").textContent).toContain("未设");
  });
});
