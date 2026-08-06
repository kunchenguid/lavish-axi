/**
 * Helpers for the conversation/chat panel's draggable width.
 *
 * The panel width is stored as a plain number of CSS pixels in localStorage
 * so it survives reloads and works across multiple sessions. These helpers
 * stay pure (no DOM, no storage, no globals) so the chrome can call them
 * with injected storage objects and the rules can be unit tested headlessly.
 *
 * The browser-side `chrome-client.js` receives an inlined copy of this module
 * (see `serializePanelWidthForBrowser` in `server.js`) so it can use the same
 * clamp/persistence rules without an extra HTTP round-trip.
 */

export const PANEL_DEFAULTS = Object.freeze({
  min: 280,
  maxViewportFraction: 0.6,
  default: 360,
});

export const PANEL_STORAGE_KEY = "lavish-axi:panel-w";

function resolveDefaults(defaults) {
  if (defaults && typeof defaults === "object") return defaults;
  return PANEL_DEFAULTS;
}

// Re-exported so the inlined browser copy in `serializePanelWidthForBrowser` can
// see it; keeping it unexported would leave the `toString()`d helpers with a
// dangling `resolveDefaults is not defined` reference at runtime.
export { resolveDefaults };

/**
 * Coerce a raw value (e.g. a stored localStorage string, a drag distance, or a
 * pixel-stringified CSS value) into a valid panel width in CSS pixels.
 *
 * - Nullish / empty / non-numeric / non-positive input returns the default.
 * - The result is clamped to `[min, maxViewportFraction * viewportWidth]`,
 *   floored at `min` so a tiny viewport never collapses the panel below it.
 * - A non-positive or non-finite viewport returns the default rather than
 *   dividing by zero or producing Infinity.
 */
export function clampPanelWidth(rawValue, viewportWidth, defaults) {
  const { min, maxViewportFraction, default: fallback } = resolveDefaults(defaults);
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return fallback;
  const parsed = Number.parseFloat(String(rawValue ?? ""));
  if (!Number.isFinite(parsed)) return fallback;
  const max = Math.max(min, maxViewportFraction * viewportWidth);
  return Math.min(max, Math.max(min, parsed));
}

/**
 * Read the stored panel width from a storage-like object (e.g. localStorage)
 * and clamp it against the current viewport. Falls back to the default on any
 * error (storage disabled, value corrupt, etc.) so a broken value can never
 * wedge the chrome on first paint.
 */
export function loadStoredPanelWidth(storage, viewportWidth, defaults) {
  const { default: fallback } = resolveDefaults(defaults);
  if (!storage || typeof storage.getItem !== "function") return fallback;
  let raw;
  try {
    raw = storage.getItem(PANEL_STORAGE_KEY);
  } catch {
    return fallback;
  }
  return clampPanelWidth(raw, viewportWidth, defaults);
}

/**
 * Persist a panel width. Silent on error: persistence is best-effort and a
 * quota/disabled-storage failure must never break the drag interaction.
 */
export function savePanelWidth(storage, width) {
  if (!storage || typeof storage.setItem !== "function") return;
  if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) return;
  try {
    storage.setItem(PANEL_STORAGE_KEY, String(width));
  } catch {
    // Ignore - persistence is best-effort.
  }
}
