import { describe, expect, it } from "vitest";
import { errorDetail } from "./sync-state.js";

describe("errorDetail（T-077）", () => {
  it("泛化 Error 不写名字；具体错误名过滤后保留", () => {
    expect(errorDetail(new Error("只读模式：x"))).toBe("只读模式：x");
    class ConfigError extends Error {
      override name = "ConfigError";
    }
    expect(errorDetail(new ConfigError("坏了"))).toBe("ConfigError：坏了");
    const evil = new Error("m");
    evil.name = "Evil<img src=x>\n";
    expect(errorDetail(evil)).toBe("Evilimgsrcx：m");
    expect(errorDetail("plain")).toBe("plain");
  });
});
