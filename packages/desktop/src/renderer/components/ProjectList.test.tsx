// @vitest-environment jsdom
// UI-07d：设置 › 项目——列表（名称 + 路径）、二次确认后移除并刷新、空路径禁用打开文件夹、空列表、只读。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopProjectRow } from "../../shared/api";
import { PROJECT_COPY } from "../lib/projectSettings";
import { ProjectList } from "./ProjectList";

afterEach(cleanup);

const rows: DesktopProjectRow[] = [
  { project_id: "p-1", name: "shop", repo_path: "/home/u/shop" },
  { project_id: "p-2", name: "legacy", repo_path: null },
];

function api(list: DesktopProjectRow[] = rows) {
  let current = [...list];
  return {
    listProjects: vi.fn(async () => ({ ok: true as const, projects: current })),
    removeProject: vi.fn(async (id: string) => {
      current = current.filter((r) => r.project_id !== id);
      return { ok: true as const, removed: true };
    }),
    openProjectFolder: vi.fn(async () => ({ ok: true as const })),
  };
}

const openBtn = (name: string) =>
  screen.getByRole("button", { name: `${PROJECT_COPY.openFolder}：${name}` }) as HTMLButtonElement;
const removeBtn = (name: string) =>
  screen.getByRole("button", { name: `${PROJECT_COPY.remove}：${name}` }) as HTMLButtonElement;

describe("ProjectList", () => {
  it("每行显示名称和仓库路径；没有路径的显示未记录", async () => {
    render(<ProjectList api={api()} />);
    const r1 = await screen.findByTestId("project-row-p-1");
    expect(r1.textContent).toContain("shop");
    expect(r1.textContent).toContain("/home/u/shop");
    expect(screen.getByTestId("project-row-p-2").textContent).toContain(PROJECT_COPY.noPath);
  });

  it("路径为空时打开文件夹按钮禁用；有路径时按 project_id 打开", async () => {
    const a = api();
    render(<ProjectList api={a} />);
    await screen.findByTestId("project-row-p-1");
    expect(openBtn("legacy").disabled).toBe(true);
    expect(openBtn("shop").disabled).toBe(false);
    fireEvent.click(openBtn("shop"));
    await waitFor(() => expect(a.openProjectFolder).toHaveBeenCalledWith("p-1"));
  });

  it("移除先弹确认框；取消不调，确认后调 removeProject 并重新取列表", async () => {
    const a = api();
    render(<ProjectList api={a} />);
    await screen.findByTestId("project-row-p-1");
    fireEvent.click(removeBtn("shop"));
    expect(a.removeProject).not.toHaveBeenCalled();
    const dlg = await screen.findByTestId("project-remove-confirm");
    expect(dlg.textContent).toContain("shop");
    fireEvent.click(screen.getByRole("button", { name: PROJECT_COPY.confirmCancel }));
    await waitFor(() => expect(screen.queryByTestId("project-remove-confirm")).toBeNull());
    expect(a.removeProject).not.toHaveBeenCalled();

    fireEvent.click(removeBtn("shop"));
    const ok = await screen.findByTestId("project-remove-ok");
    expect(ok.getAttribute("data-variant")).toBe("danger");
    fireEvent.click(ok);
    await waitFor(() => expect(a.removeProject).toHaveBeenCalledWith("p-1"));
    await waitFor(() => expect(screen.queryByTestId("project-row-p-1")).toBeNull());
    expect(a.listProjects).toHaveBeenCalledTimes(2);
  });

  it("空列表显示提示；只读时移除禁用；失败显示固定文案", async () => {
    render(<ProjectList api={api([])} />);
    expect((await screen.findByTestId("project-empty")).textContent).toBe(PROJECT_COPY.empty);
    cleanup();
    render(<ProjectList api={api()} readonly />);
    await screen.findByTestId("project-row-p-1");
    expect(removeBtn("shop").disabled).toBe(true);
    cleanup();
    const a = api();
    a.listProjects.mockResolvedValue({ ok: false, reason: "后端只读，读不到项目列表" } as never);
    render(<ProjectList api={a} />);
    expect((await screen.findByTestId("project-error")).textContent).toBe(
      "后端只读，读不到项目列表",
    );
  });
});
