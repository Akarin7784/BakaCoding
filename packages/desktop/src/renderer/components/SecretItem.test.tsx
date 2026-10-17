// @vitest-environment jsdom
// UI-03b：密钥项（来源 / 末 4 位 / 「已设置」/ 系统来源不给清除 / 值不留在界面）与模型设置向导（测试连接的固定文案）。
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  DesktopProviderTestCode,
  DesktopProviderTestResult,
  DesktopSecretStatus,
  DesktopSettings,
} from "../../shared/api";
import { PROVIDER_TEST_TEXT, SECRET_FAILURE_TEXT } from "../../shared/secret-text";
import {
  canClearSecret,
  formatMicroUsd,
  providerTestNotSent,
  providerTestText,
  secretStatusText,
} from "../lib/secretItem";
import { ModelSetupWizard, type WizardApi } from "./ModelSetupWizard";
import { SecretItem } from "./SecretItem";
import { SettingsPanel } from "./SettingsPanel";
import { toast, Toaster } from "./ui/sonner";

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

const KEY = "sk-ui03b-renderer-secret-ABCD";

function fakeApi(initial: DesktopSecretStatus, over: Partial<WizardApi> = {}) {
  let status = initial;
  return {
    secretStatus: vi.fn(async () => ({ ok: true as const, status })),
    setSecret: vi.fn(async () => {
      status = { set: true, source: "bakacoding", last4: "ABCD" };
      return { ok: true as const, status };
    }),
    clearSecret: vi.fn(async () => {
      status = { set: false, source: null };
      return { ok: true as const, status };
    }),
    testProvider: vi.fn(async (): Promise<DesktopProviderTestResult> => ({
      ok: true,
      latency_ms: 321,
      cost_micro_usd: 4,
    })),
    ...over,
  };
}

const renderItem = (a: WizardApi) =>
  render(
    <>
      <SecretItem api={a} name="DEEPSEEK_API_KEY" />
      <Toaster />
    </>,
  );

describe("密钥项纯逻辑（UI-03b）", () => {
  it("状态文字：末 4 位 / bakacoding 没有末 4 位只写「已设置」/ 系统来源 / 未设置", () => {
    expect(secretStatusText({ set: true, source: "bakacoding", last4: "WXYZ" })).toBe(
      "已设置（末 4 位 WXYZ）",
    );
    expect(secretStatusText({ set: true, source: "bakacoding" })).toBe("已设置");
    expect(secretStatusText({ set: true, source: "system" })).toBe("已设置（来自系统环境变量）");
    expect(secretStatusText({ set: false, source: null })).toBe("未设置");
    expect(canClearSecret({ set: true, source: "system" })).toBe(false);
    expect(canClearSecret({ set: true, source: "bakacoding" })).toBe(true);
    expect(canClearSecret({ set: false, source: null })).toBe(false);
    expect(formatMicroUsd(4)).toBe("$0.000004");
    expect(formatMicroUsd(Number.NaN)).toBe("$0.000000");
  });

  it("测试连接文案：失败原样用主进程按码给的固定文案；http_error 带状态码；这几种没发请求", () => {
    const f = (code: DesktopProviderTestCode, status?: number): DesktopProviderTestResult => ({
      ok: false,
      code,
      reason: PROVIDER_TEST_TEXT[code],
      ...(status !== undefined && { status }),
    });
    expect(providerTestText(f("quota_exhausted"))).toBe("服务商账户余额不足，请先去服务商那里充值");
    expect(providerTestText(f("config_error"))).toBe(
      "模型配置有问题：服务商或模型没配置，或者没有单价",
    );
    expect(providerTestText(f("http_error", 503))).toBe("服务商返回了错误（HTTP 503）");
    expect(providerTestNotSent(f("budget_exhausted"))).toBe(true);
    expect(providerTestNotSent(f("auth_failed"))).toBe(false);
    expect(providerTestText({ ok: true, latency_ms: 12.4, cost_micro_usd: 3 })).toBe(
      "连接正常：用时 12 ms，花费 $0.000003",
    );
  });
});

describe("SecretItem（UI-03b）", () => {
  it("bakacoding 来源、没有末 4 位：显示「已设置」，有「清除」", async () => {
    renderItem(fakeApi({ set: true, source: "bakacoding" }));
    await waitFor(() =>
      expect(screen.getByTestId("secret-status-DEEPSEEK_API_KEY").textContent).toBe("已设置"),
    );
    expect(screen.getByRole("button", { name: "清除" })).toBeTruthy();
  });

  it("系统来源：不给「清除」，写明不能清", async () => {
    renderItem(fakeApi({ set: true, source: "system" }));
    await waitFor(() =>
      expect(screen.getByTestId("secret-status-DEEPSEEK_API_KEY").textContent).toBe(
        "已设置（来自系统环境变量）",
      ),
    );
    expect(screen.queryByRole("button", { name: "清除" })).toBeNull();
    expect(screen.getByTestId("secret-DEEPSEEK_API_KEY").textContent).toContain(
      "BakaCoding 不能清除",
    );
  });

  it("保存：值只交给 setSecret 一次，点下去就清空输入框，界面上找不到值；之后显示末 4 位", async () => {
    const a = fakeApi({ set: false, source: null });
    const { container } = renderItem(a);
    const input = (await screen.findByLabelText("DeepSeek 密钥的值")) as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.change(input, { target: { value: KEY } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(input.value).toBe("");
    await waitFor(() =>
      expect(screen.getByTestId("secret-status-DEEPSEEK_API_KEY").textContent).toBe(
        "已设置（末 4 位 ABCD）",
      ),
    );
    expect(a.setSecret).toHaveBeenCalledTimes(1);
    expect(a.setSecret).toHaveBeenCalledWith("DEEPSEEK_API_KEY", KEY);
    expect(await screen.findByText("密钥已保存")).toBeTruthy();
    expect(container.innerHTML).not.toContain(KEY);
    expect(document.body.innerHTML).not.toContain(KEY);
    fireEvent.click(screen.getByRole("button", { name: "清除" }));
    await waitFor(() =>
      expect(screen.getByTestId("secret-status-DEEPSEEK_API_KEY").textContent).toBe("未设置"),
    );
    expect(a.clearSecret).toHaveBeenCalledWith("DEEPSEEK_API_KEY");
  });

  it("保存失败：toast 主进程的固定文案；输入框也已清空", async () => {
    const a = fakeApi(
      { set: false, source: null },
      {
        setSecret: vi.fn(async () => ({
          ok: false as const,
          code: "unsupported_platform" as const,
          reason: SECRET_FAILURE_TEXT.unsupported_platform,
        })),
      },
    );
    renderItem(a);
    const input = (await screen.findByLabelText("DeepSeek 密钥的值")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: KEY } });
    fireEvent.submit(input.closest("form")!);
    expect(
      await screen.findByText(`保存密钥失败：${SECRET_FAILURE_TEXT.unsupported_platform}`),
    ).toBeTruthy();
    expect(input.value).toBe("");
    expect(document.body.innerHTML).not.toContain(KEY);
  });

  it("空值不能保存", async () => {
    renderItem(fakeApi({ set: false, source: null }));
    await screen.findByLabelText("DeepSeek 密钥的值");
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("模型设置向导（UI-03b）", () => {
  const openWizard = (a: WizardApi) =>
    render(<ModelSetupWizard open onOpenChange={() => {}} api={a} />);

  it("两步：密钥 → 测试连接；成功显示用时和花费，只传服务商", async () => {
    const a = fakeApi({ set: true, source: "bakacoding", last4: "ABCD" });
    openWizard(a);
    const dlg = await screen.findByRole("dialog", { name: "模型设置向导" });
    expect(within(dlg).getByTestId("secret-DEEPSEEK_API_KEY")).toBeTruthy();
    fireEvent.click(within(dlg).getByRole("button", { name: "下一步" }));
    fireEvent.click(within(dlg).getByRole("button", { name: "测试连接" }));
    const r = await within(dlg).findByTestId("provider-test-result");
    expect(r.dataset.code).toBe("ok");
    expect(r.textContent).toContain("连接正常：用时 321 ms，花费 $0.000004");
    expect(a.testProvider).toHaveBeenCalledWith({ provider: "deepseek" });
  });

  for (const code of ["quota_exhausted", "config_error", "budget_exhausted"] as const) {
    it(`失败 ${code}：显示固定中文文案`, async () => {
      const a = fakeApi(
        { set: true, source: "system" },
        {
          testProvider: vi.fn(async () => ({
            ok: false as const,
            code,
            reason: PROVIDER_TEST_TEXT[code],
          })),
        },
      );
      openWizard(a);
      const dlg = await screen.findByRole("dialog");
      fireEvent.click(within(dlg).getByRole("button", { name: "下一步" }));
      fireEvent.click(within(dlg).getByRole("button", { name: "测试连接" }));
      const r = await within(dlg).findByTestId("provider-test-result");
      expect(r.dataset.code).toBe(code);
      expect(r.textContent).toContain(PROVIDER_TEST_TEXT[code]);
      expect(r.textContent).toContain("连接失败");
      if (code === "budget_exhausted") {
        expect(r.textContent).toContain("没有发出请求");
        // 已经写在文案里，不重复一行
        expect(r.textContent!.split("没有发出请求").length - 1).toBe(1);
      }
      if (code === "config_error") expect(r.textContent).toContain("没有发出请求");
    });
  }

  it("测试连接抛错：固定文案「测试连接失败，请重试」", async () => {
    const a = fakeApi(
      { set: true, source: "system" },
      {
        testProvider: vi.fn(async () => {
          throw new Error(`boom ${KEY}`);
        }),
      },
    );
    openWizard(a);
    const dlg = await screen.findByRole("dialog");
    fireEvent.click(within(dlg).getByRole("button", { name: "下一步" }));
    fireEvent.click(within(dlg).getByRole("button", { name: "测试连接" }));
    const r = await within(dlg).findByTestId("provider-test-result");
    expect(r.textContent).toContain(PROVIDER_TEST_TEXT.failed);
    expect(document.body.innerHTML).not.toContain(KEY);
  });
});

describe("设置页里的密钥项与向导入口（UI-03b）", () => {
  const settings: DesktopSettings = {
    repo: "/r",
    mode: "local",
    env: [
      { name: "DEEPSEEK_API_KEY", set: true },
      { name: "GITHUB_TOKEN", set: false },
      { name: "BAKACODING_REPO", set: false },
    ],
  } as DesktopSettings;

  it("有 secret 接口：两个密钥是可编辑的密钥项，能打开模型设置向导", async () => {
    const a = fakeApi({ set: false, source: null });
    render(<SettingsPanel settings={settings} onBack={() => {}} api={a} />);
    expect(await screen.findByTestId("secret-DEEPSEEK_API_KEY")).toBeTruthy();
    expect(screen.getByTestId("secret-GITHUB_TOKEN")).toBeTruthy();
    expect(screen.queryByTestId("env-DEEPSEEK_API_KEY")).toBeNull();
    expect(screen.getByTestId("env-BAKACODING_REPO")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "模型设置向导" }));
    expect(await screen.findByRole("dialog", { name: "模型设置向导" })).toBeTruthy();
  });

  it("没有 secret 接口（旧版 preload）：仍是只读的已设 / 未设", () => {
    render(<SettingsPanel settings={settings} onBack={() => {}} />);
    expect(screen.getByTestId("env-DEEPSEEK_API_KEY").textContent).toContain("已设");
    expect(screen.queryByRole("button", { name: "模型设置向导" })).toBeNull();
  });
});
