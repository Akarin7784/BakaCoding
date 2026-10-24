import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPricing } from "./pricing.js";
import { WRITABLE_PRICING_FILE, writeConfig, writePricing } from "./write-config.js";

// T-114：writePricing 校验后原子写入 pricing.json。
const repoPricingPath = fileURLToPath(new URL("../../../config/pricing.json", import.meta.url));
const pricing = () => JSON.parse(readFileSync(repoPricingPath, "utf8"));
const FAKE_KEY = "sk-test0000000000000000000000wxyz";

let dir: string;
let target: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bc-writepricing-"));
  target = join(dir, "config", WRITABLE_PRICING_FILE);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const leftovers = () => {
  try {
    return readdirSync(join(dir, "config")).filter((f) => f.endsWith(".tmp"));
  } catch {
    return [];
  }
};
const noLeak = (errors: string[]) => {
  const text = errors.join("\n");
  expect(text).not.toContain(dir);
  expect(text).not.toContain(FAKE_KEY);
};

describe("writePricing", () => {
  it("写入仓库自带的价格表：建目录、2 空格缩进、末尾换行，loadPricing 能读回且内容相同", async () => {
    const p = pricing();
    expect(await writePricing(target, p, { env: {} })).toEqual({ ok: true });
    expect(readFileSync(target, "utf8")).toBe(`${JSON.stringify(p, null, 2)}\n`);
    expect(loadPricing(target)).toEqual(loadPricing(repoPricingPath));
    expect(leftovers()).toEqual([]);
  });

  it("覆盖已有文件", async () => {
    await writePricing(target, pricing(), { env: {} });
    const p = pricing();
    p.source.note = "T-114 覆盖";
    expect(await writePricing(target, p, { env: {} })).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(target, "utf8")).source.note).toBe("T-114 覆盖");
  });

  it.each(["models.json", "pricing.json.bak", "other.json"])(
    "文件名不是 pricing.json（%s）→ 拒绝，不写",
    async (name) => {
      const t = join(dir, name);
      const r = await writePricing(t, pricing(), { env: {} });
      expect(r).toEqual({ ok: false, errors: ["(file): 只能写 pricing.json"] });
      expect(readdirSync(dir)).toEqual([]);
    },
  );

  it("writeConfig 仍然不能写 pricing.json", async () => {
    const r = await writeConfig(target, pricing(), { env: {} });
    expect(r.ok).toBe(false);
  });

  it("schema 不过 → 返回字段错误，原文件不动，不含路径和值", async () => {
    await writePricing(target, pricing(), { env: {} });
    const before = readFileSync(target, "utf8");
    const p = pricing();
    p.currency = "CNY-secret-value";
    p.models["deepseek-flash"] = { peak: { output: -1 } };
    const r = await writePricing(target, p, { env: {} });
    expect(r.ok).toBe(false);
    const errors = r.ok ? [] : r.errors;
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join("\n")).toContain("currency");
    expect(errors.join("\n")).not.toContain("CNY-secret-value");
    noLeak(errors);
    expect(readFileSync(target, "utf8")).toBe(before);
    expect(leftovers()).toEqual([]);
  });

  it("值像密钥 → 拒绝，错误里没有密钥", async () => {
    const p = pricing();
    p.source.note = `key ${FAKE_KEY}`;
    const r = await writePricing(target, p, { env: {} });
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.errors.join("\n")).toContain("source.note");
    noLeak(r.ok ? [] : r.errors);
  });

  it("值等于当前环境变量里的密钥 → 拒绝", async () => {
    const p = pricing();
    p.source.note = "plainvalue12345678";
    const r = await writePricing(target, p, { env: { DEEPSEEK_API_KEY: "plainvalue12345678" } });
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.errors.join("\n")).not.toContain("plainvalue12345678");
  });

  it("rename 失败 → 原文件不动、临时文件删掉，错误只带错误码", async () => {
    await writePricing(target, pricing(), { env: {} });
    const before = readFileSync(target, "utf8");
    const p = pricing();
    p.source.note = "changed";
    const r = await writePricing(target, p, {
      env: {},
      rename: async () => {
        throw Object.assign(new Error(`EIO at ${target}`), { code: "EIO" });
      },
    });
    expect(r).toEqual({ ok: false, errors: ["(file): 写入配置失败（EIO）"] });
    expect(readFileSync(target, "utf8")).toBe(before);
    expect(leftovers()).toEqual([]);
  });

  it("rename 遇到 EBUSY 会重试", async () => {
    let n = 0;
    const { rename } = await import("node:fs/promises");
    const r = await writePricing(target, pricing(), {
      env: {},
      sleep: async () => {},
      rename: async (a, b) => {
        if (n++ < 2) throw Object.assign(new Error("busy"), { code: "EBUSY" });
        await rename(a, b);
      },
    });
    expect(r).toEqual({ ok: true });
    expect(n).toBe(3);
  });

  it("目标路径是目录时写入失败，不留临时文件", async () => {
    writeFileSync(join(dir, "placeholder"), "");
    const r = await writePricing(join(dir, "placeholder", WRITABLE_PRICING_FILE), pricing(), {
      env: {},
    });
    expect(r.ok).toBe(false);
    noLeak(r.ok ? [] : r.errors);
  });
});
