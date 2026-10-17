import { describe, expect, it } from "vitest";
import { matchShortcut } from "./shortcuts";

const key = (k: string, mods: Partial<KeyboardEvent> = {}) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
  ...mods,
});

describe("全局快捷键匹配", () => {
  it("Ctrl+N / K / , / B / . 各对应一个动作", () => {
    expect(matchShortcut(key("n", { ctrlKey: true }), "win32")).toBe("newRequirement");
    expect(matchShortcut(key("k", { ctrlKey: true }), "win32")).toBe("commandPalette");
    expect(matchShortcut(key(",", { ctrlKey: true }), "win32")).toBe("settings");
    expect(matchShortcut(key("b", { ctrlKey: true }), "win32")).toBe("toggleSidebar");
    expect(matchShortcut(key(".", { ctrlKey: true }), "win32")).toBe("toggleRightPanel");
    expect(matchShortcut(key("N", { ctrlKey: true }), "linux")).toBe("newRequirement");
  });

  it("没有 Ctrl、带 Alt/Shift、输入法组字中、其他键都不算", () => {
    expect(matchShortcut(key("n"), "win32")).toBeNull();
    expect(matchShortcut(key("n", { ctrlKey: true, shiftKey: true }), "win32")).toBeNull();
    expect(matchShortcut(key("n", { ctrlKey: true, altKey: true }), "win32")).toBeNull();
    expect(matchShortcut(key("n", { ctrlKey: true, isComposing: true }), "win32")).toBeNull();
    expect(matchShortcut(key("x", { ctrlKey: true }), "win32")).toBeNull();
    // Enter / Shift+Enter 不归全局快捷键管（留给输入框）
    expect(matchShortcut(key("Enter", { ctrlKey: true }), "win32")).toBeNull();
    expect(matchShortcut(key("Enter"), "win32")).toBeNull();
  });

  it("macOS 用 ⌘，Ctrl 不算", () => {
    expect(matchShortcut(key("k", { metaKey: true }), "darwin")).toBe("commandPalette");
    expect(matchShortcut(key("k", { ctrlKey: true }), "darwin")).toBeNull();
    expect(matchShortcut(key("k", { metaKey: true }), "win32")).toBeNull();
  });
});
