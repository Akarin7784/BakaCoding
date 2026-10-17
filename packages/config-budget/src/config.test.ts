import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { ConfigError, ConfigSchema, getConfig, getSecret, validate } from "./config.js";

const examplePath = fileURLToPath(new URL("../../../config/models.example.json", import.meta.url));
const example = () => JSON.parse(readFileSync(examplePath, "utf8"));
const minimal = () => ({
  $schema_version: "bakacoding.model-config.v1",
  roles: { supervisor: { provider: "deepseek", model: "deepseek-flash", effort: "max" } },
  budget: { daily_micro_usd: 1_000_000 },
});

describe("config", () => {
  it("示例配置通过校验，且不含 effort_map", () => {
    expect(validate(example())).toEqual([]);
    expect(readFileSync(examplePath, "utf8")).not.toContain("effort_map");
    const c = getConfig(examplePath);
    expect(c.roles.coder.resubmit_effort).toEqual(["low", "high", "high"]);
  });
  it("最小配置补齐 PD 默认值", () => {
    expect(validate(minimal())).toEqual([]);
    const c = ConfigSchema.parse(minimal());
    expect(c.roles.review_board.members.map((m) => m.effort)).toEqual(["high", "high"]);
    expect(c.roles.sub_agent.effort).toBe("high");
    expect(c.roles.coder.effort).toBe("low");
    expect(c.pipeline).toMatchObject({ concurrency_max: 8, concurrency_hard_max: 64 });
    expect(c.budget).toMatchObject({ per_ticket_ratio: 0.05, offpeak_preference: false });
    expect(c.diagnostics.retention_days).toBe(30);
    expect(c.backpressure.reviews_per_member).toBe(2);
  });
  it("supervisor 必填且固定 max", () => {
    const a = minimal() as Record<string, unknown>;
    a.roles = {};
    expect(validate(a).join()).toMatch(/roles\.supervisor/);
    const b = minimal();
    (b.roles.supervisor as { effort: string }).effort = "high";
    expect(validate(b).join()).toMatch(/roles\.supervisor\.effort: 应为 "max"/);
  });
  it("daily_micro_usd 必填且为正整数", () => {
    const a = minimal() as Record<string, unknown>;
    a.budget = {};
    expect(validate(a).join()).toMatch(/budget\.daily_micro_usd/);
    expect(validate({ ...minimal(), budget: { daily_micro_usd: 1.5 } }).length).toBeGreaterThan(0);
    expect(validate({ ...minimal(), budget: { daily: 5 } }).join()).toMatch(/daily/);
  });
  it("未知字段报错（含 effort_map）", () => {
    expect(validate({ ...minimal(), foo: 1 }).length).toBeGreaterThan(0);
    const e = example();
    e.providers.deepseek.models["deepseek-flash"].effort_map = {};
    expect(validate(e).join()).toMatch(/effort_map/);
  });
  it("评审组不含主管，并发上限关系", () => {
    const a = minimal() as Record<string, unknown> & { roles: Record<string, unknown> };
    a.roles.review_board = {
      members: [{ id: "supervisor", provider: "deepseek", model: "deepseek-flash" }],
    };
    expect(validate(a).join()).toMatch(/不能包含主管/);
    expect(
      validate({
        ...minimal(),
        pipeline: { concurrency_max: 100, concurrency_hard_max: 64 },
      }).join(),
    ).toMatch(/concurrency_max/);
  });
  it("pipeline.max_turns 默认 40，只接受正整数", () => {
    expect(ConfigSchema.parse(minimal()).pipeline.max_turns).toBe(40);
    expect(
      ConfigSchema.parse({ ...minimal(), pipeline: { max_turns: 12 } }).pipeline.max_turns,
    ).toBe(12);
    for (const bad of [0, -1, 1.5, "40"])
      expect(validate({ ...minimal(), pipeline: { max_turns: bad } }).join()).toMatch(/max_turns/);
  });
  it("getConfig 失败抛 ConfigError", () => {
    expect(() => getConfig("/nonexistent/x.json")).toThrow(ConfigError);
  });
});

describe("配置错误不带原值（T-098）", () => {
  const SECRET = "sk-mySecretishValue12345";
  const errorsOf = (fn: () => unknown): string[] => {
    try {
      fn();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      return (e as ConfigError).errors.concat((e as Error).message);
    }
    throw new Error("应当抛 ConfigError");
  };
  const writeTmp = (text: string) => {
    const dir = mkdtempSync(join(tmpdir(), "bc-t098-"));
    const p = join(dir, "models.json");
    writeFileSync(p, text);
    return { dir, p };
  };
  const clean = (errs: string[], ...raws: string[]) => {
    const all = errs.join("\n");
    for (const r of raws) expect(all).not.toContain(r);
    expect(all).not.toMatch(/received/i);
  };

  it("validate：怪值不出现在错误里", () => {
    const bad = [
      { ...minimal(), budget: { daily_micro_usd: SECRET } },
      { ...minimal(), roles: { supervisor: { provider: "deepseek", model: "m", effort: SECRET } } },
      { ...minimal(), $schema_version: SECRET },
      { ...minimal(), pipeline: { max_turns: -7_654_321 } },
    ];
    for (const raw of bad) {
      const errs = validate(raw);
      expect(errs.length).toBeGreaterThan(0);
      clean(errs, SECRET, "7654321");
    }
  });
  it("validate：未知键名像密钥时也脱敏", () => {
    const errs = validate({ ...minimal(), [SECRET]: 1 });
    expect(errs.join()).toMatch(/未知字段/);
    clean(errs, SECRET);
  });
  it("validate 和 getConfig 的校验错误一致", () => {
    const raw = { ...minimal(), budget: { daily_micro_usd: "x" } };
    const { p } = writeTmp(JSON.stringify(raw));
    expect(errorsOf(() => getConfig(p)).slice(0, -1)).toEqual(validate(raw));
  });
  it("getConfig：坏 JSON 只报行列号，不拼原文", () => {
    const text = `{\n  "roles": {},\n  "k": "${SECRET}" x\n}`;
    const { p, dir } = writeTmp(text);
    const errs = errorsOf(() => getConfig(p));
    expect(errs[0]).toBe("配置文件不是合法 JSON（第 3 行第 35 列）");
    clean(errs, SECRET, dir);
  });
  it("getConfig：整个文件就是密钥时只说不是合法 JSON", () => {
    const { p, dir } = writeTmp(SECRET);
    const errs = errorsOf(() => getConfig(p));
    expect(errs[0]).toBe("配置文件不是合法 JSON");
    clean(errs, SECRET, "sk-", dir);
  });
  it("getConfig：空文件", () => {
    const { p } = writeTmp("");
    expect(errorsOf(() => getConfig(p))[0]).toBe("配置文件不是合法 JSON");
  });
  it("getConfig：读不到文件只报文件名和错误码", () => {
    const errs = errorsOf(() => getConfig("/nonexistent/dir-abc/models.json"));
    expect(errs[0]).toBe("无法读取配置文件 models.json（ENOENT）");
    clean(errs, "dir-abc");
  });
});

describe("getSecret", () => {
  it("读取环境变量", () => {
    expect(getSecret("DEEPSEEK_API_KEY", { DEEPSEEK_API_KEY: "test-value" })).toBe("test-value");
  });
  it("缺失时报错，且不打印值", () => {
    const log = vi.spyOn(console, "log");
    expect(() => getSecret("GITHUB_TOKEN", {})).toThrow(/GITHUB_TOKEN/);
    expect(() => getSecret("GITHUB_TOKEN", { GITHUB_TOKEN: "  " })).toThrow(/GITHUB_TOKEN/);
    expect(log).not.toHaveBeenCalled();
  });
});
