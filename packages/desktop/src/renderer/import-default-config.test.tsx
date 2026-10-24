// @vitest-environment jsdom
// T-081：导入只缺配置时，内容区「缺配置」横幅 +「用默认模板创建」按钮（页面横幅，不是 toast 里的按钮）。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BakaDesktopApi, DesktopImportResult, DesktopSnapshot } from "../shared/api";
import { App } from "./App";
import { Toaster } from "./components/ui/sonner";

afterEach(cleanup);

const snap: DesktopSnapshot = {
  db: { path: "/p/.bakacoding/bakacoding.db", state: "ok" },
  events: [],
  tickets: [],
} as unknown as DesktopSnapshot;

function api(importResult: DesktopImportResult, create?: () => Promise<DesktopImportResult>) {
  return {
    platform: "linux",
    getSnapshot: async () => snap,
    onUpdate: () => () => {},
    importProject: vi.fn(async () => importResult),
    createDefaultConfig: vi.fn(create ?? (async () => ({ ok: false, reason: "x" }))),
  } as unknown as BakaDesktopApi;
}

const MISSING: DesktopImportResult = {
  ok: false,
  missing: ["config/models.json", "config/pricing.json"],
  reason:
    "缺少 config/models.json、config/pricing.json。模板在安装目录的 config-templates 文件夹，可点「用默认模板创建」",
  canCreateDefaultConfig: true,
};

const renderApp = (props: Parameters<typeof App>[0]) =>
  render(
    <>
      <App {...props} />
      <Toaster />
    </>,
  );

async function clickImport() {
  fireEvent.click(await screen.findByRole("button", { name: "导入项目" }));
  return screen.findByRole("region", { name: "缺配置" });
}

describe("导入缺配置：用默认模板创建（T-081）", () => {
  it("只缺配置：横幅带按钮，错误 toast 里缺失清单只出现一次", async () => {
    renderApp({ api: api(MISSING) });
    const banner = await clickImport();
    expect(banner.textContent).toContain("项目缺配置文件，可以用默认模板创建");
    expect(banner.dataset.tone).toBe("danger");
    expect(screen.getByTestId("create-default-config").textContent).toContain("用默认模板创建");
    // 横幅在标题栏下面、内容上面
    const main = screen.getByRole("main", { name: "内容区" });
    expect(main.children[1]).toBe(banner);
    // 缺失清单只出现一次（T-081：主进程合成一句，界面不再拼）
    const toast = await screen.findByText(
      /导入失败：缺少 config\/models\.json、config\/pricing\.json/,
    );
    expect(toast.textContent!.match(/config\/models\.json/g)).toHaveLength(1);
  });

  it("不是只缺配置：没有横幅和按钮", async () => {
    renderApp({
      api: api({ ok: false, missing: ["config/pricing.json"], reason: "缺少 config/pricing.json" }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "导入项目" }));
    await screen.findByText("导入失败：缺少 config/pricing.json");
    expect(screen.queryByTestId("create-default-config")).toBeNull();
    expect(screen.queryByRole("region", { name: "缺配置" })).toBeNull();
  });

  it("点按钮：调 createDefaultConfig（不带参数），失败后横幅消失、原因换成新 toast", async () => {
    const a = api(MISSING, async () => ({
      ok: false,
      reason: "models.json 校验失败：x",
    }));
    renderApp({ api: a });
    await clickImport();
    fireEvent.click(screen.getByTestId("create-default-config"));
    await waitFor(() => expect(a.createDefaultConfig).toHaveBeenCalledWith());
    await waitFor(() => expect(screen.queryByTestId("create-default-config")).toBeNull());
    await screen.findByText("导入失败：models.json 校验失败：x");
  });

  it("创建成功：横幅消失，提示已用默认模板创建", async () => {
    const a = api(
      MISSING,
      async () =>
        ({
          ok: true,
          project: { project_id: "p-1", name: "p", path: "/repo" },
          note: "已用默认模板创建 config/models.json",
        }) as DesktopImportResult,
    );
    renderApp({ api: a, onReload: () => {} });
    await clickImport();
    fireEvent.click(screen.getByTestId("create-default-config"));
    await screen.findByText(/已用默认模板创建 config\/models\.json/);
    await waitFor(() => expect(screen.queryByRole("region", { name: "缺配置" })).toBeNull());
  });
});
