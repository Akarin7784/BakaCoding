// UI-01：主题切换（跟随系统 / 浅色 / 深色），选择会持久化。设置弹层的「通用」标签（UI-07）沿用它。
import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { THEME_LABEL, THEME_PREFERENCES, type ThemePreference } from "../lib/theme";
import { useTheme, type ThemeStore } from "../lib/useTheme";
import { cn } from "../lib/utils";

const ICON: Record<ThemePreference, LucideIcon> = { system: Monitor, light: Sun, dark: Moon };

export function ThemeSwitcher({ store }: { store?: ThemeStore }) {
  const { preference, setPreference } = useTheme(store);
  return (
    <div
      role="radiogroup"
      aria-label="主题"
      className="inline-flex gap-1 rounded-lg bg-secondary p-0.5"
    >
      {THEME_PREFERENCES.map((p) => {
        const Icon = ICON[p];
        const on = p === preference;
        return (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={on}
            data-theme-option={p}
            onClick={() => setPreference(p)}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              on ? "bg-background text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon size={14} strokeWidth={1.5} aria-hidden />
            {THEME_LABEL[p]}
          </button>
        );
      })}
    </div>
  );
}
