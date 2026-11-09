/* global CSS, Element, MutationObserver, NodeFilter, Range, ResizeObserver, document, getComputedStyle, parent, window */

import { readArtifactRevisions } from "./artifact-revisions.js";
import * as mermaidHelpers from "./mermaid-node.js";
import { tableCellTarget } from "./table-cell.js";

export const LAVISH_INTERNAL_QUEUE_KEY = "_lavishQueueKey";

export const MODE_TOGGLE_HOTKEY_KEY = "i";

export function isModeToggleHotkeyEvent(event) {
  if (event.shiftKey || event.altKey) return false;
  return Boolean(event.metaKey || event.ctrlKey) && String(event.key || "").toLowerCase() === MODE_TOGGLE_HOTKEY_KEY;
}

export function reviewShortcutAction(event) {
  if (event.defaultPrevented || event.isComposing || event.repeat || event.ctrlKey || event.metaKey || event.altKey)
    return "";
  const editable = "input,textarea,select,[contenteditable]:not([contenteditable='false'])";
  const path = typeof event.composedPath === "function" ? event.composedPath() : [event.target];
  if (path.some((node) => node?.matches?.(editable) || node?.closest?.(editable))) return "";
  const key = String(event.key || "").toLowerCase();
  if (key === "delete" || key === "backspace") return "delete-mark";
  if (key === "d") return event.shiftKey ? "done-parent" : "done";
  if (event.shiftKey) return "";
  if (key === "m") return "mark";
  if (key === "c") return "comment";
  return "";
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
  if (!el || !el.closest) return false;
  if (
    el.closest(
      "button,input,select,textarea,option,optgroup,label,summary,[contenteditable]:not([contenteditable='false'])",
    )
  ) {
    return true;
  }
  const widget = el.closest(
    "[role='button'],[role='checkbox'],[role='combobox'],[role='menuitem'],[role='menuitemcheckbox']," +
      "[role='menuitemradio'],[role='option'],[role='radio'],[role='switch'],[role='tab'],[role='treeitem']",
  );
  if (!widget) return false;
  const link = el.closest("a[href]");
  return !(link && widget.contains(link));
}

// A severe text failure needs rendered-fragment proof. Scroll dimensions include harmless font
// ink, masks, transforms, and offscreen carousel content, so they are never sufficient. A line is
// severe only when a material portion of a real text fragment crosses its own clipping boundary,
// or a wrapped line spills substantially outside its own visible box. Explicit truncation and
// standard accessibility hiding are author intent and stay silent.
export function classifySevereTextOverflow({
  fragments,
  box,
  overflowX,
  overflowY,
  isTruncated = false,
  isVisuallyHidden = false,
  minOutsideRatio = 0.2,
  epsilon = 1,
}) {
  function overflowOf(fragment, boundary, axis) {
    const start = Number(axis === "horizontal" ? fragment.left : fragment.top);
    const end = Number(axis === "horizontal" ? fragment.right : fragment.bottom);
    const boxStart = Number(axis === "horizontal" ? boundary.left : boundary.top);
    const boxEnd = Number(axis === "horizontal" ? boundary.right : boundary.bottom);
    const explicitSize = Number(axis === "horizontal" ? fragment.width : fragment.height);
    const size = Number.isFinite(explicitSize) ? Math.max(0, explicitSize) : Math.max(0, end - start);
    if (![start, end, boxStart, boxEnd, size].every(Number.isFinite) || size <= 0) {
      return { overflowPx: 0, outsideRatio: 0, centerOutside: false };
    }
    const before = Math.max(0, boxStart - start);
    const after = Math.max(0, end - boxEnd);
    const center = start + size / 2;
    return {
      overflowPx: Math.max(before, after),
      outsideRatio: Math.min(1, (before + after) / size),
      centerOutside: center < boxStart || center > boxEnd,
    };
  }

  if (isTruncated || isVisuallyHidden || !box || !Array.isArray(fragments) || fragments.length === 0) return null;

  const clipsX = overflowX === "hidden" || overflowX === "clip";
  const clipsY = overflowY === "hidden" || overflowY === "clip";
  const spillsY = overflowY === "visible";
  const scrollsX = overflowX === "auto" || overflowX === "scroll";
  const scrollsY = overflowY === "auto" || overflowY === "scroll";
  let strongest = null;

  for (const fragment of fragments) {
    const horizontal = overflowOf(fragment, box, "horizontal");
    const vertical = overflowOf(fragment, box, "vertical");
    const severeX =
      clipsX &&
      !scrollsX &&
      horizontal.overflowPx > epsilon &&
      (horizontal.centerOutside || horizontal.outsideRatio >= minOutsideRatio);
    const severeY = (clipsY || spillsY) && !scrollsY && vertical.overflowPx > epsilon && vertical.centerOutside;
    const candidates = [
      severeX ? { axis: "horizontal", kind: "clipped-text", overflowPx: horizontal.overflowPx } : null,
      severeY ? { axis: "vertical", kind: "clipped-text", overflowPx: vertical.overflowPx } : null,
    ];
    for (const candidate of candidates) {
      if (candidate && (!strongest || candidate.overflowPx > strongest.overflowPx)) strongest = candidate;
    }
  }

  return strongest;
}

export function classifyMaterialRectEscape({
  rect,
  boundary,
  axes = ["horizontal", "vertical"],
  minOutsidePx = 4,
  minOutsideRatio = 0.2,
}) {
  let strongest = null;
  for (const axis of axes) {
    const start = Number(axis === "horizontal" ? rect?.left : rect?.top);
    const end = Number(axis === "horizontal" ? rect?.right : rect?.bottom);
    const boundaryStart = Number(axis === "horizontal" ? boundary?.left : boundary?.top);
    const boundaryEnd = Number(axis === "horizontal" ? boundary?.right : boundary?.bottom);
    const explicitSize = Number(axis === "horizontal" ? rect?.width : rect?.height);
    const size = Number.isFinite(explicitSize) ? Math.max(0, explicitSize) : Math.max(0, end - start);
    if (![start, end, boundaryStart, boundaryEnd, size].every(Number.isFinite) || size <= 0) continue;
    const before = Math.max(0, boundaryStart - start);
    const after = Math.max(0, end - boundaryEnd);
    const outsidePx = Math.max(before, after);
    const outsideRatio = Math.min(1, (before + after) / size);
    const center = start + size / 2;
    const centerOutside = center < boundaryStart || center > boundaryEnd;
    if (outsidePx < minOutsidePx || (!centerOutside && outsideRatio < minOutsideRatio)) continue;
    const candidate = {
      axis,
      side: before >= after ? "start" : "end",
      overflowPx: outsidePx,
    };
    if (!strongest || candidate.overflowPx > strongest.overflowPx) strongest = candidate;
  }
  return strongest;
}

// Tiny document deltas are cosmetic. A page failure becomes reportable only when meaningful
// content materially escapes the usable viewport; callers establish that content evidence from
// actual visible element bounds.
export function isMaterialPageOverflow({ overflowPx, viewportWidth, hasEscapedContent }) {
  const overflow = Number(overflowPx);
  const width = Number(viewportWidth);
  const materialThreshold = Math.max(24, Number.isFinite(width) ? width * 0.05 : 24);
  return Boolean(hasEscapedContent) && Number.isFinite(overflow) && overflow >= materialThreshold;
}

export function findStableLayoutFindings(first, second) {
  const key = (finding) => `${finding.kind}:${finding.selector}:${finding.axis || ""}`;
  const firstKeys = new Set(
    (Array.isArray(first) ? first : []).filter((finding) => finding?.severity === "error").map(key),
  );
  return (Array.isArray(second) ? second : []).filter(
    (finding) => finding?.severity === "error" && firstKeys.has(key(finding)),
  );
}

export function isNearTotalOcclusion({ occludedSamples, totalSamples, minSamples = 5, minRatio = 0.9 }) {
  const occluded = Number(occludedSamples);
  const total = Number(totalSamples);
  return Number.isFinite(occluded) && Number.isFinite(total) && total >= minSamples && occluded / total >= minRatio;
}

/**
 * Whether a picked/dropped/pasted file is within the client-side byte limit, and
 * the message to show if not. Returns "" when the file is acceptable.
 *
 * @param {number} size the file's byte length (`File.size`)
 * @param {number} maxBytes the limit; <= 0 or non-finite means "no client limit"
 * @returns {string} "" if acceptable, else a human-readable error
 */
export function attachmentSizeError(size, maxBytes) {
  const cap = Number(maxBytes);
  if (!Number.isFinite(cap) || cap <= 0) return "";
  const n = Number(size);
  if (!Number.isFinite(n) || n <= cap) return "";
  // Inlined formatter: a serialized SDK helper may reference only its own args and
  // browser globals, never a non-exported sibling.
  const limit = cap >= 1024 * 1024 ? Math.round(cap / (1024 * 1024)) + " MB" : Math.round(cap / 1024) + " KB";
  return "Image is larger than the " + limit + " limit";
}

/**
 * Decide the fate of a whole batch of picked/dropped files in ONE pass, so the card
 * can apply them and render once instead of re-rendering the entire chip DOM per file
 * (O(N²) on a large multi-drop, D7). Each decision is `skip` (wrong mime), `error`
 * (over the size limit, with the message), `cap` (would exceed the per-prompt count),
 * or `accept` (carry the file forward to upload). The count cap is honored ACROSS the
 * batch, not reset per file.
 *
 * @param {ArrayLike<any>} files
 * @param {{ currentCount?: number, maxCount?: number, maxBytes?: number, accepted?: Record<string, boolean> }} options
 * @returns {Array<{ kind: string, file?: any, error?: string }>}
 */
export function classifyAttachmentBatch(files, options = {}) {
  const { currentCount = 0, maxCount = Infinity, maxBytes = 0, accepted = {} } = options;
  const decisions = [];
  let count = currentCount;
  for (const file of Array.from(files || [])) {
    if (!file || !accepted[file.type]) {
      decisions.push({ kind: "skip" });
      continue;
    }
    const error = attachmentSizeError(file.size, maxBytes);
    if (error) {
      decisions.push({ kind: "error", error });
      continue;
    }
    if (count >= maxCount) {
      decisions.push({ kind: "cap" });
      continue;
    }
    count += 1;
    decisions.push({ kind: "accept", file });
  }
  return decisions;
}

/**
 * Split a drop/paste into the images the card can attach and the names of the
 * files it cannot.
 *
 * Both halves are always reported. A mixed drop (a screenshot alongside a PDF)
 * used to accept the images and say nothing about the rest, because the
 * unsupported branch only ran when NO image was found - so the companion files
 * vanished with no feedback. The card attaches what it can and raises a visible
 * error chip for each file it cannot, rather than silently dropping either half.
 *
 * @param {{ files?: ArrayLike<any>, items?: ArrayLike<any> }|null|undefined} dataTransfer
 * @param {Record<string, boolean>} acceptedMime
 * @returns {{ images: any[], unsupported: string[] }}
 */
export function partitionDroppedFiles(dataTransfer, acceptedMime) {
  const accepted = acceptedMime || {};
  const images = [];
  const unsupported = [];
  if (!dataTransfer) return { images, unsupported };
  const files = Array.from(dataTransfer.files || []).filter(Boolean);
  for (const file of files) {
    if (accepted[file.type]) images.push(file);
    else unsupported.push(file.name || "file");
  }
  if (!files.length) {
    // Pasted screenshots arrive as items, not files, in some browsers.
    for (const item of Array.from(dataTransfer.items || [])) {
      if (!item || item.kind !== "file") continue;
      if (accepted[item.type]) {
        const file = item.getAsFile();
        if (file) images.push(file);
      } else {
        unsupported.push("file");
      }
    }
  }
  return { images, unsupported };
}

/**
 * Build the accepted-image lookups the annotation card needs from the server's
 * `ACCEPTED_IMAGE_MIME` list, threaded in by `createSdkJs`.
 *
 * The card's paste/drop filter and its file picker's `accept` attribute both come
 * from the returned value, so no surface can offer a format another one refuses.
 * The literal is only the unwired fallback (a direct `createArtifactSdk` call in a
 * unit test), matching how the count and byte caps behave.
 *
 * @param {string[]|null|undefined} list
 * @returns {{ mimes: string[], accepted: Record<string, boolean>, accept: string }}
 */
export function acceptedImageTypes(list) {
  const named = (Array.isArray(list) ? list : []).map(String).filter(Boolean);
  const mimes = named.length ? named : ["image/png", "image/jpeg", "image/webp"];
  /** @type {Record<string, boolean>} */
  const accepted = {};
  for (const mime of mimes) accepted[mime] = true;
  return { mimes, accepted, accept: mimes.join(",") };
}

/**
 * Split a paste over the annotation textarea into the images it can attach and
 * whether the browser's own text paste must be preserved.
 *
 * A screenshot pasted alone should not also drop its (usually empty or
 * placeholder) text into the textarea, so that paste is consumed. A paste that
 * carries real text alongside an image is a mixed paste: the image attaches AND
 * the text must still land, so the default is left intact.
 *
 * Placeholder text includes the pasted files' own names: Finder/Explorer file
 * copies put the file's name or full path in text/plain, and keeping it would
 * silently paste a filesystem path beside the attached image. Text is kept
 * only when at least one line is not a pasted image's name or path.
 *
 * @param {{ files?: ArrayLike<any>, items?: ArrayLike<any>, getData?: (type: string) => string }|null|undefined} clipboardData
 * @param {Record<string, boolean>} acceptedMime
 * @returns {{ images: any[], keepTextPaste: boolean }}
 */
export function planClipboardPaste(clipboardData, acceptedMime) {
  const { images } = partitionDroppedFiles(clipboardData, acceptedMime);
  const text = clipboardData && clipboardData.getData ? clipboardData.getData("text/plain") : "";
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const names = images.map((file) => String((file && file.name) || "")).filter(Boolean);
  const keepTextPaste =
    lines.length > 0 &&
    !(
      names.length > 0 &&
      lines.every((line) =>
        names.some((name) => line === name || line.endsWith("/" + name) || line.endsWith("\\" + name)),
      )
    );
  return { images, keepTextPaste };
}

/**
 * Decide whether an incoming `lavish:attachmentResult` may be applied to this
 * document's chips. Two independent conditions, both required:
 *
 * 1. It came from the chrome (`event.source === parent`). The SDK's listener is on
 *    `window`, so without this the artifact can post to ITSELF and hand its own
 *    chips any server id - the upload mediation the chrome performs is bypassed.
 * 2. It carries THIS document's upload nonce. Chip ids (`att-1`, `att-2`, ...)
 *    restart on every document load, so a result still in flight across an iframe
 *    reload would otherwise match a brand-new chip by id alone and mark it ready
 *    with the previous document's image. The nonce is minted per document, so a
 *    pre-reload result can never match.
 *
 * The nonce is compared by exact string identity - no coercion, no truthiness -
 * so a hostile `{nonce: true}` or `{nonce: [realNonce]}` cannot pass.
 *
 * @param {{ source?: unknown, data?: { nonce?: unknown } }} event the message event
 * @param {{ parentWindow?: unknown, nonce?: string }} context this document's upload identity
 * @returns {boolean}
 */
export function isTrustedAttachmentResult(event, context = {}) {
  if (!event || !context.parentWindow || event.source !== context.parentWindow) return false;
  const expected = context.nonce;
  if (typeof expected !== "string" || !expected) return false;
  const actual = (event.data || {}).nonce;
  return typeof actual === "string" && actual === expected;
}

/**
 * @param {{ itemCount?: number, maxCount?: number, capRejected?: boolean, queueBlocked?: boolean, hasPending?: boolean, hasErrors?: boolean }} [state]
 * @returns {string}
 */
export function deriveAttachmentNoticeState(state = {}) {
  const itemCount = Number(state.itemCount) || 0;
  const maxCount = Number(state.maxCount) || 0;
  if (state.queueBlocked && state.hasPending) return "Waiting for an image to finish uploading…";
  if (state.queueBlocked && state.hasErrors) return "An image couldn't be attached. Retry or remove it before queuing.";
  if (state.capRejected && maxCount > 0 && itemCount >= maxCount)
    return "You can attach up to " + maxCount + " image" + (maxCount === 1 ? "" : "s") + ".";
  return "";
}

/**
 * @param {*} deriveQueueKey
 * @param {*} [isNativeInteractive]
 * @param {*} [mermaid]
 * @param {number} [artifactRevision]
 * @param {string} [artifactLoadToken]
 * @param {string} [sessionKey]
 * @param {{ maxAttachmentCount?: number, maxAttachmentBytes?: number, acceptedImageMime?: string[], initialAnnotate?: boolean }} [options]
 */
export function createArtifactSdk(
  deriveQueueKey,
  isNativeInteractive = isNativeInteractiveControl,
  mermaid = mermaidHelpers,
  artifactRevision = 0,
  artifactLoadToken = "",
  sessionKey = "",
  options = {},
) {
  const { isMermaidSvg, mermaidNodeFrom, mermaidNodeElement } = mermaid;
  function postArtifactMessage(type, payload = {}) {
    parent.postMessage({ type, ...payload, artifact_load_token: String(artifactLoadToken || "") }, "*");
  }
  let annotationMode = options?.initialAnnotate !== undefined ? Boolean(options.initialAnnotate) : false;
  let hovered = null;
  let selected = null;
  let ignoreNextClick = false;
  // Selectors the chrome reports as carrying a queued note. A click on one opens that note in the
  // chrome's panel instead of a fresh card; the note's words never enter this document.
  let queuedAnchorSelectors = new Set();
  let shadow = null;
  let copyTarget = null;
  let copyButton = null;
  let copyHideTimer = 0;
  let counter = 0;
  const ids = new WeakMap();

  // Image attachments for the open annotation card. These are UX guides only - the
  // server re-validates size and enforces the per-prompt count/byte caps at queue
  // time (see attachment-store.js), rejecting the entire send batch on a mismatch
  // so the chrome can preserve the queue and surface the correction to the user.
  // The count cap mirrors the server's LAVISH_AXI_MAX_ATTACHMENTS_PER_PROMPT, passed
  // in via createSdkJs (W1); the literal 4 is only the fallback when the SDK runs
  // without that wiring (e.g. a unit-test call to createArtifactSdk).
  const ATTACHMENT_MAX_COUNT =
    Number.isFinite(options.maxAttachmentCount) && options.maxAttachmentCount > 0 ? options.maxAttachmentCount : 4;
  // The per-image byte limit, threaded from the server via createSdkJs. 0 means "no
  // client-side gate" (the server still enforces its own cap); it is the fallback
  // when the SDK runs unwired, e.g. a direct createArtifactSdk unit call. Checking
  // it in add() BEFORE reading the file is what stops a multi-GB drop from being
  // allocated and structured-cloned into the chrome ahead of any rejection.
  const ATTACHMENT_MAX_BYTES =
    Number.isFinite(options.maxAttachmentBytes) && options.maxAttachmentBytes > 0 ? options.maxAttachmentBytes : 0;
  const ATTACHMENT_IMAGE_TYPES = acceptedImageTypes(options.acceptedImageMime);
  const ATTACHMENT_ACCEPTED_MIME = ATTACHMENT_IMAGE_TYPES.accepted;
  // Minted once per document load and stamped on every upload, so a result the
  // chrome posts back can be tied to the exact document that asked for it. Chip
  // ids restart at att-1 on each load, so they cannot do this on their own: an
  // upload still in flight across a live-reload would otherwise land on a new
  // document's first chip. `randomUUID` needs a secure context, which the
  // sandboxed artifact frame is not guaranteed to be, hence the fallback - this
  // value only has to be unique per document, never unguessable.
  const ATTACHMENT_NONCE =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : "n" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  let attachmentLocalCounter = 0;
  // The controller for the currently open card, so upload results routed from the
  // chrome reach the right chips. Only one card is ever open at a time.
  let activeAttachments = null;

  // A clean, self-contained close glyph: the SVG path is inlined directly (no
  // <use>/sprite/symbol/CSS-mask reference), so it paints inside the sandboxed
  // annotation-card iframe where any external symbol reference would resolve to
  // nothing. The X sits inside a 14-unit viewBox with even margins so it is
  // optically centered in the round button.
  const REMOVE_ICON =
    '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

  function attachmentChipHtml(item, index) {
    const name = escapeAnnotationText(item.name || "image");
    const thumb = item.url
      ? '<img class="lavish-attachment-thumb" src="' + escapeAnnotationText(item.url) + '" alt="">'
      : '<span class="lavish-attachment-thumb lavish-attachment-thumb-empty" aria-hidden="true"></span>';
    let status = "";
    if (item.status === "uploading") status = '<span class="lavish-attachment-status">Uploading…</span>';
    else if (item.status === "error")
      status =
        '<span class="lavish-attachment-status lavish-attachment-status-error">' +
        escapeAnnotationText(item.error || "Upload failed") +
        "</span>";
    // Only a real (retryable) upload gets a Retry button; a rejected non-image has no file.
    const retry =
      item.status === "error" && item.file
        ? '<button type="button" class="lavish-attachment-retry" data-attachment-retry="' + index + '">Retry</button>'
        : "";
    return (
      '<div class="lavish-attachment-chip' +
      (item.status === "error" ? " is-error" : "") +
      '">' +
      thumb +
      '<span class="lavish-attachment-body"><span class="lavish-attachment-name" title="' +
      name +
      '">' +
      name +
      "</span>" +
      status +
      "</span>" +
      retry +
      '<button type="button" class="lavish-attachment-remove" data-attachment-remove="' +
      index +
      '" aria-label="Remove image" title="Remove">' +
      REMOVE_ICON +
      "</button></div>"
    );
  }

  // Per-card image attachment state. Captures files, renders chips, drives uploads
  // through the chrome (which owns the same-origin server round trip), and reports
  // which uploads are ready to ride along with the queued prompt.
  /**
   * @param {HTMLElement} listEl
   * @param {{ notify?: (message: string) => void, onLayout?: () => void }} [config]
   */
  function makeAttachmentsController(listEl, { notify = () => {}, onLayout = () => {} } = {}) {
    const items = [];
    let capRejected = false;
    let queueBlocked = false;

    function render() {
      if (items.length < ATTACHMENT_MAX_COUNT) capRejected = false;
      if (!hasPending() && !hasErrors()) queueBlocked = false;
      notify(
        deriveAttachmentNoticeState({
          itemCount: items.length,
          maxCount: ATTACHMENT_MAX_COUNT,
          capRejected,
          queueBlocked,
          hasPending: hasPending(),
          hasErrors: hasErrors(),
        }),
      );
      listEl.innerHTML = items.map((item, index) => attachmentChipHtml(item, index)).join("");
      listEl.hidden = items.length === 0;
      for (const button of listEl.querySelectorAll("[data-attachment-remove]")) {
        button.addEventListener("click", () => removeAt(Number(button.getAttribute("data-attachment-remove"))));
      }
      for (const button of listEl.querySelectorAll("[data-attachment-retry]")) {
        button.addEventListener("click", () => retryAt(Number(button.getAttribute("data-attachment-retry"))));
      }
      // Chip rows change the card's height, so let the card re-clamp itself back
      // inside the viewport (W3) - otherwise a grown card can push Queue/Cancel off
      // the bottom of the frame.
      onLayout();
    }

    function upload(item) {
      item.status = "uploading";
      item.error = "";
      render();
      item.file
        .arrayBuffer()
        .then((bytes) => {
          if (!items.includes(item)) return;
          // Route through postArtifactMessage so the message carries the current
          // artifact_load_token - the chrome drops any artifact message without it
          // before the upload handler ever runs.
          postArtifactMessage("lavish:uploadAttachment", {
            nonce: ATTACHMENT_NONCE,
            localId: item.localId,
            name: item.name,
            mime: item.mime,
            bytes,
          });
        })
        .catch(() => {
          if (!items.includes(item)) return;
          item.status = "error";
          item.error = "Could not read image";
          render();
        });
    }

    // Append the chips for a whole batch, then render ONCE and start the uploads. The
    // per-file decision (mime / size / count cap) is made by classifyAttachmentBatch;
    // this only materializes chips + object URLs. A size error becomes a dismissible
    // chip (the oversized file is never read - see round-7 (a)); a cap rejection sets
    // the notice; accepted files upload. Uploads are count-capped (<= ATTACHMENT_MAX_COUNT),
    // so the render-per-upload they trigger is bounded, not O(N).
    function addFiles(fileList) {
      const files = [...(fileList || [])];
      const decisions = classifyAttachmentBatch(files, {
        currentCount: items.length,
        maxCount: ATTACHMENT_MAX_COUNT,
        maxBytes: ATTACHMENT_MAX_BYTES,
        accepted: ATTACHMENT_ACCEPTED_MIME,
      });
      const toUpload = [];
      let added = false;
      for (const decision of decisions) {
        if (decision.kind === "cap") {
          capRejected = true;
        } else if (decision.kind === "error") {
          items.push({
            localId: "att-" + ++attachmentLocalCounter,
            file: null,
            name: decision.file?.name || "image",
            mime: "",
            status: "error",
            id: "",
            error: decision.error,
            url: "",
          });
        } else if (decision.kind === "accept") {
          let initialUrl;
          try {
            initialUrl = URL.createObjectURL(decision.file);
          } catch {
            initialUrl = "";
          }
          const item = {
            localId: "att-" + ++attachmentLocalCounter,
            file: decision.file,
            name: decision.file.name || "image",
            mime: decision.file.type,
            status: "uploading",
            id: "",
            error: "",
            url: initialUrl,
          };
          items.push(item);
          toUpload.push(item);
          added = true;
          const FileReaderClass = typeof globalThis.FileReader !== "undefined" ? globalThis.FileReader : null;
          if (FileReaderClass) {
            const reader = new FileReaderClass();
            reader.onload = () => {
              if (typeof reader.result === "string" && items.includes(item)) {
                if (item.url && item.url.startsWith("blob:")) {
                  try {
                    URL.revokeObjectURL(item.url);
                  } catch {
                    // Ignore revoke errors
                  }
                }
                item.url = reader.result;
                render();
              }
            };
            reader.readAsDataURL(decision.file);
          }
        }
      }
      render();
      for (const item of toUpload) upload(item);
      return added;
    }

    function removeAt(index) {
      const item = items[index];
      if (!item) return;
      if (item.url && item.url.startsWith("blob:")) {
        try {
          URL.revokeObjectURL(item.url);
        } catch {
          // Ignore revoke errors
        }
      }
      items.splice(index, 1);
      render();
    }

    function retryAt(index) {
      if (items[index] && items[index].file) upload(items[index]);
    }

    // Surface dropped non-images as dismissible UNSUPPORTED_TYPE error chips (no file,
    // so no thumbnail and no retry) instead of letting the browser open them. Batched:
    // a mixed drop of many unsupported files pushes all chips, then renders ONCE, so N
    // rejections cost one DOM rebuild rather than N (D7).
    function rejectUnsupportedBatch(names) {
      for (const name of names || []) {
        items.push({
          localId: "att-" + ++attachmentLocalCounter,
          file: null,
          name: name || "file",
          mime: "",
          status: "error",
          id: "",
          error: "UNSUPPORTED_TYPE",
          url: "",
        });
      }
      render();
    }

    function rejectUnsupported(name) {
      rejectUnsupportedBatch([name]);
    }

    function handleResult(localId, ok, id, error) {
      const item = items.find((entry) => entry.localId === localId);
      if (item) {
        if (ok && id) {
          item.status = "ready";
          item.id = String(id);
          item.error = "";
        } else {
          item.status = "error";
          item.error = String(error || "Upload failed");
        }
        render();
      }
    }

    function collectReady() {
      return items
        .filter((item) => item.status === "ready" && item.id)
        .map((item) => ({ id: item.id, name: item.name }));
    }

    function hasReady() {
      return items.some((item) => item.status === "ready" && item.id);
    }

    // Any chip still mid-flight. Queuing while one is uploading would silently drop
    // it (collectReady excludes it, and closeCard destroys the controller), so the
    // send path gates on this (R2.4).
    function hasPending() {
      return items.some((item) => item.status === "uploading");
    }

    // Any chip in the error state - a failed upload (retryable) or a rejected
    // non-image. collectReady drops these and closeCard destroys the card, so queuing
    // while one is present would silently discard the failed attachment along with its
    // retry/remove UI; the send path gates on this and keeps the card open (W2).
    function hasErrors() {
      return items.some((item) => item.status === "error");
    }

    function setQueueBlocked(value) {
      queueBlocked = Boolean(value);
      render();
    }

    function destroy() {
      for (const item of items) {
        if (item.url && item.url.startsWith("blob:")) {
          try {
            URL.revokeObjectURL(item.url);
          } catch {
            // Ignore revoke errors
          }
        }
      }
      items.length = 0;
    }

    render();
    return {
      addFiles,
      rejectUnsupported,
      rejectUnsupportedBatch,
      handleResult,
      collectReady,
      hasReady,
      hasPending,
      hasErrors,
      setQueueBlocked,
      destroy,
    };
  }

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
    while (node && node.nodeType === 1 && parts.length < 24) {
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
      if (parts.length >= 5) {
        const candidate = parts.join(" > ");
        if (candidate.length > 420 || queryAll(candidate).length <= 1) break;
      }
    }

    return parts.join(" > ");
  }

  // `table` is opt-in because resolving a cell's row and column walks the whole table, while
  // `snapshot()` calls this for every element in the document and reads only uid/tag/text.
  function context(el, { table = false, needSelector = true } = {}) {
    const computeSelector = needSelector ? selector : () => "";
    const base = {
      uid: uid(el),
      selector: computeSelector(el),
      tag: (el.tagName || "").toLowerCase(),
      text: (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 240),
    };

    // Semantic table coordinates are extra context, never a replacement identity: the highlight
    // outlines the element the reviewer clicked, so its selector, tag, and text must keep
    // describing that exact element rather than being coarsened up to the enclosing cell.
    const tableTarget = table ? tableCellTarget(el, computeSelector) : null;
    if (tableTarget) base.target = tableTarget;

    const mermaidNode = mermaidNodeFrom(el, computeSelector);
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
      // The frame's channel token is bound to this session, so the frame page
      // must be told which session it belongs to.
      key: String(sessionKey || ""),
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
    if (msg.type === "lavish:requestLayoutDiagnostics") scheduleLayoutAudit(true);
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

  function textRangeContextFromRange(range, fallbackText = "") {
    if (!range || range.collapsed) return null;
    const rangeText =
      typeof range.toString === "function" && range.toString !== Object.prototype.toString ? range.toString() : "";
    const text = String(fallbackText || rangeText)
      .trim()
      .replace(/\s+/g, " ");
    if (!text) return null;

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

  function textSelectionContext(selection) {
    if (!selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    return textRangeContextFromRange(range, selection.toString());
  }

  function isLavishUi(el) {
    return !!(el && el.closest && el.closest("[data-lavish-ui]"));
  }

  function isLavishAction(el) {
    return !!(el && el.closest && el.closest("[data-lavish-action]"));
  }
  function windowsWslLink(el) {
    const link = el?.closest?.("a[data-lavish-wsl-path],a[href]");
    const windowsPath = link?.getAttribute?.("data-lavish-wsl-path") || link?.getAttribute?.("href") || "";
    return /^\\\\wsl(?:\.localhost|\$)\\[^\\/]+\\/i.test(windowsPath) ? windowsPath : "";
  }

  // Native interactive controls (radios, checkboxes, inputs, selects, buttons,
  // labels, disclosure summaries, editable regions, interactive ARIA widgets)
  // should toggle/focus/type natively instead of triggering annotation, just
  // like elements marked with data-lavish-action.
  function isInteractiveControl(el) {
    return isNativeInteractive(el);
  }

  const COPY_TARGET_SELECTOR =
    "[data-lavish-copy],article,p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,figcaption,td,th,.card,.metric,.notice,.source,.callout,.panel,.review-card,.report-card,.evidence-card,.src-card,.sec-card,.meta-block,.dp-card,.tr-card,.source-banner,.sub,.island";

  function copyTargetFor(el) {
    if (
      !(el instanceof Element) ||
      isLavishUi(el) ||
      el.closest?.("[data-lavish-no-copy],.glass-showcase-canvas,.psc-card,.psc-page-group")
    )
      return null;
    const matches = [];
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      if (!node.matches?.(COPY_TARGET_SELECTOR) || isLavishUi(node)) continue;
      const tag = String(node.tagName || "").toLowerCase();
      if (tag === "html" || tag === "body" || tag === "main" || tag === "nav") continue;
      const className = String(node.className || "");
      if (/\b(layout|content|rail|topline|toc)\b/.test(className)) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      matches.push({ node, height: rect.height });
    }
    if (!matches.length) return null;
    const limit = Math.max(140, (window.innerHeight || 0) * 0.45);
    const small = matches.filter((entry) => entry.height <= limit);
    return small[0] ? small[0].node : null;
  }

  function markdownFromElement(element) {
    function text(value) {
      return String(value || "")
        .replace(/\s+/g, " ")
        .trim();
    }
    function render(node) {
      if (node.nodeType === 3) return node.nodeValue || "";
      if (node.nodeType !== 1) return "";
      const tag = String(node.tagName || "").toLowerCase();
      const children = [...(node.childNodes || [])].map(render).join("");
      if (/^h[1-6]$/.test(tag)) return "\n\n" + "#".repeat(Number(tag[1])) + " " + text(children) + "\n\n";
      if (tag === "br") return "\n";
      if (tag === "li") return "\n- " + text(children);
      if (tag === "pre") return "\n\n```\n" + String(node.textContent || "").trim() + "\n```\n\n";
      if (tag === "code") return "`" + text(children) + "`";
      if (tag === "a") {
        const href = node.getAttribute?.("href") || node.href || "";
        return href ? "[" + text(children) + "](" + href + ")" : children;
      }
      if (new Set(["p", "div", "section", "article", "header", "footer", "blockquote", "ul", "ol"]).has(tag)) {
        return "\n\n" + children + "\n\n";
      }
      return children;
    }
    const rendered = render(element)
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return rendered || text(element.innerText || element.textContent);
  }

  async function copyMarkdown(element) {
    const markdown = markdownFromElement(element);
    try {
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(markdown);
          return true;
        } catch {
          // Fall back to execCommand when clipboard API is restricted in sandboxed iframe
        }
      }
      const textarea = document.createElement("textarea");
      textarea.value = markdown;
      textarea.setAttribute("aria-hidden", "true");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand?.("copy");
      textarea.remove();
      return copied === true;
    } catch {
      return false;
    }
  }

  function positionCopyButton() {
    if (!copyTarget || !copyButton) return;
    const rect = copyTarget.getBoundingClientRect();
    const viewportWidth = window.innerWidth || 0;
    const viewportHeight = window.innerHeight || 0;
    const buttonWidth = 24;
    const buttonHeight = 24;
    const gap = 8;

    const onScreen =
      rect.bottom > 16 && rect.top < viewportHeight - 16 && rect.right > 16 && rect.left < viewportWidth - 16;
    if (!onScreen) {
      hideCopyButton();
      return;
    }

    let left = rect.right + gap;
    let top = rect.height >= buttonHeight ? rect.top + 2 : rect.top + Math.round((rect.height - buttonHeight) / 2);

    if (left + buttonWidth > viewportWidth - 8) {
      if (rect.left - gap - buttonWidth >= 8) {
        left = rect.left - gap - buttonWidth;
      } else if (rect.top - buttonHeight - 4 >= 8) {
        top = rect.top - buttonHeight - 4;
        left = Math.max(8, Math.min(rect.right - buttonWidth, viewportWidth - buttonWidth - 8));
      } else {
        top = Math.max(8, rect.top + 2);
        left = Math.max(8, Math.min(rect.right - buttonWidth - 4, viewportWidth - buttonWidth - 8));
      }
    }

    top = Math.max(8, Math.min(top, viewportHeight - buttonHeight - 8));
    left = Math.max(8, Math.min(left, viewportWidth - buttonWidth - 8));

    copyButton.hidden = false;
    copyButton.style.display = "grid";
    copyButton.style.left = left + "px";
    copyButton.style.top = top + "px";
  }

  function hideCopyButton() {
    copyHideTimer = 0;
    if (copyButton) {
      copyButton.hidden = true;
      copyButton.style.display = "none";
    }
    copyTarget = null;
  }

  function showCopyButton(target) {
    const root = ensureShadow();
    if (!copyButton) {
      copyButton = document.createElement("button");
      copyButton.type = "button";
      copyButton.className = "lavish-copy-markdown";
      copyButton.setAttribute("data-lavish-ui", "copy-markdown");
      copyButton.setAttribute("aria-label", "Copy content as Markdown");
      copyButton.title = "Copy as Markdown";
      copyButton.innerHTML = "⧉";
      copyButton.addEventListener("mouseenter", () => {
        if (copyHideTimer) window.clearTimeout(copyHideTimer);
      });
      copyButton.addEventListener("mouseleave", () => {
        if (!copyHideTimer) copyHideTimer = window.setTimeout(hideCopyButton, 160);
      });
      copyButton.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!copyTarget) return;
        const copied = await copyMarkdown(copyTarget);
        copyButton.textContent = copied ? "✓" : "!";
        copyButton.title = copied ? "Markdown copied" : "Copy failed";
        window.setTimeout(() => {
          if (!copyButton) return;
          copyButton.textContent = "⧉";
          copyButton.title = "Copy as Markdown";
        }, 1200);
      });
      root.appendChild(copyButton);
    }
    if (copyHideTimer) window.clearTimeout(copyHideTimer);
    copyTarget = target;
    copyButton.hidden = false;
    copyButton.style.display = "grid";
    positionCopyButton();
  }

  function installActiveNavigation() {
    const styleId = "lavish-active-navigation-style";
    if (!document.getElementById(styleId)) {
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent =
        "nav a[data-lavish-active-nav='true'],.toc a[data-lavish-active-nav='true']{background:var(--lavish-nav-active-bg,rgba(244,201,93,.22))!important;color:var(--lavish-nav-active-ink,#fff)!important;box-shadow:inset 3px 0 0 var(--lavish-nav-active-accent,#f4c95d)}";
      document.head.appendChild(style);
    }
    function update() {
      const entries = [...document.querySelectorAll("nav a[href^='#'],.toc a[href^='#']")]
        .map((link) => ({ link, id: String(link.getAttribute("href") || "").slice(1) }))
        .map((entry) => ({ ...entry, section: entry.id ? document.getElementById(entry.id) : null }))
        .filter((entry) => entry.section);
      if (!entries.length) return;
      const threshold = Math.max(96, (window.innerHeight || 800) * 0.35);
      let active = entries[0];
      for (const entry of entries) {
        if (entry.section.getBoundingClientRect().top <= threshold) active = entry;
        else break;
      }
      for (const entry of entries) {
        const current = entry === active;
        entry.link.setAttribute("data-lavish-active-nav", String(current));
        if (current) entry.link.setAttribute("aria-current", "location");
        else entry.link.removeAttribute?.("aria-current");
      }
    }
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    };
    window.addEventListener("scroll", schedule, { passive: true, capture: true });
    window.addEventListener("resize", schedule, { passive: true });
    schedule();
    window.setTimeout(update, 0);
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
        ":root{--lavish-accent:#f4c95d;--lavish-annotate-outline:2px solid var(--lavish-accent);--lavish-annotate-offset:2px}*{cursor:default!important}:where(:is([role='button'],[role='checkbox'],[role='combobox'],[role='menuitem'],[role='menuitemcheckbox'],[role='menuitemradio'],[role='option'],[role='radio'],[role='switch'],[role='tab'],[role='treeitem']):not(a[href])),:where(:is([role='button'],[role='checkbox'],[role='combobox'],[role='menuitem'],[role='menuitemcheckbox'],[role='menuitemradio'],[role='option'],[role='radio'],[role='switch'],[role='tab'],[role='treeitem']):not(a[href])) *{cursor:pointer!important}:where(:is([role='button'],[role='checkbox'],[role='combobox'],[role='menuitem'],[role='menuitemcheckbox'],[role='menuitemradio'],[role='option'],[role='radio'],[role='switch'],[role='tab'],[role='treeitem']) a[href]),:where(:is([role='button'],[role='checkbox'],[role='combobox'],[role='menuitem'],[role='menuitemcheckbox'],[role='menuitemradio'],[role='option'],[role='radio'],[role='switch'],[role='tab'],[role='treeitem']) a[href]) *{cursor:default!important}[data-lavish-action],[data-lavish-action] *{cursor:pointer!important}input,textarea,[contenteditable]:not([contenteditable='false']){cursor:text!important}button,select,label,option,input[type='button'],input[type='submit'],input[type='reset'],input[type='checkbox'],input[type='radio'],input[type='file'],input[type='color'],input[type='range'],input[type='image']{cursor:pointer!important}";
      document.head.appendChild(style);
    }
    if (!annotationMode && style) style.remove();
    if (!annotationMode) closeCard();

    // Freeze Mermaid pan/zoom while annotating so nodes sit at stable screen
    // positions and a click resolves cleanly to one node instead of panning.
    setMermaidFrozen(annotationMode);
  }

  // Overlay state stays outside the artifact DOM, so text offsets remain stable.
  let annotationMarks = [];
  let selectedMarkId = "";
  // The bare marker whose + comment button and arrows the pointer is near, so an overlay rebuild
  // mid-press keeps them visible and clickable.
  let hoveredMarkId = "";
  // The logical overlay control a primary press started on, and its pointer (see onOverlayActivate).
  let pressedOverlay = null;
  // Each rendered overlay control by its logical key, and the key that should hold the focus after
  // the next render: the overlay is rebuilt on every change, which would drop a keyboard focus.
  let overlayControls = new Map();
  let overlayFocusKey = "";
  let pendingSelectLatestMark = false;
  let doneRanges = [];
  let unresolvedDoneItems = [];
  let renderedMarkRects = [];
  let renderedDoneRects = [];
  let lastPointerTarget = null;
  let lastPointerClient = { x: 0, y: 0 };
  let overlayFrame = 0;
  let overlayObserver = null;
  // Room the up/down arrows take beside a comment badge.
  const MARK_NAV_WIDTH = 52;
  const normalizeWs = (value) =>
    String(value || "")
      .replace(/\s+/g, " ")
      .trim();

  function queryAll(value) {
    try {
      return [...document.querySelectorAll(String(value || ""))];
    } catch {
      return [];
    }
  }

  function textSignature(el) {
    const norm = normalizeWs(el.textContent || "");
    let fnv = 2166136261;
    let djb = 5381;
    for (let i = 0; i < norm.length; i++) {
      fnv = Math.imul(fnv ^ norm.charCodeAt(i), 16777619);
      djb = (Math.imul(djb, 33) + norm.charCodeAt(i)) | 0;
    }
    return `${fnv >>> 0}:${djb >>> 0}:${norm.length}`;
  }

  function ancestorSignature(el) {
    const chain = [];
    for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      if (/^main$/i.test(p.tagName || "")) {
        chain.push(`${p.tagName.toLowerCase()}#${p.id || ""}`);
        continue;
      }
      chain.push(`${p.tagName.toLowerCase()}#${p.id || ""}:${textSignature(p)}`);
    }
    return chain.join("|");
  }

  // A document intro header (a `<header>` wrapping the page's h1 together with its lead prose)
  // is one content unit, not page chrome: `done-parent` has to be able to grey the heading along
  // with the paragraph below it. Headers without that heading-and-prose pairing stay excluded so
  // site banners and nav strips never become done boxes.
  function isIntroHeader(node) {
    if (!/^header$/i.test(node?.tagName || "") || typeof node?.querySelector !== "function") return false;
    return Boolean(node.querySelector("h1,h2,h3,h4,h5,h6") && node.querySelector("p"));
  }

  function isExcludedDoneTag(node) {
    return (
      !node?.tagName ||
      (/^(html|body|main|nav|header|footer|h[1-6]|summary|legend|caption|script|style|svg)$/i.test(node.tagName) &&
        !isIntroHeader(node)) ||
      node.getAttribute?.("role") === "heading" ||
      isLavishUi(node)
    );
  }

  function isDoneCandidate(node) {
    if (isExcludedDoneTag(node)) return false;
    const rect = node.getBoundingClientRect();
    if (node.matches("p,li,blockquote,pre,dd,dt,figcaption")) return rect.width >= 60 && rect.height >= 16;
    if (rect.width < 120 || rect.height < 36) return false;
    const bodyRect = document.body.getBoundingClientRect();
    if (
      node.matches(".layout,.content,.page-shell") &&
      rect.width >= bodyRect.width * 0.92 &&
      rect.height >= bodyRect.height * 0.92
    )
      return false;
    if (
      node.matches(
        "[data-lavish-box],[data-lavish-copy],section,article,aside,details,fieldset,tr,td,th,.card,.metric,.notice,.source,.callout,.panel,.review-card,.report-card,.evidence-card,.src-card,.sec-card,.meta-block,.dp-card,.tr-card,.source-banner,.sub,.island,.box",
      )
    )
      return true;
    const style = getComputedStyle(node);
    if (!/^(block|flex|grid|inline-flex|inline-grid|flow-root)$/.test(style.display || "")) return false;
    const border =
      [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].some(
        (v) => parseFloat(v) > 0,
      ) && style.borderStyle !== "none";
    const background = style.backgroundColor && !/^(transparent|rgba\(0,\s*0,\s*0,\s*0\))$/.test(style.backgroundColor);
    const padded =
      parseFloat(style.borderRadius) >= 4 ||
      [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].some((v) => parseFloat(v) >= 8);
    return Boolean(border || (style.boxShadow && style.boxShadow !== "none") || (background && padded));
  }

  function resolveDoneCandidates(target) {
    const candidates = [];
    for (
      let node = target;
      node && node !== document.body && node !== document.documentElement;
      node = node.parentElement
    ) {
      if (/^(main|nav)$/i.test(node.tagName || "")) break;
      if (!isDoneCandidate(node)) continue;
      const previous = candidates.at(-1);
      if (previous) {
        const a = previous.getBoundingClientRect(),
          b = node.getBoundingClientRect();
        if (Math.abs(a.width - b.width) < 6 && Math.abs(a.height - b.height) < 6) {
          candidates[candidates.length - 1] = node;
          continue;
        }
      }
      candidates.push(node);
    }
    return candidates;
  }

  function resolveBoundaryRange(target) {
    if (!target?.start || !target?.end) return null;
    function walkPath(root, path) {
      /** @type {Node | null | undefined} */
      let node = root;
      for (const index of path || []) {
        node = node.childNodes?.[index];
        if (!node) return null;
      }
      return node;
    }
    const startRoots = queryAll(target.start.selector);
    const endRoots = target.start.selector === target.end.selector ? startRoots : queryAll(target.end.selector);
    if (!startRoots.length || !endRoots.length) return null;
    const pairs = [];
    if (target.start.selector === target.end.selector) {
      for (const root of startRoots) pairs.push([root, root]);
    }
    for (const s of startRoots) {
      for (const e of endRoots) {
        if (target.start.selector === target.end.selector && s === e) continue;
        pairs.push([s, e]);
        if (pairs.length >= 24) break;
      }
      if (pairs.length >= 24) break;
    }
    const resolved = [];
    for (const [sRoot, eRoot] of pairs) {
      try {
        const start = walkPath(sRoot, target.start.path);
        const end = walkPath(eRoot, target.end.path);
        if (!start || !end) continue;
        const range = document.createRange();
        range.setStart(start, target.start.offset);
        range.setEnd(end, target.end.offset);
        if (!range.collapsed && normalizeWs(range.toString()) === normalizeWs(target.text)) {
          resolved.push(range);
        }
      } catch {
        // Ignore invalid boundary candidate
      }
    }
    return resolved.length === 1 ? resolved[0] : null;
  }

  function findUniqueFullTextRange(anchor, text) {
    if (!text || String(text).endsWith("…")) return null;
    const walker = document.createTreeWalker(anchor, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let raw = "",
      node;
    while ((node = walker.nextNode())) {
      nodes.push({ node, start: raw.length });
      raw += node.nodeValue || "";
    }
    // Match normalized whitespace while retaining a map to original DOM offsets.
    let normalized = "",
      offsets = [];
    for (let i = 0; i < raw.length; i++) {
      if (/\s/.test(raw[i])) {
        if (!normalized || normalized.endsWith(" ")) continue;
        normalized += " ";
        offsets.push(i);
      } else {
        normalized += raw[i];
        offsets.push(i);
      }
    }
    const needle = normalizeWs(text),
      index = normalized.indexOf(needle);
    if (!needle || index < 0 || normalized.indexOf(needle, index + 1) !== -1) return null;
    const startOffset = offsets[index],
      endOffset = offsets[index + needle.length - 1] + 1;
    const startNode = [...nodes].reverse().find((entry) => entry.start <= startOffset);
    const endNode = [...nodes].reverse().find((entry) => entry.start < endOffset);
    if (!startNode || !endNode) return null;
    const range = document.createRange();
    range.setStart(startNode.node, startOffset - startNode.start);
    range.setEnd(endNode.node, endOffset - endNode.start);
    return range;
  }

  function resolveTextTarget(target, fallbackSelector) {
    const boundaryRange = resolveBoundaryRange(target);
    if (boundaryRange) {
      const anchor = closestElement(boundaryRange.commonAncestorContainer);
      return { anchor, range: boundaryRange };
    }
    const matches = queryAll(target?.commonAncestorSelector || target?.selector || fallbackSelector);
    if (!matches.length) return null;
    const found = [];
    for (const anchor of matches) {
      const range = findUniqueFullTextRange(anchor, target?.text);
      if (range) found.push({ anchor, range });
    }
    return found.length === 1 ? found[0] : null;
  }

  // An element mark (a right-click annotation made without a text selection) carries only its
  // container selector. Resolve it to a range spanning that container so the badge, the arrows
  // and the reveal treat it exactly like a marked passage. Text marks never take this path:
  // their selector names a container, and the text itself has to be matched, never assumed.
  function resolveElementMarkTarget(item) {
    const selector = item?.target?.selector || item?.selector;
    if (!selector) return null;
    const matches = queryAll(selector);
    if (matches.length !== 1) return null;
    const element = matches[0];
    const range = document.createRange();
    range.selectNodeContents(element);
    return { anchor: element, range };
  }

  // Element marks stand for a whole container and share one definition across every consumer:
  // resolving, overlap checks, reading order, focus, and drawing all branch on this predicate.
  function isElementMark(item) {
    return Boolean(item?.kind && item.kind !== "text-range");
  }

  // Every consumer of a mark resolves it through the same path its kind dictates: text marks
  // must match their text (never a bare selector), element marks span the container their
  // selector names. Diverging resolvers made an element mark's arrow render but jump nowhere.
  function resolveMarkTarget(item) {
    return isElementMark(item)
      ? resolveElementMarkTarget(item)
      : resolveTextTarget(item.target || { text: item.text, selector: item.selector }, item.selector);
  }

  function getScrollAncestors(anchor) {
    const result = [];
    for (let p = anchor; p && p !== document.documentElement; p = p.parentElement) {
      const style = getComputedStyle(p);
      if (/(auto|scroll|hidden|clip)/.test(`${style.overflowX} ${style.overflowY}`)) result.push(p);
    }
    return result;
  }

  function clipRectToScrollAncestors(rect, anchor) {
    let left = Math.max(0, rect.left),
      top = Math.max(0, rect.top);
    let right = Math.min(window.innerWidth, rect.right),
      bottom = Math.min(window.innerHeight, rect.bottom);
    for (const el of getScrollAncestors(anchor)) {
      overlayObserver?.observe(el);
      const r = el.getBoundingClientRect();
      const x = r.left + el.clientLeft,
        y = r.top + el.clientTop;
      left = Math.max(left, x);
      top = Math.max(top, y);
      right = Math.min(right, x + el.clientWidth);
      bottom = Math.min(bottom, y + el.clientHeight);
    }
    return right > left && bottom > top
      ? { left, top, right, bottom, width: right - left, height: bottom - top }
      : null;
  }

  function pointInRect(rect, x, y, pad = 0) {
    return x >= rect.left - pad && x <= rect.right + pad && y >= rect.top - pad && y <= rect.bottom + pad;
  }
  function findRenderedTextMarkAtPoint(x, y, pad = 0) {
    return (
      renderedMarkRects
        .filter((entry) => pointInRect(entry.rect, x, y, pad))
        .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height || b.order - a.order)[0]?.mark ||
      null
    );
  }

  function rangesOverlap(a, b) {
    try {
      return a.compareBoundaryPoints(Range.END_TO_START, b) < 0 && a.compareBoundaryPoints(Range.START_TO_END, b) > 0;
    } catch {
      return false;
    }
  }

  function rangeContains(outer, inner) {
    try {
      return (
        outer.compareBoundaryPoints(Range.START_TO_START, inner) <= 0 &&
        outer.compareBoundaryPoints(Range.END_TO_END, inner) >= 0
      );
    } catch {
      return false;
    }
  }

  function findOverlappingMarks(range) {
    const overlaps = [];
    for (const mark of annotationMarks) {
      // Element marks span whole containers; treating their excerpt as text would let a fresh
      // selection swallow the element mark instead of creating its own text mark.
      if (isElementMark(mark)) continue;
      const resolved = resolveTextTarget(mark.target || { text: mark.text, selector: mark.selector }, mark.selector);
      if (resolved && rangesOverlap(resolved.range, range)) {
        overlaps.push({ mark, resolved });
      }
    }
    return overlaps;
  }

  function mergeRangeWithOverlaps(baseRange, overlaps) {
    try {
      const merged = baseRange.cloneRange();
      for (const { resolved } of overlaps) {
        if (resolved.range.compareBoundaryPoints(Range.START_TO_START, merged) < 0) {
          merged.setStart(resolved.range.startContainer, resolved.range.startOffset);
        }
        if (resolved.range.compareBoundaryPoints(Range.END_TO_END, merged) > 0) {
          merged.setEnd(resolved.range.endContainer, resolved.range.endOffset);
        }
      }
      return textRangeContextFromRange(merged);
    } catch {
      return null;
    }
  }

  function ensureDoneStyle() {
    if (document.getElementById("lavish-done-box-style")) return;
    const style = document.createElement("style");
    style.id = "lavish-done-box-style";
    style.textContent =
      '[data-lavish-done="true"]{opacity:.36!important;filter:grayscale(.85)!important;transition:opacity 120ms ease,filter 120ms ease}';
    (document.head || document.documentElement).appendChild(style);
  }

  // The OS scrollbar thumb barely separates from warm artifact backgrounds, so the review
  // surface restyles it for contrast inside the sandboxed frame only. Exports strip the SDK
  // and keep the artifact's own scrollbar styling untouched.
  // The thumb adapts to the surface: a bright artifact (white customer surfaces) gets a dark
  // grey thumb, a dark or warm surface keeps the light #f3f3f4 thumb with its fine outline.
  function effectiveBackgroundRgb() {
    for (const el of [document.documentElement, document.body]) {
      if (!el) continue;
      const match = String(getComputedStyle(el).backgroundColor || "").match(
        /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/,
      );
      if (match && (match[4] === undefined || Number(match[4]) > 0)) {
        return [Number(match[1]), Number(match[2]), Number(match[3])];
      }
    }
    return [255, 255, 255];
  }

  function isBrightSurface() {
    const [r, g, b] = effectiveBackgroundRgb();
    const channel = (c) => (c <= 0.03928 ? c / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b) > 0.75;
  }

  function scrollbarStyleText() {
    const thumb = isBrightSurface() ? "#4b4b52" : "#f3f3f4";
    const outline = isBrightSurface() ? "" : "border:1px solid rgba(0,0,0,.28);";
    return `::-webkit-scrollbar{width:12px;height:12px}::-webkit-scrollbar-thumb{background:${thumb};border-radius:8px;${outline}background-clip:content-box}::-webkit-scrollbar-track{background:transparent}html{scrollbar-color:${thumb} transparent}`;
  }

  function ensureScrollbarStyle() {
    let style = document.getElementById("lavish-scrollbar-style");
    if (!style) {
      style = document.createElement("style");
      style.id = "lavish-scrollbar-style";
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = scrollbarStyleText();
  }

  function watchScrollbarSurface() {
    if (typeof MutationObserver !== "function") return;
    let timer = null;
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(ensureScrollbarStyle, 80);
    });
    for (const el of [document.documentElement, document.body]) {
      if (el) observer.observe(el, { attributes: true, attributeFilter: ["class", "style"], subtree: false });
    }
  }

  function normalizeDoneElement(el) {
    for (const child of el.querySelectorAll('[data-lavish-done="true"]')) child.removeAttribute("data-lavish-done");
    for (let p = el.parentElement; p; p = p.parentElement) p.removeAttribute("data-lavish-done");
    doneRanges = doneRanges.filter((item) => !el.contains(item.anchor));
  }

  function normalizeAllDoneState() {
    const elements = queryAll('[data-lavish-done="true"]');
    for (const el of elements)
      if (el.parentElement?.closest('[data-lavish-done="true"]')) el.removeAttribute("data-lavish-done");
    doneRanges = doneRanges.filter((item) => !item.anchor.closest('[data-lavish-done="true"]'));
  }

  function reportDoneBoxes() {
    const items = queryAll('[data-lavish-done="true"]').map((el) => ({
      id: uid(el),
      kind: "element",
      selector: selector(el),
      uid: uid(el),
      tag: el.tagName.toLowerCase(),
      textSignature: textSignature(el),
      ancestorSignature: ancestorSignature(el),
      revision: artifactRevision,
    }));
    items.push(...doneRanges.map(({ anchor: _anchor, range: _range, ...item }) => item));
    items.push(...unresolvedDoneItems);
    postArtifactMessage("lavish:doneBoxes", { items });
  }

  function validRestoreAnchor(el, item) {
    if (ancestorSignature(el) !== item.ancestorSignature) return false;
    if (!/:nth-(?:of-type|child)\(/.test(item.selector)) return true;
    const sig = textSignature(el),
      ancestors = ancestorSignature(el);
    return (
      queryAll(el.tagName).filter((other) => textSignature(other) === sig && ancestorSignature(other) === ancestors)
        .length === 1
    );
  }

  function restoreDoneItems(items) {
    for (const el of queryAll('[data-lavish-done="true"]')) el.removeAttribute("data-lavish-done");
    doneRanges = [];
    unresolvedDoneItems = [];
    for (const item of Array.isArray(items) ? items : []) {
      const matches = queryAll(item.selector);
      if (matches.length !== 1) {
        unresolvedDoneItems.push(item);
        continue;
      }
      const el = matches[0];
      if (!validRestoreAnchor(el, item)) {
        unresolvedDoneItems.push(item);
        continue;
      }
      let restored = false;
      if (item.kind === "element" && isDoneCandidate(el) && textSignature(el) === item.textSignature) {
        ensureDoneStyle();
        el.setAttribute("data-lavish-done", "true");
        restored = true;
      }
      if (item.kind === "text-range") {
        const resolved = resolveTextTarget(item.target, item.selector);
        if (resolved && resolved.anchor === el) {
          doneRanges.push({ ...item, ...resolved });
          restored = true;
        }
      }
      if (!restored) unresolvedDoneItems.push(item);
    }
    normalizeAllDoneState();
    renderOverlays();
  }

  function applyDoneTextRange(c) {
    for (let p = c.element; p; p = p.parentElement) p.removeAttribute("data-lavish-done");
    doneRanges = doneRanges.filter((item) => {
      try {
        return (
          item.range.compareBoundaryPoints(Range.END_TO_START, c.range) <= 0 ||
          item.range.compareBoundaryPoints(Range.START_TO_END, c.range) >= 0
        );
      } catch {
        return false;
      }
    });
    doneRanges.push({
      id: `done-${Date.now()}-${++counter}`,
      kind: "text-range",
      selector: c.selector,
      text: c.target.text,
      target: c.target,
      ancestorSignature: ancestorSignature(c.element),
      revision: artifactRevision,
      anchor: c.element,
      range: c.range,
    });
    renderOverlays();
    reportDoneBoxes();
  }

  function executeReviewShortcut(action, event) {
    if (activeCardContext) return false;
    if (action === "delete-mark") {
      const targetMark = selectedMarkId ? annotationMarks.find((m) => m.id === selectedMarkId) : null;
      if (!targetMark) return false;
      event?.preventDefault();
      selectedMarkId = "";
      annotationMarks = annotationMarks.filter((m) => m.id !== targetMark.id);
      renderOverlays();
      postArtifactMessage("lavish:deleteAnnotationMark", {
        id: targetMark.id,
        state: targetMark.state,
        selector: targetMark.selector,
      });
      return true;
    }
    const selection = document.getSelection();
    const c = textSelectionContext(selection);
    if (action === "comment" && !c) {
      const targetMark =
        findRenderedTextMarkAtPoint(lastPointerClient.x, lastPointerClient.y, 6) ||
        (selectedMarkId ? annotationMarks.find((m) => m.id === selectedMarkId) : null);
      if (!targetMark) return false;
      event?.preventDefault();
      selectedMarkId = targetMark.id;
      openCommentForMark(targetMark);
      return true;
    }
    if (action === "mark" || action === "comment") {
      if (!c) return false;
      event?.preventDefault();
      ignoreNextClick = false;
      const overlaps = findOverlappingMarks(c.range);
      if (action === "mark") {
        if (overlaps.length === 1 && rangeContains(overlaps[0].resolved.range, c.range)) {
          selectedMarkId = overlaps[0].mark.id;
          selection?.removeAllRanges?.();
          renderOverlays();
          return true;
        }
        const mergedContext = overlaps.length ? mergeRangeWithOverlaps(c.range, overlaps) || c : c;
        const replaceMarkIds = overlaps.map((o) => o.mark.id);
        pendingSelectLatestMark = true;
        queuePrompt("", {
          ...mergedContext,
          queueKey: "",
          ...(replaceMarkIds.length ? { replaceMarkIds } : {}),
        });
        selection?.removeAllRanges?.();
      } else {
        const mergedContext = overlaps.length ? mergeRangeWithOverlaps(c.range, overlaps) || c : c;
        const replaceMarkIds = overlaps.map((o) => o.mark.id);
        selection?.removeAllRanges?.();
        showAnnotationCard(mergedContext.element, {
          context: replaceMarkIds.length ? { ...mergedContext, replaceMarkIds } : mergedContext,
          range: mergedContext.range,
        });
      }
      return true;
    }
    if (action === "done" && c) {
      event?.preventDefault();
      ignoreNextClick = false;
      applyDoneTextRange(c);
      selection?.removeAllRanges?.();
      return true;
    }
    if (action !== "done" && action !== "done-parent") return false;
    const candidates = resolveDoneCandidates(c?.element || lastPointerTarget);
    if (action === "done" && !c && !candidates.some((el) => el.getAttribute("data-lavish-done") === "true")) {
      const hit = renderedDoneRects.find((entry) => pointInRect(entry.rect, lastPointerClient.x, lastPointerClient.y));
      if (hit) {
        event?.preventDefault();
        doneRanges = doneRanges.filter((item) => item !== hit.item);
        renderOverlays();
        reportDoneBoxes();
        return true;
      }
    }
    if (!candidates.length) return false;
    event?.preventDefault();
    const activeIdx = candidates.findIndex((el) => el.getAttribute("data-lavish-done") === "true");
    if (
      (action === "done" && activeIdx >= 0) ||
      (action === "done-parent" && (activeIdx >= 1 || (activeIdx === 0 && candidates.length === 1)))
    ) {
      candidates[activeIdx].removeAttribute("data-lavish-done");
    } else {
      const target = action === "done" ? candidates[0] : candidates[1] || candidates[0];
      if (target) {
        ensureDoneStyle();
        target.setAttribute("data-lavish-done", "true");
        normalizeDoneElement(target);
      }
    }
    if (action === "done-parent") selection?.removeAllRanges?.();
    renderOverlays();
    reportDoneBoxes();
    return true;
  }

  function openCommentForMark(mark) {
    if (!mark) return;
    if (mark.hasComment) {
      postArtifactMessage("lavish:activateAnnotationMark", {
        id: mark.id,
        state: mark.state,
        selector: mark.selector,
      });
      return;
    }
    const resolved = resolveTextTarget(mark.target || { text: mark.text, selector: mark.selector }, mark.selector);
    const fallbackEl = resolved?.anchor || safeQuerySelector(mark.selector) || document.body;
    const range = resolved?.range || null;
    const markRect = renderedMarkRects.filter((entry) => entry.mark === mark).at(-1)?.rect || null;
    const target = mark.target || {
      type: "text-range",
      text: mark.text,
      selector: mark.selector,
      commonAncestorSelector: mark.selector,
    };
    showAnnotationCard(fallbackEl, {
      context: {
        uid: "",
        selector: mark.selector,
        tag: "text",
        text: String(target.text || mark.text || "").slice(0, 240),
        target,
        element: fallbackEl,
        ...(range ? { range } : {}),
        replaceMarkIds: [mark.id],
      },
      ...(range ? { range } : markRect ? { point: { x: markRect.left, y: markRect.bottom } } : {}),
    });
  }

  // Marks top to bottom as the reader sees them, commented or not: the order the arrows step through.
  function marksInReadingOrder(resolvedMarks) {
    return resolvedMarks
      .map(({ item, resolved }) => ({
        item,
        rect: isElementMark(item)
          ? resolved.anchor?.getBoundingClientRect?.() || [...resolved.range.getClientRects()][0]
          : [...resolved.range.getClientRects()][0],
      }))
      .filter(({ rect }) => rect)
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)
      .map(({ item }) => item);
  }

  // Moves a box to the middle of the view (a box taller than the view to its top) with explicit
  // scroll offsets. Artifacts with sticky rails, clipped layouts or a CSS smooth scroll-behavior can
  // leave scrollIntoView stalled or short of its target, while `instant` offsets land every time.
  // `includeAnchor` scrolls the anchor itself too, for words inside a scrollable anchor; an element
  // that is the target scrolls only its ancestors. The window moves sideways only for a box outside
  // the view, so a page without horizontal overflow keeps its position.
  function scrollIntoCenter(anchor, getRect, { includeAnchor = false } = {}) {
    const offsetFor = (start, size, viewStart, viewSize) =>
      size > viewSize ? start - viewStart - 24 : start + size / 2 - (viewStart + viewSize / 2);
    // Instant, like the window below: a smooth scroll-behavior would only start an animation, so the
    // marker and the window offset would use the old position.
    const scrollInstantly = (el, top, left) => {
      try {
        el.scrollTo({ top, left, behavior: "instant" });
      } catch {
        el.scrollTop = top;
        el.scrollLeft = left;
      }
    };
    // The body counts: an app-shell layout (html{overflow:hidden}, body{overflow:auto}) scrolls only
    // the body. On an ordinary page its scroll offset is inert and the window below does the work.
    for (
      let p = includeAnchor ? anchor : anchor?.parentElement;
      p && p !== document.documentElement;
      p = p.parentElement
    ) {
      const style = getComputedStyle(p);
      const box = p.getBoundingClientRect();
      if (p.scrollHeight > p.clientHeight + 1 && /(auto|scroll)/.test(style.overflowY || "")) {
        const rect = getRect();
        scrollInstantly(p, p.scrollTop + offsetFor(rect.top, rect.height, box.top, p.clientHeight), p.scrollLeft || 0);
      }
      if (p.scrollWidth > p.clientWidth + 1 && /(auto|scroll)/.test(style.overflowX || "")) {
        const rect = getRect();
        scrollInstantly(p, p.scrollTop || 0, p.scrollLeft + offsetFor(rect.left, rect.width, box.left, p.clientWidth));
      }
    }
    const rect = getRect();
    const viewWidth = window.innerWidth || 1200;
    const top = (window.scrollY || 0) + offsetFor(rect.top, rect.height, 0, window.innerHeight || 800);
    const left =
      (window.scrollX || 0) +
      (rect.left < 0 || rect.right > viewWidth ? offsetFor(rect.left, rect.width, 0, viewWidth) : 0);
    try {
      window.scrollTo?.({ top, left, behavior: "instant" });
    } catch {
      window.scrollTo?.(left, top);
    }
  }

  // Brings one mark's words to the middle of the view and selects it. With `syncChat` the
  // conversation highlights the matching note too, the same way a click on the mark does.
  // An element mark targets the element box, not its text range: an empty container's range is a
  // null rectangle and would scroll the page to its top instead of to the container.
  function focusAnnotationMark(mark, { syncChat = false } = {}) {
    const resolved = resolveMarkTarget(mark);
    if (!resolved) return false;
    const elementMark = isElementMark(mark);
    scrollIntoCenter(
      resolved.anchor,
      () => (elementMark ? resolved.anchor.getBoundingClientRect() : resolved.range.getBoundingClientRect()),
      { includeAnchor: !elementMark },
    );
    selectedMarkId = mark.id;
    renderOverlays();
    if (syncChat) {
      postArtifactMessage("lavish:activateAnnotationMark", {
        id: mark.id,
        state: mark.state,
        selector: mark.selector,
        selectOnly: true,
      });
    }
    return true;
  }

  function renderOverlays() {
    if (overlayFrame) {
      window.cancelAnimationFrame?.(overlayFrame);
      overlayFrame = 0;
    }
    const doneElements = queryAll('[data-lavish-done="true"]');
    if (!annotationMarks.length && !doneRanges.length && !doneElements.length && !shadow) return;
    const root = ensureShadow();
    const focusKey = overlayFocusKey || root.activeElement?.getAttribute?.("data-lavish-overlay") || "";
    overlayFocusKey = "";
    overlayControls = new Map();
    for (const el of [...(root.children || [])]) {
      if (
        /lavish-(?:persistent-mark|mark-badge|mark-add-comment|mark-nav|done-range|done-badge)/.test(el.className || "")
      )
        el.remove();
    }
    const resolvedMarks = [];
    annotationMarks.forEach((item, index) => {
      const resolved = resolveMarkTarget(item);
      if (resolved) resolvedMarks.push({ item, resolved, index });
    });
    const markOrder = marksInReadingOrder(resolvedMarks);
    renderedMarkRects = [];
    renderedDoneRects = [];
    function position(el, rect) {
      el.style.left = rect.left + "px";
      el.style.top = rect.top + "px";
      el.style.width = rect.width + "px";
      el.style.height = rect.height + "px";
    }
    // Arrows sit beside their badge, whose width is read only after every overlay element is
    // written, so a render forces one layout instead of one per mark.
    const navPlacements = [];
    function draw(item, resolved, order, done) {
      const isSelected = !done && item.id === selectedMarkId;
      let rects = isElementMark(item)
        ? []
        : [...resolved.range.getClientRects()]
            .map((rect) => clipRectToScrollAncestors(rect, resolved.anchor))
            .filter(Boolean);
      // An element mark stands for its whole element, padding included, so it always draws and
      // hit-tests through the element box; a text mark keeps its line-range geometry. An empty
      // container simply has no range rectangles, and the box covers it the same way — and the
      // range is not even measured for element marks, because a container range can hand back
      // hundreds of rectangles that are all replaced by the one element box right after.
      // An element spanning nearly the whole viewport would tint every visible line (a body-wide
      // note turned whole surfaces into "yellow mush"), so such marks outline instead of filling.
      let documentWide = false;
      if (isElementMark(item) && resolved.anchor) {
        const rawBox = resolved.anchor.getBoundingClientRect();
        const box = rawBox && clipRectToScrollAncestors(rawBox, resolved.anchor);
        if (box) {
          rects = [box];
          documentWide =
            rawBox.width >= 0.9 * (window.innerWidth || 0) && rawBox.height >= 0.9 * (window.innerHeight || 0);
        }
      }
      for (const rect of rects) {
        const el = document.createElement("div");
        el.className = done
          ? "lavish-done-range"
          : `lavish-persistent-mark ${item.hasComment ? "is-commented" : "is-marker-only"}${item.state === "sent" ? " is-sent" : ""}${isSelected ? " is-selected" : ""}${documentWide ? " is-document-wide" : ""}`;
        position(el, rect);
        root.appendChild(el);
        if (done) renderedDoneRects.push({ item, rect });
        else renderedMarkRects.push({ mark: item, rect, order });
      }
      const last = rects.at(-1);
      if (!last) return;
      const button = document.createElement("button");
      button.type = "button";
      button.className = done
        ? "lavish-done-badge"
        : item.hasComment
          ? "lavish-mark-badge"
          : `lavish-mark-add-comment${isSelected || item.id === hoveredMarkId ? " is-visible" : ""}`;
      const navIndex = done ? -1 : markOrder.indexOf(item);
      const hasNav = navIndex !== -1 && markOrder.length > 1;
      if (!done) item._nav = null;
      const badgeLeft = Math.min(
        (window.innerWidth || 1200) - 48 - (hasNav ? MARK_NAV_WIDTH : 0),
        Math.max(4, last.right - 2),
      );
      button.style.left = badgeLeft + "px";
      button.style.top = Math.max(4, last.top - 8) + "px";
      if (done) button.textContent = "✓ Done";
      else if (item.hasComment)
        button.innerHTML =
          '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 2h12v9H7l-3 3v-3H2z" stroke="currentColor"/></svg> ' +
          escapeAnnotationText(item.badgeNumber || "");
      else button.textContent = "+ 💬";
      onOverlayActivate(button, (done ? "done-range:" : "mark:") + item.id, () => {
        if (done) {
          doneRanges = doneRanges.filter((entry) => entry !== item);
          scheduleOverlayRender();
          reportDoneBoxes();
        } else {
          selectedMarkId = item.id;
          openCommentForMark(item);
        }
      });
      if (!done && !item.hasComment) {
        button.addEventListener("mouseenter", () => button.classList.add("is-visible"));
        button.addEventListener("mouseleave", () => {
          if (item.id !== selectedMarkId) button.classList.remove("is-visible");
        });
        item._button = button;
      }
      root.appendChild(button);
      if (!hasNav) return;
      // Up and down step to the marked passage above or below this one. Beside a bare marker they
      // show and hide with its + comment button.
      const nav = document.createElement("div");
      nav.className = item.hasComment
        ? "lavish-mark-nav"
        : `lavish-mark-nav is-marker-only${isSelected || item.id === hoveredMarkId ? " is-visible" : ""}`;
      if (!item.hasComment) item._nav = nav;
      navPlacements.push({ nav, button, badgeLeft });
      nav.style.top = button.style.top;
      for (const step of [-1, 1]) {
        const arrow = document.createElement("button");
        arrow.type = "button";
        arrow.setAttribute("aria-label", step < 0 ? "Previous mark" : "Next mark");
        arrow.title = step < 0 ? "Previous mark" : "Next mark";
        arrow.innerHTML =
          '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="' +
          (step < 0 ? "M3.5 10 8 5.5 12.5 10" : "M3.5 6 8 10.5 12.5 6") +
          '" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        const neighbour = markOrder[navIndex + step];
        arrow.disabled = !neighbour;
        onOverlayActivate(arrow, "nav:" + item.id + ":" + step, () => {
          if (!neighbour) return;
          // A keyboard user keeps stepping: the focus moves to the same arrow beside the mark reached,
          // or to the opposite one once that mark is the last in this direction.
          if (root.activeElement === arrow)
            overlayFocusKey = "nav:" + neighbour.id + ":" + (markOrder[navIndex + 2 * step] ? step : -step);
          focusAnnotationMark(neighbour, { syncChat: true });
        });
        nav.appendChild(arrow);
      }
      root.appendChild(nav);
    }
    for (const { item, resolved, index } of resolvedMarks) draw(item, resolved, index, false);
    doneRanges.forEach((item) => {
      if (item.anchor.isConnected !== false) draw(item, item, 0, true);
    });
    const badgeWidths = navPlacements.map(({ button }) => button.getBoundingClientRect?.().width || 36);
    navPlacements.forEach(({ nav, badgeLeft }, i) => (nav.style.left = badgeLeft + badgeWidths[i] + 3 + "px"));
    for (const el of doneElements) {
      const rect = clipRectToScrollAncestors(el.getBoundingClientRect(), el);
      if (!rect) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "lavish-done-badge";
      button.style.left = rect.right + "px";
      button.style.top = rect.top + "px";
      button.textContent = "✓ Done";
      onOverlayActivate(button, "done-element:" + uid(el), () => {
        el.removeAttribute("data-lavish-done");
        scheduleOverlayRender();
        reportDoneBoxes();
      });
      root.appendChild(button);
    }
    if (focusKey) overlayControls.get(focusKey)?.focus({ preventScroll: true });
  }

  // Overlay controls are rebuilt whenever the artifact mutates. An artifact that toggles a tooltip
  // on mousedown swaps the control out between press and release, and the browser then fires no
  // `click`. A press records the control's logical `key`, which every rebuilt copy shares, and its
  // pointer. Only the same pointer released over a copy with that key activates it: a release that
  // began elsewhere does nothing, and neither does a touch dragged off the control, whose release
  // implicit pointer capture still delivers to it. A click without a pointer (keyboard,
  // `element.click()`) still activates.
  function onOverlayActivate(button, key, activate) {
    button.setAttribute("data-lavish-overlay", key);
    overlayControls.set(key, button);
    button.addEventListener("pointerdown", (event) => {
      if (event.button === 0) pressedOverlay = { key, pointerId: event.pointerId };
    });
    button.addEventListener("pointerup", (event) => {
      if (event.button !== 0) return;
      const pressed =
        pressedOverlay?.key === key &&
        pressedOverlay.pointerId === event.pointerId &&
        pointInRect(button.getBoundingClientRect(), event.clientX, event.clientY, 4);
      pressedOverlay = null;
      if (!pressed) return;
      event.preventDefault();
      event.stopPropagation();
      activate();
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!event.detail) activate();
    });
  }

  // A release or cancel anywhere else ends the press, so a later release over a control that was
  // never pressed cannot activate it.
  window.addEventListener("pointerup", () => (pressedOverlay = null));
  window.addEventListener("pointercancel", () => (pressedOverlay = null));

  function scheduleOverlayRender() {
    if (overlayFrame) return;
    overlayFrame = window.requestAnimationFrame(renderOverlays);
  }

  window.addEventListener("scroll", scheduleOverlayRender, { passive: true, capture: true });
  window.addEventListener("resize", scheduleOverlayRender, { passive: true });
  window.addEventListener("load", scheduleOverlayRender, true);
  document.addEventListener("toggle", scheduleOverlayRender, true);
  if (typeof ResizeObserver !== "undefined") {
    overlayObserver = new ResizeObserver(scheduleOverlayRender);
    overlayObserver.observe(document.documentElement);
    if (document.body) overlayObserver.observe(document.body);
  }
  if (typeof MutationObserver !== "undefined") {
    new MutationObserver((mutations) => {
      if (mutations.some((mutation) => !isLavishUi(mutation.target))) scheduleOverlayRender();
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
  }
  document.addEventListener(
    "mousemove",
    (event) => {
      if (!isLavishUi(event.target)) {
        lastPointerTarget = event.target;
        lastPointerClient = { x: event.clientX, y: event.clientY };
      }
      for (const mark of annotationMarks)
        if (mark._button) {
          const hit = renderedMarkRects.some(
            (entry) => entry.mark === mark && pointInRect(entry.rect, event.clientX, event.clientY, 18),
          );
          const near = [mark._button, mark._nav].some(
            (el) => el && pointInRect(el.getBoundingClientRect(), event.clientX, event.clientY, 10),
          );
          const pointerNear = hit || near || mark._button.matches(":hover");
          const visible = mark.id === selectedMarkId || pointerNear;
          if (pointerNear) hoveredMarkId = mark.id;
          else if (hoveredMarkId === mark.id) hoveredMarkId = "";
          mark._button.classList.toggle("is-visible", visible);
          mark._nav?.classList.toggle("is-visible", visible);
        }
    },
    true,
  );
  document.addEventListener(
    "mouseover",
    (event) => {
      if (!isLavishUi(event.target)) {
        lastPointerTarget = event.target;
        lastPointerClient = { x: event.clientX, y: event.clientY };
      }
    },
    true,
  );

  function queuePrompt(prompt, options = {}) {
    const originElement = options.element || document.activeElement || document.body;
    /** @type {{ uid: string, prompt: string, selector: string, tag: string, text: string, target?: unknown, attachments?: Array<{ id: string, name?: string }>, _lavishQueueKey?: string, replace_mark_ids?: string[] }} */
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
    if (Array.isArray(options.replaceMarkIds) && options.replaceMarkIds.length) {
      item.replace_mark_ids = options.replaceMarkIds.map(String).filter(Boolean);
    }
    if (options.data) item.prompt += "\n\nContext data:\n" + JSON.stringify(options.data, null, 2);
    // Attach only the client-controllable fields (server-vetted id + display name);
    // the chrome forwards these and the server re-resolves each id (see queuePrompts).
    if (Array.isArray(options.attachments) && options.attachments.length) {
      const attachments = options.attachments
        .filter((attachment) => attachment && attachment.id)
        .map((attachment) =>
          attachment.name
            ? { id: String(attachment.id), name: String(attachment.name) }
            : { id: String(attachment.id) },
        );
      if (attachments.length) item.attachments = attachments;
    }

    const questionScope = originElement.closest?.("[data-lavish-question]");
    const requestId = questionScope ? "question-" + ++questionQueueSequence : "";
    if (requestId) {
      const keys = new Set(
        lavishQuestionControls()
          .filter((entry) => entry.scope === questionScope)
          .map((entry) => entry.key),
      );
      pendingQuestionQueues.set(
        requestId,
        collectReviewState().fields.filter((field) => keys.has(field.key)),
      );
      if (pendingQuestionQueues.size > 200) pendingQuestionQueues.delete(pendingQuestionQueues.keys().next().value);
    }
    postArtifactMessage("lavish:queuePrompt", { prompt: item, review_request_id: requestId });
  }

  function sendQueuedPrompts() {
    postArtifactMessage("lavish:sendQueuedPrompts");
  }

  function endSession() {
    postArtifactMessage("lavish:endSession");
  }

  function snapshot() {
    const lines = [];

    function walk(el, depth) {
      if (!(el instanceof Element) || depth > 6 || isLavishUi(el)) return;

      const c = context(el, { needSelector: false });
      const name = c.text ? ' "' + c.text.slice(0, 80).replace(/"/g, "'") + '"' : "";
      lines.push("  ".repeat(depth) + "uid=" + c.uid + " " + c.tag + name);
      for (const child of el.children) walk(child, depth + 1);
    }

    walk(document.body, 0);
    return lines.join("\n");
  }

  const layoutAuditSettleMs = 180;
  const layoutAuditMaxWaitMs = 2000;
  const layoutAuditAnimationMaxWaitMs = 4000;
  const layoutAuditStableSampleMs = 120;
  let layoutAuditTimer = 0;
  let layoutAuditRun = 0;
  let lastLayoutAuditSignature = null;
  let layoutAuditPublishRequested = false;
  let layoutAuditPassSequence = 0;

  function toPixelNumber(value) {
    const parsed = Number.parseFloat(String(value || "0"));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function roundedOverflowPx(value) {
    return Math.round(Math.max(0, value) * 10) / 10;
  }

  function elementText(el) {
    return String(el?.innerText || el?.textContent || "")
      .trim()
      .replace(/\s+/g, " ");
  }

  function directText(el) {
    return [...(el?.childNodes || [])]
      .filter((node) => node.nodeType === 3)
      .map((node) => String(node.textContent || ""))
      .join(" ")
      .trim()
      .replace(/\s+/g, " ");
  }

  function isRequiredControl(el) {
    if (!el?.matches?.("button,input,select,textarea,a[href],summary,[data-lavish-action],[role]")) return false;
    if (el.matches("input[type='hidden'],[disabled],[aria-disabled='true']")) return false;
    if (!el.hasAttribute("role")) return true;
    return new Set(["button", "link", "checkbox", "radio", "switch", "textbox", "combobox"]).has(
      String(el.getAttribute("role") || "").toLowerCase(),
    );
  }

  function isSemanticTextBoundary(el) {
    return Boolean(
      el?.matches?.(
        "p,h1,h2,h3,h4,h5,h6,button,label,a[href],li,dt,dd,th,td,legend,figcaption,summary,[role='button'],[role='link'],[role='alert'],[role='status']",
      ),
    );
  }

  function hasSemanticTextBoundaryAncestor(el) {
    let node = el?.parentElement;
    while (node && node !== document.body && node !== document.documentElement) {
      if (isSemanticTextBoundary(node)) return true;
      node = node.parentElement;
    }
    return false;
  }

  function auditedText(el) {
    return isSemanticTextBoundary(el) ? elementText(el) : directText(el);
  }

  function rectArea(rect) {
    return Math.max(0, rect.width) * Math.max(0, rect.height);
  }

  function isVisibleForLayoutAudit(el, rect = el.getBoundingClientRect()) {
    if (!el || isLavishUi(el) || rect.width <= 0 || rect.height <= 0) return false;
    let node = el;
    while (node && node.nodeType === 1) {
      const style = getComputedStyle(node);
      const opacity = Number.parseFloat(style.opacity || "1");
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.contentVisibility === "hidden" ||
        (Number.isFinite(opacity) && opacity <= 0.01)
      ) {
        return false;
      }
      node = node.parentElement;
    }
    return true;
  }

  function isIntentionalHorizontalScroller(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    const overflowX = getComputedStyle(el).overflowX;
    return overflowX === "auto" || overflowX === "scroll";
  }

  function isIntentionalVerticalScroller(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    const overflowY = getComputedStyle(el).overflowY;
    return overflowY === "auto" || overflowY === "scroll";
  }

  function hasIntentionalHorizontalScrollerAncestor(el) {
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement) {
      if (isIntentionalHorizontalScroller(node)) return true;
      node = node.parentElement;
    }
    return false;
  }

  function hasIntentionalVerticalScrollerAncestor(el) {
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement) {
      if (isIntentionalVerticalScroller(node)) return true;
      node = node.parentElement;
    }
    return false;
  }

  function hasReachableVerticalScrollerAncestor(el) {
    let node = el?.parentElement;
    const locked = rootVerticalScrollLocked();
    const scrollY = locked ? 0 : Number(window.scrollY || window.pageYOffset || 0);
    const pageBoundary = locked
      ? window.innerHeight || 0
      : document.documentElement.scrollHeight || window.innerHeight || 0;
    while (node && node !== document.body && node !== document.documentElement) {
      if (isIntentionalVerticalScroller(node)) {
        const rect = node.getBoundingClientRect();
        const top = rect.top + scrollY;
        const bottom = rect.bottom + scrollY;
        if (bottom > 0 && top < pageBoundary) return true;
      }
      node = node.parentElement;
    }
    return false;
  }

  function rootVerticalScrollLocked() {
    const values = [document.documentElement, document.body]
      .filter(Boolean)
      .map((node) => getComputedStyle(node).overflowY);
    return values.some((value) => value === "hidden" || value === "clip");
  }

  function paddingBoxRect(el) {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return {
      left: rect.left + toPixelNumber(style.borderLeftWidth),
      right: rect.right - toPixelNumber(style.borderRightWidth),
      top: rect.top + toPixelNumber(style.borderTopWidth),
      bottom: rect.bottom - toPixelNumber(style.borderBottomWidth),
    };
  }

  function textNodesForAudit(el) {
    const descendants = isSemanticTextBoundary(el);
    const nodes = [];
    const pending = [...(el?.childNodes || [])];
    while (pending.length > 0) {
      const node = pending.shift();
      if (!node) continue;
      if (node.nodeType === 3) {
        if (String(node.textContent || "").trim()) nodes.push(node);
      } else if (descendants && node.nodeType === 1) {
        pending.unshift(...(node.childNodes || []));
      }
    }
    return nodes;
  }

  function textFragmentsForAudit(el) {
    const fragments = [];
    for (const textNode of textNodesForAudit(el)) {
      const range = document.createRange();
      range.selectNodeContents(textNode);
      fragments.push(...[...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0));
      range.detach?.();
    }
    return fragments;
  }

  function isIntentionalTextTruncation(style) {
    return style.textOverflow === "ellipsis" || Number.parseInt(style.webkitLineClamp || "0", 10) > 0;
  }

  function hasVisualMask(style) {
    const maskImage = String(style.maskImage || style.webkitMaskImage || "none").toLowerCase();
    const clipPath = String(style.clipPath || "none").toLowerCase();
    return (maskImage !== "none" && maskImage !== "") || (clipPath !== "none" && clipPath !== "");
  }

  function isRoundedOverflowMask(style) {
    const clips =
      style.overflowX === "hidden" ||
      style.overflowX === "clip" ||
      style.overflowY === "hidden" ||
      style.overflowY === "clip";
    if (!clips) return false;
    return [
      style.borderTopLeftRadius,
      style.borderTopRightRadius,
      style.borderBottomRightRadius,
      style.borderBottomLeftRadius,
    ].some((value) => toPixelNumber(value) > 0);
  }

  function isDiagramLayoutElement(el) {
    return Boolean(el?.closest?.(".mermaid,svg,[data-lavish-ui]"));
  }

  function hasVisualMaskAncestor(el) {
    let node = el;
    while (node && node.nodeType === 1) {
      const style = getComputedStyle(node);
      if (hasVisualMask(style) || isRoundedOverflowMask(style)) return true;
      node = node.parentElement;
    }
    return false;
  }

  function clippingBoundariesFor(el) {
    const boundaries = [];
    let node = el?.parentElement;
    while (node && node !== document.body && node !== document.documentElement) {
      const style = getComputedStyle(node);
      const axes = [];
      if (style.overflowX === "hidden" || style.overflowX === "clip") axes.push("horizontal");
      if (style.overflowY === "hidden" || style.overflowY === "clip") axes.push("vertical");
      if (axes.length > 0 && !hasVisualMask(style) && !isRoundedOverflowMask(style)) {
        boundaries.push({ el: node, box: paddingBoxRect(node), axes });
      }
      node = node.parentElement;
    }
    return boundaries;
  }

  function isStandardVisuallyHidden(el, style, rect) {
    const positioned = style.position === "absolute" || style.position === "fixed";
    const clipped = style.overflowX === "hidden" || style.overflowX === "clip";
    const legacyClip = String(style.clip || "").toLowerCase();
    const clipPath = String(style.clipPath || "").toLowerCase();
    const hasClip = legacyClip !== "auto" || (clipPath !== "none" && clipPath !== "");
    return positioned && clipped && rect.width <= 2 && rect.height <= 2 && (style.whiteSpace === "nowrap" || hasClip);
  }

  function hasStandardVisuallyHiddenAncestor(el) {
    let node = el;
    while (node && node.nodeType === 1) {
      const rect = node.getBoundingClientRect();
      if (isStandardVisuallyHidden(node, getComputedStyle(node), rect)) return true;
      node = node.parentElement;
    }
    return false;
  }

  function isExcludedLayoutAuditElement(el) {
    return isDiagramLayoutElement(el) || hasVisualMaskAncestor(el) || hasStandardVisuallyHiddenAncestor(el);
  }

  function collectLayoutAuditElements() {
    return [...(document.body?.querySelectorAll("*") || [])]
      .filter((el) => el instanceof Element && !isLavishUi(el))
      .slice(0, 800);
  }

  function pushLayoutFinding(findings, seen, finding) {
    if (finding.severity !== "error") return;
    const selectorValue = finding.selector || "";
    const axis = finding.axis === "vertical" ? "vertical" : "horizontal";
    const key = `${finding.kind}:${selectorValue}:${axis}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({
      selector: selectorValue,
      kind: String(finding.kind || "layout-failure"),
      axis,
      overflowPx: roundedOverflowPx(finding.overflowPx),
      viewportWidth: Math.round(Number(finding.viewportWidth) || window.innerWidth || 0),
      severity: "error",
    });
  }

  function auditSevereTextOverflow(el, viewportWidth, findings, seen, animationTargets, failedRoots) {
    if (el === document.body || el === document.documentElement) return;
    if (isExcludedLayoutAuditElement(el)) return;
    if (!auditedText(el)) return;
    if (!isSemanticTextBoundary(el) && hasSemanticTextBoundaryAncestor(el)) return;
    if (failedRoots.some((root) => root.contains(el))) return;
    if (isAnimationAssociatedWithElement(el, animationTargets)) return;

    const rect = el.getBoundingClientRect();
    if (!isVisibleForLayoutAudit(el, rect)) return;
    const style = getComputedStyle(el);
    const fragments = textFragmentsForAudit(el);
    let severe = classifySevereTextOverflow({
      fragments,
      box: paddingBoxRect(el),
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      isTruncated: isIntentionalTextTruncation(style),
      isVisuallyHidden: false,
    });
    let failureRoot = el;
    for (const boundary of clippingBoundariesFor(el)) {
      const ancestorFailure = classifySevereTextOverflow({
        fragments,
        box: boundary.box,
        overflowX: boundary.axes.includes("horizontal") ? "hidden" : "auto",
        overflowY: boundary.axes.includes("vertical") ? "hidden" : "auto",
        isTruncated: isIntentionalTextTruncation(style),
        isVisuallyHidden: false,
      });
      if (ancestorFailure && (!severe || ancestorFailure.overflowPx > severe.overflowPx)) {
        severe = ancestorFailure;
        failureRoot = boundary.el;
      }
    }
    if (!severe) return;

    failedRoots.push(failureRoot);
    pushLayoutFinding(findings, seen, {
      selector: selector(failureRoot),
      kind: severe.kind,
      axis: severe.axis,
      overflowPx: severe.overflowPx,
      viewportWidth,
      severity: "error",
    });
  }

  function materiallyEscapesViewport(rect, viewportWidth, minOutsidePx) {
    return classifyMaterialRectEscape({
      rect,
      boundary: { left: 0, right: viewportWidth, top: 0, bottom: window.innerHeight || 0 },
      axes: ["horizontal"],
      minOutsidePx,
    });
  }

  function elementHasMaterialViewportEscape(el, viewportWidth, animationTargets) {
    if (hasIntentionalHorizontalScrollerAncestor(el)) return false;
    if (isAnimationAssociatedWithElement(el, animationTargets)) return false;
    if (isExcludedLayoutAuditElement(el)) return false;
    if (!isSemanticTextBoundary(el) && hasSemanticTextBoundaryAncestor(el)) return false;

    const rect = el.getBoundingClientRect();
    if (!isVisibleForLayoutAudit(el, rect)) return false;
    const style = getComputedStyle(el);
    const positioned = style.position === "absolute" || style.position === "fixed" || style.position === "sticky";
    if (positioned && !isRequiredControl(el)) return false;
    if (isRequiredControl(el)) {
      return materiallyEscapesViewport(rect, viewportWidth, 4)?.side === "end";
    }
    if (!auditedText(el)) return false;
    const materialPx = Math.max(24, viewportWidth * 0.05);
    return textFragmentsForAudit(el).some(
      (fragment) => materiallyEscapesViewport(fragment, viewportWidth, materialPx)?.side === "end",
    );
  }

  function auditUnreachableLeftText(el, viewportWidth, findings, seen, animationTargets) {
    if (hasIntentionalHorizontalScrollerAncestor(el)) return;
    if (isAnimationAssociatedWithElement(el, animationTargets)) return;
    if (isExcludedLayoutAuditElement(el)) return;
    if (!isSemanticTextBoundary(el) && hasSemanticTextBoundaryAncestor(el)) return;
    if (!auditedText(el)) return;
    const rect = el.getBoundingClientRect();
    if (!isVisibleForLayoutAudit(el, rect)) return;
    const style = getComputedStyle(el);
    if (["absolute", "fixed", "sticky"].includes(style.position) && !isRequiredControl(el)) return;
    const materialPx = Math.max(24, viewportWidth * 0.05);
    let escape = null;
    for (const fragment of textFragmentsForAudit(el)) {
      const candidate = materiallyEscapesViewport(fragment, viewportWidth, materialPx);
      if (candidate?.side === "start" && (!escape || candidate.overflowPx > escape.overflowPx)) escape = candidate;
    }
    if (!escape) return;
    pushLayoutFinding(findings, seen, {
      selector: selector(el),
      kind: "viewport-unreachable-content",
      axis: "horizontal",
      overflowPx: escape.overflowPx,
      viewportWidth,
      severity: "error",
    });
  }

  function auditRequiredControlBounds(el, viewportWidth, findings, seen, animationTargets, failedRoots) {
    if (!isRequiredControl(el) || isExcludedLayoutAuditElement(el)) return;
    if (isAnimationAssociatedWithElement(el, animationTargets)) return;
    const rect = el.getBoundingClientRect();
    if (!isVisibleForLayoutAudit(el, rect)) return;

    let clipped = null;
    for (const boundary of clippingBoundariesFor(el)) {
      const escape = classifyMaterialRectEscape({ rect, boundary: boundary.box, axes: boundary.axes });
      if (escape && (!clipped || escape.overflowPx > clipped.escape.overflowPx)) clipped = { boundary, escape };
    }
    if (clipped && !failedRoots.some((root) => root === clipped.boundary.el || root.contains(clipped.boundary.el))) {
      failedRoots.push(clipped.boundary.el);
      pushLayoutFinding(findings, seen, {
        selector: selector(clipped.boundary.el),
        kind: "clipped-control",
        axis: clipped.escape.axis,
        overflowPx: clipped.escape.overflowPx,
        viewportWidth,
        severity: "error",
      });
    }

    const horizontal = hasIntentionalHorizontalScrollerAncestor(el)
      ? null
      : materiallyEscapesViewport(rect, viewportWidth, 4);
    if (horizontal?.side === "start") {
      pushLayoutFinding(findings, seen, {
        selector: selector(el),
        kind: "viewport-unreachable-control",
        axis: "horizontal",
        overflowPx: horizontal.overflowPx,
        viewportWidth,
        severity: "error",
      });
    }

    const style = getComputedStyle(el);
    const fixedToViewport = style.position === "fixed" || style.position === "sticky";
    const lockedToViewport = rootVerticalScrollLocked() && !hasReachableVerticalScrollerAncestor(el);
    const scrollY = Number(window.scrollY || window.pageYOffset || 0);
    const verticalRect =
      fixedToViewport || lockedToViewport
        ? rect
        : {
            top: rect.top + scrollY,
            bottom: rect.bottom + scrollY,
            height: rect.height,
          };
    const verticalBoundary =
      fixedToViewport || lockedToViewport
        ? { top: 0, bottom: window.innerHeight || 0 }
        : { top: 0, bottom: document.documentElement.scrollHeight };
    const vertical =
      hasReachableVerticalScrollerAncestor(el) || hasIntentionalVerticalScrollerAncestor(el)
        ? null
        : classifyMaterialRectEscape({
            rect: verticalRect,
            boundary: verticalBoundary,
            axes: ["vertical"],
          });
    if (vertical) {
      pushLayoutFinding(findings, seen, {
        selector: selector(el),
        kind: "viewport-unreachable-control",
        axis: "vertical",
        overflowPx: vertical.overflowPx,
        viewportWidth,
        severity: "error",
      });
    }
  }

  function backgroundIsOpaque(el) {
    const style = getComputedStyle(el);
    if (Number.parseFloat(style.opacity || "1") < 0.95) return false;
    const color = String(style.backgroundColor || "")
      .trim()
      .toLowerCase();
    if (!color || color === "transparent") return false;
    const rgba = color.match(/^rgba?\(([^)]+)\)$/);
    if (!rgba) return false;
    const parts = rgba[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 4) return true;
    const alpha = Number(parts[3]);
    return Number.isFinite(alpha) && alpha >= 0.95;
  }

  function effectiveOpacityTo(node, stopParent) {
    let opacity = 1;
    let current = node;
    while (current && current !== stopParent) {
      const value = Number.parseFloat(getComputedStyle(current).opacity || "1");
      if (Number.isFinite(value)) opacity *= value;
      current = current.parentElement;
    }
    return opacity;
  }

  function opaqueSiblingBlocker(el, point, animationTargets) {
    const top = document.elementFromPoint(point.x, point.y);
    if (!(top instanceof Element) || top === el || el.contains(top) || top.contains(el) || isLavishUi(top)) return null;

    const targetAncestors = [];
    let targetNode = el;
    while (targetNode && targetNode !== document.body && targetNode !== document.documentElement) {
      targetAncestors.push(targetNode);
      targetNode = targetNode.parentElement;
    }

    let node = top;
    let foundOpaqueSurface = false;
    while (node && node !== document.body && node !== document.documentElement) {
      if (isAnimationAssociatedWithElement(node, animationTargets)) return null;
      if (backgroundIsOpaque(node)) foundOpaqueSurface = true;
      const siblingOf = targetAncestors.find((target) => target.parentElement === node.parentElement);
      if (siblingOf && foundOpaqueSurface && effectiveOpacityTo(top, node.parentElement) >= 0.95) return node;
      node = node.parentElement;
    }
    return null;
  }

  function isPointClippedByAncestor(el, point) {
    let node = el?.parentElement;
    while (node && node !== document.body && node !== document.documentElement) {
      const style = getComputedStyle(node);
      const clipsX =
        style.overflowX === "hidden" ||
        style.overflowX === "clip" ||
        style.overflowX === "auto" ||
        style.overflowX === "scroll";
      const clipsY =
        style.overflowY === "hidden" ||
        style.overflowY === "clip" ||
        style.overflowY === "auto" ||
        style.overflowY === "scroll";
      if (clipsX || clipsY) {
        const box = paddingBoxRect(node);
        if (clipsX && (point.x < box.left || point.x > box.right)) return true;
        if (clipsY && (point.y < box.top || point.y > box.bottom)) return true;
      }
      node = node.parentElement;
    }
    return false;
  }

  function fragmentSamplePoints(fragment) {
    const xs = [0.2, 0.5, 0.8];
    const ys = [0.2, 0.5, 0.8];
    return xs.flatMap((xRatio) =>
      ys.map((yRatio) => ({
        x: fragment.left + fragment.width * xRatio,
        y: fragment.top + fragment.height * yRatio,
      })),
    );
  }

  function auditSevereTextOcclusion(elements, viewportWidth, findings, seen, animationTargets) {
    const candidates = elements
      .filter((el) => !isExcludedLayoutAuditElement(el))
      .filter((el) => {
        const text = auditedText(el);
        return text.length >= 8 || (text.length > 0 && isRequiredControl(el));
      })
      .filter((el) => isSemanticTextBoundary(el) || !hasSemanticTextBoundaryAncestor(el))
      .filter((el) => isVisibleForLayoutAudit(el))
      .filter((el) => getComputedStyle(el).position === "static")
      .filter((el) => !isAnimationAssociatedWithElement(el, animationTargets))
      .slice(0, 200);
    const failedRoots = [];

    for (const el of candidates) {
      if (failedRoots.some((root) => root.contains(el))) continue;
      const blockers = new Map();
      let totalSamples = 0;
      for (const fragment of textFragmentsForAudit(el)) {
        if (rectArea(fragment) < 16) continue;
        for (const point of fragmentSamplePoints(fragment)) {
          if (point.x < 0 || point.y < 0 || point.x > viewportWidth || point.y > window.innerHeight) continue;
          if (isPointClippedByAncestor(el, point)) continue;
          totalSamples += 1;
          const blocker = opaqueSiblingBlocker(el, point, animationTargets);
          if (blocker) blockers.set(blocker, (blockers.get(blocker) || 0) + 1);
        }
      }
      const occludedSamples = Math.max(0, ...blockers.values());
      if (!isNearTotalOcclusion({ occludedSamples, totalSamples })) continue;
      failedRoots.push(el);
      pushLayoutFinding(findings, seen, {
        selector: selector(el),
        kind: "overlapping-text",
        axis: "horizontal",
        overflowPx: 0,
        viewportWidth,
        severity: "error",
      });
    }
  }

  function auditLayout() {
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const findings = [];
    const seen = new Set();
    const elements = collectLayoutAuditElements();
    const animationTargets = activeAnimationTargets();
    const pageOverflowPx = document.documentElement.scrollWidth - viewportWidth;
    const escapedContent = elements.some((el) => elementHasMaterialViewportEscape(el, viewportWidth, animationTargets));
    if (isMaterialPageOverflow({ overflowPx: pageOverflowPx, viewportWidth, hasEscapedContent: escapedContent })) {
      pushLayoutFinding(findings, seen, {
        selector: "html",
        kind: "page-horizontal-overflow",
        axis: "horizontal",
        overflowPx: pageOverflowPx,
        viewportWidth,
        severity: "error",
      });
    }

    const failedClippingRoots = [];
    for (const el of elements) {
      auditRequiredControlBounds(el, viewportWidth, findings, seen, animationTargets, failedClippingRoots);
    }
    for (const el of elements) {
      auditUnreachableLeftText(el, viewportWidth, findings, seen, animationTargets);
    }
    for (const el of elements) {
      auditSevereTextOverflow(el, viewportWidth, findings, seen, animationTargets, failedClippingRoots);
    }
    auditSevereTextOcclusion(elements, viewportWidth, findings, seen, animationTargets);
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

  function waitForDomHydrationQuiescence() {
    return new Promise((resolve) => {
      if (typeof MutationObserver === "undefined" || !document.documentElement) {
        resolve(false);
        return;
      }
      let observer = null;
      let settleTimer = 0;
      let maxTimer = 0;
      let done = false;
      const finish = (quiescent) => {
        if (done) return;
        done = true;
        if (settleTimer) window.clearTimeout(settleTimer);
        if (maxTimer) window.clearTimeout(maxTimer);
        observer?.disconnect();
        resolve(quiescent);
      };
      const scheduleFinish = () => {
        if (settleTimer) window.clearTimeout(settleTimer);
        settleTimer = window.setTimeout(() => finish(true), layoutAuditSettleMs);
      };

      observer = new MutationObserver(scheduleFinish);
      observer.observe(document.documentElement, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });
      scheduleFinish();
      maxTimer = window.setTimeout(() => finish(false), layoutAuditMaxWaitMs);
    });
  }

  function animationTarget(animation) {
    const target = /** @type {any} */ (animation.effect)?.target;
    if (target instanceof Element) return target;
    return target?.element instanceof Element ? target.element : null;
  }

  function activeDocumentAnimations() {
    if (typeof document.getAnimations !== "function") return [];
    return document
      .getAnimations()
      .filter((animation) => ["running", "pending"].includes(String(animation.playState)))
      .filter((animation) => !isLavishUi(animationTarget(animation)));
  }

  function activeAnimationTargets() {
    return activeDocumentAnimations().map(animationTarget).filter(Boolean);
  }

  function isAnimationAssociatedWithElement(el, targets) {
    return targets.some((target) => target === el || target.contains(el) || el.contains(target));
  }

  async function waitForFiniteAnimationsSettle() {
    const finite = activeDocumentAnimations().filter((animation) => {
      const endTime = Number(animation.effect?.getComputedTiming?.().endTime);
      return Number.isFinite(endTime);
    });
    // Infinite animations are allowed to continue while the audit reports stable findings that
    // are unrelated to their targets. Completeness only waits for finite animations to settle;
    // active animation targets are still used by the audit to suppress motion-associated noise.
    if (finite.length === 0) return true;

    let settled = false;
    await Promise.race([
      Promise.all(finite.map((animation) => animation.finished.catch(() => {}))).then(() => {
        settled = true;
      }),
      new Promise((resolve) => window.setTimeout(resolve, layoutAuditAnimationMaxWaitMs)),
    ]);
    if (!settled) {
      for (const animation of finite) {
        animation.finished.then(
          () => scheduleLayoutAudit(),
          () => scheduleLayoutAudit(),
        );
      }
    }
    return settled;
  }

  // A diagnostic pass reports its own completeness. An incomplete pass is uncertainty, never
  // evidence that a previously detected failure is gone - the inbox preserves prior warnings as
  // `unverified` instead of clearing them.
  function publishLayoutAudit(findings, complete, targetPresenceComplete = false) {
    const severe = findings.filter((finding) => finding?.severity === "error");
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const signature = JSON.stringify({ complete, targetPresenceComplete, viewportWidth, severe });
    if (!layoutAuditPublishRequested && signature === lastLayoutAuditSignature) return;
    layoutAuditPublishRequested = false;
    lastLayoutAuditSignature = signature;
    postArtifactMessage("lavish:layoutDiagnostics", {
      complete,
      artifact_revision: artifactRevision,
      artifact_pass_sequence: ++layoutAuditPassSequence,
      target_presence_complete: targetPresenceComplete === true,
      viewport_width: viewportWidth,
      findings: severe,
    });
  }

  async function runLayoutAudit(runId) {
    await waitForDocumentFontsReady();
    await waitForResizeObserverSettle();
    const animationsSettled = await waitForFiniteAnimationsSettle();
    await waitForAnimationFrames(2);
    if (runId !== layoutAuditRun) return;

    const first = auditLayout();
    await new Promise((resolve) => window.setTimeout(resolve, layoutAuditStableSampleMs));
    await waitForAnimationFrames(2);
    if (runId !== layoutAuditRun) return;
    const second = auditLayout();
    const domHydrationQuiescent = await waitForDomHydrationQuiescence();
    if (runId !== layoutAuditRun) return;
    const final = domHydrationQuiescent ? auditLayout() : second;
    const targetPresenceComplete = document.readyState === "complete" && domHydrationQuiescent;
    publishLayoutAudit(
      findStableLayoutFindings(domHydrationQuiescent ? second : first, final),
      animationsSettled && targetPresenceComplete,
      targetPresenceComplete,
    );
  }

  function scheduleLayoutAudit(publishRequested = false) {
    if (publishRequested) layoutAuditPublishRequested = true;
    if (layoutAuditTimer) window.clearTimeout(layoutAuditTimer);
    const runId = ++layoutAuditRun;
    layoutAuditTimer = window.setTimeout(() => {
      runLayoutAudit(runId).catch(() => {
        if (runId === layoutAuditRun) publishLayoutAudit([], false);
      });
    }, 50);
  }

  function startLayoutAudit() {
    scheduleLayoutAudit();
    window.addEventListener("load", () => scheduleLayoutAudit(), { once: true });
    window.addEventListener("resize", () => scheduleLayoutAudit(), { passive: true });
    window.addEventListener("animationend", () => scheduleLayoutAudit(), { passive: true });
    window.addEventListener("transitionend", () => scheduleLayoutAudit(), { passive: true });
  }

  // The narrow fatal path. A local subresource the artifact declares but the server cannot serve
  // makes the review unusable rather than merely mislaid, so it bypasses the passive inbox. Only
  // same-document (relative or /artifact/-rooted) references count; a remote CDN outage is the
  // viewer's network, not a defect in the artifact.
  function reportLocalAssetFailure(event) {
    const el = event.target;
    if (!(el instanceof Element) || isLavishUi(el)) return;
    const tag = String(el.tagName || "").toLowerCase();
    if (!["img", "script", "link", "source", "video", "audio", "iframe"].includes(tag)) return;
    const raw = String(el.getAttribute("src") || el.getAttribute("href") || "");
    if (!raw) return;
    let resolved;
    try {
      resolved = new URL(raw, document.baseURI);
    } catch {
      return;
    }
    if (resolved.origin !== window.location.origin) return;
    postArtifactMessage("lavish:artifactAssetFailure", {
      detail: "<" + tag + "> could not load " + resolved.pathname,
    });
  }

  window.addEventListener("error", reportLocalAssetFailure, true);

  // ---------------------------------------------------------------------------
  // Review-context preservation. A live reload replaces this document wholesale, so anything the
  // user typed or answered inside it is lost unless the chrome replays it. Lavish only ever
  // replays state it owns: an open annotation card, and controls inside a `data-lavish-question`
  // scope (the documented Lavish input contract). Application-owned form state is left alone
  // because Lavish cannot tell an intentional reset from a preserved answer.
  // ---------------------------------------------------------------------------

  let activeCardContext = null;
  let questionQueueSequence = 0;
  const pendingQuestionQueues = new Map();
  const acknowledgedQuestionValues = new Map();
  function fieldValueSignature(field) {
    return JSON.stringify([field.context, field.value, field.checked, field.selectedValues]);
  }
  let reviewStateTimer = 0;
  let draftRestoreTimer = 0;
  const REVIEW_DRAFT_ANCHOR_SETTLE_MS = 1500;

  // A card the user opened ends the pending late restore for good, not just for the instant the
  // settle timer happens to fire: closing that card reports `card: null`, which retires the stored
  // draft, so a restore landing afterwards would put text the chrome no longer holds back on
  // screen and back into persistence over a card the user already dismissed.
  function cancelPendingDraftRestore() {
    if (!draftRestoreTimer) return;
    window.clearTimeout(draftRestoreTimer);
    draftRestoreTimer = 0;
  }

  function safeQuerySelector(selector) {
    try {
      return document.querySelector(String(selector || ""));
    } catch {
      return null;
    }
  }

  function lavishQuestionControls() {
    const entries = [];
    for (const scope of document.querySelectorAll("[data-lavish-question]")) {
      const question = String(scope.getAttribute("data-lavish-question") || "");
      const controls = [...scope.querySelectorAll("input,select,textarea")];
      controls.forEach((el, index) => {
        const control = /** @type {any} */ (el);
        const type = String(control.getAttribute("type") || control.type || "text").toLowerCase();
        if (["button", "submit", "reset", "file", "image", "password"].includes(type)) return;
        if (entries.length >= 200) return;
        entries.push({
          scope,
          el: control,
          key: [
            question,
            String(control.getAttribute("name") || control.id || ""),
            type,
            String(control.getAttribute("value") || ""),
          ]
            .join("|")
            .slice(0, 300),
          index,
          question,
          type,
          context: JSON.stringify([
            String(scope.textContent || ""),
            scope.getAttribute("data-lavish-question-context") || "",
            scope.closest?.("[data-source-sha256]")?.getAttribute("data-source-sha256") || "",
            controls.map((item) => [
              item.getAttribute("name"),
              item.getAttribute("type"),
              item.getAttribute("value"),
              item.textContent,
            ]),
          ]),
        });
      });
    }
    return entries;
  }

  function collectReviewState() {
    const card = shadow ? shadow.querySelector(".lavish-annotation-card") : null;
    const textarea = card ? card.querySelector("textarea") : null;
    const text = textarea ? String(textarea.value || "") : "";
    return {
      card:
        activeCardContext && text.trim()
          ? {
              selector: String(activeCardContext.selector || ""),
              text: text.slice(0, 4000),
              revision: artifactRevision,
              unbound: activeCardContext.tag === "text",
            }
          : null,
      attachmentsPending: Boolean(
        activeAttachments &&
        (activeAttachments.hasPending() || activeAttachments.hasErrors() || activeAttachments.hasReady()),
      ),
      fields: lavishQuestionControls()
        .map((entry) => ({
          key: entry.key,
          index: entry.index,
          question: entry.question,
          type: entry.type,
          context: entry.context,
          selectedValues: entry.el.options ? [...entry.el.options].filter((o) => o.selected).map((o) => o.value) : null,
          dirty: entry.el.options
            ? [...entry.el.options].some(
                (o, index, options) =>
                  Boolean(o.selected) !==
                  (Boolean(o.defaultSelected) ||
                    (!entry.el.multiple && !options.some((option) => option.defaultSelected) && index === 0)),
              )
            : entry.type === "checkbox" || entry.type === "radio"
              ? Boolean(entry.el.checked) !== Boolean(entry.el.defaultChecked)
              : String(entry.el.value ?? "") !== String(entry.el.defaultValue ?? ""),
          value: String(entry.el.value === undefined || entry.el.value === null ? "" : entry.el.value).slice(0, 2000),
          checked: entry.type === "checkbox" || entry.type === "radio" ? Boolean(entry.el.checked) : null,
        }))
        .map((field) => ({
          ...field,
          dirty: acknowledgedQuestionValues.has(field.key)
            ? acknowledgedQuestionValues.get(field.key) !== fieldValueSignature(field)
            : field.dirty,
        })),
    };
  }

  function scheduleReviewStateReport() {
    if (reviewStateTimer) window.clearTimeout(reviewStateTimer);
    reviewStateTimer = window.setTimeout(() => {
      reviewStateTimer = 0;
      postArtifactMessage("lavish:reviewState", { state: collectReviewState() });
    }, 120);
  }

  function restoreReviewState(state) {
    if (!state || typeof state !== "object") return;
    const fields = Array.isArray(state.fields) ? state.fields : [];
    if (fields.length) {
      const entries = lavishQuestionControls();
      for (const field of fields) {
        const match = entries.find((entry) => entry.key === field.key && entry.context === field.context);
        if (!match) {
          if (field.dirty || (!field.context && (field.value || field.checked))) {
            postArtifactMessage("lavish:reviewDraftRecovered", {
              field,
              text:
                String(field.question || "Question") +
                ": " +
                (Array.isArray(field.selectedValues)
                  ? JSON.stringify(field.selectedValues)
                  : field.checked !== null
                    ? String(field.value || "") + " (checked: " + Boolean(field.checked) + ")"
                    : String(field.value ?? "")),
            });
          }
          continue;
        }
        // No synthetic change/input events: the artifact's own handlers queue prompts, and
        // replaying them would silently re-queue answers the user already sent.
        if (match.el.options && Array.isArray(field.selectedValues)) {
          for (const option of match.el.options) option.selected = field.selectedValues.includes(option.value);
        } else if (field.checked === null) match.el.value = String(field.value ?? "");
        else match.el.checked = Boolean(field.checked);
        if (field.dirty === false) acknowledgedQuestionValues.set(field.key, fieldValueSignature(field));
      }
    }
    const card = state.card;
    if (card && card.unbound) {
      postArtifactMessage("lavish:reviewDraftRecovered", { card, text: String(card.text || "") });
      return;
    }
    if (!card || !card.selector || !String(card.text || "").trim()) return;
    const target = safeQuerySelector(card.selector);
    if (!target) {
      // The load event says the document parsed, not that it finished rendering: a section this
      // page builds in script, or a Mermaid diagram, arrives later. Ask again once it has had
      // time to appear, and restore the card if it did. Only then is the anchor's absence an
      // answer worth reporting - the chrome cannot see into this document, and a draft it is
      // never told about is retried against every later load.
      cancelPendingDraftRestore();
      draftRestoreTimer = window.setTimeout(() => {
        draftRestoreTimer = 0;
        // The user may have opened a card of their own inside the settle window, and
        // `showAnnotationCard` closes whatever is open before it draws. Restoring over live
        // typing destroys text nothing has carried to the chrome yet, so a card on screen ends
        // this attempt: the draft is still stored, and the next load tries again.
        if (activeCardContext) return;
        const late = safeQuerySelector(card.selector);
        if (late) {
          showAnnotationCard(late, { restoreText: String(card.text) });
          return;
        }
        postArtifactMessage("lavish:reviewDraftUnrestorable", { selector: String(card.selector) });
      }, REVIEW_DRAFT_ANCHOR_SETTLE_MS);
      return;
    }
    showAnnotationCard(target, { restoreText: String(card.text) });
  }

  document.addEventListener("change", (event) => {
    const el = event.target;
    if (el instanceof Element && el.closest("[data-lavish-question]")) scheduleReviewStateReport();
  });
  document.addEventListener("input", (event) => {
    const el = event.target;
    if (el instanceof Element && el.closest("[data-lavish-question]")) scheduleReviewStateReport();
  });

  function ensureShadow() {
    if (shadow) return shadow;

    const host = document.createElement("div");
    host.className = "lavish-annotation-root";
    host.setAttribute("data-lavish-ui", "annotation-root");
    document.documentElement.appendChild(host);

    shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `:host{all:initial;position:fixed;z-index:2147483647;left:0;top:0;color-scheme:dark;--ink-900:#0f1115;--ink-800:#11141a;--ink-700:#171a21;--ink-600:#1c212b;--steel-700:#2a2f3a;--steel-600:#303745;--steel-500:#3c4557;--steel-400:#8c96aa;--steel-300:#aeb6c6;--steel-200:#b9c0cf;--steel-100:#d8deea;--cream-50:#fffbf3;--cream-100:#f7f3ea;--cream-200:#e8e1cf;--brass-500:#f4c95d;--brass-400:#ffd877;--brass-ink:#17130a;--bg:var(--ink-900);--bg-panel:var(--ink-800);--bg-elevated:var(--ink-600);--fg:var(--cream-100);--fg-faint:var(--steel-300);--border:var(--steel-600);--accent:#f4c95d;--accent-hover:#ffd877;--font-sans:Geist,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;--font-mono:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--radius-md:10px;--radius-xl:14px;--shadow-floating:0 20px 70px rgba(0,0,0,.35);font-family:var(--font-sans)}*{box-sizing:border-box}:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.lavish-text-highlight{position:fixed;pointer-events:none;background:rgba(244,201,93,.28);border-radius:2px;box-shadow:0 0 0 1px rgba(244,201,93,.45)}.lavish-copy-markdown{position:fixed;display:grid;place-items:center;width:24px;height:24px;padding:0;border:1px solid rgba(255,255,255,.28);border-radius:7px;background:rgba(17,20,26,.92);color:var(--cream-100);box-shadow:0 4px 14px rgba(0,0,0,.28);font:700 15px/1 var(--font-sans);cursor:pointer;transition:opacity .12s ease}.lavish-copy-markdown:hover{background:var(--accent);color:var(--brass-ink)}.lavish-copy-markdown[hidden],.lavish-copy-markdown.is-hidden{display:none!important;visibility:hidden!important;opacity:0!important;pointer-events:none!important}.lavish-annotation-card{position:fixed;width:min(320px,calc(100vw - 24px));padding:12px;border-radius:var(--radius-xl);background:var(--bg-panel);color:var(--fg);border:1px solid var(--accent);box-shadow:var(--shadow-floating);font:14px/1.4 var(--font-sans)}.lavish-heading{font-weight:700;margin-bottom:6px}.lavish-annotation-card textarea{width:100%;min-height:86px;resize:vertical;border-radius:var(--radius-md);border:1px solid var(--border);background:var(--bg);color:var(--fg);padding:9px;font:inherit;font-family:var(--font-sans)}.lavish-annotation-card textarea::placeholder{color:var(--fg-faint)}.lavish-annotation-card .lavish-hint{margin-top:6px;font-size:11px;color:var(--fg-faint)}.lavish-annotation-card .lavish-hint-alert{color:#ff9d7a;font-weight:700}.lavish-annotation-card .lavish-row{display:flex;gap:8px;justify-content:flex-end;margin-top:8px}.lavish-annotation-card button{border:0;border-radius:var(--radius-md);padding:8px 10px;font-family:var(--font-sans);font-size:13px;font-weight:700;cursor:pointer}.lavish-annotation-card button:active{opacity:.85}.lavish-annotation-card .lavish-send{background:var(--accent);color:var(--brass-ink)}.lavish-annotation-card .lavish-send:hover{background:var(--accent-hover)}.lavish-annotation-card .lavish-cancel{background:var(--steel-700);color:var(--fg)}.lavish-annotation-card.is-dropping{outline:2px dashed var(--accent);outline-offset:3px}.lavish-attachments{display:flex;flex-direction:column;gap:6px;margin-top:8px;max-height:176px;overflow-y:auto}.lavish-attachment-chip{display:flex;align-items:center;gap:8px;padding:6px;border-radius:var(--radius-md);background:var(--bg);border:1px solid var(--border)}.lavish-attachment-chip.is-error{border-color:#e0623d}.lavish-attachment-thumb{width:32px;height:32px;border-radius:6px;object-fit:cover;background:var(--ink-700);flex:0 0 auto}.lavish-attachment-thumb-empty{display:inline-block}.lavish-attachment-body{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1 1 auto}.lavish-attachment-name{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.lavish-attachment-status{font-size:11px;color:var(--fg-faint)}.lavish-attachment-status-error{color:#ff9d7a}.lavish-attachment-retry{flex:0 0 auto;padding:4px 8px;font-size:11px;font-weight:700;border-radius:8px;background:var(--steel-700);color:var(--fg);cursor:pointer;border:0}.lavish-attachment-remove{flex:0 0 auto;display:flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0!important;border-radius:50%;background:transparent;color:rgba(255,255,255,.85);cursor:pointer;border:0}.lavish-attachment-remove:hover{background:rgba(255,255,255,.14);color:#fff}.lavish-attach-row{margin-top:8px}.lavish-attach{display:inline-flex;align-items:center;gap:6px;padding:6px 9px!important;background:var(--steel-700)!important;color:var(--fg)!important;font-size:12px!important}.lavish-attach:hover{background:var(--steel-600)!important}.lavish-reveal-marker{position:fixed;pointer-events:none;border:2px solid var(--accent);border-radius:4px;box-shadow:0 0 0 4px rgba(244,201,93,.22);animation:lavish-reveal-pulse 2.4s var(--ease,ease-out) forwards}@keyframes lavish-reveal-pulse{0%{opacity:0}12%{opacity:1}70%{opacity:1}100%{opacity:0}}`;
    style.textContent += `.lavish-persistent-mark,.lavish-done-range{position:fixed;pointer-events:none;box-sizing:border-box}.lavish-persistent-mark.is-marker-only{background:rgba(255,196,0,.34);border-bottom:2px solid rgba(217,119,6,.5)}.lavish-persistent-mark.is-commented{background:rgba(255,190,0,.45);border-bottom:2px solid #b45309}.lavish-persistent-mark.is-selected{background:rgba(255,190,0,.55);outline:2px solid #b45309;outline-offset:1px;border-radius:2px}.lavish-persistent-mark.is-sent{opacity:.8}.lavish-persistent-mark.is-document-wide{background:transparent;border:2px dashed rgba(180,83,9,.55);border-radius:6px}.lavish-persistent-mark.is-document-wide.is-selected{background:transparent}.lavish-done-range{background:rgba(190,190,190,.55);backdrop-filter:grayscale(1)}.lavish-mark-badge,.lavish-mark-add-comment,.lavish-done-badge{position:fixed;pointer-events:auto;border:1px solid #d99b16;border-radius:8px;background:#fff8dc;color:#3b3016;font:12px sans-serif;cursor:pointer}.lavish-mark-nav{position:fixed;display:flex;gap:2px;pointer-events:auto}.lavish-mark-nav button{display:inline-flex;align-items:center;justify-content:center;width:24px;padding:1px 0;border:1px solid #d99b16;border-radius:8px;background:#fff8dc;color:#3b3016;font:12px sans-serif;cursor:pointer}.lavish-mark-nav button:hover:not(:disabled){background:#f4c95d}.lavish-mark-nav button:disabled{opacity:.4;cursor:default}.lavish-mark-nav.is-marker-only{opacity:0;pointer-events:none}.lavish-mark-nav.is-marker-only.is-visible,.lavish-mark-nav.is-marker-only:focus-within{opacity:1;pointer-events:auto}.lavish-mark-add-comment{opacity:0;pointer-events:none}.lavish-mark-add-comment.is-visible,.lavish-mark-add-comment:hover,.lavish-mark-add-comment:focus{opacity:1;pointer-events:auto}`;
    shadow.appendChild(style);
    return shadow;
  }

  function closeCard() {
    activeCardContext = null;
    if (activeAttachments) {
      activeAttachments.destroy();
      activeAttachments = null;
    }
    if (shadow) {
      for (const el of [...shadow.querySelectorAll(".lavish-annotation-card")]) el.remove();
    }
    clearHighlight(hovered);
    clearHighlight(selected);
    hovered = null;
    clearTextHighlight();
    selected = null;
    scheduleReviewStateReport();
  }

  function showAnnotationCard(target, options = {}) {
    cancelPendingDraftRestore();
    const root = ensureShadow();
    closeCard();

    const c = options.context || context(target, { table: true });
    activeCardContext = c;
    let anchor = target;
    if (options.range) {
      highlightTextRange(options.range);
    } else {
      anchor = annotationTargetEl(target);
      selected = anchor;
      highlightElement(selected);
    }

    const rect = options.range
      ? options.range.getBoundingClientRect()
      : options.point
        ? {
            left: options.point.x,
            right: options.point.x,
            top: options.point.y,
            bottom: options.point.y,
            width: 0,
            height: 0,
          }
        : anchor.getBoundingClientRect();
    const card = document.createElement("div");
    card.className = "lavish-annotation-card";
    const nodeLabel = c.tag === "mermaid-node" ? c.target?.label || c.text || "" : "";
    const isTableCell = c.target?.type === "table-cell";
    // The annotation targets the element that was clicked, which inside a table cell is often a
    // nested badge or code span. Say "cell" only when the cell itself was clicked; otherwise name
    // the clicked element and place it at the cell's coordinates. An unlabelled table names
    // nothing, so it falls back to the plain element heading rather than a dangling "cell: ".
    const isCellItself = isTableCell && (c.tag === "td" || c.tag === "th");
    const tableLabel = isTableCell ? [c.target?.rowLabel, c.target?.columnLabel].filter(Boolean).join(" → ") : "";
    const heading =
      c.tag === "text"
        ? "Annotate text"
        : tableLabel
          ? isCellItself
            ? "Annotate cell: " + escapeAnnotationText(tableLabel)
            : "Annotate &lt;" + c.tag + "&gt; in " + escapeAnnotationText(tableLabel)
          : c.tag === "mermaid-node"
            ? "Annotate node" + (nodeLabel ? ": " + escapeAnnotationText(nodeLabel) : "")
            : "Annotate &lt;" + c.tag + "&gt;";
    const placeholder =
      c.tag === "text"
        ? "Tell the agent what to change about this text..."
        : isCellItself
          ? "Tell the agent what to change about this table cell..."
          : c.tag === "mermaid-node"
            ? "Tell the agent what to change about this diagram node..."
            : "Tell the agent what to change about this element...";
    const sendNowHint = /Mac|iP(hone|ad|od)/.test(navigator.platform) ? "⌘" : "Ctrl";
    card.innerHTML =
      '<div class="lavish-heading">' +
      heading +
      '</div><textarea placeholder="' +
      placeholder +
      '"></textarea><div class="lavish-attachments" data-attachments hidden></div>' +
      '<div class="lavish-attach-row"><button class="lavish-attach" type="button">' +
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>' +
      "<span>Attach image</span></button>" +
      '<input class="lavish-attach-input" type="file" accept="' +
      ATTACHMENT_IMAGE_TYPES.accept +
      '" multiple hidden></div>' +
      '<div class="lavish-hint">Enter to queue &middot; ' +
      sendNowHint +
      "+Enter to send &middot; paste or drop an image" +
      '</div><div class="lavish-row"><button class="lavish-cancel" type="button">Cancel</button><button class="lavish-send" type="button">Queue</button></div>';
    root.appendChild(card);

    // Clamp the card fully inside the viewport. Called again whenever its height
    // changes (attachment chip rows are added/removed) so a grown card never pushes
    // its Queue/Cancel buttons off the bottom of the frame (W3). The anchor `rect` is
    // captured once; only the card's own measured size varies between calls.
    function positionCard() {
      const left = Math.min(Math.max(12, rect.left), window.innerWidth - card.offsetWidth - 12);
      const top = Math.min(Math.max(12, rect.bottom + 8), window.innerHeight - card.offsetHeight - 12);
      card.style.left = left + "px";
      card.style.top = top + "px";
    }
    positionCard();

    const textarea = /** @type {HTMLTextAreaElement | null} */ (card.querySelector("textarea"));
    const cancelButton = /** @type {HTMLButtonElement | null} */ (card.querySelector(".lavish-cancel"));
    const sendButton = /** @type {HTMLButtonElement | null} */ (card.querySelector(".lavish-send"));
    const attachmentsList = /** @type {HTMLDivElement | null} */ (card.querySelector("[data-attachments]"));
    const attachButton = /** @type {HTMLButtonElement | null} */ (card.querySelector(".lavish-attach"));
    const attachInput = /** @type {HTMLInputElement | null} */ (card.querySelector(".lavish-attach-input"));
    const attachNotice = /** @type {HTMLDivElement | null} */ (card.querySelector(".lavish-hint"));
    if (!textarea || !cancelButton || !sendButton || !attachmentsList || !attachButton || !attachInput) return;

    // The card has one notice line, shared by the neutral keyboard hint and by
    // attachment problems (the count cap, a stalled upload, a failed one). A rejected
    // drop is an error, so it must not inherit the hint's passive gray - it renders in
    // the error color until cleared, and clearing restores the hint rather than
    // leaving stale red text behind.
    const defaultHintHtml = attachNotice ? attachNotice.innerHTML : "";
    const notify = (message) => {
      if (!attachNotice) return;
      if (message) {
        attachNotice.textContent = message;
        attachNotice.classList.add("lavish-hint-alert");
      } else {
        attachNotice.innerHTML = defaultHintHtml;
        attachNotice.classList.remove("lavish-hint-alert");
      }
    };
    const attachments = makeAttachmentsController(attachmentsList, {
      notify,
      onLayout() {
        positionCard();
        scheduleReviewStateReport();
      },
    });
    activeAttachments = attachments;

    attachButton.onclick = () => attachInput.click();
    attachInput.addEventListener("change", () => {
      attachments.addFiles(attachInput.files);
      attachInput.value = "";
    });
    textarea.addEventListener("paste", (event) => {
      const { images, keepTextPaste } = planClipboardPaste(event.clipboardData, ATTACHMENT_ACCEPTED_MIME);
      if (images.length && attachments.addFiles(images) && !keepTextPaste) event.preventDefault();
    });
    card.addEventListener("dragover", (event) => {
      // Accept ANY file drag so the drop lands on the card (and is preventable)
      // instead of the browser navigating to a dropped non-image.
      if (dataTransferHasFiles(event.dataTransfer)) {
        event.preventDefault();
        card.classList.add("is-dropping");
      }
    });
    card.addEventListener("dragleave", (event) => {
      if (event.target === card) card.classList.remove("is-dropping");
    });
    card.addEventListener("drop", (event) => {
      // Intercept every drop over the card so a dropped PDF/other file can never
      // navigate the frame away, then partial-accept: attach the images and raise
      // one UNSUPPORTED_TYPE chip per file that cannot be attached.
      event.preventDefault();
      card.classList.remove("is-dropping");
      const { images, unsupported } = partitionDroppedFiles(event.dataTransfer, ATTACHMENT_ACCEPTED_MIME);
      if (images.length) attachments.addFiles(images);
      if (unsupported.length) attachments.rejectUnsupportedBatch(unsupported);
      // Some drags expose no enumerable files or items (only a "Files" type hint),
      // so nothing can be partitioned; still tell the user the drop was refused.
      if (!images.length && !unsupported.length && dataTransferHasFiles(event.dataTransfer)) {
        attachments.rejectUnsupported("file");
      }
    });

    // Try to queue the card. Returns true only if a prompt was actually queued, so
    // the caller knows whether a follow-up "send now" should fire. Gates on any
    // still-uploading attachment (R2.4): queuing then would silently drop it, so we
    // keep the card open and tell the user to wait instead. Also gates on any errored
    // attachment (W2): collectReady drops errors and closeCard tears down the card, so
    // queuing would discard the failed image and its retry/remove UI - keep the card
    // open so the user can retry or explicitly remove it first.
    function tryQueue() {
      if (attachments.hasPending()) {
        attachments.setQueueBlocked(true);
        return false;
      }
      if (attachments.hasErrors()) {
        attachments.setQueueBlocked(true);
        return false;
      }
      attachments.setQueueBlocked(false);
      const prompt = textarea.value.trim();
      const readyAttachments = attachments.collectReady();
      // Allow an image-only annotation (the element/target still identifies what it
      // refers to), but never queue an empty card.
      if (prompt || readyAttachments.length) {
        if (c.tag === "text") pendingSelectLatestMark = true;
        queuePrompt(prompt, { ...c, queueKey: "", attachments: readyAttachments });
      }
      closeCard();
      return true;
    }

    cancelButton.onclick = closeCard;
    sendButton.onclick = () => {
      tryQueue();
    };
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        const sendNow = (event.ctrlKey || event.metaKey) && (!!textarea.value.trim() || attachments.hasReady());
        const queued = tryQueue();
        // postMessage delivery is ordered, so the queued prompt lands before the send.
        if (queued && sendNow) sendQueuedPrompts();
      } else if (event.key === "Escape" && !event.isComposing) {
        // Close only when there is nothing to lose; excludes isComposing since mid-IME text isn't in textarea.value yet.
        if (textarea.value.trim() || attachments.hasPending() || attachments.hasErrors() || attachments.hasReady())
          return;
        event.preventDefault();
        closeCard();
      }
    });
    // Unsent annotation text is review context Lavish owns, so it is reported to the chrome and
    // replayed after a live reload.
    textarea.addEventListener("input", scheduleReviewStateReport);
    if (typeof options.restoreText === "string") {
      textarea.value = options.restoreText;
      // Re-report immediately so restored text survives a second reload too, rather than only
      // living until the next keystroke.
      scheduleReviewStateReport();
    }
    setTimeout(() => textarea.focus(), 0);
  }

  function dataTransferHasFiles(dataTransfer) {
    if (!dataTransfer) return false;
    if ((dataTransfer.files || []).length) return true;
    for (const item of dataTransfer.items || []) {
      if (item.kind === "file") return true;
    }
    return (dataTransfer.types || []).includes?.("Files");
  }

  /** @type {Window & { lavish?: unknown }} */ (window).lavish = {
    queuePrompt,
    sendQueuedPrompts,
    endSession,
    getQueuedPrompts: () => [],
    setStatus: (message) => postArtifactMessage("lavish:status", { message: String(message) }),
    snapshot,
  };

  window.addEventListener("message", (event) => {
    // The chrome is the only legitimate sender. This listener is on `window`, so
    // without the source check the artifact could post to itself and drive the SDK.
    if (event.source !== parent) return;
    const msg = event.data || {};
    if (msg.type === "lavish:setAnnotationMode") {
      setAnnotationMode(msg.enabled);
      // A mode flip can come with a theme flip; re-measure the scrollbar surface cheaply.
      ensureScrollbarStyle();
    }
    if (msg.type === "lavish:selectionShortcut") executeReviewShortcut(msg.action, null);
    if (msg.type === "lavish:annotationMarks") {
      const list = Array.isArray(msg.marks) ? msg.marks : Array.isArray(msg.items) ? msg.items : [];
      annotationMarks = list;
      if (pendingSelectLatestMark && list.length) {
        selectedMarkId = list.at(-1)?.id || selectedMarkId;
        pendingSelectLatestMark = false;
      } else if (selectedMarkId && !list.some((item) => item.id === selectedMarkId)) {
        selectedMarkId = "";
      }
      renderOverlays();
    }
    if (msg.type === "lavish:restoreDoneBoxes") restoreDoneItems(msg.items);
    if (msg.type === "lavish:openCommentForMark") {
      const mark = annotationMarks.find((item) => item.id === msg.id);
      if (mark && !activeCardContext) openCommentForMark(mark);
    }
    if (msg.type === "lavish:attachmentResult") {
      if (!isTrustedAttachmentResult(event, { parentWindow: parent, nonce: ATTACHMENT_NONCE })) return;
      activeAttachments?.handleResult(msg.localId, msg.ok, msg.id, msg.error);
    }
    if (msg.type === "lavish:requestSnapshot") {
      postArtifactMessage("lavish:snapshot", {
        snapshot: snapshot(),
        snapshot_request_id: typeof msg.snapshot_request_id === "string" ? msg.snapshot_request_id : "",
      });
    }
    if (msg.type === "lavish:restoreScroll") {
      window.scrollTo(Number(msg.x) || 0, Number(msg.y) || 0);
    }
    if (msg.type === "lavish:restoreReviewState") restoreReviewState(msg.state);
    if (msg.type === "lavish:questionQueued") {
      const fields = pendingQuestionQueues.get(msg.review_request_id);
      pendingQuestionQueues.delete(msg.review_request_id);
      if (msg.accepted && fields) {
        for (const field of fields) acknowledgedQuestionValues.set(field.key, fieldValueSignature(field));
        scheduleReviewStateReport();
      }
    }
    if (msg.type === "lavish:requestReviewState") {
      if (msg.freeze) document.documentElement.inert = true;
      postArtifactMessage("lavish:reviewState", {
        request_id: String(msg.request_id || ""),
        state: collectReviewState(),
      });
    }
    if (msg.type === "lavish:releaseReviewState") document.documentElement.inert = false;
    if (msg.type === "lavish:revealElement") revealElement(msg.selector);
    if (msg.type === "lavish:revealAnnotationMark") {
      const mark = annotationMarks.find((item) => item.id === msg.id);
      if (!mark || !focusAnnotationMark(mark)) revealElement(msg.selector);
    }
    if (msg.type === "lavish:copyUrlResult") handleCopyUrlResult(msg);
    if (msg.type === "lavish:accessUrls") updateAccessUrls(msg);
    if (msg.type === "lavish:queuedAnchors") {
      queuedAnchorSelectors = new Set(Array.isArray(msg.selectors) ? msg.selectors.map(String) : []);
    }
    if (msg.type === "lavish:annotateElement" && annotationMode) {
      const target = safeQuerySelector(msg.selector);
      if (target) showAnnotationCard(target);
    }
  });

  // Bring a warning's element into view and flash it. The marker is Lavish UI, so it is excluded
  // from the layout audit and never becomes a finding of its own.
  function revealElement(selector) {
    const target = selector === "html" ? document.documentElement : safeQuerySelector(selector);
    if (!(target instanceof Element)) return;
    scrollIntoCenter(target, () => target.getBoundingClientRect());
    const root = ensureShadow();
    for (const el of [...root.querySelectorAll(".lavish-reveal-marker")]) el.remove();
    const rect = target.getBoundingClientRect();
    const marker = document.createElement("div");
    marker.className = "lavish-reveal-marker";
    marker.style.left = rect.left + "px";
    marker.style.top = rect.top + "px";
    marker.style.width = Math.max(rect.width, 4) + "px";
    marker.style.height = Math.max(rect.height, 4) + "px";
    root.appendChild(marker);
    window.setTimeout(() => marker.remove(), 2400);
  }

  // Capture phase so the mode hotkey fires no matter where focus is inside the artifact -
  // including a checkbox, button, link, or the annotation-card textarea - without disturbing
  // normal typing. This SDK doesn't own the mode state; it asks the chrome to toggle the same
  // state the on-screen switch drives, via the same postMessage protocol as setAnnotationMode.
  document.addEventListener(
    "keydown",
    (event) => {
      if (!isModeToggleHotkeyEvent(event)) return;
      event.preventDefault();
      postArtifactMessage("lavish:toggleAnnotationMode");
    },
    true,
  );

  document.addEventListener(
    "keydown",
    (event) => {
      const action = reviewShortcutAction(event);
      if (!action || activeCardContext) return;
      executeReviewShortcut(action, event);
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
        postArtifactMessage("lavish:scroll", { x: window.scrollX, y: window.scrollY });
      });
    },
    { passive: true },
  );

  document.addEventListener(
    "mouseover",
    (event) => {
      const target = copyTargetFor(event.target);
      if (target) {
        showCopyButton(target);
        return;
      }
      if (copyTarget && copyButton && !copyButton.contains?.(event.target) && !isLavishUi(event.target)) {
        if (!copyHideTimer) copyHideTimer = window.setTimeout(hideCopyButton, 160);
      }
    },
    true,
  );

  document.addEventListener(
    "mouseout",
    (event) => {
      if (!copyTarget || !copyButton || copyButton.contains?.(event.relatedTarget)) return;
      const nextTarget = copyTargetFor(event.relatedTarget);
      if (nextTarget === copyTarget) return;
      if (!copyHideTimer) copyHideTimer = window.setTimeout(hideCopyButton, 160);
    },
    true,
  );

  document.addEventListener("mouseleave", () => {
    hideCopyButton();
  });
  window.addEventListener("blur", () => {
    hideCopyButton();
  });

  window.addEventListener("resize", positionCopyButton, { passive: true });
  window.addEventListener("scroll", positionCopyButton, { passive: true });

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
      window.setTimeout(() => {
        ignoreNextClick = false;
      }, 0);
    },
    true,
  );

  let copyBridgeRequestCounter = 0;
  /** @type {Map<number, { button: HTMLElement, timer: any }>} */
  const activeCopyBridgeRequests = new Map();
  /** @type {WeakMap<HTMLElement, string>} */
  const origButtonHtml = new WeakMap();
  /** @type {WeakMap<HTMLElement, any>} */
  const buttonResetTimers = new WeakMap();

  function findCopyTarget(element) {
    if (!element || !(element instanceof Element)) return null;
    if (element.closest("button:disabled, [aria-disabled='true']")) return null;
    if (element.closest("a[href]")) return null;

    // 1. New template button contract: data-lavish-copy-url
    const copyUrlEl = /** @type {HTMLElement | null} */ (element.closest("[data-lavish-copy-url]"));
    if (copyUrlEl) {
      const url = copyUrlEl.getAttribute("data-lavish-copy-url") || "";
      if (url) return { element: copyUrlEl, url };
    }

    // 2. Existing access-card copy buttons
    const accessCard = element.closest(".lavish-access-card");
    if (accessCard) {
      const btn = /** @type {HTMLElement | null} */ (element.closest("button, [role='button']"));
      if (btn) {
        let url =
          btn.getAttribute("data-lavish-copy-url") ||
          btn.getAttribute("data-copy-url") ||
          btn.getAttribute("data-copy-text");

        if (!url) {
          const onclickAttr = btn.getAttribute("onclick") || "";
          const match = onclickAttr.match(/(?:writeText|copyText)\(\s*['"]([^'"]+)['"]\s*\)/i);
          if (match) url = match[1];
        }

        if (!url) {
          const row = btn.closest("div, li, tr, p") || accessCard;
          const codeEl = /** @type {HTMLInputElement | HTMLElement | null} */ (
            row.querySelector("code, input, a[href^='http']")
          );
          if (codeEl) {
            const input = /** @type {HTMLInputElement} */ (codeEl);
            const val = String(
              codeEl.tagName === "INPUT" ? input.value : codeEl.textContent || codeEl.getAttribute("href") || "",
            ).trim();
            if (/^https?:\/\//i.test(val)) url = val;
          }
        }

        if (url) return { element: btn, url };
      }
    }

    return null;
  }

  function updateAccessUrls(msg) {
    const urls = [String(msg.localUrl || ""), String(msg.remoteUrl || "")];
    document.querySelectorAll(".lavish-access-card").forEach((card) => {
      Array.from(card.querySelectorAll("code"))
        .slice(0, 2)
        .forEach((code, index) => {
          const row = code.parentElement?.parentElement;
          if (!row) return;
          const url = urls[index];
          code.textContent = url || "Remote unavailable";
          const button = row.querySelector("button");
          if (button) {
            button.removeAttribute("onclick");
            button.setAttribute("data-lavish-copy-url", url);
            button.setAttribute("data-copy-label", index === 0 ? "Local" : "Remote");
            button.disabled = !url;
          }
          row.querySelectorAll("a").forEach((link) => {
            if (url) link.setAttribute("href", url);
            else link.removeAttribute("href");
            link.setAttribute("data-lavish-action", "link");
            link.setAttribute("target", "_blank");
            link.setAttribute("rel", "noopener noreferrer");
          });
        });
    });
  }

  function applyCopyButtonFeedback(button, success) {
    if (!button) return;
    const isGerman = /kopier/i.test(button.getAttribute("onclick") || button.textContent || "");
    button.classList.remove("copying");
    const card = button.closest(".lavish-access-card");
    if (card) {
      let status = card.querySelector("[data-lavish-copy-status]");
      if (!status) {
        status = document.createElement("p");
        status.setAttribute("data-lavish-copy-status", "");
        status.setAttribute("role", "status");
        status.setAttribute("aria-live", "polite");
        card.appendChild(status);
      }
      const copyLabel = button.getAttribute("data-copy-label") || "Session";
      status.textContent = success
        ? isGerman
          ? `${copyLabel}-Adresse kopiert ✓`
          : `${copyLabel} address copied ✓`
        : isGerman
          ? "Kopieren fehlgeschlagen. Adresse auswählen und manuell kopieren."
          : "Copy failed. Select the address and copy it manually.";
    }
    if (success) {
      button.classList.remove("copy-error");
      button.classList.add("copied");
    } else {
      button.classList.remove("copied");
      button.classList.add("copy-error");
    }

    const hint = button.querySelector(".copy-canonical-hint, .copy-hint, .copy-status");
    if (hint) {
      hint.textContent = success ? (isGerman ? "✓ Kopiert" : "Copied") : isGerman ? "Fehler" : "Error";
    } else {
      const textNode = Array.from(button.childNodes).find((node) => node.nodeType === 3 && node.textContent?.trim());
      if (textNode) {
        textNode.textContent = success ? (isGerman ? "✓ Kopiert" : "Copied") : isGerman ? "Fehler" : "Error";
      } else {
        button.textContent = success ? (isGerman ? "✓ Kopiert" : "Copied") : isGerman ? "Fehler" : "Error";
      }
    }

    const prevTimer = buttonResetTimers.get(button);
    if (prevTimer) window.clearTimeout(prevTimer);

    const resetTimer = window.setTimeout(() => {
      button.classList.remove("copied", "copy-error");
      const origHtml = origButtonHtml.get(button);
      if (origHtml !== undefined) {
        button.innerHTML = origHtml;
        origButtonHtml.delete(button);
      }
    }, 2000);
    buttonResetTimers.set(button, resetTimer);
  }

  function handleCopyUrlResult(msg) {
    const req = activeCopyBridgeRequests.get(Number(msg.requestId));
    if (req) {
      window.clearTimeout(req.timer);
      activeCopyBridgeRequests.delete(Number(msg.requestId));
      applyCopyButtonFeedback(req.button, Boolean(msg.success));
    }
  }

  function executeCopyBridge(button, url) {
    if (!button || !url) return;
    if (!origButtonHtml.has(button)) {
      origButtonHtml.set(button, button.innerHTML);
    }
    button.classList.add("copying");

    const requestId = ++copyBridgeRequestCounter;
    const timer = window.setTimeout(() => {
      activeCopyBridgeRequests.delete(requestId);
      applyCopyButtonFeedback(button, false);
    }, 3000);

    activeCopyBridgeRequests.set(requestId, { button, timer });

    if (parent && parent !== window) {
      postArtifactMessage("lavish:copyUrl", { requestId, url });
    } else {
      (async () => {
        let ok = false;
        try {
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(url);
            ok = true;
          }
        } catch {
          // Fall through
        }
        window.clearTimeout(timer);
        activeCopyBridgeRequests.delete(requestId);
        applyCopyButtonFeedback(button, ok);
      })();
    }
  }

  document.addEventListener(
    "click",
    (event) => {
      if (!event.isTrusted || event.defaultPrevented) return;
      const copyTarget = findCopyTarget(event.target);
      if (!copyTarget) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      executeCopyBridge(copyTarget.element, copyTarget.url);
    },
    true,
  );

  document.addEventListener(
    "click",
    (event) => {
      const windowsPath = windowsWslLink(event.target);
      if (!windowsPath || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      postArtifactMessage("lavish:openWindowsWslPath", { path: windowsPath });
    },
    true,
  );

  document.addEventListener(
    "click",
    (event) => {
      if (
        event.ctrlKey ||
        event.metaKey ||
        isLavishUi(event.target) ||
        isLavishAction(event.target) ||
        isInteractiveControl(event.target)
      )
        return;
      if (ignoreNextClick || textSelectionContext(document.getSelection())) {
        ignoreNextClick = false;
        return;
      }
      if (!annotationMode && /** @type {Element | null} */ (event.target)?.closest?.("a[href]")) return;
      const hitMark = findRenderedTextMarkAtPoint(event.clientX, event.clientY, 2);
      if (hitMark) {
        event.preventDefault();
        event.stopPropagation();
        selectedMarkId = hitMark.id;
        renderOverlays();
        window.focus?.();
        postArtifactMessage("lavish:activateAnnotationMark", {
          id: hitMark.id,
          state: hitMark.state,
          selector: hitMark.selector,
          selectOnly: true,
        });
        return;
      }
      if (selectedMarkId) {
        selectedMarkId = "";
        renderOverlays();
      }
      if (!annotationMode) return;
      event.preventDefault();
      event.stopPropagation();
      // The clicked element's own selector, plus its diagram node's, so any click inside a node
      // finds the node's note again. A table cell's note stays on the exact element clicked.
      const clicked = queuedAnchorSelectors.size ? context(event.target) : null;
      const node = clicked?.target?.type === "mermaid-node" ? clicked.target.selector : "";
      const selector = [clicked?.selector, node].find((candidate) => candidate && queuedAnchorSelectors.has(candidate));
      if (selector) {
        closeCard();
        postArtifactMessage("lavish:editQueuedAnchor", { selector });
        return;
      }
      showAnnotationCard(event.target);
    },
    true,
  );

  document.addEventListener(
    "contextmenu",
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (
        !target ||
        isLavishUi(target) ||
        target.closest("input,textarea,[contenteditable]:not([contenteditable='false'])")
      ) {
        return;
      }

      const selection = document.getSelection();
      const c = textSelectionContext(selection);
      event.preventDefault();
      event.stopPropagation();
      if (c) {
        showAnnotationCard(c.element, { context: c, range: c.range });
      } else {
        showAnnotationCard(target, { point: { x: event.clientX, y: event.clientY } });
      }
    },
    true,
  );

  setAnnotationMode(annotationMode);
  ensureScrollbarStyle();
  watchScrollbarSurface();
  installActiveNavigation();
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

  // Sync document title and favicon to parent chrome (especially for SPAs and wrapped apps)
  function syncDocumentMetadata() {
    try {
      const currentTitle = (document.title || "").trim();
      let iconHref = "";
      const iconLinks = /** @type {HTMLLinkElement[]} */ (Array.from(document.querySelectorAll("link[rel~='icon']")));
      const preferredIcon =
        iconLinks.find((l) => /svg/i.test(l.type || l.href)) ||
        iconLinks.find((l) => /png/i.test(l.type || l.href)) ||
        iconLinks[0];
      if (preferredIcon && preferredIcon.href) {
        iconHref = preferredIcon.href;
      }
      postArtifactMessage("lavish:documentMeta", {
        title: currentTitle,
        faviconHref: iconHref,
      });
    } catch {
      // Ignore frame read failures
    }
  }

  syncDocumentMetadata();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", syncDocumentMetadata, { once: true });
  }
  window.addEventListener("load", syncDocumentMetadata, { once: true });

  try {
    const metaObserver = new MutationObserver(() => syncDocumentMetadata());
    if (document.head) {
      metaObserver.observe(document.head, { childList: true, subtree: true, characterData: true });
    }
    if (document.documentElement) {
      metaObserver.observe(document.documentElement, { childList: true });
    }
  } catch {
    // Ignore observer failures in restricted environments
  }

  // Report the agent-declared revision registry so the chrome can offer its
  // legend. Read-only: the SDK never marks up the page for it, because a
  // highlight painted here would make the served artifact differ from the file
  // opened without Lavish. The message is sent even when the artifact declares
  // nothing, so a reload that removed the registry clears a stale legend.
  function reportArtifactRevisions() {
    let payload = { revisions: [], marks: [] };
    try {
      payload = readArtifactRevisions(document);
    } catch {
      // A malformed registry costs the reader a legend, never the review.
    }
    postArtifactMessage("lavish:revisions", payload);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", reportArtifactRevisions, { once: true });
  } else {
    reportArtifactRevisions();
  }
}
