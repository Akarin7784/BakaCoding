// UI-03b：secret:* / provider:test IPC——参数校验先于 3 / 1、密钥值不回传不进日志、失败原因固定文案。
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SECRET_NAMES, type SecretName, type UserEnvStore } from "@bakacoding/config-budget";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_SECRET_NAMES,
  IPC_CHANNELS,
  type DesktopProviderTestCode,
  type DesktopProviderTestResult,
  type DesktopSecretSetResult,
} from "../shared/api.js";
import { PROVIDER_TEST_TEXT, SECRET_FAILURE_TEXT } from "../shared/secret-text.js";
import type { BackendTestResult } from "./backend.js";
import { serveSecretProvider } from "./ipc.js";
import {
  parseProviderTarget,
  parseSecretName,
  type SecretProviderDeps,
} from "./secret-provider-ipc.js";

const FAKE_EVENT = { sender: {} };
const KEY = "sk-UI03b-test-secret-VALUE-9f3kQRST";
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function memUserEnv(): UserEnvStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async get(n) {
      return data.get(n);
    },
    async set(n, v) {
      data.set(n, v);
    },
    async remove(n) {
      data.delete(n);
    },
  };
}

function setup(over: Partial<SecretProviderDeps> = {}, mode: "live" | "readonly" = "live") {
  const dir = mkdtempSync(join(tmpdir(), "bc-secret-ipc-"));
  dirs.push(dir);
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  const env: NodeJS.ProcessEnv = {};
  const userEnv = memUserEnv();
  const markerPath = join(dir, "secret-markers.json");
  const testConnection = vi.fn(async (): Promise<BackendTestResult> => ({
    ok: true,
    latency_ms: 12,
    cost_micro_usd: 3,
  }));
  const reconnect = vi.fn(async () => ({ state: "reloaded" as const }));
  const stop = serveSecretProvider(
    { handle: (c, l) => void handlers.set(c, l), removeHandler: (c) => void handlers.delete(c) },
    {
      secretDeps: { env, markerPath, userEnv },
      backend: { status: () => ({ mode }), testConnection, reconnect },
      ...over,
    },
  );
  const invoke = <T>(c: string, a?: unknown) => handlers.get(c)!(FAKE_EVENT, a) as Promise<T>;
  return { invoke, env, userEnv, markerPath, testConnection, reconnect, handlers, stop };
}

describe("secret:*（UI-03b）", () => {
  it("名字和 3 的 SECRET_NAMES 一致；四个通道都注册，stop 后都移除", () => {
    expect([...DESKTOP_SECRET_NAMES]).toEqual([...SECRET_NAMES]);
    const { handlers, stop } = setup();
    for (const c of [
      IPC_CHANNELS.secretStatus,
      IPC_CHANNELS.secretSet,
      IPC_CHANNELS.secretClear,
      IPC_CHANNELS.providerTest,
    ])
      expect(handlers.has(c)).toBe(true);
    stop();
    expect(handlers.size).toBe(0);
  });

  it("保存 → 状态 bakacoding + 末 4 位 → 清除；回给界面的只有 set / source / last4，绝不含值", async () => {
    const { invoke, env, userEnv, markerPath } = setup();
    const log = vi.spyOn(console, "log");
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    expect(await invoke(IPC_CHANNELS.secretStatus, { name: "DEEPSEEK_API_KEY" })).toEqual({
      ok: true,
      status: { set: false, source: null },
    });
    const r = await invoke<DesktopSecretSetResult>(IPC_CHANNELS.secretSet, {
      name: "DEEPSEEK_API_KEY",
      value: KEY,
    });
    expect(r).toEqual({ ok: true, status: { set: true, source: "bakacoding", last4: "QRST" } });
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(env["DEEPSEEK_API_KEY"]).toBe(KEY);
    expect(userEnv.data.get("DEEPSEEK_API_KEY")).toBe(KEY);
    expect(readFileSync(markerPath, "utf8")).not.toContain(KEY);
    const st = await invoke(IPC_CHANNELS.secretStatus, { name: "DEEPSEEK_API_KEY" });
    expect(JSON.stringify(st)).not.toContain(KEY);
    expect(await invoke(IPC_CHANNELS.secretClear, { name: "DEEPSEEK_API_KEY" })).toEqual({
      ok: true,
      status: { set: false, source: null },
    });
    for (const spy of [log, warn, error])
      for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain(KEY);
  });

  it("短值（<8）保存后来源 bakacoding 但没有 last4（界面显示「已设置」）", async () => {
    const { invoke } = setup();
    expect(await invoke(IPC_CHANNELS.secretSet, { name: "GITHUB_TOKEN", value: "short1" })).toEqual(
      { ok: true, status: { set: true, source: "bakacoding" } },
    );
  });

  it("系统环境变量来源：状态 system、不带 last4；清除回 not_owned，不动值", async () => {
    const { invoke, env } = setup();
    env["DEEPSEEK_API_KEY"] = KEY;
    const st = await invoke(IPC_CHANNELS.secretStatus, { name: "DEEPSEEK_API_KEY" });
    expect(st).toEqual({ ok: true, status: { set: true, source: "system" } });
    expect(await invoke(IPC_CHANNELS.secretClear, { name: "DEEPSEEK_API_KEY" })).toEqual({
      ok: false,
      code: "not_owned",
      reason: SECRET_FAILURE_TEXT.not_owned,
    });
    expect(env["DEEPSEEK_API_KEY"]).toBe(KEY);
  });

  it("参数类型不对：固定码 + 固定文案，根本不调 3", async () => {
    const fns = {
      secretStatus: vi.fn(),
      setUserSecret: vi.fn(),
      clearUserSecret: vi.fn(),
    };
    const { invoke } = setup({ fns: fns as never });
    const badNames = [
      undefined,
      null,
      "DEEPSEEK_API_KEY",
      ["DEEPSEEK_API_KEY"],
      { name: 1 },
      { name: "PATH" },
      { name: "deepseek_api_key" },
    ];
    for (const bad of badNames) {
      for (const c of [IPC_CHANNELS.secretStatus, IPC_CHANNELS.secretSet, IPC_CHANNELS.secretClear])
        expect(await invoke(c, bad), `${c} ${JSON.stringify(bad)}`).toEqual({
          ok: false,
          code: "invalid_name",
          reason: SECRET_FAILURE_TEXT.invalid_name,
        });
    }
    for (const value of [undefined, 123, "", "x".repeat(4097), { v: KEY }, [KEY]])
      expect(await invoke(IPC_CHANNELS.secretSet, { name: "DEEPSEEK_API_KEY", value })).toEqual({
        ok: false,
        code: "invalid_value",
        reason: SECRET_FAILURE_TEXT.invalid_value,
      });
    expect(fns.secretStatus).not.toHaveBeenCalled();
    expect(fns.setUserSecret).not.toHaveBeenCalled();
    expect(fns.clearUserSecret).not.toHaveBeenCalled();
  });

  it("3 回的失败码映射成固定文案；3 抛错（错误里带值和路径）也只回固定文案", async () => {
    const boom = new Error(`write ${KEY} to C:\\Users\\eva\\secret failed`);
    const { invoke } = setup({
      fns: {
        setUserSecret: vi.fn(async () => ({ ok: false as const, reason: "write_failed" as const })),
        clearUserSecret: vi.fn(async () => {
          throw boom;
        }),
        secretStatus: vi.fn(async () => {
          throw boom;
        }),
      },
    });
    const r1 = await invoke(IPC_CHANNELS.secretSet, { name: "DEEPSEEK_API_KEY", value: KEY });
    expect(r1).toEqual({
      ok: false,
      code: "write_failed",
      reason: SECRET_FAILURE_TEXT.write_failed,
    });
    const r2 = await invoke(IPC_CHANNELS.secretClear, { name: "DEEPSEEK_API_KEY" });
    const r3 = await invoke(IPC_CHANNELS.secretStatus, { name: "DEEPSEEK_API_KEY" });
    for (const r of [r2, r3]) {
      expect(r).toEqual({ ok: false, code: "failed", reason: SECRET_FAILURE_TEXT.failed });
      expect(JSON.stringify(r)).not.toContain(KEY);
      expect(JSON.stringify(r)).not.toContain("Users");
    }
  });

  it("非 Windows（没有 userEnv）：unsupported_platform 固定文案", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bc-secret-ipc-"));
    dirs.push(dir);
    const { invoke } = setup({
      secretDeps: { env: {}, markerPath: join(dir, "m.json"), userEnv: undefined },
    });
    if (process.platform === "win32") return;
    expect(await invoke(IPC_CHANNELS.secretSet, { name: "DEEPSEEK_API_KEY", value: KEY })).toEqual({
      ok: false,
      code: "unsupported_platform",
      reason: SECRET_FAILURE_TEXT.unsupported_platform,
    });
  });

  it("后端只读时保存成功后自动 reconnect，结果带 reload；live 时不重连", async () => {
    const ro = setup({}, "readonly");
    expect(
      await ro.invoke(IPC_CHANNELS.secretSet, { name: "DEEPSEEK_API_KEY", value: KEY }),
    ).toMatchObject({ ok: true, reload: { state: "reloaded" } });
    expect(ro.reconnect).toHaveBeenCalledTimes(1);
    const live = setup();
    const r = await live.invoke<DesktopSecretSetResult>(IPC_CHANNELS.secretSet, {
      name: "DEEPSEEK_API_KEY",
      value: KEY,
    });
    expect(r.ok && "reload" in r).toBe(false);
    expect(live.reconnect).not.toHaveBeenCalled();
  });

  it("parseSecretName 纯函数", () => {
    for (const n of SECRET_NAMES) expect(parseSecretName({ name: n })).toBe(n as SecretName);
    expect(parseSecretName({ name: "toString" })).toBeNull();
  });
});

describe("provider:test（UI-03b）", () => {
  it("成功：只回耗时和花费；参数只把 provider / model 交给后端（多余字段丢掉）", async () => {
    const { invoke, testConnection } = setup();
    expect(
      await invoke(IPC_CHANNELS.providerTest, {
        provider: "deepseek",
        model: "deepseek-chat",
        x: 1,
      }),
    ).toEqual({ ok: true, latency_ms: 12, cost_micro_usd: 3 });
    expect(testConnection).toHaveBeenCalledWith({ provider: "deepseek", model: "deepseek-chat" });
    await invoke(IPC_CHANNELS.providerTest, { provider: "deepseek" });
    expect(testConnection).toHaveBeenLastCalledWith({ provider: "deepseek" });
  });

  it("参数不对：invalid_target 固定文案，不调后端", async () => {
    const { invoke, testConnection } = setup();
    for (const bad of [
      undefined,
      "deepseek",
      { provider: 1 },
      { provider: "" },
      { provider: "deepseek", model: 2 },
      { provider: "a b" },
      { provider: "x".repeat(200) },
      { provider: "../etc" },
    ])
      expect(await invoke(IPC_CHANNELS.providerTest, bad), JSON.stringify(bad)).toEqual({
        ok: false,
        code: "invalid_target",
        reason: PROVIDER_TEST_TEXT.invalid_target,
      });
    expect(testConnection).not.toHaveBeenCalled();
  });

  it("1 的每个失败原因都映射成固定中文文案；quota_exhausted / config_error / budget_exhausted 文案锁住", async () => {
    const codes: DesktopProviderTestCode[] = [
      "budget_exhausted",
      "no_secret",
      "auth_failed",
      "quota_exhausted",
      "rate_limited",
      "network",
      "config_error",
      "http_error",
    ];
    for (const code of codes) {
      const s = setup({
        backend: {
          status: () => ({ mode: "live" }),
          reconnect: async () => ({ state: "reloaded" }),
          testConnection: async () =>
            ({
              ok: false,
              reason: code,
              ...(code === "http_error" && { status: 502 }),
            }) as BackendTestResult,
        },
      });
      const r = await s.invoke<DesktopProviderTestResult>(IPC_CHANNELS.providerTest, {
        provider: "deepseek",
      });
      expect(r).toEqual({
        ok: false,
        code,
        reason: PROVIDER_TEST_TEXT[code],
        ...(code === "http_error" && { status: 502 }),
      });
    }
    expect(PROVIDER_TEST_TEXT.quota_exhausted).toBe("服务商账户余额不足，请先去服务商那里充值");
    expect(PROVIDER_TEST_TEXT.config_error).toBe(
      "模型配置有问题：服务商或模型没配置，或者没有单价",
    );
    expect(PROVIDER_TEST_TEXT.budget_exhausted).toContain("没有发出请求");
    // 429 只记进按 provider/model 的共享退避状态，不挡后面的请求：文案不能暗示后面会等待 / 退让
    expect(PROVIDER_TEST_TEXT.rate_limited).toBe("服务商限流了，请稍后再试");
    for (const w of ["等待", "退让", "排队", "暂停", "自动重试"])
      expect(PROVIDER_TEST_TEXT.rate_limited).not.toContain(w);
  });

  it("后端只读：unavailable；后端抛错（带值和路径）：failed 固定文案", async () => {
    const ro = setup({
      backend: {
        status: () => ({ mode: "readonly" }),
        reconnect: async () => ({ state: "reloaded" }),
        testConnection: async () => ({ ok: false, reason: "unavailable" }),
      },
    });
    expect(await ro.invoke(IPC_CHANNELS.providerTest, { provider: "deepseek" })).toEqual({
      ok: false,
      code: "unavailable",
      reason: PROVIDER_TEST_TEXT.unavailable,
    });
    const bad = setup({
      backend: {
        status: () => ({ mode: "live" }),
        reconnect: async () => ({ state: "reloaded" }),
        testConnection: async () => {
          throw new Error(`Bearer ${KEY} /home/eva/x`);
        },
      },
    });
    const r = await bad.invoke(IPC_CHANNELS.providerTest, { provider: "deepseek" });
    expect(r).toEqual({ ok: false, code: "failed", reason: PROVIDER_TEST_TEXT.failed });
  });

  it("parseProviderTarget 纯函数", () => {
    expect(parseProviderTarget({ provider: "deepseek", model: "deepseek-v3.2" })).toEqual({
      provider: "deepseek",
      model: "deepseek-v3.2",
    });
    expect(parseProviderTarget({ provider: "deepseek", model: "" })).toBeNull();
    expect(parseProviderTarget(null)).toBeNull();
  });
});
