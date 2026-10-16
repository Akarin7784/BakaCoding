import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isOffpeak, loadPricing, PricingSchema } from "./pricing.js";

const pricing = loadPricing(
  fileURLToPath(new URL("../../../config/pricing.json", import.meta.url)),
);
const at = (s: string) => new Date(s);

describe("pricing.json", () => {
  it("通过 schema，闲时为高峰一半", () => {
    for (const m of Object.values(pricing.models)) {
      expect(m.offpeak.input_cache_hit * 2).toBe(m.peak.input_cache_hit);
      expect(m.offpeak.input_cache_miss * 2).toBe(m.peak.input_cache_miss);
      expect(m.offpeak.output * 2).toBe(m.peak.output);
    }
    expect(pricing.models["deepseek-flash"]!.peak.output).toBe(1_200_000);
  });
  it("拒绝未知字段与小数价格", () => {
    expect(PricingSchema.safeParse({ ...pricing, extra: 1 }).success).toBe(false);
    const bad = structuredClone(pricing);
    bad.models["deepseek-flash"]!.peak.output = 1.5;
    expect(PricingSchema.safeParse(bad).success).toBe(false);
  });
});

describe("isOffpeak", () => {
  it("工作日高峰时段", () => {
    expect(isOffpeak(at("2026-10-14T02:00:00Z"), pricing)).toBe(false); // 周三
    expect(isOffpeak(at("2026-10-14T04:00:00Z"), pricing)).toBe(true); // 右开
    expect(isOffpeak(at("2026-10-14T06:00:00Z"), pricing)).toBe(false);
    expect(isOffpeak(at("2026-10-14T10:00:00Z"), pricing)).toBe(true);
    expect(isOffpeak(at("2026-10-14T00:59:00Z"), pricing)).toBe(true);
  });
  it("周末与节假日全天闲时", () => {
    expect(isOffpeak(at("2026-10-17T02:00:00Z"), pricing)).toBe(true); // 周六
    expect(isOffpeak(at("2026-10-01T02:00:00Z"), pricing)).toBe(true); // 国庆
    expect(isOffpeak(at("2026-10-08T02:00:00Z"), pricing)).toBe(false); // 节后周四
  });
  it("调休上班的周末仍按闲时（source.note 说明）", () => {
    expect(pricing.source.note).toContain("Monday through Friday");
    expect(isOffpeak(at("2026-10-10T02:00:00Z"), pricing)).toBe(true); // 周六调休上班
  });
  it("没有该年节假日数据时按高峰", () => {
    expect(isOffpeak(at("2027-01-01T02:00:00Z"), pricing)).toBe(false); // 周五
  });
});
