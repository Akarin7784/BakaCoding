// @vitest-environment jsdom
// UI-07c：设置 › 预算。必填不给默认值、比例 (0,1]、低于今天已花费只警告不拦、只读、今天花费只取 budget:status。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopBudgetStatusResult,
  DesktopLedgerSummaryResult,
  DesktopModelSaveResult,
} from "../../shared/api";
import { belowToday, microToUsd, parseRatio } from "../lib/budgetSettings";
import { BudgetSettings, type BudgetSettingsApi } from "./BudgetSettings";

afterEach(cleanup);
const text = (el: Element) => el.textContent ?? "";

function status(
  over: Partial<Extract<DesktopBudgetStatusResult, { ok: true }>> = {},
): DesktopBudgetStatusResult {
  return {
    ok: true,
    source: "repo",
    readonly: false,
    budget: { daily_micro_usd: 5_000_000, per_ticket_ratio: 0.05, offpeak_preference: false },
    today: {
      day: "2026-10-24",
      spent_micro_usd: 2_500_000,
      reserved_micro_usd: 0,
      daily_limit_micro_usd: 5_000_000,
      per_ticket_limit_micro_usd: 250_000,
    },
    running: 0,
    ...over,
  };
}
function api(st: DesktopBudgetStatusResult, save?: DesktopModelSaveResult): BudgetSettingsApi {
  return {
    getBudgetStatus: vi.fn(async () => st),
    saveBudget: vi.fn(
      async () =>
        save ?? { ok: true as const, written: ["models"], reload: { state: "reloaded" as const } },
    ),
  };
}
const daily = () => screen.getByLabelText("每日预算（美元，必填）") as HTMLInputElement;
const ratio = () => screen.getByLabelText("每单上限比例") as HTMLInputElement;

describe("设置 › 预算", () => {
  it("显示今天已花费（来自 budget:status）；改好后保存把三项交给主进程", async () => {
    const a = api(status());
    render(<BudgetSettings api={a} />);
    expect(text(await screen.findByTestId("budget-today"))).toContain("$2.5");
    expect(daily().value).toBe("5");
    fireEvent.change(daily(), { target: { value: "8.25" } });
    fireEvent.change(ratio(), { target: { value: "0.1" } });
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(screen.getByTestId("budget-save"));
    await waitFor(() =>
      expect(text(screen.getByTestId("budget-notice"))).toContain("已保存，后端已按新配置重载"),
    );
    expect(a.saveBudget).toHaveBeenCalledWith({
      budget: { daily_micro_usd: 8_250_000, per_ticket_ratio: 0.1, offpeak_preference: true },
    });
  });

  it("每日预算必填、不预填默认值：配置里没有就是空的，空着保存被拦，不调主进程", async () => {
    const a = api(
      status({ budget: { daily_micro_usd: 0, per_ticket_ratio: 0.05, offpeak_preference: false } }),
    );
    render(<BudgetSettings api={a} />);
    await screen.findByTestId("budget-settings");
    expect(daily().value).toBe("");
    expect(daily().required).toBe(true);
    fireEvent.click(screen.getByTestId("budget-save"));
    expect(screen.getByTestId("field-error-budget.daily_micro_usd")).toBeTruthy();
    expect(a.saveBudget).not.toHaveBeenCalled();
  });

  it.each(["0", "-0.1", "1.5", "NaN", "abc", ""])("比例 %s 被拦，不调主进程", async (v) => {
    const a = api(status());
    render(<BudgetSettings api={a} />);
    await screen.findByTestId("budget-settings");
    fireEvent.change(ratio(), { target: { value: v } });
    fireEvent.click(screen.getByTestId("budget-save"));
    expect(screen.getByTestId("field-error-budget.per_ticket_ratio")).toBeTruthy();
    expect(a.saveBudget).not.toHaveBeenCalled();
  });

  it("低于今天已花费只警告，照样能保存", async () => {
    const a = api(status());
    render(<BudgetSettings api={a} />);
    await screen.findByTestId("budget-settings");
    expect(screen.queryByTestId("budget-below-today")).toBeNull();
    fireEvent.change(daily(), { target: { value: "1" } });
    expect(text(screen.getByTestId("budget-below-today"))).toContain("$2.5");
    fireEvent.click(screen.getByTestId("budget-save"));
    await waitFor(() => expect(a.saveBudget).toHaveBeenCalledTimes(1));
    expect(a.saveBudget).toHaveBeenCalledWith({
      budget: { daily_micro_usd: 1_000_000, per_ticket_ratio: 0.05, offpeak_preference: false },
    });
  });

  it("--config 锁定时只读：控件禁用、没有保存按钮", async () => {
    const a = api(status({ source: "--config", readonly: true }));
    render(<BudgetSettings api={a} />);
    expect(text(await screen.findByTestId("budget-readonly"))).toBe("配置来自外部文件，此页只读");
    expect(daily().disabled).toBe(true);
    expect(ratio().disabled).toBe(true);
    expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId("budget-save")).toBeNull();
  });

  it("只读后端（today 为 null）时照实说取不到，不编数，也不警告", async () => {
    render(<BudgetSettings api={api(status({ today: null }))} />);
    expect(text(await screen.findByTestId("budget-today"))).toContain("取不到今天已花费");
    fireEvent.change(daily(), { target: { value: "0.01" } });
    expect(screen.queryByTestId("budget-below-today")).toBeNull();
  });

  it("主进程按字段报的错标在字段下；读取失败显示固定文案", async () => {
    const a = api(status(), {
      ok: false,
      code: "invalid",
      reason: "有字段没通过校验，没有写入任何文件",
      written: [],
      errors: [{ field: "budget.per_ticket_ratio", message: "比例必须大于 0、不超过 1" }],
    });
    render(<BudgetSettings api={a} />);
    await screen.findByTestId("budget-settings");
    fireEvent.click(screen.getByTestId("budget-save"));
    await waitFor(() =>
      expect(screen.getByTestId("field-error-budget.per_ticket_ratio")).toBeTruthy(),
    );
    cleanup();
    render(
      <BudgetSettings
        api={api({ ok: false, code: "read_failed", reason: "读不到 config/models.json" })}
      />,
    );
    expect(text(await screen.findByTestId("budget-load-error"))).toContain("读不到");
  });

  it("有在途单时先确认再保存", async () => {
    const a = api(status({ running: 2 }));
    render(<BudgetSettings api={a} />);
    await screen.findByTestId("budget-settings");
    fireEvent.click(screen.getByTestId("budget-save"));
    expect(screen.getByTestId("budget-confirm")).toBeTruthy();
    expect(a.saveBudget).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("确认保存"));
    await waitFor(() => expect(a.saveBudget).toHaveBeenCalledTimes(1));
  });
});

describe("预算纯逻辑", () => {
  it("parseRatio 只收 (0,1]", () => {
    expect(parseRatio("1")).toBe(1);
    expect(parseRatio("0.05")).toBe(0.05);
    for (const v of ["0", "0.0", "-1", "1.01", "NaN", "Infinity", "", "1e-3"])
      expect(parseRatio(v)).toBeNull();
  });
  it("microToUsd / belowToday", () => {
    expect(microToUsd(5_000_000)).toBe("5");
    expect(microToUsd(1_234_567)).toBe("1.234567");
    expect(belowToday(1, 2)).toBe(true);
    expect(belowToday(2, 2)).toBe(false);
    expect(belowToday(null, 2)).toBe(false);
    expect(belowToday(1, null)).toBe(false);
  });
});

// UI-07e：§4.6「本项目已花费（来自台账）」——各项目累计只取 ledger:summary，今天已花费仍只取 budget:status。
describe("设置 › 预算 本项目已花费", () => {
  const role = { supervisor: 0, reviewer: 0, sub_agent: 0, coder: 0 };
  const summary: DesktopLedgerSummaryResult = {
    ok: true,
    projects: [
      {
        project_id: "p-1",
        name: "alpha",
        total_micro_usd: 12_340_000,
        resubmit_micro_usd: 1_500_000,
        entries: 9,
        by_role: role,
      },
      {
        project_id: "p-2",
        name: "beta",
        total_micro_usd: 700_000,
        resubmit_micro_usd: 0,
        entries: 1,
        by_role: role,
      },
    ],
  };
  const withSummary = (
    s: () => Promise<DesktopLedgerSummaryResult>,
    st = status(),
  ): BudgetSettingsApi => ({ ...api(st), getLedgerSummary: vi.fn(s) });

  it("按项目显示累计（含重写只在大于 0 时显示）；今天已花费仍来自 budget:status", async () => {
    const a = withSummary(async () => summary);
    render(<BudgetSettings api={a} />);
    const one = await screen.findByTestId("project-spend-p-1");
    expect(text(one)).toContain("alpha");
    expect(text(one)).toContain("$12.34");
    expect(text(one)).toContain("（含重写 $1.5）");
    const two = screen.getByTestId("project-spend-p-2");
    expect(text(two)).toContain("$0.7");
    expect(text(two)).not.toContain("含重写");
    expect(a.getLedgerSummary).toHaveBeenCalledTimes(1);
    // 今天已花费：budget:status 的 2.5，不是台账累计
    const today = screen.getByTestId("budget-today");
    expect(text(today)).toContain("$2.5");
    expect(text(today)).not.toContain("12.34");
    expect(text(screen.getByTestId("project-spend"))).not.toContain("$2.5");
  });

  it("今天已花费跟着 budget:status 变，与台账无关", async () => {
    const st = status();
    const a = withSummary(async () => summary, {
      ...st,
      ...(st.ok && st.today && { today: { ...st.today, spent_micro_usd: 3_210_000 } }),
    } as DesktopBudgetStatusResult);
    render(<BudgetSettings api={a} />);
    await screen.findByTestId("project-spend-list");
    expect(text(screen.getByTestId("budget-today"))).toContain("$3.21");
  });

  it("读取中显示加载；没有项目显示空状态", async () => {
    let done: (r: DesktopLedgerSummaryResult) => void = () => {};
    const a = withSummary(() => new Promise((r) => (done = r)));
    render(<BudgetSettings api={a} />);
    expect(await screen.findByTestId("project-spend-loading")).toBeTruthy();
    done({ ok: true, projects: [] });
    expect(text(await screen.findByTestId("project-spend-empty"))).toContain("还没有已导入的项目");
    expect(screen.queryByTestId("project-spend-list")).toBeNull();
  });

  it("出错：ok:false 显示原因；调用抛错显示固定文案；预算表单照常可用", async () => {
    render(
      <BudgetSettings
        api={withSummary(async () => ({ ok: false, reason: "后端只读，读不到台账" }))}
      />,
    );
    expect(text(await screen.findByTestId("project-spend-error"))).toBe("后端只读，读不到台账");
    expect(screen.getByTestId("budget-save")).toBeTruthy();
    cleanup();
    render(<BudgetSettings api={withSummary(async () => Promise.reject(new Error("x")))} />);
    expect(text(await screen.findByTestId("project-spend-error"))).toBe(
      "读取项目花费失败，请重试。",
    );
  });
});
