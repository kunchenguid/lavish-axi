/* global CSS, Element, MutationObserver, ResizeObserver, document, getComputedStyle, parent, window */

import * as mermaidHelpers from "./mermaid-node.js";

export const LAVISH_INTERNAL_QUEUE_KEY = "_lavishQueueKey";

export const MODE_TOGGLE_HOTKEY_KEY = "i";

export function isModeToggleHotkeyEvent(event) {
  if (event.shiftKey || event.altKey) return false;
  return Boolean(event.metaKey || event.ctrlKey) && String(event.key || "").toLowerCase() === MODE_TOGGLE_HOTKEY_KEY;
}

// Derive the browser-only replacement key used to collapse unsent updates for the same input.
// The key is stripped by the chrome before prompts are sent to the server or returned by poll.
export function deriveLavishQueueKey(element, options = {}) {
  function stringValue(value) {
    return value === null || value === undefined ? "" : String(value);
  }

  function attributeValue(el, name) {
    if (!el) return "";
    if (el.getAttribute) {
      const value = el.getAttribute(name);
      if (value !== null && value !== undefined) return value;
    }
    return el[name] || "";
  }

  function tagName(el) {
    return stringValue(el?.tagName || el?.nodeName).toLowerCase();
  }

  function closestElementMatching(el, selector) {
    return el && el.closest ? el.closest(selector) : null;
  }

  function elementPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      let part = tagName(node) || "element";
      const id = stringValue(attributeValue(node, "id") || node.id).trim();
      if (id) {
        part += `#${id}`;
        parts.unshift(part);
        break;
      }

      const parent = node.parentElement;
      if (parent && parent.children) {
        const siblings = [...parent.children].filter((child) => tagName(child) === tagName(node));
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  }

  function scopeKey(el) {
    const scope = closestElementMatching(el, "form,fieldset") || el?.parentElement || el;
    const tag = tagName(scope) || "scope";
    const explicit = stringValue(
      attributeValue(scope, "data-lavish-question") || attributeValue(scope, "id") || attributeValue(scope, "name"),
    ).trim();
    if (explicit) return `${tag}:${explicit}`;
    return elementPath(scope) || tag;
  }

  function controlIdentity(el) {
    const identity = stringValue(attributeValue(el, "name") || attributeValue(el, "id") || el?.name).trim();
    if (identity) return identity;
    return elementPath(el);
  }

  function isKeyedInputType(type) {
    return !new Set(["button", "submit", "reset", "file", "image", "hidden", "radio", "checkbox"]).has(type);
  }

  if (Object.hasOwn(options, "queueKey")) {
    return stringValue(options.queueKey).trim();
  }

  const question = closestElementMatching(element, "[data-lavish-question]");
  const questionKey = stringValue(attributeValue(question, "data-lavish-question")).trim();
  if (questionKey) return `question:${questionKey}`;

  const tag = tagName(element);
  const type = stringValue(attributeValue(element, "type") || element?.type).toLowerCase();
  const scope = scopeKey(element);

  if (tag === "input" && type === "radio") {
    const name = stringValue(attributeValue(element, "name") || element?.name).trim();
    if (name) return `radio:${scope}:${name}`;
    return "";
  }

  if (tag === "input" && type === "checkbox") {
    const identity = controlIdentity(element);
    const explicitValue = stringValue(element?.getAttribute ? element.getAttribute("value") : "").trim();
    const option = explicitValue || stringValue(attributeValue(element, "id") || elementPath(element)).trim();
    if (identity) return `checkbox:${scope}:${identity}:${option}`;
    return "";
  }

  if (tag === "select" || tag === "textarea" || (tag === "input" && isKeyedInputType(type))) {
    const identity = controlIdentity(element);
    if (identity) return `field:${scope}:${identity}`;
  }

  return "";
}

export function isNativeInteractiveControl(el) {
  return !!(
    el &&
    el.closest &&
    el.closest(
      "button,input,select,textarea,option,optgroup,label,summary,[contenteditable]:not([contenteditable='false'])",
    )
  );
}

// Wrapped inline text (a bold phrase or code token that breaks across a line) reports one
// getBoundingClientRect() spanning both lines, so a bounding-box intersection test "overlaps"
// every element sitting in the reflow gap between the fragments even though nothing is actually
// drawn there. Comparing real per-line fragments (getClientRects()) instead only flags overlap
// where rendered pixels of unrelated elements actually collide.
export function fragmentsSignificantlyOverlap(fragmentsA, fragmentsB, { minAreaRatio = 0.25, minAreaPx = 24 } = {}) {
  function rectAreaOf(rect) {
    return Math.max(0, rect.width) * Math.max(0, rect.height);
  }

  function intersectionAreaOf(a, b) {
    const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    return width * height;
  }

  for (const a of fragmentsA) {
    const threshold = Math.min(rectAreaOf(a) * minAreaRatio, minAreaPx);
    for (const b of fragmentsB) {
      if (intersectionAreaOf(a, b) >= threshold) return true;
    }
  }
  return false;
}

export function verticalFragmentOverflow(fragments, box) {
  return fragments.reduce(
    (largest, fragment) =>
      Math.max(largest, Number(box.top) - Number(fragment.top), Number(fragment.bottom) - Number(box.bottom)),
    0,
  );
}

// scrollWidth/scrollHeight can only exceed clientWidth/clientHeight when something constrains
// the box's size (a fixed height/width, or a flex/grid item smaller than its content) - a box
// that simply grows to fit its content always has scrollHeight === clientHeight, so this never
// false-positives on ordinary auto-sized elements.
export function classifyHorizontalOverflow({ scrollWidth, clientWidth, overflowX, hasText, isTruncated, epsilon = 1 }) {
  const overflowPx = clientWidth > 0 ? scrollWidth - clientWidth : 0;
  if (overflowPx <= epsilon) return null;
  const clipsText = hasText && (overflowX === "hidden" || overflowX === "clip") && !isTruncated;
  return { overflowPx, kind: clipsText ? "clipped-text" : "element-scroll-overflow" };
}

// A child crossing the parent's content edge can be a deliberate negative-margin accent. Ignore
// it unless it changes scroll geometry, and leave the remaining heuristic advisory; the separate
// page-horizontal-overflow finding is the strict signal when content escapes the viewport.
export function classifyParentOverflow({ overhangPx, scrollWidth, clientWidth, epsilon = 1 }) {
  const scrollOverflowPx = clientWidth > 0 ? scrollWidth - clientWidth : 0;
  if (overhangPx <= epsilon || scrollOverflowPx <= epsilon) return null;
  return { overflowPx: overhangPx, kind: "element-parent-overflow", severity: "warning" };
}

// Fixed-size badges/buttons/pills usually leave overflow at its default "visible" rather than
// "hidden" - the text doesn't get clipped, it spills out of the box and overlaps neighboring
// content, which is just as broken. Scroll dimensions also include font-metric and decorative
// overflow, so browser callers cross-check real text fragments; one visible line is harmless,
// while wrapped text outside the box remains a finding. `clips` distinguishes a hard clip from
// a visible spill, which callers dedup against unconstrained ancestors before reporting.
export function classifyVerticalOverflow({
  scrollHeight,
  clientHeight,
  overflowY,
  hasText,
  isTruncated,
  textOverflowPx,
  textLineCount,
  epsilon = 1,
}) {
  const overflowPx = clientHeight > 0 ? scrollHeight - clientHeight : 0;
  if (overflowPx <= epsilon) return null;
  const scrollable = overflowY === "auto" || overflowY === "scroll";
  if (scrollable || !hasText || isTruncated) return null;
  if (Number.isFinite(textOverflowPx) && textOverflowPx <= epsilon) return null;
  const clips = overflowY === "hidden" || overflowY === "clip";
  if (!clips && textLineCount === 1) return null;
  return { overflowPx, kind: "clipped-text", clips };
}

export function resolveVisibleSpillCandidates(spillCandidates, { epsilon = 1 } = {}) {
  function spillBottomEdge(candidate) {
    const explicit = Number(candidate.spillBottom);
    if (Number.isFinite(explicit)) return explicit;
    const rectBottom = Number(candidate.rect?.bottom);
    const overflowPx = Number(candidate.overflowPx);
    if (!Number.isFinite(rectBottom) || !Number.isFinite(overflowPx)) return null;
    return rectBottom + overflowPx;
  }

  function sameSpillEdge(candidate, other) {
    const candidateBottom = spillBottomEdge(candidate);
    const otherBottom = spillBottomEdge(other);
    return candidateBottom !== null && otherBottom !== null && Math.abs(candidateBottom - otherBottom) <= epsilon;
  }

  return spillCandidates.filter(
    (candidate) =>
      !spillCandidates.some(
        (other) => other.el !== candidate.el && candidate.el.contains(other.el) && sameSpillEdge(candidate, other),
      ),
  );
}

export function createArtifactSdk(
  deriveQueueKey,
  isNativeInteractive = isNativeInteractiveControl,
  mermaid = mermaidHelpers,
) {
  const { isMermaidSvg, mermaidNodeFrom, mermaidNodeElement } = mermaid;
  let annotationMode = true;
  let hovered = null;
  let selected = null;
  let ignoreNextClick = false;
  let shadow = null;
  let counter = 0;
  const ids = new WeakMap();

  function uid(el) {
    if (!ids.has(el)) ids.set(el, String(++counter));
    return ids.get(el);
  }

  function escapeAnnotationText(value) {
    return String(value).replace(
      /[&<>"']/g,
      (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
    );
  }

  function selector(el) {
    if (!el || !el.tagName) return "";

    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 5) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        part += "#" + CSS.escape(node.id);
        parts.unshift(part);
        break;
      }

      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((x) => x.tagName === node.tagName);
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      node = parent;
    }

    return parts.join(" > ");
  }

  function context(el) {
    const base = {
      uid: uid(el),
      selector: selector(el),
      tag: (el.tagName || "").toLowerCase(),
      text: (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 240),
    };

    const mermaidNode = mermaidNodeFrom(el, selector);
    if (mermaidNode) {
      base.tag = "mermaid-node";
      base.text = mermaidNode.label || base.text;
      base.target = mermaidNode;
    }

    return base;
  }

  // Hover and click must outline the exact element they annotate. Clicking inside
  // a Mermaid diagram annotates the whole <g> node, so resolve a raw event target
  // up to that node before highlighting; every other element annotates itself.
  function annotationTargetEl(el) {
    return mermaidNodeElement(el) || el;
  }

  // ---------------------------------------------------------------------------
  // Mermaid diagram enhancement: pan/zoom in explore mode, freeze in annotate
  // mode. All of this operates on the rendered SVG only; the saved artifact is
  // never modified, so a diagram still renders identically when opened directly.
  // Node identity/label extraction lives in the injected `mermaid` helpers so it
  // can be unit tested and shared with the server-side target validator.
  // ---------------------------------------------------------------------------

  const mermaidViewports = new WeakMap();

  function findMermaidSvgs() {
    const svgs = new Set();
    for (const svg of document.querySelectorAll("svg")) {
      if (isMermaidSvg(svg)) svgs.add(svg);
    }
    return [...svgs];
  }

  // A minimal, dependency-free viewBox-based pan/zoom. Kept small on purpose:
  // "nodes only" annotation plus freeze-on-annotate means we do not need
  // momentum, gestures, or a full pan/zoom library here. svg-pan-zoom is a
  // documented drop-in upgrade if richer interaction is wanted later.
  function createViewport(svg) {
    const bbox = svg.getBBox ? safeBBox(svg) : null;
    const initial = readViewBox(svg) || (bbox ? { x: bbox.x, y: bbox.y, w: bbox.width, h: bbox.height } : null);
    if (!initial) return null;
    svg.setAttribute("viewBox", `${initial.x} ${initial.y} ${initial.w} ${initial.h}`);

    const view = { ...initial };
    let frozen = false;
    let panning = null;

    function apply() {
      svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);
    }
    function reset() {
      Object.assign(view, initial);
      apply();
    }
    function zoomAt(clientX, clientY, factor) {
      const rect = svg.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const px = (clientX - rect.left) / rect.width;
      const py = (clientY - rect.top) / rect.height;
      const fx = view.x + view.w * px;
      const fy = view.y + view.h * py;
      const next = Math.min(Math.max(view.w * factor, initial.w / 40), initial.w * 8);
      const scale = next / view.w;
      view.w = next;
      view.h *= scale;
      view.x = fx - (fx - view.x) * scale;
      view.y = fy - (fy - view.y) * scale;
      apply();
    }

    function onWheel(event) {
      if (frozen) return;
      event.preventDefault();
      zoomAt(event.clientX, event.clientY, event.deltaY > 0 ? 1.15 : 1 / 1.15);
    }
    function onPointerDown(event) {
      if (frozen || event.button !== 0) return;
      panning = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y };
      svg.setPointerCapture?.(event.pointerId);
      svg.style.cursor = "grabbing";
    }
    function onPointerMove(event) {
      if (!panning) return;
      const rect = svg.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      view.x = panning.vx - ((event.clientX - panning.x) / rect.width) * view.w;
      view.y = panning.vy - ((event.clientY - panning.y) / rect.height) * view.h;
      apply();
    }
    function onPointerUp(event) {
      panning = null;
      svg.releasePointerCapture?.(event.pointerId);
      svg.style.cursor = frozen ? "" : "grab";
    }

    svg.addEventListener("wheel", onWheel, { passive: false });
    svg.addEventListener("pointerdown", onPointerDown);
    svg.addEventListener("pointermove", onPointerMove);
    svg.addEventListener("pointerup", onPointerUp);
    svg.addEventListener("pointercancel", onPointerUp);

    function setFrozen(next) {
      frozen = !!next;
      panning = null;
      svg.style.cursor = frozen ? "" : "grab";
      svg.style.touchAction = frozen ? "" : "none";
    }
    setFrozen(false);

    return { reset, setFrozen };
  }

  function safeBBox(svg) {
    try {
      return svg.getBBox();
    } catch {
      return null;
    }
  }

  function readViewBox(svg) {
    const raw = svg.getAttribute?.("viewBox");
    if (!raw) return null;
    const parts = raw
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
    return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
  }

  // Inline whiteboard embedding. Each rendered diagram inside a `.mermaid`
  // container is replaced, at view time only, by a nested sandboxed iframe
  // hosting the Excalidraw whiteboard frame - the artifact file keeps its
  // Mermaid source and still renders plain diagrams when opened standalone or
  // exported. The index of the container among `.mermaid` elements in document
  // order is the diagram's identity; the server recovers the matching source
  // from the artifact file. This SDK owns their lifecycle during fullscreen
  // transitions.
  const whiteboardEmbeds = new Map(); // container -> { iframe, index }

  function mermaidContainerIndex(container) {
    return [...document.querySelectorAll(".mermaid")].indexOf(container);
  }

  function whiteboardEmbedHeightPx(svgRect) {
    const headerPx = 96;
    const min = 360;
    const max = Math.max(min, Math.round((window.innerHeight || 800) * 0.8));
    return Math.max(min, Math.min(Math.round(svgRect.height) + headerPx, max));
  }

  function embedWhiteboard(svg) {
    const container = svg.closest(".mermaid");
    if (!container) return;
    const existing = whiteboardEmbeds.get(container);
    if (existing && existing.iframe.isConnected) {
      existing.index = mermaidContainerIndex(container);
      return;
    }
    const index = mermaidContainerIndex(container);
    if (index < 0) return;
    const rect = svg.getBoundingClientRect();
    // Mermaid renders asynchronously; a zero-ish rect means this svg has not
    // been laid out yet. Skip it and retry shortly - layout completion does
    // not necessarily mutate the DOM again, so the observer alone is not a
    // guaranteed wake-up.
    if (rect.height < 40) {
      window.setTimeout(scheduleMermaidEnhance, 150);
      return;
    }
    const iframe = document.createElement("iframe");
    iframe.setAttribute("data-lavish-ui", "whiteboard-inline");
    iframe.setAttribute("title", "Excalidraw whiteboard");
    // Stricter than (and independent of) this artifact frame's own sandbox.
    iframe.setAttribute("sandbox", "allow-scripts allow-popups");
    iframe.src = whiteboardFrameSrc({ index, diagramId: svg.id || "" });
    iframe.style.cssText =
      `display:block;width:100%;height:${whiteboardEmbedHeightPx(rect)}px;border:1px solid rgba(128,128,128,.35);` +
      "border-radius:12px;background:transparent";
    // The design snippet re-renders Mermaid inside the container on theme
    // changes, so the frame lives as a sibling: re-renders stay harmless
    // inside the hidden container instead of destroying the editor.
    container.style.display = "none";
    container.insertAdjacentElement("afterend", iframe);
    whiteboardEmbeds.set(container, { iframe, index, diagramId: svg.id || "" });
  }

  function whiteboardEmbedEntries() {
    return [...whiteboardEmbeds.values()].filter((entry) => entry.iframe.isConnected);
  }

  function whiteboardEntryByIndex(index) {
    return whiteboardEmbedEntries().find((entry) => entry.index === Number(index)) || null;
  }

  function whiteboardFrameSrc(entry) {
    const params = new URLSearchParams({
      diagramIndex: String(entry.index),
      diagramId: String(entry.diagramId || ""),
    });
    return `/whiteboard-frame?${params}`;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== parent) return;
    const msg = event.data || {};
    // While the chrome overlay edits a diagram fullscreen, its inline frame is
    // parked on about:blank so two editors never autosave the same sidecar;
    // resume reboots the frame, which re-inits from the latest saved scene.
    if (msg.type === "lavish:suspendWhiteboard") {
      const target = whiteboardEntryByIndex(msg.diagramIndex);
      if (target) target.iframe.src = "about:blank";
    }
    if (msg.type === "lavish:resumeWhiteboard") {
      const target = whiteboardEntryByIndex(msg.diagramIndex);
      if (target) target.iframe.src = whiteboardFrameSrc(target);
    }
  });

  function enhanceMermaid() {
    for (const svg of findMermaidSvgs()) {
      embedWhiteboard(svg);
      if (mermaidViewports.has(svg)) continue;
      const viewport = createViewport(svg);
      if (viewport) {
        viewport.setFrozen(annotationMode);
        mermaidViewports.set(svg, viewport);
      }
    }
  }

  let mermaidEnhanceScheduled = false;
  function scheduleMermaidEnhance() {
    if (mermaidEnhanceScheduled) return;
    mermaidEnhanceScheduled = true;
    const run = () => {
      mermaidEnhanceScheduled = false;
      enhanceMermaid();
    };
    if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(run);
    else window.setTimeout(run, 50);
  }

  function setMermaidFrozen(frozen) {
    for (const svg of findMermaidSvgs()) {
      mermaidViewports.get(svg)?.setFrozen(frozen);
    }
  }

  function closestElement(node) {
    if (!node) return document.body;
    if (node.nodeType === 1) return node;
    return node.parentElement || document.body;
  }

  function nodePath(node, root) {
    const path = [];
    let current = node;
    while (current && current !== root) {
      const parentNode = current.parentNode;
      if (!parentNode) break;
      path.unshift([...parentNode.childNodes].indexOf(current));
      current = parentNode;
    }
    return path;
  }

  function rangeBoundary(node, offset) {
    const el = closestElement(node);
    return {
      selector: selector(el),
      path: nodePath(node, el),
      offset: Number(offset) || 0,
    };
  }

  function textSelectionContext(selection) {
    if (!selection || selection.rangeCount === 0) return null;

    const range = selection.getRangeAt(0);
    const text = selection.toString().trim().replace(/\s+/g, " ");
    if (range.collapsed || !text) return null;

    const ancestor = closestElement(range.commonAncestorContainer);
    if (isLavishUi(ancestor) || isLavishAction(ancestor) || isInteractiveControl(ancestor)) return null;

    const commonAncestorSelector = selector(ancestor);
    const target = {
      type: "text-range",
      text,
      selector: commonAncestorSelector,
      commonAncestorSelector,
      start: rangeBoundary(range.startContainer, range.startOffset),
      end: rangeBoundary(range.endContainer, range.endOffset),
    };

    return {
      uid: "",
      selector: commonAncestorSelector,
      tag: "text",
      text: text.slice(0, 240),
      target,
      element: ancestor,
      range: range.cloneRange(),
    };
  }

  function isLavishUi(el) {
    return !!(el && el.closest && el.closest("[data-lavish-ui]"));
  }

  function isLavishAction(el) {
    return !!(el && el.closest && el.closest("[data-lavish-action]"));
  }

  // Native interactive controls (radios, checkboxes, inputs, selects, buttons,
  // labels, disclosure summaries, editable regions) should toggle/focus/type
  // natively instead of triggering annotation, just like elements marked with
  // data-lavish-action.
  function isInteractiveControl(el) {
    return isNativeInteractive(el);
  }

  function highlightElement(el) {
    if (!el) return;
    el.style.outline = "var(--lavish-annotate-outline,2px solid #f4c95d)";
    el.style.outlineOffset = "var(--lavish-annotate-offset,2px)";
  }

  function clearHighlight(el) {
    if (el) el.style.outline = "";
  }

  function clearTextHighlight() {
    if (!shadow) return;
    for (const el of [...shadow.querySelectorAll(".lavish-text-highlight")]) el.remove();
  }

  function highlightTextRange(range) {
    clearTextHighlight();
    const root = ensureShadow();
    for (const rect of [...range.getClientRects()]) {
      if (rect.width <= 0 || rect.height <= 0) continue;
      const mark = document.createElement("div");
      mark.className = "lavish-text-highlight";
      mark.style.left = rect.left + "px";
      mark.style.top = rect.top + "px";
      mark.style.width = rect.width + "px";
      mark.style.height = rect.height + "px";
      root.appendChild(mark);
    }
  }

  function setAnnotationMode(enabled) {
    annotationMode = !!enabled;
    let style = document.getElementById("lavish-cursor-style");
    if (annotationMode && !style) {
      style = document.createElement("style");
      style.id = "lavish-cursor-style";
      style.textContent =
        ":root{--lavish-accent:#f4c95d;--lavish-annotate-outline:2px solid var(--lavish-accent);--lavish-annotate-offset:2px}*{cursor:default!important}[data-lavish-action],[data-lavish-action] *{cursor:pointer!important}input,textarea,[contenteditable]:not([contenteditable='false']){cursor:text!important}button,select,label,option,input[type='button'],input[type='submit'],input[type='reset'],input[type='checkbox'],input[type='radio'],input[type='file'],input[type='color'],input[type='range'],input[type='image']{cursor:pointer!important}";
      document.head.appendChild(style);
    }
    if (!annotationMode && style) style.remove();
    if (!annotationMode) closeCard();

    // Freeze Mermaid pan/zoom while annotating so nodes sit at stable screen
    // positions and a click resolves cleanly to one node instead of panning.
    setMermaidFrozen(annotationMode);
  }

  function queuePrompt(prompt, options = {}) {
    const originElement = options.element || document.activeElement || document.body;
    /** @type {{ uid: string, prompt: string, selector: string, tag: string, text: string, target?: unknown, _lavishQueueKey?: string }} */
    const item = {
      ...context(originElement),
      prompt: String(prompt || ""),
    };
    const queueKey = typeof deriveQueueKey === "function" ? deriveQueueKey(originElement, options) : "";
    if (queueKey) item._lavishQueueKey = String(queueKey);

    if (options.uid) item.uid = String(options.uid);
    if (options.selector) item.selector = String(options.selector);
    if (options.tag) item.tag = String(options.tag);
    if (options.text) item.text = String(options.text);
    if (options.target) item.target = options.target;
    if (options.data) item.prompt += "\n\nContext data:\n" + JSON.stringify(options.data, null, 2);

    parent.postMessage({ type: "lavish:queuePrompt", prompt: item }, "*");
  }

  function sendQueuedPrompts() {
    parent.postMessage({ type: "lavish:sendQueuedPrompts" }, "*");
  }

  function endSession() {
    parent.postMessage({ type: "lavish:endSession" }, "*");
  }

  function snapshot() {
    const lines = [];

    function walk(el, depth) {
      if (!(el instanceof Element) || depth > 6 || isLavishUi(el)) return;

      const c = context(el);
      const name = c.text ? ' "' + c.text.slice(0, 80).replace(/"/g, "'") + '"' : "";
      lines.push("  ".repeat(depth) + "uid=" + c.uid + " " + c.tag + name);
      for (const child of el.children) walk(child, depth + 1);
    }

    walk(document.body, 0);
    return lines.join("\n");
  }

  const layoutAuditOverflowEpsilon = 1;
  const layoutAuditErrorOverflowPx = 4;
  const layoutAuditSettleMs = 180;
  const layoutAuditMaxWaitMs = 2000;
  let layoutAuditTimer = 0;
  let layoutAuditRun = 0;
  let lastLayoutAuditSignature = null;

  function toPixelNumber(value) {
    const parsed = Number.parseFloat(String(value || "0"));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function roundedOverflowPx(value) {
    return Math.round(Math.max(0, value) * 10) / 10;
  }

  function overflowSeverity(overflowPx) {
    return overflowPx > layoutAuditErrorOverflowPx ? "error" : "warning";
  }

  function elementText(el) {
    return String(el?.innerText || el?.textContent || "")
      .trim()
      .replace(/\s+/g, " ");
  }

  function hasReadableText(el) {
    return elementText(el).length > 0;
  }

  function rectArea(rect) {
    return Math.max(0, rect.width) * Math.max(0, rect.height);
  }

  function isVisibleForLayoutAudit(el, rect = el.getBoundingClientRect()) {
    if (!el || isLavishUi(el) || rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  }

  function isIntentionalHorizontalScroller(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    const overflowX = getComputedStyle(el).overflowX;
    return overflowX === "auto" || overflowX === "scroll";
  }

  function hasIntentionalHorizontalScrollerAncestor(el) {
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement) {
      if (isIntentionalHorizontalScroller(node)) return true;
      node = node.parentElement;
    }
    return false;
  }

  function contentBoxRect(el) {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const borderLeft = toPixelNumber(style.borderLeftWidth);
    const borderRight = toPixelNumber(style.borderRightWidth);
    const borderTop = toPixelNumber(style.borderTopWidth);
    const borderBottom = toPixelNumber(style.borderBottomWidth);
    const paddingLeft = toPixelNumber(style.paddingLeft);
    const paddingRight = toPixelNumber(style.paddingRight);
    const paddingTop = toPixelNumber(style.paddingTop);
    const paddingBottom = toPixelNumber(style.paddingBottom);
    return {
      left: rect.left + borderLeft + paddingLeft,
      right: rect.right - borderRight - paddingRight,
      top: rect.top + borderTop + paddingTop,
      bottom: rect.bottom - borderBottom - paddingBottom,
    };
  }

  function paddingBoxRect(el) {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return {
      top: rect.top + toPixelNumber(style.borderTopWidth),
      bottom: rect.bottom - toPixelNumber(style.borderBottomWidth),
    };
  }

  function elementTextFragments(el) {
    const fragments = [];
    const walker = document.createTreeWalker(el, 4);
    let textNode = walker.nextNode();
    while (textNode) {
      if (String(textNode.textContent || "").trim()) {
        const range = document.createRange();
        range.selectNodeContents(textNode);
        fragments.push(...range.getClientRects());
        range.detach?.();
      }
      textNode = walker.nextNode();
    }
    return fragments;
  }

  function renderedTextLineCount(fragments) {
    const lineTops = [];
    for (const fragment of fragments) {
      const top = Number(fragment.top);
      if (Number.isFinite(top) && !lineTops.some((lineTop) => Math.abs(lineTop - top) <= 1)) lineTops.push(top);
    }
    return lineTops.length;
  }

  function collectLayoutAuditElements() {
    const elements = [];

    function walk(el) {
      if (!(el instanceof Element) || isLavishUi(el)) return;
      if (isIntentionalHorizontalScroller(el)) return;
      elements.push(el);
      for (const child of el.children) walk(child);
    }

    if (document.body) walk(document.body);
    return elements;
  }

  function pushLayoutFinding(findings, seen, finding) {
    const selectorValue = finding.selector || "";
    const key = `${finding.kind}:${selectorValue}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({
      selector: selectorValue,
      kind: String(finding.kind || "layout-warning"),
      overflowPx: roundedOverflowPx(finding.overflowPx),
      viewportWidth: Math.round(Number(finding.viewportWidth) || window.innerWidth || 0),
      severity: finding.severity === "warning" ? "warning" : "error",
    });
  }

  function isIntentionalTextTruncation(style) {
    return style.textOverflow === "ellipsis" || Number.parseInt(style.webkitLineClamp || "0", 10) > 0;
  }

  function auditElementOverflow(el, viewportWidth, findings, seen, spillCandidates) {
    if (el === document.body || el === document.documentElement || hasIntentionalHorizontalScrollerAncestor(el)) return;

    const rect = el.getBoundingClientRect();
    if (!isVisibleForLayoutAudit(el, rect)) return;

    const style = getComputedStyle(el);
    const hasText = hasReadableText(el);
    const isTruncated = isIntentionalTextTruncation(style);

    const horizontal = classifyHorizontalOverflow({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      overflowX: style.overflowX,
      hasText,
      isTruncated,
      epsilon: layoutAuditOverflowEpsilon,
    });
    if (horizontal) {
      pushLayoutFinding(findings, seen, {
        selector: selector(el),
        kind: horizontal.kind,
        overflowPx: horizontal.overflowPx,
        viewportWidth,
        severity: horizontal.kind === "clipped-text" ? "error" : overflowSeverity(horizontal.overflowPx),
      });
    }

    const verticallyScrollable = style.overflowY === "auto" || style.overflowY === "scroll";
    const needsVerticalTextCheck =
      hasText &&
      !isTruncated &&
      !verticallyScrollable &&
      el.clientHeight > 0 &&
      el.scrollHeight - el.clientHeight > layoutAuditOverflowEpsilon;
    const textFragments = needsVerticalTextCheck ? elementTextFragments(el) : [];
    const vertical = classifyVerticalOverflow({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      overflowY: style.overflowY,
      hasText,
      isTruncated,
      textOverflowPx: textFragments.length ? verticalFragmentOverflow(textFragments, paddingBoxRect(el)) : undefined,
      textLineCount: renderedTextLineCount(textFragments),
      epsilon: layoutAuditOverflowEpsilon,
    });
    if (vertical) {
      if (vertical.clips) {
        pushLayoutFinding(findings, seen, {
          selector: selector(el),
          kind: vertical.kind,
          overflowPx: vertical.overflowPx,
          viewportWidth,
          severity: "error",
        });
      } else {
        spillCandidates.push({
          el,
          selector: selector(el),
          overflowPx: vertical.overflowPx,
          viewportWidth,
          spillBottom: rect.bottom + vertical.overflowPx,
        });
      }
    }

    const parent = el.parentElement;
    if (!parent || parent === document.body || parent === document.documentElement) return;
    if (hasIntentionalHorizontalScrollerAncestor(parent)) return;

    const parentBox = contentBoxRect(parent);
    const parentOverflowPx = rect.right - parentBox.right;
    const parentFinding = classifyParentOverflow({
      overhangPx: parentOverflowPx,
      scrollWidth: parent.scrollWidth,
      clientWidth: parent.clientWidth,
      epsilon: layoutAuditOverflowEpsilon,
    });
    if (parentFinding && rectArea(rect) > 1) {
      pushLayoutFinding(findings, seen, {
        selector: selector(el),
        kind: parentFinding.kind,
        overflowPx: parentFinding.overflowPx,
        viewportWidth,
        severity: parentFinding.severity,
      });
    }
  }

  function resolveSpillCandidates(spillCandidates, findings, seen) {
    for (const candidate of resolveVisibleSpillCandidates(spillCandidates, { epsilon: layoutAuditOverflowEpsilon })) {
      pushLayoutFinding(findings, seen, {
        selector: candidate.selector,
        kind: "clipped-text",
        overflowPx: candidate.overflowPx,
        viewportWidth: candidate.viewportWidth,
        severity: "error",
      });
    }
  }

  // getClientRects() returns one rect per rendered line fragment; falls back to the bounding
  // rect for elements the browser doesn't fragment (e.g. replaced elements).
  function elementLineFragments(el) {
    const rects = [...el.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    if (rects.length) return rects;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? [rect] : [];
  }

  function auditOverlappingText(elements, viewportWidth, findings, seen) {
    const candidates = elements
      .filter((el) => el.children.length === 0 && hasReadableText(el))
      .filter((el) => isVisibleForLayoutAudit(el))
      .filter((el) => getComputedStyle(el).position === "static")
      .slice(0, 200);

    for (const el of candidates) {
      const fragments = elementLineFragments(el);
      let flagged = false;

      for (const rect of fragments) {
        if (flagged) break;
        if (rectArea(rect) < 16) continue;
        const points = [
          { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
          { x: rect.left + Math.min(4, rect.width / 2), y: rect.top + Math.min(4, rect.height / 2) },
          { x: rect.right - Math.min(4, rect.width / 2), y: rect.bottom - Math.min(4, rect.height / 2) },
        ];
        for (const point of points) {
          if (point.x < 0 || point.y < 0 || point.x > viewportWidth || point.y > window.innerHeight) continue;
          const top = document.elementFromPoint(point.x, point.y);
          if (!(top instanceof Element) || top === el || el.contains(top) || top.contains(el) || isLavishUi(top))
            continue;
          if (hasIntentionalHorizontalScrollerAncestor(top)) continue;
          if (getComputedStyle(top).position !== "static") continue;
          if (!fragmentsSignificantlyOverlap([rect], elementLineFragments(top))) continue;
          pushLayoutFinding(findings, seen, {
            selector: selector(el),
            kind: "overlapping-text",
            overflowPx: 0,
            viewportWidth,
            // Heuristic and sampling-based even after fragment-aware matching, so it stays a
            // warning rather than holding the open-time gate the way a real clip/overflow does.
            severity: "warning",
          });
          flagged = true;
          break;
        }
      }
    }
  }

  function auditLayout() {
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const findings = [];
    const seen = new Set();
    const pageOverflowPx = document.documentElement.scrollWidth - viewportWidth;
    if (pageOverflowPx > layoutAuditOverflowEpsilon) {
      pushLayoutFinding(findings, seen, {
        selector: "html",
        kind: "page-horizontal-overflow",
        overflowPx: pageOverflowPx,
        viewportWidth,
        severity: overflowSeverity(pageOverflowPx),
      });
    }

    const elements = collectLayoutAuditElements();
    const spillCandidates = [];
    for (const el of elements) auditElementOverflow(el, viewportWidth, findings, seen, spillCandidates);
    resolveSpillCandidates(spillCandidates, findings, seen);
    auditOverlappingText(elements, viewportWidth, findings, seen);
    return findings;
  }

  function waitForDocumentFontsReady() {
    try {
      if (document.fonts?.ready) return document.fonts.ready.catch(() => {});
    } catch {
      // Ignore font readiness failures. The ResizeObserver settle below is still a safety net.
    }
    return Promise.resolve();
  }

  function waitForAnimationFrames(count) {
    return new Promise((resolve) => {
      function step(remaining) {
        if (remaining <= 0) {
          resolve();
          return;
        }
        const next = () => step(remaining - 1);
        if (window.requestAnimationFrame) {
          window.requestAnimationFrame(next);
        } else {
          window.setTimeout(next, 16);
        }
      }
      step(count);
    });
  }

  function waitForResizeObserverSettle() {
    return new Promise((resolve) => {
      let observer = null;
      let settleTimer = 0;
      let maxTimer = 0;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (settleTimer) window.clearTimeout(settleTimer);
        if (maxTimer) window.clearTimeout(maxTimer);
        if (observer) observer.disconnect();
        resolve();
      };
      const scheduleFinish = () => {
        if (settleTimer) window.clearTimeout(settleTimer);
        settleTimer = window.setTimeout(finish, layoutAuditSettleMs);
      };

      if (typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(scheduleFinish);
        const observed = [document.documentElement, document.body, ...[...(document.body?.querySelectorAll("*") || [])]]
          .filter(Boolean)
          .slice(0, 800);
        for (const el of observed) observer.observe(el);
      }

      scheduleFinish();
      maxTimer = window.setTimeout(finish, layoutAuditMaxWaitMs);
    });
  }

  async function runLayoutAudit(runId) {
    await waitForDocumentFontsReady();
    await waitForResizeObserverSettle();
    await waitForAnimationFrames(2);
    if (runId !== layoutAuditRun) return;
    const layout_warnings = auditLayout();
    const signature = JSON.stringify(layout_warnings);
    if (signature === lastLayoutAuditSignature) return;
    lastLayoutAuditSignature = signature;
    parent.postMessage({ type: "lavish:layoutWarnings", layout_warnings }, "*");
  }

  function scheduleLayoutAudit() {
    if (layoutAuditTimer) window.clearTimeout(layoutAuditTimer);
    const runId = ++layoutAuditRun;
    layoutAuditTimer = window.setTimeout(() => {
      runLayoutAudit(runId).catch(() => {});
    }, 50);
  }

  function startLayoutAudit() {
    scheduleLayoutAudit();
    window.addEventListener("load", scheduleLayoutAudit, { once: true });
    window.addEventListener("resize", scheduleLayoutAudit, { passive: true });
  }

  function ensureShadow() {
    if (shadow) return shadow;

    const host = document.createElement("div");
    host.className = "lavish-annotation-root";
    host.setAttribute("data-lavish-ui", "annotation-root");
    document.documentElement.appendChild(host);

    shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `:host{all:initial;position:fixed;z-index:2147483647;left:0;top:0;color-scheme:dark;--ink-900:#0f1115;--ink-800:#11141a;--ink-700:#171a21;--ink-600:#1c212b;--steel-700:#2a2f3a;--steel-600:#303745;--steel-500:#3c4557;--steel-400:#8c96aa;--steel-300:#aeb6c6;--steel-200:#b9c0cf;--steel-100:#d8deea;--cream-50:#fffbf3;--cream-100:#f7f3ea;--cream-200:#e8e1cf;--brass-500:#f4c95d;--brass-400:#ffd877;--brass-ink:#17130a;--bg:var(--ink-900);--bg-panel:var(--ink-800);--bg-elevated:var(--ink-600);--fg:var(--cream-100);--fg-faint:var(--steel-300);--border:var(--steel-600);--accent:#f4c95d;--accent-hover:#ffd877;--font-sans:Geist,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;--font-mono:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--radius-md:10px;--radius-xl:14px;--shadow-floating:0 20px 70px rgba(0,0,0,.35);font-family:var(--font-sans)}*{box-sizing:border-box}:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.lavish-text-highlight{position:fixed;pointer-events:none;background:rgba(244,201,93,.28);border-radius:2px;box-shadow:0 0 0 1px rgba(244,201,93,.45)}.lavish-annotation-card{position:fixed;width:min(320px,calc(100vw - 24px));padding:12px;border-radius:var(--radius-xl);background:var(--bg-panel);color:var(--fg);border:1px solid var(--accent);box-shadow:var(--shadow-floating);font:14px/1.4 var(--font-sans)}.lavish-heading{font-weight:700;margin-bottom:6px}.lavish-annotation-card textarea{width:100%;min-height:86px;resize:vertical;border-radius:var(--radius-md);border:1px solid var(--border);background:var(--bg);color:var(--fg);padding:9px;font:inherit;font-family:var(--font-sans)}.lavish-annotation-card textarea::placeholder{color:var(--fg-faint)}.lavish-annotation-card .lavish-hint{margin-top:6px;font-size:11px;color:var(--fg-faint)}.lavish-annotation-card .lavish-row{display:flex;gap:8px;justify-content:flex-end;margin-top:8px}.lavish-annotation-card button{border:0;border-radius:var(--radius-md);padding:8px 10px;font-family:var(--font-sans);font-size:13px;font-weight:700;cursor:pointer}.lavish-annotation-card button:active{opacity:.85}.lavish-annotation-card .lavish-send{background:var(--accent);color:var(--brass-ink)}.lavish-annotation-card .lavish-send:hover{background:var(--accent-hover)}.lavish-annotation-card .lavish-cancel{background:var(--steel-700);color:var(--fg)}`;
    shadow.appendChild(style);
    return shadow;
  }

  function closeCard() {
    if (shadow) {
      for (const el of [...shadow.querySelectorAll(".lavish-annotation-card")]) el.remove();
    }
    clearHighlight(hovered);
    clearHighlight(selected);
    hovered = null;
    clearTextHighlight();
    selected = null;
  }

  function showAnnotationCard(target, options = {}) {
    const root = ensureShadow();
    closeCard();

    const c = options.context || context(target);
    let anchor = target;
    if (options.range) {
      highlightTextRange(options.range);
    } else {
      anchor = annotationTargetEl(target);
      selected = anchor;
      highlightElement(selected);
    }

    const rect = options.range ? options.range.getBoundingClientRect() : anchor.getBoundingClientRect();
    const card = document.createElement("div");
    card.className = "lavish-annotation-card";
    const nodeLabel = c.tag === "mermaid-node" ? c.target?.label || c.text || "" : "";
    const heading =
      c.tag === "text"
        ? "Annotate text"
        : c.tag === "mermaid-node"
          ? "Annotate node" + (nodeLabel ? ": " + escapeAnnotationText(nodeLabel) : "")
          : "Annotate &lt;" + c.tag + "&gt;";
    const placeholder =
      c.tag === "text"
        ? "Tell the agent what to change about this text..."
        : c.tag === "mermaid-node"
          ? "Tell the agent what to change about this diagram node..."
          : "Tell the agent what to change about this element...";
    card.innerHTML =
      '<div class="lavish-heading">' +
      heading +
      '</div><textarea placeholder="' +
      placeholder +
      '"></textarea><div class="lavish-hint">Enter to queue &middot; ' +
      (/Mac|iP(hone|ad|od)/.test(navigator.platform) ? "⌘" : "Ctrl") +
      '+Enter to send now</div><div class="lavish-row"><button class="lavish-cancel" type="button">Cancel</button><button class="lavish-send" type="button">Queue</button></div>';
    root.appendChild(card);

    const left = Math.min(Math.max(12, rect.left), window.innerWidth - card.offsetWidth - 12);
    const top = Math.min(Math.max(12, rect.bottom + 8), window.innerHeight - card.offsetHeight - 12);
    card.style.left = left + "px";
    card.style.top = top + "px";

    const textarea = /** @type {HTMLTextAreaElement | null} */ (card.querySelector("textarea"));
    const cancelButton = /** @type {HTMLButtonElement | null} */ (card.querySelector(".lavish-cancel"));
    const sendButton = /** @type {HTMLButtonElement | null} */ (card.querySelector(".lavish-send"));
    if (!textarea || !cancelButton || !sendButton) return;

    cancelButton.onclick = closeCard;
    sendButton.onclick = () => {
      const prompt = textarea.value.trim();
      if (prompt) queuePrompt(prompt, { ...c, queueKey: "" });
      closeCard();
    };
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        const sendNow = (event.ctrlKey || event.metaKey) && !!textarea.value.trim();
        sendButton.click();
        // postMessage delivery is ordered, so the queued prompt lands before the send.
        if (sendNow) sendQueuedPrompts();
      }
    });
    setTimeout(() => textarea.focus(), 0);
  }

  /** @type {Window & { lavish?: unknown }} */ (window).lavish = {
    queuePrompt,
    sendQueuedPrompts,
    endSession,
    getQueuedPrompts: () => [],
    setStatus: (message) => parent.postMessage({ type: "lavish:status", message: String(message) }, "*"),
    snapshot,
  };

  window.addEventListener("message", (event) => {
    const msg = event.data || {};
    if (msg.type === "lavish:setAnnotationMode") setAnnotationMode(msg.enabled);
    if (msg.type === "lavish:requestSnapshot") {
      parent.postMessage({ type: "lavish:snapshot", snapshot: snapshot() }, "*");
    }
    if (msg.type === "lavish:restoreScroll") {
      window.scrollTo(Number(msg.x) || 0, Number(msg.y) || 0);
    }
  });

  // Capture phase so the mode hotkey fires no matter where focus is inside the artifact -
  // including a checkbox, button, link, or the annotation-card textarea - without disturbing
  // normal typing. This SDK doesn't own the mode state; it asks the chrome to toggle the same
  // state the on-screen switch drives, via the same postMessage protocol as setAnnotationMode.
  document.addEventListener(
    "keydown",
    (event) => {
      if (!isModeToggleHotkeyEvent(event)) return;
      event.preventDefault();
      parent.postMessage({ type: "lavish:toggleAnnotationMode" }, "*");
    },
    true,
  );

  // Report scroll position to the chrome so it can be restored across hot reloads.
  // The iframe is sandboxed without same-origin, so the chrome can't read scrollY directly.
  let scrollFrame = 0;
  window.addEventListener(
    "scroll",
    () => {
      if (scrollFrame) return;
      scrollFrame = window.requestAnimationFrame(() => {
        scrollFrame = 0;
        parent.postMessage({ type: "lavish:scroll", x: window.scrollX, y: window.scrollY }, "*");
      });
    },
    { passive: true },
  );

  document.addEventListener(
    "mouseover",
    (event) => {
      if (
        !annotationMode ||
        isLavishUi(event.target) ||
        isLavishAction(event.target) ||
        isInteractiveControl(event.target)
      )
        return;
      const target = annotationTargetEl(event.target);
      if (target === selected) return;
      if (hovered && hovered !== selected) clearHighlight(hovered);
      hovered = target;
      highlightElement(hovered);
    },
    true,
  );

  document.addEventListener(
    "mouseout",
    () => {
      if (hovered && hovered !== selected) {
        clearHighlight(hovered);
        hovered = null;
      }
    },
    true,
  );

  document.addEventListener(
    "mouseup",
    (event) => {
      if (
        !annotationMode ||
        isLavishUi(event.target) ||
        isLavishAction(event.target) ||
        isInteractiveControl(event.target)
      )
        return;

      const c = textSelectionContext(document.getSelection());
      if (!c) return;

      ignoreNextClick = true;
      showAnnotationCard(c.element, { context: c, range: c.range });
    },
    true,
  );

  document.addEventListener(
    "click",
    (event) => {
      if (
        !annotationMode ||
        isLavishUi(event.target) ||
        isLavishAction(event.target) ||
        isInteractiveControl(event.target)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (ignoreNextClick) {
        ignoreNextClick = false;
        return;
      }
      showAnnotationCard(event.target);
    },
    true,
  );

  setAnnotationMode(annotationMode);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startLayoutAudit, { once: true });
  } else {
    startLayoutAudit();
  }

  // Mermaid renders asynchronously (and can re-render on theme/resize), so we
  // enhance on load, again shortly after, and whenever the DOM adds new SVGs.
  enhanceMermaid();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", enhanceMermaid, { once: true });
  }
  const mermaidObserver = new MutationObserver(() => scheduleMermaidEnhance());
  mermaidObserver.observe(document.documentElement, { childList: true, subtree: true });
}
