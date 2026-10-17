// UI-02：全局快捷键（docs/ui-design.md §2）。Ctrl（macOS 上 ⌘）加一个键；Enter / Shift+Enter 留给输入框。
import { useEffect, useRef } from "react";

export const SHORTCUT_ACTIONS = [
  "newRequirement",
  "commandPalette",
  "settings",
  "toggleSidebar",
  "toggleRightPanel",
] as const;
export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number];

/** 按键（KeyboardEvent.key，小写比较）→ 动作 */
export const SHORTCUT_KEYS: Record<ShortcutAction, string> = {
  newRequirement: "n",
  commandPalette: "k",
  settings: ",",
  toggleSidebar: "b",
  toggleRightPanel: ".",
};

/** 界面上显示的写法（Command 面板、tooltip）。 */
export const SHORTCUT_LABEL: Record<ShortcutAction, string> = {
  newRequirement: "Ctrl+N",
  commandPalette: "Ctrl+K",
  settings: "Ctrl+,",
  toggleSidebar: "Ctrl+B",
  toggleRightPanel: "Ctrl+.",
};

type KeyLike = Pick<
  KeyboardEvent,
  "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing"
>;

export function matchShortcut(e: KeyLike, platform?: string): ShortcutAction | null {
  if (e.isComposing || e.altKey || e.shiftKey) return null;
  const mod = platform === "darwin" ? e.metaKey : e.ctrlKey;
  if (!mod) return null;
  const key = e.key.toLowerCase();
  for (const a of SHORTCUT_ACTIONS) if (SHORTCUT_KEYS[a] === key) return a;
  return null;
}

/** 挂在 window 上；命中就 preventDefault 并调对应 handler（没给 handler 的动作不拦）。 */
export function useShortcuts(
  handlers: Partial<Record<ShortcutAction, () => void>>,
  platform?: string,
): void {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = matchShortcut(e, platform);
      const h = action ? ref.current[action] : undefined;
      if (!h) return;
      e.preventDefault();
      h();
    };
    globalThis.window?.addEventListener("keydown", onKey);
    return () => globalThis.window?.removeEventListener("keydown", onKey);
  }, [platform]);
}
