import { describe, expect, it } from "vitest";
import { failureText, stripErrorNoise } from "./error-text.js";

describe("报错文案去噪（T-077）", () => {
  it("只读导出：前缀只出现一次，不露出 Error：", () => {
    expect(failureText("导出失败", "导出失败：Error：只读模式：配置校验失败（ConfigError）")).toBe(
      "导出失败：只读模式：配置校验失败（ConfigError）",
    );
    expect(failureText("导出失败", "只读模式：配置校验失败（ConfigError）")).toBe(
      "导出失败：只读模式：配置校验失败（ConfigError）",
    );
  });

  it("Electron remote method 包装去掉", () => {
    const wrapped =
      "Error invoking remote method 'bakacoding:diagnostics:export': Error: 只读模式：配置校验失败（ConfigError）";
    expect(stripErrorNoise(wrapped)).toBe("只读模式：配置校验失败（ConfigError）");
    expect(failureText("导出失败", wrapped)).toBe(
      "导出失败：只读模式：配置校验失败（ConfigError）",
    );
  });

  it("具体错误名保留，叠了几层的 Error 都去掉", () => {
    expect(failureText("导入失败", "Error: Error：ConfigError：坏了")).toBe(
      "导入失败：ConfigError：坏了",
    );
    expect(failureText("发送失败", "发送失败：发送失败：超时")).toBe("发送失败：超时");
    expect(failureText("导出失败", "")).toBe("导出失败");
  });
});
