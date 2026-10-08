// Pure whiteboard helpers shared by the whiteboard frame bundle (esbuild), the
// server, and the session store. Everything here is plain data-in/data-out so
// it unit tests under node:test without a DOM and ships to the browser through
// normal module imports in the bundled whiteboard frame (unlike mermaid-node.js
// helpers, these are never serialized with `.toString()`).

import { LIBRARY_REF_CUSTOM_DATA_KEY } from "./whiteboard-libraries.js";

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

// Mermaid node labels use `<br>` / `<br/>` and a two-character `\n` sequence as
// line breaks. parseMermaidToExcalidraw copies vertex.text onto skeleton
// `label.text` unchanged, and convertToExcalidrawElements then treats those
// characters as part of a single line - so "classify<br>checks" renders as the
// fused "classifychecks" instead of two lines. Excalidraw stores multiline
// labels as real `\n` in `text` / `originalText`.
const MERMAID_HTML_BREAK_RE = /<br\s*\/?\s*>/gi;
const MERMAID_ESCAPED_NEWLINE_RE = /\\n/g;
const LABEL_CHAR_WIDTH_RATIO = 0.62;
const LABEL_LINE_HEIGHT = 1.25;
const BOUND_TEXT_PADDING_X = 16;
const BOUND_TEXT_PADDING_Y = 16;
const NODE_LABEL_CONTAINER_TYPES = new Set(["rectangle", "ellipse", "diamond"]);

// Node boxes only. Labelled arrows keep independently placed path-midpoint
// labels; growing or recentering those containers would move the arrow.
function isNodeLabelContainer(element) {
  return NODE_LABEL_CONTAINER_TYPES.has(element?.type);
}

export function normalizeMermaidLabelLineBreaks(text) {
  if (typeof text !== "string" || text.length === 0) return text;
  return text.replace(MERMAID_HTML_BREAK_RE, "\n").replace(MERMAID_ESCAPED_NEWLINE_RE, "\n");
}

function splitLabelLines(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
}

function estimateMultilineLabelBox(text, fontSize) {
  const size = Number(fontSize) || 16;
  const lines = splitLabelLines(text);
  const width = Math.max(
    20,
    ...lines.map((line) => Math.ceil(Math.max(String(line).length, 1) * size * LABEL_CHAR_WIDTH_RATIO)),
  );
  const height = Math.max(1, lines.length) * size * LABEL_LINE_HEIGHT;
  return { width, height, lineCount: lines.length };
}

function expandBoxToFit(element, minWidth, minHeight) {
  const width = Number(element.width) || 0;
  const height = Number(element.height) || 0;
  const nextWidth = Math.max(width, minWidth);
  const nextHeight = Math.max(height, minHeight);
  if (nextWidth === width && nextHeight === height) return element;
  const next = { ...element, width: nextWidth, height: nextHeight };
  if (nextWidth > width) next.x = (Number(element.x) || 0) - (nextWidth - width) / 2;
  if (nextHeight > height) next.y = (Number(element.y) || 0) - (nextHeight - height) / 2;
  return next;
}

function positionBoundTextInContainer(container, text) {
  const align = String(text.textAlign || "center");
  const valign = String(text.verticalAlign || "middle");
  const cx = Number(container.x) || 0;
  const cy = Number(container.y) || 0;
  const cw = Number(container.width) || 0;
  const ch = Number(container.height) || 0;
  const tw = Number(text.width) || 0;
  const th = Number(text.height) || 0;
  const x = align === "left" ? cx : align === "right" ? cx + cw - tw : cx + (cw - tw) / 2;
  const y = valign === "top" ? cy : valign === "bottom" ? cy + ch - th : cy + (ch - th) / 2;
  if (x === (Number(text.x) || 0) && y === (Number(text.y) || 0)) return text;
  return { ...text, x, y };
}

function fitContainersToBoundText(elements) {
  if (!Array.isArray(elements)) return [];
  const byId = new Map();
  for (const element of elements) {
    if (element?.id) byId.set(element.id, element);
  }
  for (const element of elements) {
    if (!element || element.type !== "text" || element.isDeleted || !element.containerId) continue;
    const container = byId.get(element.containerId);
    if (!container || !isNodeLabelContainer(container)) continue;
    const fitted = expandBoxToFit(
      container,
      (Number(element.width) || 0) + BOUND_TEXT_PADDING_X,
      (Number(element.height) || 0) + BOUND_TEXT_PADDING_Y,
    );
    if (fitted !== container) byId.set(container.id, fitted);
  }
  // Bound text keeps its own x/y. Growing the container from the center (or
  // growing the text box independently) leaves that label at the old coords,
  // so it sits off-center until something like restore() recomputes it.
  for (const element of elements) {
    if (!element || element.type !== "text" || element.isDeleted || !element.containerId) continue;
    const current = byId.get(element.id) ?? element;
    const container = byId.get(current.containerId);
    if (!container || !isNodeLabelContainer(container)) continue;
    const positioned = positionBoundTextInContainer(container, current);
    if (positioned !== current) byId.set(current.id, positioned);
  }
  return elements.map((element) => (element?.id && byId.has(element.id) ? byId.get(element.id) : element));
}

function withNormalizedLabelText(element) {
  if (!element || typeof element !== "object") return element;
  let next = element;
  const write = (key, value) => {
    if (next === element) next = { ...element };
    next[key] = value;
  };
  if (typeof element.text === "string") {
    const text = normalizeMermaidLabelLineBreaks(element.text);
    if (text !== element.text) write("text", text);
  }
  if (typeof element.originalText === "string") {
    const originalText = normalizeMermaidLabelLineBreaks(element.originalText);
    if (originalText !== element.originalText) {
      write("originalText", originalText);
      // Drop leftover `<br>` from the wrapped `text` field; convertToExcalidrawElements
      // can re-wrap from originalText on the next pass. Do not overwrite when
      // originalText was already clean - that would discard legitimate wrapping.
      if (typeof next.text === "string") write("text", originalText);
    }
  }
  if (element.label && typeof element.label === "object" && typeof element.label.text === "string") {
    const text = normalizeMermaidLabelLineBreaks(element.label.text);
    if (text !== element.label.text) {
      if (next === element) next = { ...element };
      next.label = { ...element.label, text };
    }
  }
  const labelText = next.label?.text || next.originalText || next.text;
  if (typeof labelText === "string" && labelText.includes("\n") && isNodeLabelContainer(next)) {
    const fontSize = next.label?.fontSize || next.fontSize;
    const estimated = estimateMultilineLabelBox(labelText, fontSize);
    next = expandBoxToFit(next, estimated.width + BOUND_TEXT_PADDING_X, estimated.height + BOUND_TEXT_PADDING_Y);
  }
  return next;
}

/**
 * @param {any[]} elements
 * @param {{ measure?: (element: any) => { width: number, height: number } }} [adapters]
 * @returns {any[]}
 */
export function restoreMermaidLabelLineBreaks(elements, { measure } = {}) {
  const restored = (Array.isArray(elements) ? elements : []).map((element) => withNormalizedLabelText(element));
  const sized = measure
    ? restored.map((element) => {
        const candidate = /** @type {Record<string, any>} */ (element);
        if (!candidate || candidate.type !== "text" || candidate.isDeleted) return element;
        const metrics = measure(element);
        return expandBoxToFit(element, Number(metrics?.width) || 0, Number(metrics?.height) || 0);
      })
    : restored;
  return fitContainersToBoundText(sized);
}

// Library icon nodes. A `%% lavish-icon` directive turns a flowchart vertex
// into a library icon above its label. The vertex keeps its Mermaid id,
// bindings, and label so edit summaries still speak in Mermaid node ids; it
// only grows to fit the icon and turns transparent.
// Every icon is scaled to one height so a diagram's icons read as a set;
// very wide items are capped by width instead.
export const LIBRARY_ICON_HEIGHT = 64;
export const LIBRARY_ICON_MAX_WIDTH = 120;
// Icon nodes are about 50px taller than the boxes Mermaid lays out, so the
// gap along that axis needs Mermaid's default 50px plus that growth, or
// neighbours overlap. The other axis keeps Mermaid's default.
export const LIBRARY_ICON_GROWN_SPACING = 100;
const MERMAID_DEFAULT_SPACING = 50;
const LIBRARY_ICON_PADDING = 8;
const LIBRARY_ICON_LABEL_GAP = 6;
const LIBRARY_ICON_ARROW_GAP = 4;
const LIBRARY_ICON_LABEL_BOTTOM_PADDING = 5;
const ICON_NODE_CUSTOM_DATA_KEY = "lavishIconNode";

function elementBounds(element) {
  const x = Number(element.x) || 0;
  const y = Number(element.y) || 0;
  if (Array.isArray(element.points) && element.points.length > 0) {
    const xs = element.points.map((point) => x + (Number(point?.[0]) || 0));
    const ys = element.points.map((point) => y + (Number(point?.[1]) || 0));
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  return [x, y, x + (Number(element.width) || 0), y + (Number(element.height) || 0)];
}

function commonBounds(elements) {
  const bounds = elements.map(elementBounds);
  const minX = Math.min(...bounds.map((b) => b[0]));
  const minY = Math.min(...bounds.map((b) => b[1]));
  const maxX = Math.max(...bounds.map((b) => b[2]));
  const maxY = Math.max(...bounds.map((b) => b[3]));
  return { minX, minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Extra Mermaid config for a diagram that places at least one icon. The
 * converter merges `flowchart` shallowly over its own, so its linear curve is
 * restated here.
 * @param {{ item: unknown }[]} icons
 * @param {string} source
 * @returns {{ flowchart?: { curve: "linear", nodeSpacing: number, rankSpacing: number } }}
 */
export function libraryIconMermaidConfig(icons, source) {
  if (!(Array.isArray(icons) && icons.some((icon) => icon.item))) return {};
  const header = String(source || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^(flowchart|graph)\b/i.test(line));
  const leftRight = /^(?:flowchart|graph)\s+(LR|RL)\b/i.test(header || "");
  return {
    flowchart: {
      curve: "linear",
      nodeSpacing: leftRight ? LIBRARY_ICON_GROWN_SPACING : MERMAID_DEFAULT_SPACING,
      rankSpacing: leftRight ? MERMAID_DEFAULT_SPACING : LIBRARY_ICON_GROWN_SPACING,
    },
  };
}

export function libraryIconSize(item) {
  const bounds = commonBounds(item.elements);
  const width = Math.max(bounds.width, 1);
  const height = Math.max(bounds.height, 1);
  const scale = Math.min(LIBRARY_ICON_HEIGHT / height, LIBRARY_ICON_MAX_WIDTH / width);
  return { scale, width: width * scale, height: height * scale };
}

function isFlowchartVertexSkeleton(skeleton, nodeId) {
  return (
    skeleton?.id === nodeId &&
    isNodeLabelContainer(skeleton) &&
    skeleton.label &&
    !(Array.isArray(skeleton.groupIds) && skeleton.groupIds.includes(`subgraph_group_${nodeId}`))
  );
}

// Liang-Barsky: where the segment from `outside` to `inside` first enters the box.
function segmentEntryPoint(outside, inside, box) {
  const [x0, y0] = outside;
  const dx = inside[0] - x0;
  const dy = inside[1] - y0;
  let entry = 0;
  let exit = 1;
  const edges = [
    [-dx, x0 - box.minX],
    [dx, box.maxX - x0],
    [-dy, y0 - box.minY],
    [dy, box.maxY - y0],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > exit) return null;
      entry = Math.max(entry, r);
    } else {
      if (r < entry) return null;
      exit = Math.min(exit, r);
    }
  }
  return [x0 + entry * dx, y0 + entry * dy];
}

function insideBox(point, box) {
  return point[0] > box.minX && point[0] < box.maxX && point[1] > box.minY && point[1] < box.maxY;
}

// Excalidraw binds skeleton arrows without rerouting them, so an arrow that
// ended on the node's old edge would stop short of, or end inside, the
// resized node. Extend the last segment to the new edge, or walk back to the
// first point outside and cut the path where it enters.
function fitPathEnd(points, box) {
  if (points.length < 2) return points;
  if (!insideBox(points.at(-1), box)) {
    const end = points.at(-1);
    const previous = points.at(-2);
    const length = Math.hypot(end[0] - previous[0], end[1] - previous[1]);
    if (length === 0) return points;
    const reach = (box.maxX - box.minX + box.maxY - box.minY) * 4;
    const far = [
      end[0] + ((end[0] - previous[0]) / length) * reach,
      end[1] + ((end[1] - previous[1]) / length) * reach,
    ];
    const entry = segmentEntryPoint(end, far, box);
    return entry ? [...points.slice(0, -1), entry] : points;
  }
  let outside = points.length - 2;
  while (outside >= 0 && insideBox(points[outside], box)) outside -= 1;
  if (outside < 0) return points;
  const entry = segmentEntryPoint(points[outside], points[outside + 1], box);
  return entry ? [...points.slice(0, outside + 1), entry] : points;
}

function trimArrowSkeleton(arrow, startBox, endBox) {
  const x = Number(arrow.x) || 0;
  const y = Number(arrow.y) || 0;
  let points = arrow.points.map((point) => [x + (Number(point?.[0]) || 0), y + (Number(point?.[1]) || 0)]);
  if (endBox) points = fitPathEnd(points, endBox);
  if (startBox) points = fitPathEnd(points.slice().reverse(), startBox).reverse();
  const [originX, originY] = points[0];
  return { ...arrow, x: originX, y: originY, points: points.map(([px, py]) => [px - originX, py - originY]) };
}

/**
 * Grow each directive's flowchart vertex to fit a library icon above its
 * label, before Excalidraw materializes the skeletons.
 * @param {any[]} skeletons
 * The converter shrinks some labels (cylinders) to fit Mermaid's shape width;
 * an icon node's box is resized anyway, so `labelFontSize` restores them.
 * @param {{ nodeId: string, ref: string, item: { ref?: string, elements: any[] } | null }[]} icons
 * @param {{ labelFontSize?: number }} [options]
 * @returns {{ skeletons: any[], missing: { nodeId: string, ref: string, reason: "item" | "node" }[] }}
 */
export function prepareLibraryIconSkeletons(skeletons, icons, { labelFontSize = 0 } = {}) {
  const list = Array.isArray(skeletons) ? skeletons : [];
  /** @type {{ nodeId: string, ref: string, reason: "item" | "node" }[]} */
  const missing = [];
  const grown = new Map();
  for (const icon of Array.isArray(icons) ? icons : []) {
    if (!icon.item || !Array.isArray(icon.item.elements) || icon.item.elements.length === 0) {
      missing.push({ nodeId: icon.nodeId, ref: icon.ref, reason: "item" });
      continue;
    }
    const index = list.findIndex((skeleton) => isFlowchartVertexSkeleton(skeleton, icon.nodeId));
    if (index < 0 || grown.has(icon.nodeId)) {
      missing.push({ nodeId: icon.nodeId, ref: icon.ref, reason: "node" });
      continue;
    }
    const node = list[index];
    const iconSize = libraryIconSize(icon.item);
    const fontSize = Math.max(Number(node.label.fontSize) || 0, labelFontSize) || undefined;
    const label = estimateMultilineLabelBox(node.label.text, fontSize);
    const width = Number(node.width) || 0;
    const height = Number(node.height) || 0;
    // The box is invisible, so it hugs icon and label; arrows are refitted below.
    const nextWidth = Math.max(iconSize.width, label.width) + 2 * LIBRARY_ICON_PADDING;
    const nextHeight =
      LIBRARY_ICON_PADDING + iconSize.height + LIBRARY_ICON_LABEL_GAP + label.height + LIBRARY_ICON_PADDING;
    const x = (Number(node.x) || 0) - (nextWidth - width) / 2;
    const y = (Number(node.y) || 0) - (nextHeight - height) / 2;
    grown.set(icon.nodeId, {
      index,
      node: {
        ...node,
        x,
        y,
        width: nextWidth,
        height: nextHeight,
        strokeColor: "transparent",
        backgroundColor: "transparent",
        // Bound text inherits the container's stroke color, which is now
        // transparent, so the label keeps the node's original color.
        label: {
          ...node.label,
          ...(fontSize ? { fontSize } : {}),
          verticalAlign: "bottom",
          strokeColor: node.label.strokeColor || node.strokeColor || "#1e1e1e",
        },
        customData: { ...node.customData, [ICON_NODE_CUSTOM_DATA_KEY]: icon.item.ref || icon.ref },
      },
      box: {
        minX: x - LIBRARY_ICON_ARROW_GAP,
        minY: y - LIBRARY_ICON_ARROW_GAP,
        maxX: x + nextWidth + LIBRARY_ICON_ARROW_GAP,
        maxY: y + nextHeight + LIBRARY_ICON_ARROW_GAP,
      },
    });
  }
  if (grown.size === 0) return { skeletons: list, missing };
  const prepared = list.map((skeleton, index) => {
    for (const entry of grown.values()) if (entry.index === index) return entry.node;
    if (skeleton?.type !== "arrow" || !Array.isArray(skeleton.points)) return skeleton;
    const startBox = grown.get(skeleton.start?.id)?.box;
    const endBox = grown.get(skeleton.end?.id)?.box;
    return startBox || endBox ? trimArrowSkeleton(skeleton, startBox, endBox) : skeleton;
  });
  return { skeletons: prepared, missing };
}

function cloneIconElements(item, { idPrefix, ref, left, top, outerGroupIds }) {
  const { minX, minY } = commonBounds(item.elements);
  const { scale } = libraryIconSize(item);
  const ids = new Map(item.elements.map((element, index) => [element.id, `${idPrefix}:${index}`]));
  const mapId = (id) => (ids.has(id) ? ids.get(id) : null);
  const mapBinding = (binding) =>
    binding && mapId(binding.elementId) ? { ...binding, elementId: mapId(binding.elementId) } : null;
  return item.elements.map((element) => {
    const clone = {
      ...element,
      id: mapId(element.id),
      x: left + ((Number(element.x) || 0) - minX) * scale,
      y: top + ((Number(element.y) || 0) - minY) * scale,
      width: (Number(element.width) || 0) * scale,
      height: (Number(element.height) || 0) * scale,
      groupIds: [
        ...(Array.isArray(element.groupIds) ? element.groupIds : []).map((groupId) => `${idPrefix}:${groupId}`),
        ...outerGroupIds,
      ],
      frameId: null,
      customData: { ...element.customData, [LIBRARY_REF_CUSTOM_DATA_KEY]: ref },
    };
    delete clone.index;
    if (Array.isArray(element.points)) {
      clone.points = element.points.map((point) => [
        (Number(point?.[0]) || 0) * scale,
        (Number(point?.[1]) || 0) * scale,
      ]);
    }
    if (typeof element.fontSize === "number") clone.fontSize = element.fontSize * scale;
    if ("containerId" in element) clone.containerId = element.containerId ? mapId(element.containerId) : null;
    if (Array.isArray(element.boundElements)) {
      clone.boundElements = element.boundElements
        .filter((bound) => mapId(bound?.id))
        .map((bound) => ({ ...bound, id: mapId(bound.id) }));
    }
    if ("startBinding" in element) clone.startBinding = mapBinding(element.startBinding);
    if ("endBinding" in element) clone.endBinding = mapBinding(element.endBinding);
    return clone;
  });
}

/**
 * Add the library icon to every vertex `prepareLibraryIconSkeletons` grew.
 * Icon element ids derive from the vertex id, so re-conversions are stable.
 * @param {any[]} elements
 * @param {(ref: string) => { ref?: string, elements: any[] } | null} resolveItem
 */
export function placeLibraryIcons(elements, resolveItem) {
  const list = Array.isArray(elements) ? elements : [];
  const nodes = list.filter(
    (element) => isNodeLabelContainer(element) && typeof element.customData?.[ICON_NODE_CUSTOM_DATA_KEY] === "string",
  );
  if (nodes.length === 0) return list;
  const updates = new Map();
  const icons = new Map();
  for (const node of nodes) {
    const ref = node.customData[ICON_NODE_CUSTOM_DATA_KEY];
    const item = resolveItem(ref);
    if (!item || !Array.isArray(item.elements) || item.elements.length === 0) continue;
    const iconGroup = `${node.id}:icon`;
    const outerGroupIds = [iconGroup, ...(Array.isArray(node.groupIds) ? node.groupIds : [])];
    const left = (Number(node.x) || 0) + ((Number(node.width) || 0) - libraryIconSize(item).width) / 2;
    const top = (Number(node.y) || 0) + LIBRARY_ICON_PADDING;
    updates.set(node.id, { ...node, groupIds: outerGroupIds });
    const label = list.find((element) => element?.type === "text" && element.containerId === node.id);
    if (label) {
      const height = Number(label.height) || 0;
      updates.set(label.id, {
        ...label,
        groupIds: outerGroupIds,
        y: (Number(node.y) || 0) + (Number(node.height) || 0) - height - LIBRARY_ICON_LABEL_BOTTOM_PADDING,
      });
    }
    icons.set(
      label ? label.id : node.id,
      cloneIconElements(item, { idPrefix: iconGroup, ref: item.ref || ref, left, top, outerGroupIds }),
    );
  }
  return list.flatMap((element) => {
    const updated = updates.get(element?.id) ?? element;
    return icons.has(element?.id) ? [updated, ...icons.get(element.id)] : [updated];
  });
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
  const baselineElements = Array.isArray(state?.baselineElements) ? state.baselineElements : [];
  if (
    state?.librariesUnavailable &&
    !savedSceneHasPreservableEdits({ scene, baseline: { elements: baselineElements } })
  ) {
    return null;
  }
  return {
    sourceHash: String(state?.sceneSourceHash || ""),
    textMetricsVersion: Math.max(0, Math.floor(Number(state?.textMetricsVersion) || 0)),
    scene: scene ?? null,
    baseline: { elements: baselineElements },
  };
}

// Conversion always autosaves on view, so a sidecar's presence is not proof of
// user edits. When the Mermaid source hash changes, prompt only if the saved
// scene actually differs from its conversion baseline.
const BENIGN_ELEMENT_CHANGE_KEYS = new Set([
  "backgroundColor",
  "fillStyle",
  "fontFamily",
  "fontSize",
  "index",
  "lineHeight",
  "opacity",
  "roughness",
  "roundness",
  "seed",
  "strokeColor",
  "strokeSharpness",
  "strokeStyle",
  "strokeWidth",
  "textAlign",
  "updated",
  "version",
  "versionNonce",
  "verticalAlign",
]);
const JITTER_ELEMENT_KEYS = new Set(["height", "width", "x", "y"]);

function valuesDiffer(before, after, key, elementProperty = false) {
  if (elementProperty && BENIGN_ELEMENT_CHANGE_KEYS.has(key)) return false;
  if (elementProperty && JITTER_ELEMENT_KEYS.has(key)) {
    return Math.abs((Number(after) || 0) - (Number(before) || 0)) > SUMMARY_MOVE_EPSILON_PX;
  }
  if (Object.is(before, after)) return false;
  if (!before || !after || typeof before !== "object" || typeof after !== "object") return true;
  if (Array.isArray(before) || Array.isArray(after)) {
    if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length) return true;
    return before.some((value, index) => valuesDiffer(value, after[index], String(index)));
  }
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const childKey of keys) {
    if (valuesDiffer(before[childKey], after[childKey], childKey)) return true;
  }
  return false;
}

function elementHasMeaningfulDifference(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (key === "isDeleted") continue;
    if (valuesDiffer(before[key], after[key], key, true)) return true;
  }
  return false;
}

export function savedSceneHasPreservableEdits(saved) {
  const sceneElements = saved?.scene?.elements;
  const baselineElements = saved?.baseline?.elements;
  if (!Array.isArray(baselineElements)) return Array.isArray(sceneElements);
  if (!Array.isArray(sceneElements)) return true;
  const baseline = byId(liveElements(baselineElements));
  const scene = byId(liveElements(sceneElements));
  if (baseline.size !== scene.size) return true;
  for (const [id, element] of scene) {
    const original = baseline.get(id);
    if (!original || elementHasMeaningfulDifference(original, element)) return true;
  }
  return false;
}

/**
 * @param {object | null | undefined} saved
 * @param {string} currentSourceHash
 * @returns {"convert" | "restore" | "prompt"}
 */
export function resolveWhiteboardInitAction(saved, currentSourceHash) {
  const record = saved && typeof saved === "object" && saved.scene ? saved : null;
  if (!record) return "convert";
  if (String(record.source_hash || "") === String(currentSourceHash || "")) return "restore";
  return savedSceneHasPreservableEdits(record) ? "prompt" : "convert";
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
  const addedItems = new Map();
  const removedItems = new Map();
  const movedItems = new Map();

  for (const el of edited) {
    if (baselineMap.has(el.id)) continue;
    if (libraryRefOf(el)) {
      const [minX, minY] = elementBounds(el);
      const entry = addedItems.get(libraryGroupKey(el));
      if (entry) {
        entry.x = Math.min(entry.x, minX);
        entry.y = Math.min(entry.y, minY);
      } else {
        addedItems.set(libraryGroupKey(el), { ref: libraryRefOf(el), x: minX, y: minY });
      }
      continue;
    }
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

  for (const { ref, x, y } of addedItems.values()) {
    stats.added += 1;
    lines.push(clampLine(`Added library item ${ref} near (${Math.round(x)}, ${Math.round(y)})`));
  }

  for (const el of baseline) {
    if (editedMap.has(el.id)) continue;
    if (libraryRefOf(el)) {
      const key = libraryGroupKey(el);
      if (!removedItems.has(key)) removedItems.set(key, { ref: libraryRefOf(el), group: libraryGroupOf(el) });
      continue;
    }
    if (el.type === "text" && el.containerId && baselineMap.has(el.containerId)) {
      // Bound label removal surfaces through its container's relabel/remove.
      continue;
    }
    stats.removed += 1;
    lines.push(clampLine(`Removed ${describeElement(el, baselineText)}`));
  }

  for (const { ref, group } of removedItems.values()) {
    const node = iconNodeFor(baseline, group);
    if (node && !editedMap.has(node.id)) continue;
    stats.removed += 1;
    lines.push(clampLine(`Removed library item ${ref}${node ? ` from ${describeElement(node, baselineText)}` : ""}`));
  }

  for (const el of edited) {
    const before = baselineMap.get(el.id);
    if (!before) continue;
    if (libraryRefOf(el)) {
      const key = libraryGroupKey(el);
      if (!movedItems.has(key)) {
        movedItems.set(key, {
          ref: libraryRefOf(el),
          group: libraryGroupOf(el),
          dx: Math.round((el.x ?? 0) - (before.x ?? 0)),
          dy: Math.round((el.y ?? 0) - (before.y ?? 0)),
        });
      }
      continue;
    }

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

  for (const { ref, group, dx, dy } of movedItems.values()) {
    // An icon node's icon moves with its node, which reports the move.
    if (iconNodeFor(edited, group)) continue;
    if (Math.abs(dx) <= SUMMARY_MOVE_EPSILON_PX && Math.abs(dy) <= SUMMARY_MOVE_EPSILON_PX) continue;
    stats.moved += 1;
    lines.push(clampLine(`Moved library item ${ref} by (${dx}, ${dy})`));
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

function libraryRefOf(el) {
  const ref = el?.customData?.[LIBRARY_REF_CUSTOM_DATA_KEY];
  return typeof ref === "string" ? ref : "";
}

// The outermost non-subgraph group is the one instance of a library item: an
// icon node's `<id>:icon` group, or the group a dropped item came with.
function libraryGroupOf(el) {
  const groups = (Array.isArray(el.groupIds) ? el.groupIds : []).filter(
    (groupId) => !String(groupId).startsWith("subgraph_group_"),
  );
  return groups.length > 0 ? String(groups.at(-1)) : "";
}

function libraryGroupKey(el) {
  return `${libraryRefOf(el)}\u0000${libraryGroupOf(el) || el.id}`;
}

function iconNodeFor(elements, group) {
  if (!group) return null;
  return (
    elements.find(
      (el) => !libraryRefOf(el) && el.type !== "text" && Array.isArray(el.groupIds) && el.groupIds.includes(group),
    ) || null
  );
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
