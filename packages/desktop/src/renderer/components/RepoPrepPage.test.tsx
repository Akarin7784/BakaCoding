// @vitest-environment jsdom
// UI-03a：项目准备页——逐项检查、前一项不过后面灰掉、写操作先确认、身份表单只显示缺的字段、
// 首次提交确认框列 include / excluded 和「暂存会变回未暂存」提示、路由高亮、只读横幅入口。
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  BakaDesktopApi,
  DesktopBackendStatus,
  DesktopRepoCheck,
  DesktopRepoFixResult,
} from "../../shared/api";
import { App } from "../App";
import { toast, Toaster } from "./ui/sonner";
import { RepoPrepPage, type RepoPrepApi } from "./RepoPrepPage";
import { identityFormFields, missingIdentity, prepItems, shortFolder } from "../lib/repoPrep";
import { needsImportFirst, repoFixRoute } from "../lib/readonly";

beforeAll(() => {
  Element.prototype.scrollIntoView ??= function () {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  window.matchMedia ??= ((q: string) => ({
    matches: false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  toast.dismiss();
  cleanup();
});

const NOT_GIT: DesktopRepoCheck = {
  items: [
    { id: "git", ok: false, code: "not_git", detail: "这个文件夹还不是 Git 仓库" },
    { id: "commit", ok: false, code: "no_commits", detail: "仓库还没有任何提交" },
    { id: "main", ok: false, code: "no_main", detail: "没找到 main 分支" },
    { id: "ignored", ok: false, code: "not_ignored", detail: ".bakacoding/ 还没加入忽略" },
  ],
  current_branch: null,
  identity: { name: false, email: false },
};
const NO_COMMITS = (identity = { name: false, email: false }): DesktopRepoCheck => ({
  items: [
    { id: "git", ok: true },
    { id: "commit", ok: false, code: "no_commits", detail: "仓库还没有任何提交" },
    { id: "main", ok: false, code: "no_main", detail: "没找到 main 分支" },
    { id: "ignored", ok: true },
  ],
  current_branch: "main",
  identity,
});
const NO_MAIN: DesktopRepoCheck = {
  items: [
    { id: "git", ok: true },
    { id: "commit", ok: true },
    {
      id: "main",
      ok: false,
      code: "no_main",
      detail: "没找到 main 分支（当前是 master）",
      current: "master",
    },
    { id: "ignored", ok: true },
  ],
  current_branch: "master",
  identity: { name: true, email: true },
};
const ALL_OK: DesktopRepoCheck = {
  items: ["git", "commit", "main", "ignored"].map((id) => ({
    id: id as "git",
    ok: true,
  })),
  current_branch: "main",
  identity: { name: true, email: true },
};
const OK_FIX: DesktopRepoFixResult = { ok: true, reload: { state: "reloaded" } };

function api(checks: DesktopRepoCheck[], over: Partial<RepoPrepApi> = {}, folder = "my-project") {
  const queue = [...checks];
  const a = {
    checkRepo: vi.fn(async () => ({
      ok: true as const,
      check: queue.length > 1 ? queue.shift()! : queue[0]!,
      folder,
    })),
    initRepo: vi.fn(async () => OK_FIX),
    listInitialFiles: vi.fn(async () => ({
      ok: true as const,
      include: ["README.md", "src/a.ts"],
      excluded: [{ path: ".env", reason: "protected" as const }],
    })),
    initialCommit: vi.fn(async () => ({ ...OK_FIX, commit: "abc" })),
    createMainBranch: vi.fn(async () => ({ ...OK_FIX, from: "master" })),
    ...over,
  };
  return a;
}
const renderPage = (a: RepoPrepApi, route: Parameters<typeof RepoPrepPage>[0]["route"] = null) => {
  const onFixed = vi.fn();
  const onBack = vi.fn();
  render(
    <>
      <RepoPrepPage api={a} route={route} onBack={onBack} onFixed={onFixed} />
      <Toaster />
    </>,
  );
  return { onFixed, onBack };
};

describe("纯逻辑（UI-03a）", () => {
  it("前一项不过后面一律 blocked；只给第一项不过的按钮", () => {
    const v = prepItems(NOT_GIT);
    expect(v.map((i) => i.state)).toEqual(["fail", "blocked", "blocked", "blocked"]);
    expect(v[0]!.action).toBe("初始化 Git");
    expect(v.slice(1).every((i) => !i.action)).toBe(true);
    expect(prepItems(NO_MAIN).map((i) => i.state)).toEqual(["ok", "ok", "fail", "blocked"]);
  });

  it("身份字段：缺哪项算哪项；表单只在两项都缺时出现", () => {
    expect(missingIdentity({ name: false, email: true })).toEqual(["name"]);
    expect(identityFormFields(["name", "email"])).toEqual(["name", "email"]);
    expect(identityFormFields(["email"])).toEqual([]);
  });
});

describe("项目准备页（UI-03a）", () => {
  it("不是 Git 仓库：第一项给主按钮、后面灰掉；确认后才调 initRepo，成功后重新检查、通知外层", async () => {
    const a = api([NOT_GIT, NO_COMMITS()]);
    const { onFixed } = renderPage(a, "init_repo");
    const git = await screen.findByTestId("prep-item-git");
    expect(git.getAttribute("aria-current")).toBe("step");
    expect(screen.getByTestId("prep-item-commit").dataset.state).toBe("blocked");
    const btn = within(git).getByRole("button", { name: "初始化 Git" });
    expect(btn.dataset.variant).toBe("primary");
    // 整页只有一个主按钮
    expect(
      document.querySelectorAll('[data-testid="repo-prep"] [data-variant="primary"]'),
    ).toHaveLength(1);
    fireEvent.click(btn);
    const dlg = await screen.findByRole("dialog", { name: "初始化 Git" });
    expect(a.initRepo).not.toHaveBeenCalled();
    fireEvent.click(within(dlg).getByRole("button", { name: "初始化 Git" }));
    await waitFor(() => expect(a.initRepo).toHaveBeenCalledWith({}));
    await waitFor(() => expect(onFixed).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId("prep-item-commit").dataset.state).toBe("fail"));
  });

  it("取消确认框什么都不做", async () => {
    const a = api([NOT_GIT]);
    renderPage(a);
    fireEvent.click(await screen.findByRole("button", { name: "初始化 Git" }));
    const dlg = await screen.findByRole("dialog");
    fireEvent.click(within(dlg).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(a.initRepo).not.toHaveBeenCalled();
  });

  it("首次提交：列 include 和 excluded（带原因）、写明暂存提示；两项身份都缺时表单两栏都要填", async () => {
    const a = api([NO_COMMITS()]);
    renderPage(a, "initial_commit");
    fireEvent.click(await screen.findByRole("button", { name: "创建首次提交" }));
    const dlg = await screen.findByRole("dialog", { name: "创建首次提交" });
    await waitFor(() =>
      expect(within(dlg).getByTestId("include-list").textContent).toContain("src/a.ts"),
    );
    const ex = within(dlg).getByTestId("excluded-list").textContent;
    expect(ex).toContain(".env");
    expect(ex).toContain("密钥或环境变量文件，默认不提交");
    expect(within(dlg).getByTestId("unstaged-note").textContent).toBe(
      "你之前暂存的文件会变回未暂存，内容不会丢",
    );
    const submit = within(dlg).getByRole("button", { name: "提交 2 个文件" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dlg).getByLabelText("Git 用户名"), { target: { value: " Eva " } });
    fireEvent.change(within(dlg).getByLabelText("Git 邮箱"), { target: { value: "eva@x.io" } });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() =>
      expect(a.initialCommit).toHaveBeenCalledWith({
        files: ["README.md", "src/a.ts"],
        identity: { name: "Eva", email: "eva@x.io" },
      }),
    );
  });

  it("身份都配好时不出表单、不传 identity；可以只做空提交", async () => {
    const a = api([NO_COMMITS({ name: true, email: true })]);
    renderPage(a);
    fireEvent.click(await screen.findByRole("button", { name: "创建首次提交" }));
    const dlg = await screen.findByRole("dialog");
    await within(dlg).findByTestId("include-list");
    expect(within(dlg).queryByTestId("identity-form")).toBeNull();
    fireEvent.click(within(dlg).getByRole("button", { name: "只做空提交" }));
    await waitFor(() => expect(a.initialCommit).toHaveBeenCalledWith({ empty: true }));
  });

  it("只缺一项身份：不出表单（只显示缺的那项的补法），不能提交", async () => {
    const a = api([NO_COMMITS({ name: true, email: false })]);
    renderPage(a);
    fireEvent.click(await screen.findByRole("button", { name: "创建首次提交" }));
    const dlg = await screen.findByRole("dialog");
    const part = await within(dlg).findByTestId("identity-partial");
    expect(part.textContent).toContain("Git 邮箱");
    expect(part.textContent).not.toContain("Git 用户名");
    expect(within(dlg).queryByLabelText("Git 用户名")).toBeNull();
    expect(
      (within(dlg).getByRole("button", { name: "提交 2 个文件" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("新建 main：确认框写明从哪个分支、只新建；失败只 toast 主进程给的固定文案", async () => {
    const a = api([NO_MAIN], {
      createMainBranch: vi.fn(async () => ({
        ok: false as const,
        code: "main_exists" as const,
        reason: "main 分支已经存在",
      })),
    });
    renderPage(a, "create_main");
    fireEvent.click(await screen.findByRole("button", { name: "从当前分支新建 main" }));
    const dlg = await screen.findByRole("dialog");
    expect(dlg.textContent).toContain("从当前分支 master 新建 main");
    expect(dlg.textContent).toContain("不切换、不改名、不删除原来的分支");
    fireEvent.click(within(dlg).getByRole("button", { name: "新建 main" }));
    expect(await screen.findByText("新建 main 失败：main 分支已经存在")).toBeTruthy();
  });

  it("全部通过：显示通过提示，没有修复按钮", async () => {
    renderPage(api([ALL_OK]));
    expect(await screen.findByTestId("prep-all-ok")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /初始化|首次提交|新建 main/ })).toBeNull();
  });
});

describe("只读横幅入口（UI-03a）", () => {
  const status: DesktopBackendStatus = {
    mode: "readonly",
    reason: "仓库没有任何提交，请先提交一次再启动",
    error: {
      name: "RepoNotReadyError",
      message: "仓库没有任何提交，请先提交一次再启动",
      code: "no_commits",
    },
    repoSource: "last_import",
  };
  const appApi = (s: DesktopBackendStatus) =>
    ({
      platform: "win32",
      getSnapshot: async () => ({
        db: { path: "/p", state: "ok" },
        events: [],
        tickets: [],
        last_seq: 0,
      }),
      onUpdate: () => () => {},
      getBackendStatus: vi.fn(async () => s),
      ...api([NO_COMMITS()]),
    }) as unknown as BakaDesktopApi;

  it("RepoNotReadyError：横幅有「准备仓库」，点开准备页并高亮首次提交", async () => {
    render(<App api={appApi(status)} />);
    const banner = await screen.findByRole("region", { name: "只读模式" });
    fireEvent.click(within(banner).getByRole("button", { name: "准备仓库" }));
    const item = await screen.findByTestId("prep-item-commit");
    expect(item.getAttribute("aria-current")).toBe("step");
    // 准备页打开时横幅上不再显示入口
    expect(within(banner).queryByRole("button", { name: "准备仓库" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    await waitFor(() => expect(screen.queryByTestId("repo-prep")).toBeNull());
  });

  it("其他只读原因（如锁被占）不显示入口", async () => {
    render(<App api={appApi({ mode: "readonly", reason: "写入锁被占用（pid 1）" })} />);
    const banner = await screen.findByRole("region", { name: "只读模式" });
    expect(within(banner).queryByRole("button", { name: "准备仓库" })).toBeNull();
  });
});

describe("目标文件夹名（UI-03a 评审 B1）", () => {
  it("准备页标题和三个确认框都显示最后一级文件夹名", async () => {
    const check = async (checks: DesktopRepoCheck[], button: string) => {
      renderPage(api(checks, {}, "my-project"));
      expect((await screen.findByTestId("prep-folder")).textContent).toBe("my-project");
      fireEvent.click(await screen.findByRole("button", { name: button }));
      const dlg = await screen.findByRole("dialog");
      expect(within(dlg).getByTestId("target-folder").textContent).toContain("my-project");
      cleanup();
    };
    await check([NOT_GIT], "初始化 Git");
    await check([NO_COMMITS()], "创建首次提交");
    await check([NO_MAIN], "从当前分支新建 main");
  });

  it("过长的文件夹名截断；就算传来带路径的也只取最后一级", async () => {
    expect(shortFolder("a".repeat(40))).toBe(`${"a".repeat(31)}…`);
    expect(shortFolder("/home/eva/secret/proj")).toBe("proj");
    expect(shortFolder("C:\\Users\\eva\\proj\\")).toBe("proj");
    renderPage(api([NOT_GIT], {}, "很长".repeat(30)));
    const t = (await screen.findByTestId("prep-folder")).textContent!;
    expect([...t]).toHaveLength(32);
    expect(t.endsWith("…")).toBe(true);
  });
});

describe("仓库来源是当前工作目录（UI-03a 评审 B1）", () => {
  const notGit = (repoSource?: DesktopBackendStatus["repoSource"]): DesktopBackendStatus => ({
    mode: "readonly",
    reason: "这个文件夹还不是 Git 仓库",
    error: { name: "Error", message: "这个文件夹还不是 Git 仓库", code: "not_git" },
    ...(repoSource && { repoSource }),
  });
  const appApi = (s: DesktopBackendStatus, importProject = vi.fn(async () => ({ ok: false }))) =>
    ({
      platform: "win32",
      getSnapshot: async () => ({
        db: { path: "/p", state: "ok" },
        events: [],
        tickets: [],
        last_seq: 0,
      }),
      onUpdate: () => () => {},
      getBackendStatus: vi.fn(async () => s),
      importProject,
      ...api([NOT_GIT]),
    }) as unknown as BakaDesktopApi;

  for (const src of ["cwd", undefined] as const) {
    it(`来源 ${String(src)} 且不是 Git 仓库：没有「准备仓库」，横幅提示先导入项目`, async () => {
      const importProject = vi.fn(async () => ({ ok: false }));
      render(<App api={appApi(notGit(src), importProject)} />);
      const banner = await screen.findByRole("region", { name: "只读模式" });
      expect(within(banner).queryByRole("button", { name: "准备仓库" })).toBeNull();
      expect(within(banner).getByTestId("import-first-hint").textContent).toContain("请先导入项目");
      fireEvent.click(within(banner).getByRole("button", { name: "导入项目" }));
      await waitFor(() => expect(importProject).toHaveBeenCalled());
      expect(screen.queryByTestId("repo-prep")).toBeNull();
    });
  }

  it("来源是上次导入：照常给「准备仓库」，不提示导入", async () => {
    render(<App api={appApi(notGit("last_import"))} />);
    const banner = await screen.findByRole("region", { name: "只读模式" });
    expect(within(banner).getByRole("button", { name: "准备仓库" })).toBeTruthy();
    expect(within(banner).queryByTestId("import-first-hint")).toBeNull();
  });

  it("repoFixRoute / needsImportFirst：cwd 或不明来源不给路由", () => {
    expect(repoFixRoute(notGit("cwd"))).toBeNull();
    expect(repoFixRoute(notGit())).toBeNull();
    expect(needsImportFirst(notGit("cwd"))).toBe(true);
    expect(repoFixRoute(notGit("arg"))).toBe("init_repo");
    expect(needsImportFirst(notGit("env"))).toBe(false);
    // 不是仓库没准备好的只读（锁被占）：不提示导入
    expect(needsImportFirst({ mode: "readonly", reason: "写入锁被占用（pid 1）" })).toBe(false);
  });
});
