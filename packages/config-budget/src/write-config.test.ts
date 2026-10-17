import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getConfig } from "./config.js";
import { findSecretLikeValues, writeConfig } from "./write-config.js";

const examplePath = fileURLToPath(new URL("../../../config/models.example.json", import.meta.url));
const example = () => JSON.parse(readFileSync(examplePath, "utf8"));
const FAKE_KEY = "sk-test0000000000000000000000abcd";

let dir: string;
let target: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bc-writecfg-"));
  target = join(dir, "models.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const leftovers = () => readdirSync(dir).filter((f) => f.endsWith(".tmp"));

describe("writeConfig", () => {
  it("写入合法配置：2 空格缩进、末尾换行，可被 getConfig 读回", async () => {
    const cfg = example();
    expect(await writeConfig(target, cfg, { env: {} })).toEqual({ ok: true });
    const text = readFileSync(target, "utf8");
    expect(text).toBe(`${JSON.stringify(cfg, null, 2)}\n`);
    expect(getConfig(target).roles.supervisor.model).toBe("deepseek-flash");
    expect(leftovers()).toEqual([]);
  });

  it("覆盖已有文件", async () => {
    writeFileSync(target, "{}\n");
    const cfg = example();
    cfg.roles.coder.effort = "high";
    expect(await writeConfig(target, cfg, { env: {} })).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(target, "utf8")).roles.coder.effort).toBe("high");
  });

  it("写原始对象，不展开默认值", async () => {
    const cfg = {
      $schema_version: "bakacoding.model-config.v1",
      roles: example().roles,
      budget: { daily_micro_usd: 5 },
    };
    expect(await writeConfig(target, cfg, { env: {} })).toEqual({ ok: true });
    expect(Object.keys(JSON.parse(readFileSync(target, "utf8")))).toEqual(Object.keys(cfg));
  });

  it("校验失败：返回与 validate 相同的错误，原文件不动", async () => {
    writeFileSync(target, "ORIGINAL");
    const cfg = example();
    cfg.roles.supervisor.effort = "turbo";
    const r = await writeConfig(target, cfg, { env: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.startsWith("roles.supervisor.effort"))).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("ORIGINAL");
    expect(leftovers()).toEqual([]);
  });

  it("拒绝像密钥的值，错误里只有路径和规则名，不含值", async () => {
    const cfg = example();
    cfg.providers.deepseek.models["deepseek-flash"].expected_display_name = FAKE_KEY;
    const r = await writeConfig(target, cfg, { env: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]).toContain(
        "providers.deepseek.models.deepseek-flash.expected_display_name",
      );
      expect(r.errors[0]).toContain("api_key");
      expect(JSON.stringify(r)).not.toContain(FAKE_KEY);
    }
    expect(() => readFileSync(target)).toThrow();
  });

  it("拒绝 URL 凭据", async () => {
    const cfg = example();
    cfg.providers.deepseek.base_url = "https://user:hunter2pass@api.example.com/v1";
    const r = await writeConfig(target, cfg, { env: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(JSON.stringify(r)).not.toContain("hunter2pass");
  });

  it("拒绝 Bearer token", async () => {
    const token = "abcDEF0123456789ghijKLMNOP";
    const cfg = example();
    cfg.providers.deepseek.models["deepseek-flash"].expected_display_name = `Bearer ${token}`;
    const r = await writeConfig(target, cfg, { env: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]).toContain("bearer");
      expect(JSON.stringify(r)).not.toContain(token);
    }
  });

  it("校验错误不带出配置原值（只用 path 和 code）", async () => {
    const cfg = example();
    cfg.roles.coder.effort = "mySecretishValue";
    cfg.roles.supervisor.effort = "anotherOddValue";
    cfg.budget.daily_micro_usd = "notANumberValue";
    const r = await writeConfig(target, { ...cfg, oddUnknownKey: "x" }, { env: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const all = JSON.stringify(r);
      for (const v of ["mySecretishValue", "anotherOddValue", "notANumberValue", "received"]) {
        expect(all).not.toContain(v);
      }
      expect(r.errors.some((e) => e.startsWith("roles.coder.effort: 应为"))).toBe(true);
      expect(r.errors).toContain('roles.supervisor.effort: 应为 "max"');
      expect(r.errors).toContain("budget.daily_micro_usd: 类型不对，应为 number");
      expect(r.errors).toContain('(root): 有未知字段 "oddUnknownKey"');
    }
  });

  it("rename 遇到 EPERM 会重试，成功后不留临时文件", async () => {
    let calls = 0;
    const waits: number[] = [];
    const r = await writeConfig(target, example(), {
      env: {},
      sleep: async (ms) => void waits.push(ms),
      rename: async (from, to) => {
        calls++;
        if (calls < 3) throw Object.assign(new Error("busy"), { code: "EPERM" });
        renameSync(from, to);
      },
    });
    expect(r).toEqual({ ok: true });
    expect(calls).toBe(3);
    expect(waits).toEqual([50, 100]);
    expect(leftovers()).toEqual([]);
  });

  it("rename 一直失败：返回错误码，删掉临时文件，原文件不变", async () => {
    writeFileSync(target, "ORIGINAL");
    let calls = 0;
    const r = await writeConfig(target, example(), {
      env: {},
      sleep: async () => {},
      rename: async () => {
        calls++;
        throw Object.assign(new Error("busy"), { code: "EBUSY" });
      },
    });
    expect(r).toEqual({ ok: false, errors: ["(file): 写入配置失败（EBUSY）"] });
    expect(calls).toBe(6);
    expect(leftovers()).toEqual([]);
    expect(readFileSync(target, "utf8")).toBe("ORIGINAL");
  });

  it("拒绝等于当前环境变量密钥的值（即使不像 sk- 格式）", async () => {
    const raw = "plainLookingSecretValue42";
    const cfg = example();
    cfg.providers.deepseek.models["deepseek-flash"].expected_display_name = raw;
    const r = await writeConfig(target, cfg, { env: { DEEPSEEK_API_KEY: raw } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]).toContain("env_secret_value");
      expect(JSON.stringify(r)).not.toContain(raw);
    }
  });

  it("键名像密钥也拒绝", () => {
    const errs = findSecretLikeValues({ a: { [FAKE_KEY]: 1 } }, {});
    expect(errs).toHaveLength(1);
    expect(errs[0]).not.toContain(FAKE_KEY);
  });

  it("未知键是密钥时，validate 的错误也脱敏", async () => {
    const cfg = { ...example(), [FAKE_KEY]: true };
    const r = await writeConfig(target, cfg, { env: {} });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(FAKE_KEY);
  });

  it("内网 base_url 和 credential_ref 不算密钥", async () => {
    const cfg = example();
    cfg.providers.deepseek.base_url = "http://192.168.1.20:8080/anthropic";
    expect(findSecretLikeValues(cfg, {})).toEqual([]);
    expect(await writeConfig(target, cfg, { env: {} })).toEqual({ ok: true });
  });

  it("只能写 models.json", async () => {
    const r = await writeConfig(join(dir, "pricing.json"), example(), { env: {} });
    expect(r).toEqual({ ok: false, errors: ["(file): 只能写 models.json"] });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("目录不存在时创建", async () => {
    const nested = join(dir, "a", "b", "models.json");
    expect(await writeConfig(nested, example(), { env: {} })).toEqual({ ok: true });
    expect(getConfig(nested).budget).toBeDefined();
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "写失败：返回错误码不含路径，原文件不变，不留临时文件",
    async () => {
      writeFileSync(target, "ORIGINAL");
      chmodSync(dir, 0o500);
      try {
        const r = await writeConfig(target, example(), { env: {} });
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.errors[0]).toMatch(/^\(file\): 写入配置失败（E[A-Z]+）$/);
          expect(r.errors[0]).not.toContain(dir);
        }
      } finally {
        chmodSync(dir, 0o700);
      }
      expect(readFileSync(target, "utf8")).toBe("ORIGINAL");
      expect(leftovers()).toEqual([]);
    },
  );
});
