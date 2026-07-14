// Pure whiteboard helpers shared by the whiteboard frame bundle (esbuild), the
// server, and the session store. Everything here is plain data-in/data-out so
// it unit tests under node:test without a DOM and ships to the browser through
// normal module imports in the bundled whiteboard frame (unlike mermaid-node.js
// helpers, these are never serialized with `.toString()`).

export const WHITEBOARD_PROMPT_TAG = "whiteboard";
export const EXCALIDRAW_SCENE_TARGET_TYPE = "excalidraw-scene";
export const WHITEBOARD_TEXT_METRICS_VERSION = 1;

export const SUMMARY_MAX_LINES = 40;
export const SUMMARY_MAX_LINE_CHARS = 200;
const SUMMARY_MOVE_EPSILON_PX = 2;
const STAT_KEYS = ["added", "removed", "moved", "relabeled", "drawn"];

export function sanitizeWhiteboardAppState(appState) {
  if (!appState || typeof appState !== "object" || Array.isArray(appState)) return {};
  const safeAppState = { ...appState };
  delete safeAppState.theme;
  delete safeAppState.viewBackgroundColor;
  return safeAppState;
}

export function sanitizeWhiteboardScene(scene) {
  if (!scene || typeof scene !== "object" || Array.isArray(scene)) return scene ?? null;
  if (!Object.hasOwn(scene, "appState")) return { ...scene };
  return { ...scene, appState: sanitizeWhiteboardAppState(scene.appState) };
}

// Only plain web/mail links may leave the whiteboard. Everything else -
// javascript:, data:, file:, vbscript:, chrome:, about:, or relative noise
// coming from untrusted Mermaid `click` directives - is dropped.
export function sanitizeSceneLink(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  if (/^mailto:[^\s]+$/i.test(value)) return value;
  return "";
}

// True when a conversion produced the converter's image fallback (an
// unsupported diagram type, or a parser error caught in-library): the scene is
// one or more image elements and nothing else. The whiteboard stays usable -
// the user draws on top - but edits can't be tied to diagram node identity.
export function sceneIsImageFallback(elements) {
  const list = Array.isArray(elements) ? elements.filter((el) => el && !el.isDeleted) : [];
  if (list.length === 0) return false;
  return list.every((el) => el.type === "image");
}

// `convertToExcalidrawElements(..., { regenerateIds: false })` preserves the
// Mermaid node/edge ids we want for edit summaries, but upstream can emit the
// same id twice for parallel edges (mermaid-to-excalidraw#110). Excalidraw
// requires unique ids, so callers regenerate ids for the whole scene when this
// returns a non-empty list, trading summary quality for correctness.
export function findDuplicateElementIds(elements) {
  const seen = new Set();
  const duplicates = new Set();
  for (const el of Array.isArray(elements) ? elements : []) {
    const id = String(el?.id || "");
    if (!id) continue;
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates];
}

// Excalidraw measures text synchronously while materializing skeletons. Its
// bundled fonts load asynchronously, so the first pass also gives the caller
// the concrete text elements needed to request exactly those fonts. Always
// materialize again after that request so the second pass records the real
// glyph metrics before anything reaches the visible editor.
/**
 * @template T
 * @template E
 * @param {T[]} skeletons
 * @param {{ convert: (skeletons: T[]) => E[], loadFonts: (elements: E[]) => Promise<unknown> }} adapters
 * @returns {Promise<E[]>}
 */
export async function convertExcalidrawSkeletonsAfterFontsLoad(skeletons, { convert, loadFonts }) {
  const fallbackElements = convert(skeletons);
  await loadFonts(fallbackElements);
  return convert(skeletons);
}

/**
 * @template E
 * @param {E[]} elements
 * @param {{ measure: (element: E) => { width: number, height: number } }} adapters
 * @returns {{ elements: E[], repaired: number }}
 */
export function repairSavedSceneTextMetrics(elements, { measure }) {
  let repaired = 0;
  const repairedElements = (Array.isArray(elements) ? elements : []).map((element) => {
    const candidate = /** @type {Record<string, any>} */ (element);
    if (!candidate || candidate.type !== "text" || candidate.isDeleted || candidate.autoResize === false)
      return element;
    const metrics = measure(element);
    const width = Math.max(Number(candidate.width) || 0, Number(metrics?.width) || 0);
    const height = Math.max(Number(candidate.height) || 0, Number(metrics?.height) || 0);
    if (width <= Number(candidate.width) && height <= Number(candidate.height)) return element;
    repaired += 1;
    return { ...element, width, height };
  });
  return { elements: repairedElements, repaired };
}

export function createWhiteboardPersistencePayload(state, scene) {
  return {
    sourceHash: String(state?.sceneSourceHash || ""),
    textMetricsVersion: Math.max(0, Math.floor(Number(state?.textMetricsVersion) || 0)),
    scene: scene ?? null,
    baseline: { elements: Array.isArray(state?.baselineElements) ? state.baselineElements : [] },
  };
}

function liveElements(elements) {
  return (Array.isArray(elements) ? elements : []).filter(
    (el) => el && typeof el === "object" && el.id && !el.isDeleted,
  );
}

function byId(elements) {
  const map = new Map();
  for (const el of elements) map.set(el.id, el);
  return map;
}

function boundTextByContainer(elements) {
  const map = new Map();
  for (const el of elements) {
    if (el.type === "text" && el.containerId) map.set(el.containerId, el);
  }
  return map;
}

function elementLabel(el, boundText) {
  const text = String(el.text || boundText.get(el.id)?.text || "")
    .replace(/\s+/g, " ")
    .trim();
  return text;
}

function describeElement(el, boundText) {
  const label = elementLabel(el, boundText);
  const type = String(el.type || "element");
  return label ? `${type} "${truncate(label, 60)}" (${el.id})` : `${type} (${el.id})`;
}

function truncate(text, max) {
  const value = String(text);
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function clampLine(line) {
  return truncate(line, SUMMARY_MAX_LINE_CHARS);
}

function arrowEndpoints(el, elementsMap, boundText) {
  const start = el.startBinding?.elementId ? elementsMap.get(el.startBinding.elementId) : null;
  const end = el.endBinding?.elementId ? elementsMap.get(el.endBinding.elementId) : null;
  if (!start && !end) return "";
  const name = (endpoint) => (endpoint ? describeElement(endpoint, boundText) : "(unattached)");
  return ` from ${name(start)} to ${name(end)}`;
}

// Diff a baseline (freshly converted) scene against the edited scene using
// stable element ids, producing a bounded human/agent-readable summary plus
// counts. Bound label text elements are folded into their containers so a
// renamed node reads as one "relabeled" change, not a moved text element.
export function summarizeSceneEdits(baselineElements, editedElements, { maxLines = SUMMARY_MAX_LINES } = {}) {
  const baseline = liveElements(baselineElements);
  const edited = liveElements(editedElements);
  const baselineMap = byId(baseline);
  const editedMap = byId(edited);
  const baselineText = boundTextByContainer(baseline);
  const editedText = boundTextByContainer(edited);

  const stats = { added: 0, removed: 0, moved: 0, relabeled: 0, drawn: 0 };
  const lines = [];

  for (const el of edited) {
    if (baselineMap.has(el.id)) continue;
    if (el.type === "text" && el.containerId && !baselineText.has(el.containerId) && editedMap.has(el.containerId)) {
      // Label of a newly added container - reported with the container itself.
      continue;
    }
    if (el.type === "freedraw") {
      stats.drawn += 1;
      lines.push(clampLine(`Drew a freehand mark near (${Math.round(el.x)}, ${Math.round(el.y)})`));
      continue;
    }
    stats.added += 1;
    const endpoints = el.type === "arrow" || el.type === "line" ? arrowEndpoints(el, editedMap, editedText) : "";
    lines.push(clampLine(`Added ${describeElement(el, editedText)}${endpoints}`));
  }

  for (const el of baseline) {
    if (editedMap.has(el.id)) continue;
    if (el.type === "text" && el.containerId && baselineMap.has(el.containerId)) {
      // Bound label removal surfaces through its container's relabel/remove.
      continue;
    }
    stats.removed += 1;
    lines.push(clampLine(`Removed ${describeElement(el, baselineText)}`));
  }

  for (const el of edited) {
    const before = baselineMap.get(el.id);
    if (!before) continue;

    const beforeLabel = elementLabel(before, baselineText);
    const afterLabel = elementLabel(el, editedText);
    if (beforeLabel !== afterLabel && !(el.type === "text" && el.containerId)) {
      stats.relabeled += 1;
      lines.push(
        clampLine(`Relabeled ${el.type} (${el.id}): "${truncate(beforeLabel, 50)}" -> "${truncate(afterLabel, 50)}"`),
      );
    }

    if (el.type === "text" && el.containerId) continue; // container reports geometry

    const dx = Math.round((el.x ?? 0) - (before.x ?? 0));
    const dy = Math.round((el.y ?? 0) - (before.y ?? 0));
    const dw = Math.round((el.width ?? 0) - (before.width ?? 0));
    const dh = Math.round((el.height ?? 0) - (before.height ?? 0));
    const movedFar = Math.abs(dx) > SUMMARY_MOVE_EPSILON_PX || Math.abs(dy) > SUMMARY_MOVE_EPSILON_PX;
    const resized = Math.abs(dw) > SUMMARY_MOVE_EPSILON_PX || Math.abs(dh) > SUMMARY_MOVE_EPSILON_PX;
    if (movedFar || resized) {
      stats.moved += 1;
      const parts = [];
      if (movedFar) parts.push(`moved by (${dx}, ${dy})`);
      if (resized) parts.push(`resized by (${dw}, ${dh})`);
      lines.push(clampLine(`${capitalize(parts.join(" and "))}: ${describeElement(el, editedText)}`));
    }
  }

  const total = STAT_KEYS.reduce((sum, key) => sum + stats[key], 0);
  const bounded = lines.slice(0, maxLines);
  if (lines.length > bounded.length) {
    bounded.push(
      `...and ${lines.length - bounded.length} more change${lines.length - bounded.length === 1 ? "" : "s"}`,
    );
  }
  if (total === 0) bounded.push("No element changes detected (view-only or style-only edits).");
  return { lines: bounded, stats, totalChanges: total };
}

function capitalize(text) {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function boundedInt(value, max = 10_000) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.min(Math.round(number), max);
}

// Validate and canonicalize an excalidraw-scene target coming back from the
// browser, mirroring `normalizeMermaidNodeTarget`: unknown or hostile fields
// are stripped to a fixed shape before the target reaches state.json and the
// agent. Paths are produced server-side, but re-normalizing keeps the store
// safe against arbitrary POSTed prompt bodies.
export function normalizeExcalidrawSceneTarget(target) {
  const stats = target.stats && typeof target.stats === "object" && !Array.isArray(target.stats) ? target.stats : {};
  return {
    type: EXCALIDRAW_SCENE_TARGET_TYPE,
    diagramIndex: boundedInt(target.diagramIndex, 999),
    diagramId: String(target.diagramId || ""),
    sourceHash: String(target.sourceHash || ""),
    scenePath: String(target.scenePath || ""),
    previewPath: String(target.previewPath || ""),
    imageFallback: Boolean(target.imageFallback),
    stats: Object.fromEntries(STAT_KEYS.map((key) => [key, boundedInt(stats[key])])),
  };
}
