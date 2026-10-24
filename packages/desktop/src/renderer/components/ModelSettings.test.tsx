// @vitest-environment jsdom
// UI-07b：设置 › 模型。来源与只读、在途时排队确认、部分失败照实说明、字段错误标注。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopModelConfigResult, DesktopModelSaveResult } from "../../shared/api";
import { saveNotice } from "../lib/modelSettings";
import { ModelSettings, type ModelSettingsApi } from "./ModelSettings";

afterEach(cleanup);
const text = (el: Element) => el.textContent ?? "";

const rate = { input_cache_hit: 1, input_cache_miss: 2, output: 3 };
function loaded(
  over: Partial<Extract<DesktopModelConfigResult, { ok: true }>> = {},
): DesktopModelConfigResult {
  return {
    ok: true,
    source: "repo",
    readonly: false,
    running: 0,
    providers: [
      {
        id: "deepseek",
        models: ["deepseek-flash", "deepseek-v4-pro"],
        credential: { name: "DEEPSEEK_API_KEY", set: true },
      },
    ],
    form: {
      supervisor: { provider: "deepseek", model: "deepseek-v4-pro" },
      coder: { provider: "deepseek", model: "deepseek-flash", effort: "low" },
      reviewers: [
        { id: "reviewer-1", provider: "deepseek", model: "deepseek-flash", effort: "high" },
      ],
    },
    pricing: {
      "deepseek-flash": { peak: rate, offpeak: rate },
      "deepseek-v4-pro": { peak: rate, offpeak: rate },
    },
    ...over,
  };
}
function api(cfg: DesktopModelConfigResult, save?: DesktopModelSaveResult): ModelSettingsApi {
  return {
    getModelConfig: vi.fn(async () => cfg),
    saveModelConfig: vi.fn(
      async () =>
        save ?? {
          ok: true as const,
          written: ["models", "pricing"],
          reload: { state: "reloaded" as const },
        },
    ),
    testProvider: vi.fn(async () => ({ ok: true as const, latency_ms: 12, cost_micro_usd: 3 })),
  };
}

describe("设置 › 模型", () => {
  it("显示来源、各角色和单价；保存把表单和用到的模型单价交给主进程", async () => {
    const a = api(loaded());
    render(<ModelSettings api={a} />);
    expect(text(await screen.findByTestId("model-source"))).toContain(
      "仓库里的 config/models.json",
    );
    expect(screen.getByTestId("price-deepseek-flash")).toBeTruthy();
    expect(screen.getByText("思考档位固定 max")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("deepseek-flash 高峰输出"), { target: { value: "99" } });
    fireEvent.click(screen.getByTestId("model-save"));
    await waitFor(() =>
      expect(text(screen.getByTestId("model-notice"))).toContain("已保存，后端已按新配置重载"),
    );
    expect(a.saveModelConfig).toHaveBeenCalledWith({
      form: loaded().ok ? (loaded() as Extract<DesktopModelConfigResult, { ok: true }>).form : null,
      pricing: {
        "deepseek-v4-pro": { peak: rate, offpeak: rate },
        "deepseek-flash": { peak: { ...rate, output: 99 }, offpeak: rate },
      },
    });
  });

  it("来源是 --config 时整页只读：说明原因、控件禁用、没有保存按钮", async () => {
    const a = api(loaded({ source: "--config", readonly: true }));
    render(<ModelSettings api={a} />);
    expect(text(await screen.findByTestId("model-source"))).toContain("--config");
    expect(text(screen.getByTestId("model-readonly"))).toBe("配置来自外部文件，此页只读");
    expect(screen.queryByTestId("model-save")).toBeNull();
    expect(screen.queryByText("添加评审")).toBeNull();
    expect((screen.getByLabelText("deepseek-flash 高峰输出") as HTMLInputElement).disabled).toBe(
      true,
    );
    expect((screen.getByLabelText("移除 reviewer-1") as HTMLButtonElement).disabled).toBe(true);
  });

  it("有在途单时按钮写「等当前单跑完后重载」，要确认；排队结果照实显示", async () => {
    const a = api(loaded({ running: 2 }), {
      ok: true,
      written: ["models", "pricing"],
      reload: { state: "queued", waitingTickets: 2, waitingChat: false },
    });
    render(<ModelSettings api={a} />);
    const btn = await screen.findByTestId("model-save");
    expect(text(btn)).toContain("保存，等当前单跑完后重载");
    fireEvent.click(btn);
    expect(a.saveModelConfig).not.toHaveBeenCalled();
    expect(text(screen.getByTestId("model-confirm"))).toContain("有 2 张单");
    fireEvent.click(screen.getByText("确认保存"));
    await waitFor(() =>
      expect(text(screen.getByTestId("model-notice"))).toContain("2 张单跑完后自动重载"),
    );
  });

  it("部分失败：照 written 说清 models.json 写了、pricing.json 没写", async () => {
    const a = api(loaded(), {
      ok: false,
      code: "partial_write",
      reason: "已写入 config/models.json，但写入 config/pricing.json 失败（单价没改）",
      written: ["models"],
      errors: [{ field: "pricing", message: "EACCES: permission denied, open '(path)'" }],
    });
    render(<ModelSettings api={a} />);
    fireEvent.click(await screen.findByTestId("model-save"));
    const n = await screen.findByTestId("model-notice");
    expect(n.getAttribute("role")).toBe("alert");
    expect(text(n)).toContain("已写入：config/models.json；未写入：config/pricing.json");
    expect(text(screen.getByTestId("field-error-pricing"))).toContain("EACCES");
  });

  it("字段错误标在对应字段下", async () => {
    const a = api(loaded(), {
      ok: false,
      code: "invalid",
      reason: "有字段没通过校验，没有写入任何文件",
      written: [],
      errors: [{ field: "coder.model", message: "这个服务商下没有这个模型" }],
    });
    render(<ModelSettings api={a} />);
    fireEvent.click(await screen.findByTestId("model-save"));
    expect(text(await screen.findByTestId("field-error-coder"))).toContain(
      "这个服务商下没有这个模型",
    );
    expect(text(screen.getByTestId("model-notice"))).not.toContain("已写入");
  });

  it("评审可以加和删", async () => {
    render(<ModelSettings api={api(loaded())} />);
    fireEvent.click(await screen.findByText("添加评审"));
    expect(text(screen.getByTestId("reviewer-1"))).toContain("reviewer-2");
    fireEvent.click(screen.getByLabelText("移除 reviewer-1"));
    fireEvent.click(screen.getByLabelText("移除 reviewer-2"));
    expect(screen.getByText("评审池为空：主管兼任评审。")).toBeTruthy();
  });

  it("读配置失败时显示主进程的固定文案；没有 API 时说没连上", async () => {
    render(
      <ModelSettings
        api={api({ ok: false, code: "invalid_config", reason: "当前模型配置不合法" })}
      />,
    );
    expect(text(await screen.findByTestId("model-load-error"))).toContain("当前模型配置不合法");
    cleanup();
    render(<ModelSettings />);
    expect(screen.getByText("没有连接主进程，读不到模型配置。")).toBeTruthy();
  });
});

describe("saveNotice", () => {
  it("部分失败说明写了哪个、没写哪个；全没写不提已写入", () => {
    expect(
      saveNotice({ ok: false, code: "partial_write", reason: "r", written: ["models"] }).detail,
    ).toBe("已写入：config/models.json；未写入：config/pricing.json");
    expect(saveNotice({ ok: false, code: "write_failed", reason: "r", written: [] })).toEqual({
      tone: "error",
      text: "r",
    });
    expect(
      saveNotice({
        ok: true,
        written: ["models", "pricing"],
        reload: { state: "failed", reason: "x" },
      }),
    ).toMatchObject({ tone: "warn", detail: "x" });
  });
});
