export const END_SESSION_HOTKEY_KEY = "e";

export function isEndSessionHotkeyEvent(event) {
  if (event.isComposing || !event.shiftKey || event.altKey) return false;
  return Boolean(event.metaKey || event.ctrlKey) && String(event.key || "").toLowerCase() === END_SESSION_HOTKEY_KEY;
}
