// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { THEME_STORAGE_KEY } from "../lib/theme";
import { createThemeStore } from "../lib/useTheme";
import { ThemeSwitcher } from "./ThemeSwitcher";

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

const media = { matchMedia: () => ({ matches: false }) as unknown as MediaQueryList };

describe("主题切换控件", () => {
  it("三个选项，点「深色」后持久化并应用；重新打开仍选中深色", () => {
    const env = { storage: localStorage, win: media, root: document.documentElement };
    render(<ThemeSwitcher store={createThemeStore(env)} />);
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual(["跟随系统", "浅色", "深色"]);
    expect(screen.getByRole("radio", { name: "跟随系统" }).getAttribute("aria-checked")).toBe(
      "true",
    );

    fireEvent.click(screen.getByRole("radio", { name: "深色" }));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(screen.getByRole("radio", { name: "深色" }).getAttribute("aria-checked")).toBe("true");

    cleanup();
    render(<ThemeSwitcher store={createThemeStore(env)} />);
    expect(screen.getByRole("radio", { name: "深色" }).getAttribute("aria-checked")).toBe("true");
  });
});
