import {
  DEFAULT_MINI_MAP_ZOOM_IN_KEY,
  DEFAULT_MINI_MAP_ZOOM_OUT_KEY,
} from "../../types/state";

export { DEFAULT_MINI_MAP_ZOOM_IN_KEY, DEFAULT_MINI_MAP_ZOOM_OUT_KEY };

type ShortcutKeyboardEvent = Pick<KeyboardEvent, "altKey" | "code" | "ctrlKey" | "key" | "metaKey" | "shiftKey">;

function shortcutKey(event: ShortcutKeyboardEvent): string | null {
  if (event.code === "Equal" && event.shiftKey) return "Plus";
  if (event.code === "NumpadAdd") return "NumpadAdd";
  if (event.code === "Minus") return "Minus";
  if (event.code === "NumpadSubtract") return "NumpadSubtract";
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3);
  if (/^Digit\d$/.test(event.code)) return event.code.slice(5);
  if (event.key.length === 1 && !["+", "-"].includes(event.key)) {
    return event.key.toUpperCase();
  }
  return null;
}

export function formatMiniMapShortcut(event: ShortcutKeyboardEvent): string | null {
  const key = shortcutKey(event);
  if (!key) return null;

  const shiftIsPartOfPlusKey = event.code === "Equal" && event.shiftKey;
  const modifiers = [
    event.ctrlKey ? "Ctrl" : null,
    event.altKey ? "Alt" : null,
    event.shiftKey && !shiftIsPartOfPlusKey ? "Shift" : null,
    event.metaKey ? "Meta" : null,
  ].filter((modifier): modifier is string => modifier !== null);
  if (modifiers.length === 0) return null;
  return [...modifiers, key].join("+");
}

export function matchesMiniMapShortcut(
  event: ShortcutKeyboardEvent,
  shortcut: string,
): boolean {
  const actual = formatMiniMapShortcut(event);
  if (actual === shortcut) return true;
  if (shortcut === DEFAULT_MINI_MAP_ZOOM_IN_KEY) return actual === "Alt+NumpadAdd";
  if (shortcut === DEFAULT_MINI_MAP_ZOOM_OUT_KEY) return actual === "Alt+NumpadSubtract";
  return false;
}

export function describeMiniMapShortcut(shortcut: string): string {
  return shortcut
    .replace("Ctrl", "Ctrl")
    .replace("Alt", "Alt")
    .replace("Shift", "Shift")
    .replace("Meta", "Win")
    .replace("Plus", "+")
    .replace("Minus", "−")
    .replace("NumpadAdd", "Num +")
    .replace("NumpadSubtract", "Num −");
}
