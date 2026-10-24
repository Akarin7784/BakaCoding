// @vitest-environment jsdom
// UI-07a：设置弹层左侧标签——切换、键盘导航、任何标签都不回显密钥值。
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BakaDesktopApi, DesktopSettings } from "../../shared/api";
import { SettingsDialog } from "./SettingsDialog";
import type { WizardApi } from "./ModelSetupWizard";

afterEach(cleanup);

const SECRET = "sk-live-UI07a-9f8e7d6c5b4a";
const TABS = ["通用", "项目", "模型", "预算", "密钥", "诊断", "关于"];

const settings: DesktopSettings = {
  repo: "/r",
  mode: "local",
  env: [
    { name: "DEEPSEEK_API_KEY", set: true },
    { name: "GITHUB_TOKEN", set: true },
    { name: "BAKACODING_REPO", set: false },
  ],
};

/** 假 API 故意在各处塞进密钥原值，看界面会不会显示出来 */
function leakyApi() {
  const status = { set: true, source: "bakacoding", value: SECRET } as never;
  const api = {
    secretStatus: vi.fn(async () => ({ ok: true as const, status })),
    setSecret: vi.fn(async () => ({ ok: true as const, status })),
    clearSecret: vi.fn(async () => ({ ok: true as const, status })),
    testProvider: vi.fn(async () => ({ ok: true, latency_ms: 1 }) as never),
    getBackendStatus: vi.fn(async () => ({
      mode: "readonly",
      error: { name: "ConfigError", message: "配置缺少 DEEPSEEK_API_KEY", code: "config_invalid" },
    })),
    getAbout: vi.fn(async () => ({
      version: "1.0.0-preview.1",
      commit: "cbd3b41",
      runtime: { electron: "43.8.0", chrome: null, node: "22.19.0" },
    })),
    getSnapshot: vi.fn(async () => ({ tickets: [] })),
    exportDiagnostics: vi.fn(),
    openDataDir: vi.fn(),
  };
  return api as unknown as WizardApi & BakaDesktopApi;
}

function renderDialog(api = leakyApi()) {
  render(
    <SettingsDialog open onOpenChange={() => {}} settings={settings} api={api} desktopApi={api} />,
  );
  return { api, dialog: screen.getByRole("dialog", { name: "设置" }) };
}

describe("SettingsDialog 左侧标签（UI-07a）", () => {
  it("7 个标签按 §4.6 顺序竖排，默认「通用」", () => {
    const { dialog } = renderDialog();
    const list = within(dialog).getByRole("tablist", { name: "设置分类" });
    expect(list.getAttribute("aria-orientation")).toBe("vertical");
    expect(
      within(list)
        .getAllByRole("tab")
        .map((t) => t.textContent),
    ).toEqual(TABS);
    expect(within(dialog).getByRole("tab", { name: "通用" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(within(dialog).getByTestId("settings-title")).toBeTruthy();
    expect(within(dialog).getByTestId("settings-language").textContent).toBe("简体中文");
  });

  it("点击切换标签，内容跟着换", async () => {
    const { dialog } = renderDialog();
    fireEvent.mouseDown(within(dialog).getByRole("tab", { name: "项目" }), { button: 0 });
    expect(within(dialog).getByTestId("settings-repo").textContent).toBe("/r");
    expect(within(dialog).queryByTestId("settings-language")).toBeNull();
    fireEvent.mouseDown(within(dialog).getByRole("tab", { name: "关于" }), { button: 0 });
    expect((await within(dialog).findByTestId("about-version")).textContent).toBe(
      "1.0.0-preview.1",
    );
    expect(within(dialog).getByTestId("about-chrome").textContent).toBe("未知");
    fireEvent.mouseDown(within(dialog).getByRole("tab", { name: "诊断" }), { button: 0 });
    // 复用 DiagnosticsPanel：最近一次启动错误（已脱敏）
    const err = await within(dialog).findByTestId("diag-last-error");
    expect(err.textContent).toContain("配置缺少 DEEPSEEK_API_KEY");
    expect(err.textContent).toContain("config_invalid");
  });

  it("键盘：上下方向键在标签间移动并切换，Home / End 到两头", async () => {
    const { dialog } = renderDialog();
    const tab = (n: string) => within(dialog).getByRole("tab", { name: n });
    tab("通用").focus();
    fireEvent.keyDown(tab("通用"), { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(tab("项目")));
    expect(tab("项目").getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tab("项目"), { key: "End" });
    await waitFor(() => expect(document.activeElement).toBe(tab("关于")));
    fireEvent.keyDown(tab("关于"), { key: "ArrowUp" });
    await waitFor(() => expect(document.activeElement).toBe(tab("诊断")));
    fireEvent.keyDown(tab("诊断"), { key: "Home" });
    await waitFor(() => expect(document.activeElement).toBe(tab("通用")));
    expect(tab("通用").getAttribute("aria-selected")).toBe("true");
  });

  it("任何标签都不回显密钥值", async () => {
    const { api, dialog } = renderDialog();
    for (const name of TABS) {
      fireEvent.mouseDown(within(dialog).getByRole("tab", { name }), { button: 0 });
      if (name === "密钥") await within(dialog).findByTestId("secret-DEEPSEEK_API_KEY");
      await waitFor(() => expect(dialog.textContent).not.toContain(SECRET));
      expect(dialog.innerHTML).not.toContain(SECRET);
      for (const input of dialog.querySelectorAll("input"))
        expect((input as HTMLInputElement).value).not.toContain(SECRET);
    }
    expect(api.secretStatus).toHaveBeenCalled();
  });
});
