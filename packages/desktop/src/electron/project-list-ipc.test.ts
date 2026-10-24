// UI-07d：设置 › 项目的主进程 handler——参数校验、只读、打开文件夹的路径检查、失败固定文案不带路径。
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PROJECT_TEXT, projectListHandlers, type ProjectListDeps } from "./project-list-ipc.js";

const row = (id: string, repo_path: string | null) => ({
  project_id: id,
  name: `n-${id}`,
  created_at: "2026-10-24T00:00:00.000Z",
  repo_path,
});

function deps(over: Partial<ProjectListDeps> = {}) {
  const warns: string[] = [];
  const d = {
    backend: {
      status: vi.fn(() => ({ mode: "live" }) as never),
      listProjects: vi.fn(() => [
        row("p-1", "/secret/abs/repo"),
        row("p-2", null),
        row("p-3", "rel/repo"),
        row("p-4", ""),
      ]),
      removeProject: vi.fn(async () => ({ removed: true })),
    },
    openPath: vi.fn(async () => ""),
    isDirectory: vi.fn(() => true),
    pathImpl: path.posix,
    warn: (m: string) => void warns.push(m),
    ...over,
  };
  return { d, h: projectListHandlers(d), warns };
}

describe("project:list", () => {
  it("只回 project_id / name / repo_path；后端只读回固定文案", () => {
    const { h } = deps();
    const r = h.list();
    expect(r.ok && r.projects[0]).toEqual({
      project_id: "p-1",
      name: "n-p-1",
      repo_path: "/secret/abs/repo",
    });
    const ro = deps({
      backend: { ...deps().d.backend, listProjects: () => null },
    }).h.list();
    expect(ro).toEqual({ ok: false, reason: PROJECT_TEXT.readonly });
  });
});

describe("project:remove", () => {
  it("合法 id 调后端 removeProject", async () => {
    const { d, h } = deps();
    await expect(h.remove("p-1")).resolves.toEqual({ ok: true, removed: true });
    expect(d.backend.removeProject).toHaveBeenCalledWith("p-1");
  });

  it("非法参数、只读：不调后端", async () => {
    for (const bad of [undefined, 1, "", "x".repeat(201), { id: "p-1" }]) {
      const { d, h } = deps();
      await expect(h.remove(bad)).resolves.toEqual({ ok: false, reason: PROJECT_TEXT.invalidId });
      expect(d.backend.removeProject).not.toHaveBeenCalled();
    }
    const { d, h } = deps();
    d.backend.status.mockReturnValue({ mode: "readonly" } as never);
    await expect(h.remove("p-1")).resolves.toEqual({
      ok: false,
      reason: PROJECT_TEXT.removeReadonly,
    });
    expect(d.backend.removeProject).not.toHaveBeenCalled();
  });

  it("后端抛错：固定文案，错误信息里的路径不透出、不进日志", async () => {
    const { d, h, warns } = deps();
    d.backend.removeProject.mockRejectedValue(new Error("boom /secret/abs/repo"));
    const r = await h.remove("p-1");
    expect(r).toEqual({ ok: false, reason: PROJECT_TEXT.removeFailed });
    expect(warns.join()).not.toContain("/secret");
  });
});

describe("project:open-folder", () => {
  it("按 id 取记录里的绝对路径，存在才调 openPath", async () => {
    const { d, h } = deps();
    await expect(h.openFolder("p-1")).resolves.toEqual({ ok: true });
    expect(d.openPath).toHaveBeenCalledWith("/secret/abs/repo");
  });

  it("空路径 / 相对路径 / 不存在 / 找不到 / 非法 id：都不调 openPath，固定文案不带路径", async () => {
    const cases: Array<[unknown, string, Partial<ProjectListDeps>?]> = [
      ["p-2", PROJECT_TEXT.noPath],
      ["p-4", PROJECT_TEXT.noPath],
      ["p-3", PROJECT_TEXT.badPath],
      ["p-1", PROJECT_TEXT.missing, { isDirectory: () => false }],
      ["nope", PROJECT_TEXT.notFound],
      [42, PROJECT_TEXT.invalidId],
      ["/etc", PROJECT_TEXT.notFound],
    ];
    for (const [id, reason, over] of cases) {
      const { d, h } = deps(over);
      const r = await h.openFolder(id);
      expect(r, String(id)).toEqual({ ok: false, reason });
      expect(d.openPath).not.toHaveBeenCalled();
    }
  });

  it("openPath 回错误信息或抛错：固定文案，不带路径", async () => {
    for (const openPath of [
      async () => "Failed to open /secret/abs/repo",
      async () => {
        throw new Error("/secret/abs/repo");
      },
    ]) {
      const { h, warns } = deps({ openPath });
      const r = await h.openFolder("p-1");
      expect(r).toEqual({ ok: false, reason: PROJECT_TEXT.openFailed });
      expect(JSON.stringify([r, warns])).not.toContain("/secret");
    }
  });

  it("Windows 路径按 win32 判断绝对路径", async () => {
    const { d, h } = deps({
      pathImpl: path.win32,
      backend: { ...deps().d.backend, listProjects: () => [row("w", "C:\\repo")] },
    });
    await expect(h.openFolder("w")).resolves.toEqual({ ok: true });
    expect(d.openPath).toHaveBeenCalledWith("C:\\repo");
  });
});
