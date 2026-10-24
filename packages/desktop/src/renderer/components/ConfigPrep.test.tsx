// @vitest-environment jsdom
// T-113：准备页「模型配置」项和「生成配置」确认框——顺序 git → 配置 → 提交；预算必填不预填；覆盖要勾确认；
// 写明生成的文件不提交；嵌套仓库只给固定提示、不给初始化；只读原因路由到对应项。
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  DesktopBackendStatus,
  DesktopConfigCheck,
  DesktopConfigFixResult,
  DesktopRepoCheck,
} from "../../shared/api";
import { CONFIG_FIX_TEXT, NESTED_REPO_REASON } from "../../shared/config-text";
import { toast, Toaster } from "./ui/sonner";
import { RepoPrepPage, type RepoPrepApi } from "./RepoPrepPage";
import {
  CONFIG_COPY,
  configDetail,
  configPlan,
  firstFailing,
  parseBudgetUsd,
  prepItems,
  ROUTE_ITEM,
} from "../lib/repoPrep";
import { repoFixRoute } from "../lib/readonly";

beforeAll(() => {
  Element.prototype.scrollIntoView ??= function () {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  toast.dismiss();
  cleanup();
});

const NO_COMMITS: DesktopRepoCheck = {
  items: [
    { id: "git", ok: true },
    { id: "commit", ok: false, code: "no_commits", detail: "仓库还没有任何提交" },
    { id: "main", ok: false, code: "no_main", detail: "没找到 main 分支" },
    { id: "ignored", ok: true },
  ],
  current_branch: "main",
  identity: { name: true, email: true },
};
const NESTED: DesktopRepoCheck = {
  items: [
    { id: "git", ok: false, code: "nested_repo", detail: NESTED_REPO_REASON },
    { id: "commit", ok: false, code: "no_commits" },
    { id: "main", ok: false, code: "no_main" },
    { id: "ignored", ok: false, code: "not_ignored" },
  ],
  current_branch: null,
  identity: { name: false, email: false },
};
const cfg = (over: Partial<DesktopConfigCheck> = {}): DesktopConfigCheck => ({
  models: "missing",
  pricing: "missing",
  models_external: false,
  errors: [],
  ...over,
});
const CFG_OK = cfg({ models: "ok", pricing: "ok" });
const OK_RESULT: DesktopConfigFixResult = {
  ok: true,
  written: ["models", "pricing"],
  backups: [],
  excluded: true,
  reload: { state: "reloaded" },
};

function api(
  seq: { check: DesktopRepoCheck; config?: DesktopConfigCheck }[],
  over: Partial<RepoPrepApi> = {},
) {
  const queue = [...seq];
  return {
    checkRepo: vi.fn(async () => {
      const s = queue.length > 1 ? queue.shift()! : queue[0]!;
      return { ok: true as const, folder: "proj", ...s };
    }),
    initRepo: vi.fn(),
    listInitialFiles: vi.fn(async () => ({ ok: true as const, include: ["a"], excluded: [] })),
    initialCommit: vi.fn(),
    createMainBranch: vi.fn(),
    initConfig: vi.fn(async () => OK_RESULT),
    ...over,
  } satisfies RepoPrepApi;
}
const renderPage = (a: RepoPrepApi, route: Parameters<typeof RepoPrepPage>[0]["route"] = null) => {
  const onFixed = vi.fn();
  render(
    <>
      <RepoPrepPage api={a} route={route} onBack={() => {}} onFixed={onFixed} />
      <Toaster />
    </>,
  );
  return { onFixed };
};

describe("纯逻辑（T-113）", () => {
  it("prepItems：git 之后插「模型配置」；配置不过时提交等后面各项灰掉；不带 config 时同旧顺序", () => {
    const items = prepItems(NO_COMMITS, cfg());
    expect(items.map((i) => i.id)).toEqual(["git", "config", "commit", "main", "ignored"]);
    expect(items[1]).toMatchObject({
      state: "fail",
      action: "生成配置",
      detail: "缺少 config/models.json；缺少 config/pricing.json",
    });
    expect(items[2]!.state).toBe("blocked");
    expect(firstFailing(NO_COMMITS, cfg())).toBe("config");
    expect(prepItems(NO_COMMITS).map((i) => i.id)).toEqual(["git", "commit", "main", "ignored"]);
    expect(firstFailing(NO_COMMITS, CFG_OK)).toBe("commit");
  });

  it("嵌套仓库：git 项给固定提示，「初始化 Git」禁用", () => {
    const git = prepItems(NESTED)[0]!;
    expect(git).toMatchObject({
      state: "fail",
      detail: NESTED_REPO_REASON,
      action: "初始化 Git",
      disabled: true,
    });
    expect(prepItems(NO_COMMITS)[0]!.disabled).toBeUndefined();
  });

  it("models.json 是另外指定的、只剩它不对：不给按钮，说明去改那个文件", () => {
    const c = cfg({ models: "invalid", pricing: "ok", models_external: true });
    const item = prepItems(NO_COMMITS, c)[1]!;
    expect(item.action).toBeUndefined();
    expect(item.note).toBe(CONFIG_FIX_TEXT.external_config);
    expect(configPlan(c)).toEqual({ create: [], overwrite: [], needBudget: false });
  });

  it("configPlan / configDetail：缺的新建、坏的覆盖；写 models.json 才要预算", () => {
    expect(configPlan(cfg({ models: "invalid" }))).toEqual({
      create: ["config/pricing.json"],
      overwrite: ["config/models.json"],
      needBudget: true,
    });
    expect(configPlan(cfg({ models: "ok" }))).toMatchObject({ needBudget: false });
    expect(configDetail(cfg({ models: "invalid", pricing: "ok" }))).toBe(
      "config/models.json 内容不合法",
    );
  });

  it("parseBudgetUsd：必填、>0、最多 6 位小数、有上限；不给默认值", () => {
    expect(parseBudgetUsd("")).toBeNull();
    expect(parseBudgetUsd("  ")).toBeNull();
    expect(parseBudgetUsd("0")).toBeNull();
    expect(parseBudgetUsd("-1")).toBeNull();
    expect(parseBudgetUsd("1e3")).toBeNull();
    expect(parseBudgetUsd("1.1234567")).toBeNull();
    expect(parseBudgetUsd("1000001")).toBeNull();
    expect(parseBudgetUsd("5")).toBe(5_000_000);
    expect(parseBudgetUsd("0.000001")).toBe(1);
    expect(parseBudgetUsd("12.5")).toBe(12_500_000);
  });

  it("只读原因路由：config_missing / config_invalid → 生成配置；nested_repo → git 项", () => {
    const ro = (code: string): DesktopBackendStatus => ({
      mode: "readonly",
      reason: "x",
      repoSource: "last_import",
      error: { name: "Error", message: "x", code },
    });
    expect(repoFixRoute(ro("config_missing"))).toBe("init_config");
    expect(repoFixRoute(ro("config_invalid"))).toBe("init_config");
    expect(repoFixRoute(ro("nested_repo"))).toBe("init_repo");
    expect(ROUTE_ITEM.init_config).toBe("config");
  });
});

describe("准备页「生成配置」（T-113）", () => {
  it("预算必填不预填：空着按钮灰；填好后带微美元调 initConfig；写明不提交；成功后通知外层、页上留说明", async () => {
    const a = api([
      { check: NO_COMMITS, config: cfg() },
      { check: NO_COMMITS, config: CFG_OK },
    ]);
    const { onFixed } = renderPage(a, "init_config");
    const item = await screen.findByTestId("prep-item-config");
    expect(item.getAttribute("aria-current")).toBe("step");
    fireEvent.click(within(item).getByRole("button", { name: "生成配置" }));
    const dlg = await screen.findByRole("dialog", { name: "生成配置" });
    const input = within(dlg).getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(within(dlg).getByTestId("config-create").textContent).toContain("config/models.json");
    expect(within(dlg).getByTestId("config-exclude-note").textContent).toBe(
      CONFIG_COPY.notCommitted,
    );
    const go = within(dlg).getByRole("button", { name: "生成配置" });
    expect((go as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "abc" } });
    expect(within(dlg).getByText(CONFIG_COPY.budgetInvalid)).toBeTruthy();
    expect((go as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "2.5" } });
    expect((go as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(go);
    await waitFor(() => expect(a.initConfig).toHaveBeenCalledWith({ daily_micro_usd: 2_500_000 }));
    await waitFor(() => expect(onFixed).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId("prep-item-config").dataset.state).toBe("ok"));
    expect(screen.getByTestId("config-not-committed").textContent).toBe(CONFIG_COPY.notCommitted);
    // 首次提交确认框里也写明
    fireEvent.click(screen.getByRole("button", { name: "创建首次提交" }));
    const commit = await screen.findByRole("dialog", { name: "创建首次提交" });
    expect(within(commit).getByTestId("commit-config-note").textContent).toBe(
      CONFIG_COPY.notCommitted,
    );
  });

  it("再打开确认框：预算重新是空的（不记上次填的）", async () => {
    const a = api([{ check: NO_COMMITS, config: cfg() }]);
    renderPage(a);
    fireEvent.click(await screen.findByRole("button", { name: "生成配置" }));
    let dlg = await screen.findByRole("dialog");
    fireEvent.change(within(dlg).getByRole("textbox"), { target: { value: "3" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "生成配置" }));
    dlg = await screen.findByRole("dialog");
    expect((within(dlg).getByRole("textbox") as HTMLInputElement).value).toBe("");
  });

  it("覆盖不合法的文件：列出、写明先备份、显示脱敏后的错误；不勾确认不能生成，勾了带 confirm_overwrite", async () => {
    const c = cfg({
      models: "ok",
      pricing: "invalid",
      errors: ["config/pricing.json 校验失败：x"],
    });
    const a = api([{ check: NO_COMMITS, config: c }]);
    renderPage(a);
    fireEvent.click(await screen.findByRole("button", { name: "生成配置" }));
    const dlg = await screen.findByRole("dialog");
    expect(within(dlg).getByTestId("config-overwrite").textContent).toContain(
      "config/pricing.json",
    );
    expect(within(dlg).getByText(CONFIG_COPY.backupNote)).toBeTruthy();
    expect(within(dlg).getByText("config/pricing.json 校验失败：x")).toBeTruthy();
    // 只写 pricing：不要预算
    expect(within(dlg).queryByRole("textbox")).toBeNull();
    const go = within(dlg).getByRole("button", { name: "生成配置" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.click(within(dlg).getByRole("checkbox"));
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    await waitFor(() => expect(a.initConfig).toHaveBeenCalledWith({ confirm_overwrite: true }));
  });

  it("失败：toast 用主进程的固定文案，确认框不关", async () => {
    const a = api([{ check: NO_COMMITS, config: cfg() }], {
      initConfig: vi.fn(async () => ({
        ok: false as const,
        code: "unavailable" as const,
        reason: CONFIG_FIX_TEXT.unavailable,
      })),
    });
    renderPage(a);
    fireEvent.click(await screen.findByRole("button", { name: "生成配置" }));
    const dlg = await screen.findByRole("dialog");
    fireEvent.change(within(dlg).getByRole("textbox"), { target: { value: "1" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "生成配置" }));
    expect(await screen.findByText(`生成配置失败：${CONFIG_FIX_TEXT.unavailable}`)).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("嵌套仓库：git 项显示固定提示，「初始化 Git」禁用、点了不开确认框，后面都灰掉", async () => {
    const a = api([{ check: NESTED }]);
    renderPage(a, "init_repo");
    const git = await screen.findByTestId("prep-item-git");
    expect(git.textContent).toContain(NESTED_REPO_REASON);
    const btn = within(git).getByRole("button", { name: "初始化 Git" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(a.initRepo).not.toHaveBeenCalled();
    expect(screen.getByTestId("prep-item-commit").dataset.state).toBe("blocked");
  });
});
