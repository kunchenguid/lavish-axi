/* global document, window, FileReader, location */

// Browser entry for the whiteboard frame. It runs in two placements, both
// sandboxed (`allow-scripts allow-popups`, no `allow-same-origin`): inline,
// where the artifact SDK embeds one frame in place of each rendered Mermaid
// diagram; and overlay,
// where the chrome hosts one frame full-viewport (reached from the inline
// frame's fullscreen action). The `mode` field of the init message selects the
// placement-specific UI; everything else is identical. Bundled by
// `scripts/build.js` (esbuild) together with Excalidraw, the Mermaid
// converter, its own exactly-pinned mermaid, and React into
// `dist/whiteboard/whiteboard.js`, so nothing here loads from the network.
//
// The frame owns all whiteboard UI. It holds no server access; the chrome does
// the same-origin fetches. Untrusted Mermaid text therefore renders only
// inside opaque origins, exactly like the artifact iframe.

import { parseMermaidToExcalidraw } from "@excalidraw/mermaid-to-excalidraw";
import {
  convertToExcalidrawElements,
  Excalidraw,
  exportToBlob,
  exportToCanvas,
  FONT_FAMILY,
  restore,
} from "@excalidraw/excalidraw";
import React from "react";
import { createRoot } from "react-dom/client";
import "@excalidraw/excalidraw/index.css";
import "./whiteboard-frame.css";

import {
  convertExcalidrawSkeletonsAfterFontsLoad,
  createWhiteboardPersistencePayload,
  findDuplicateElementIds,
  repairSavedSceneTextMetrics,
  sanitizeSceneLink,
  sanitizeWhiteboardAppState,
  sceneIsImageFallback,
  summarizeSceneEdits,
  WHITEBOARD_TEXT_METRICS_VERSION,
} from "./whiteboard-core.js";

const SAVE_DEBOUNCE_MS = 800;

const state = {
  mode: "overlay",
  diagramIndex: 0,
  diagramId: "",
  // Hash of the Mermaid source this scene was converted from. Stays at the old
  // value when the user keeps editing a saved scene after the diagram changed
  // underneath, so feedback honestly reports which source the edits refer to.
  sceneSourceHash: "",
  currentSource: "",
  currentSourceHash: "",
  baselineElements: [],
  files: {},
  imageFallback: false,
  textMetricsVersion: WHITEBOARD_TEXT_METRICS_VERSION,
  channelId: "",
  api: null,
  saveTimer: 0,
  teardownFlushId: "",
  flushIds: new Set(),
  queueBusy: false,
  // Inline frames boot locked (view mode) so a page full of embedded
  // whiteboards scrolls normally; the first click on the canvas unlocks it.
  setLocked: null,
};

function post(message) {
  window.top.postMessage(
    {
      ...message,
      diagramIndex: state.diagramIndex,
      ...(state.channelId
        ? { channelId: state.channelId }
        : {
            channelToken: String(/** @type {any} */ (window).__lavishWhiteboardChannelToken || ""),
            diagramId: state.diagramId,
          }),
    },
    "*",
  );
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) node.append(child);
  return node;
}

function setBanner(id, text) {
  const banner = document.getElementById(id);
  if (!banner) return;
  banner.textContent = text;
  banner.hidden = !text;
}

function buildShell(theme, mode) {
  document.body.dataset.lavishWhiteboardTheme = theme;
  document.body.dataset.lavishWhiteboardMode = mode;
  const shell = el("div", { id: "wbShell" });
  const header = el("header", { id: "wbHeader" });
  const title = el("div", { id: "wbTitle", textContent: "Whiteboard" });
  const note = el("input", {
    id: "wbNote",
    placeholder: "Optional note for the agent about these edits...",
    autocomplete: "off",
  });
  const queueButton = el("button", { id: "wbQueue", type: "button", textContent: "Queue feedback" });
  // In overlay mode the chrome renders the close control on top of this
  // header's right edge (it must work even when this frame fails to boot), so
  // the header reserves that space via CSS instead of adding its own close.
  // Inline frames offer a fullscreen action instead, which asks the chrome to
  // reopen this diagram in the overlay.
  header.append(title, note, queueButton);
  if (mode === "inline") {
    const fullscreenButton = el("button", {
      id: "wbFullscreen",
      type: "button",
      textContent: "Fullscreen",
      title: "Open this whiteboard full screen",
    });
    fullscreenButton.onclick = () => post({ type: "lavish-whiteboard:maximize", diagramIndex: state.diagramIndex });
    header.append(fullscreenButton);
  }
  const fallbackBanner = el("div", { id: "wbFallbackBanner", className: "wb-banner", hidden: true });
  const staleBanner = el("div", { id: "wbStaleBanner", className: "wb-banner wb-banner-warn", hidden: true });
  const status = el("div", { id: "wbStatus", className: "wb-status", hidden: true });
  const editor = el("div", { id: "wbEditor" });
  const linkConfirm = el("div", { id: "wbLinkConfirm", className: "wb-link-confirm", hidden: true });
  linkConfirm.setAttribute("role", "dialog");
  linkConfirm.setAttribute("aria-modal", "true");
  linkConfirm.setAttribute("aria-label", "Open external link");
  const linkConfirmCard = el("div", { className: "wb-link-confirm-card" });
  const linkConfirmTitle = el("div", { className: "wb-link-confirm-title", textContent: "Open external link?" });
  const linkConfirmCopy = el("p", {
    className: "wb-link-confirm-copy",
    textContent: "This link came from the diagram.",
  });
  const linkConfirmUrl = el("p", { id: "wbLinkConfirmUrl", className: "wb-link-confirm-url" });
  const linkConfirmActions = el("div", { className: "wb-link-confirm-actions" });
  const linkConfirmCancel = el("button", {
    id: "wbLinkConfirmCancel",
    type: "button",
    textContent: "Cancel",
  });
  const linkConfirmOpen = el("button", {
    id: "wbLinkConfirmOpen",
    type: "button",
    textContent: "Open link",
  });
  linkConfirmActions.append(linkConfirmCancel, linkConfirmOpen);
  linkConfirmCard.append(linkConfirmTitle, linkConfirmCopy, linkConfirmUrl, linkConfirmActions);
  linkConfirm.append(linkConfirmCard);
  shell.append(header, fallbackBanner, staleBanner, status, editor, linkConfirm);
  document.body.append(shell);

  queueButton.onclick = () => queueFeedback().catch((error) => showStatus(`Queue failed: ${describeError(error)}`));
  note.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      queueButton.click();
    }
  });
  linkConfirmCancel.onclick = dismissLinkConfirmation;
  linkConfirmOpen.onclick = () => {
    const safe = String(linkConfirm.dataset.url || "");
    if (safe) window.open(safe, "_blank", "noopener,noreferrer");
    dismissLinkConfirmation();
  };
  linkConfirm.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      dismissLinkConfirmation();
      return;
    }
    if (event.key !== "Tab") return;
    const buttons = [linkConfirmCancel, linkConfirmOpen];
    const activeIndex = buttons.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
    const nextIndex = event.shiftKey ? activeIndex - 1 : activeIndex + 1;
    if (nextIndex >= 0 && nextIndex < buttons.length) return;
    event.preventDefault();
    buttons[event.shiftKey ? buttons.length - 1 : 0].focus();
  });
}

let statusTimer = 0;
function showStatus(text, { transient = true } = {}) {
  const status = document.getElementById("wbStatus");
  if (!status) return;
  status.textContent = text;
  status.hidden = !text;
  if (transient && text) {
    window.clearTimeout(statusTimer);
    statusTimer = window.setTimeout(() => {
      status.hidden = true;
    }, 4000);
  }
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function currentScene() {
  if (!state.api) return null;
  const appState = state.api.getAppState();
  return {
    elements: state.api.getSceneElements().map((element) => JSON.parse(JSON.stringify(element))),
    appState: sanitizeWhiteboardAppState({
      scrollX: appState.scrollX,
      scrollY: appState.scrollY,
      zoom: appState.zoom,
    }),
    files: state.api.getFiles() || {},
  };
}

function postSave(flushId = "") {
  const scene = currentScene();
  if (!scene) return false;
  post({
    type: "lavish-whiteboard:save",
    diagramIndex: state.diagramIndex,
    ...createWhiteboardPersistencePayload(state, scene),
    ...(flushId ? { flushId } : {}),
  });
  return true;
}

function scheduleSave() {
  if (state.teardownFlushId) return;
  window.clearTimeout(state.saveTimer);
  state.saveTimer = window.setTimeout(() => {
    postSave();
  }, SAVE_DEBOUNCE_MS);
}

function prepareTeardown(message) {
  const flushId = String(message.flushId || "");
  if (!flushId) return;
  state.teardownFlushId = flushId;
  window.clearTimeout(state.saveTimer);
  state.setLocked?.(true);
  if (!postSave(flushId)) {
    state.teardownFlushId = "";
    post({ type: "lavish-whiteboard:teardownReady", flushId });
  }
}

function flushSaveNow(message) {
  const flushId = String(message.flushId || "");
  if (!flushId || state.flushIds.has(flushId)) return;
  state.flushIds.add(flushId);
  window.clearTimeout(state.saveTimer);
  if (!postSave(flushId)) {
    state.flushIds.delete(flushId);
    post({ type: "lavish-whiteboard:flushComplete", flushId, ok: true });
  }
}

function handleSaveResult(message) {
  const flushId = String(message.flushId || "");
  if (!flushId) return;
  if (flushId === state.teardownFlushId) {
    state.teardownFlushId = "";
    if (message.ok) {
      post({ type: "lavish-whiteboard:teardownReady", flushId });
      return;
    }
    state.setLocked?.(false);
    const error = String(message.error || "failed to save whiteboard scene");
    showStatus(`Could not save before closing: ${error}`, { transient: false });
    post({ type: "lavish-whiteboard:teardownFailed", flushId, error });
    return;
  }
  if (state.flushIds.delete(flushId)) {
    post({ type: "lavish-whiteboard:flushComplete", flushId, ok: Boolean(message.ok) });
  }
}

/** @type {{ focus?: () => void } | null} */
let linkConfirmationReturnFocus = null;

function dismissLinkConfirmation() {
  const dialog = document.getElementById("wbLinkConfirm");
  if (dialog) dialog.hidden = true;
  const returnFocus = linkConfirmationReturnFocus;
  linkConfirmationReturnFocus = null;
  returnFocus?.focus?.();
}

function showLinkConfirmation(safe) {
  const dialog = document.getElementById("wbLinkConfirm");
  const url = document.getElementById("wbLinkConfirmUrl");
  const cancel = /** @type {HTMLButtonElement | null} */ (document.getElementById("wbLinkConfirmCancel"));
  if (!dialog || !url || !cancel) return;
  const activeElement = /** @type {{ focus?: () => void } | null} */ (document.activeElement);
  linkConfirmationReturnFocus = activeElement && typeof activeElement.focus === "function" ? activeElement : null;
  dialog.dataset.url = safe;
  url.textContent = safe;
  dialog.hidden = false;
  cancel.focus();
}

function onLinkOpen(element, event) {
  event.preventDefault();
  const safe = sanitizeSceneLink(element?.link);
  if (!safe) {
    showStatus("Blocked a link with an unsupported or unsafe scheme.");
    return;
  }
  showLinkConfirmation(safe);
}

// Inline frames start locked in view mode behind a click-catcher: a page of
// embedded whiteboards must scroll like a page, not trap every wheel event in
// canvas zoom. The first click unlocks this one editor.
function EditorApp({ elements, appState, files, theme, startLocked }) {
  const [locked, setLocked] = React.useState(startLocked);
  state.setLocked = setLocked;
  return React.createElement(
    "div",
    { style: { position: "relative", width: "100%", height: "100%" } },
    React.createElement(Excalidraw, {
      initialData: { elements, appState, files: files || undefined, scrollToContent: true },
      theme,
      viewModeEnabled: locked,
      onChange: scheduleSave,
      onLinkOpen,
      excalidrawAPI: (api) => {
        state.api = api;
        // Fit the whole scene into the frame - inline frames are far smaller
        // than the scene's natural 100% size, and a zoomed-in corner of a
        // diagram reads as broken.
        window.setTimeout(() => {
          try {
            api.scrollToContent(api.getSceneElements(), { fitToContent: true });
          } catch {
            // scrollToContent is cosmetic; initialData already centered us.
          }
        }, 0);
      },
      UIOptions: {
        canvasActions: {
          loadScene: false,
          saveToActiveFile: false,
          toggleTheme: false,
        },
      },
    }),
    locked
      ? React.createElement(
          "div",
          {
            className: "wb-activate",
            role: "button",
            tabIndex: 0,
            onClick: () => setLocked(false),
            onKeyDown: (event) => {
              if (event.key === "Enter" || event.key === " ") setLocked(false);
            },
          },
          React.createElement("span", { className: "wb-activate-label" }, "Click to edit"),
        )
      : null,
  );
}

function mountEditor({ elements, appState, files, theme }) {
  const editorHost = document.getElementById("wbEditor");
  const root = createRoot(editorHost);
  root.render(
    React.createElement(EditorApp, {
      elements,
      appState,
      files,
      theme,
      startLocked: state.mode === "inline",
    }),
  );
}

const textMetricsCanvas = document.createElement("canvas");
const textMetricsContext = textMetricsCanvas.getContext("2d");

function fontFamilyName(fontFamily) {
  return Object.entries(FONT_FAMILY).find(([, value]) => value === fontFamily)?.[0] || "Segoe UI Emoji";
}

function fontString(element) {
  const family = fontFamilyName(element.fontFamily);
  const families = family === "Excalifont" ? [family, "Xiaolai", "Segoe UI Emoji"] : [family, "Segoe UI Emoji"];
  return `${Number(element.fontSize) || 20}px ${families.map((value) => JSON.stringify(value)).join(", ")}`;
}

function measureSceneText(element) {
  if (!textMetricsContext) return { width: Number(element.width) || 0, height: Number(element.height) || 0 };
  textMetricsContext.font = fontString(element);
  const lines = String(element.text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "        ")
    .split("\n");
  const width = Math.max(...lines.map((line) => textMetricsContext.measureText(line || " ").width));
  const height = lines.length * (Number(element.fontSize) || 20) * (Number(element.lineHeight) || 1.25);
  return { width, height };
}

async function loadSceneFonts(elements, files) {
  const textElements = elements.filter((element) => element.type === "text" && !element.isDeleted);
  if (textElements.length === 0) return;
  await exportToCanvas({
    elements,
    appState: { exportBackground: false },
    files: files || null,
    maxWidthOrHeight: 1,
  });
  await Promise.all(
    textElements.map((element) => document.fonts.load(fontString(element), String(element.text || ""))),
  );
  await document.fonts.ready;
}

async function convertSource(source) {
  const { elements: skeletons, files } = await parseMermaidToExcalidraw(source, {
    themeVariables: { fontSize: "16px" },
  });
  const materialize = (input) => {
    // Preserve Mermaid node/edge identity for edit summaries; regenerate only
    // when upstream emitted colliding ids (parallel edges), where uniqueness
    // matters more than identity.
    let elements = convertToExcalidrawElements(input, { regenerateIds: false });
    if (findDuplicateElementIds(elements).length > 0) {
      elements = convertToExcalidrawElements(input, { regenerateIds: true });
    }
    return elements;
  };
  const elements = await convertExcalidrawSkeletonsAfterFontsLoad(skeletons, {
    convert: materialize,
    loadFonts: async (fallbackElements) => {
      await loadSceneFonts(fallbackElements, files);
    },
  });
  return { elements, files: files || {}, imageFallback: sceneIsImageFallback(elements) };
}

// Theme is passed only through the <Excalidraw theme> prop - putting it in
// appState as well double-applies the dark-mode invert filter and washes the
// canvas out. The background stays a light paper color in both themes; dark
// mode derives its rendering from it via Excalidraw's own filter.
function defaultAppState() {
  return {
    viewBackgroundColor: "#ffffff",
  };
}

async function startFromConversion(init) {
  const { elements, files, imageFallback } = await convertSource(init.source);
  state.baselineElements = JSON.parse(JSON.stringify(elements));
  state.files = files;
  state.imageFallback = imageFallback;
  state.sceneSourceHash = init.sourceHash;
  state.textMetricsVersion = WHITEBOARD_TEXT_METRICS_VERSION;
  if (imageFallback) {
    setBanner(
      "wbFallbackBanner",
      "This diagram type is not natively editable, so it is shown as an image - draw, annotate, and add shapes on top.",
    );
  }
  mountEditor({ elements, appState: defaultAppState(), files, theme: init.theme });
  scheduleSave();
}

async function startFromSavedScene(init) {
  const saved = init.saved;
  const savedAppState = sanitizeWhiteboardAppState(saved.scene?.appState);
  // restore() is Excalidraw's defensive loader: it fills missing fields with
  // defaults and repairs bindings, so a stale or hand-edited sidecar cannot
  // crash the editor.
  const restored = restore(
    {
      elements: Array.isArray(saved.scene?.elements) ? saved.scene.elements : [],
      appState: savedAppState,
      files: saved.scene?.files || {},
    },
    null,
    null,
    { repairBindings: true },
  );
  let elements = restored.elements;
  let baselineElements = Array.isArray(saved.baseline?.elements)
    ? JSON.parse(JSON.stringify(saved.baseline.elements))
    : JSON.parse(JSON.stringify(restored.elements));
  state.files = restored.files || saved.scene?.files || {};
  const savedMetricsVersion = Number(saved.text_metrics_version) || 0;
  if (savedMetricsVersion < WHITEBOARD_TEXT_METRICS_VERSION) {
    await loadSceneFonts(elements, state.files);
    elements = repairSavedSceneTextMetrics(elements, { measure: measureSceneText }).elements;
    baselineElements = repairSavedSceneTextMetrics(baselineElements, { measure: measureSceneText }).elements;
  }
  state.baselineElements = baselineElements;
  state.textMetricsVersion = WHITEBOARD_TEXT_METRICS_VERSION;
  state.imageFallback = sceneIsImageFallback(elements);
  state.sceneSourceHash = saved.source_hash || init.sourceHash;
  if (state.imageFallback) {
    setBanner(
      "wbFallbackBanner",
      "This diagram type is not natively editable, so it is shown as an image - draw, annotate, and add shapes on top.",
    );
  }
  mountEditor({
    elements,
    appState: { ...defaultAppState(), ...savedAppState },
    files: state.files,
    theme: init.theme,
  });
  if (savedMetricsVersion < WHITEBOARD_TEXT_METRICS_VERSION) scheduleSave();
}

// The saved scene was converted from a different version of the diagram. Never
// merge silently: the user explicitly picks between re-converting (discarding
// edits) and continuing on the saved scene.
function offerStaleChoice() {
  const staleBanner = document.getElementById("wbStaleBanner");
  staleBanner.textContent = "This diagram changed since these whiteboard edits were saved. ";
  const reconvert = el("button", { type: "button", textContent: "Re-convert (discard saved edits)" });
  const keep = el("button", { type: "button", textContent: "Keep editing saved scene" });
  staleBanner.append(reconvert, keep);
  staleBanner.hidden = false;
  return new Promise((resolve) => {
    reconvert.onclick = () => {
      staleBanner.hidden = true;
      resolve("reconvert");
    };
    keep.onclick = () => {
      staleBanner.textContent =
        "Editing a scene converted from an older version of this diagram. Re-open the whiteboard to convert the latest diagram.";
      resolve("keep");
    };
  });
}

async function queueFeedback() {
  if (!state.api || state.queueBusy) return;
  state.queueBusy = true;
  const queueButton = /** @type {HTMLButtonElement} */ (document.getElementById("wbQueue"));
  queueButton.disabled = true;
  queueButton.textContent = "Queueing...";
  try {
    const scene = currentScene();
    const summary = summarizeSceneEdits(state.baselineElements, scene.elements);
    const appState = state.api.getAppState();
    const blob = await exportToBlob({
      elements: state.api.getSceneElements(),
      appState: {
        exportBackground: true,
        viewBackgroundColor: appState.viewBackgroundColor || "#ffffff",
      },
      files: state.api.getFiles() || null,
      mimeType: "image/png",
    });
    const pngDataUrl = await blobToDataUrl(blob);
    post({
      type: "lavish-whiteboard:queueFeedback",
      diagramIndex: state.diagramIndex,
      diagramId: state.diagramId,
      ...createWhiteboardPersistencePayload(state, scene),
      imageFallback: state.imageFallback,
      note: String(/** @type {HTMLInputElement} */ (document.getElementById("wbNote")).value || "").trim(),
      summaryLines: summary.lines,
      stats: summary.stats,
      pngDataUrl,
    });
  } catch (error) {
    resetQueueButton();
    throw error;
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("could not encode PNG preview"));
    reader.readAsDataURL(blob);
  });
}

function resetQueueButton() {
  state.queueBusy = false;
  const queueButton = /** @type {HTMLButtonElement | null} */ (document.getElementById("wbQueue"));
  if (queueButton) {
    queueButton.disabled = false;
    queueButton.textContent = "Queue feedback";
  }
}

async function handleInit(init) {
  state.mode = init.mode === "inline" ? "inline" : "overlay";
  state.diagramIndex = Number(init.diagramIndex) || 0;
  state.diagramId = String(init.diagramId || "");
  state.currentSource = String(init.source || "");
  state.currentSourceHash = String(init.sourceHash || "");
  const theme = init.theme === "dark" ? "dark" : "light";
  document.getElementById("wbTitle").textContent = `Whiteboard · diagram ${state.diagramIndex + 1}`;

  const saved = init.saved && typeof init.saved === "object" && init.saved.scene ? init.saved : null;
  try {
    if (!saved) {
      await startFromConversion({ ...init, theme });
      return;
    }
    if (saved.source_hash === init.sourceHash) {
      await startFromSavedScene({ ...init, saved, theme });
      return;
    }
    const choice = await offerStaleChoice();
    if (choice === "keep") {
      await startFromSavedScene({ ...init, saved, theme });
    } else {
      await startFromConversion({ ...init, theme });
    }
  } catch (error) {
    showStatus(`Could not open this diagram as a whiteboard: ${describeError(error)}`, { transient: false });
  }
}

function handleSourceChanged(message) {
  state.currentSource = String(message.source || "");
  state.currentSourceHash = String(message.sourceHash || "");
  if (state.currentSourceHash !== state.sceneSourceHash) {
    setBanner(
      "wbStaleBanner",
      "The underlying diagram changed while you were editing. Your edits are kept; close and re-open the whiteboard to convert the latest diagram.",
    );
  } else {
    setBanner("wbStaleBanner", "");
  }
}

function main() {
  /** @type {any} */ (window).EXCALIDRAW_ASSET_PATH = `${location.origin}/whiteboard-assets/`;
  const frameUrl = new URL(location.href);
  const diagramIndex = Number(frameUrl.searchParams.get("diagramIndex"));
  state.diagramIndex = Number.isInteger(diagramIndex) && diagramIndex >= 0 && diagramIndex <= 999 ? diagramIndex : 0;
  state.diagramId = String(frameUrl.searchParams.get("diagramId") || "");
  let initialized = false;
  window.addEventListener("message", (event) => {
    if (event.source !== window.top) return;
    const msg = event.data || {};
    if (msg.type === "lavish-whiteboard:init" && !initialized && typeof msg.channelId === "string" && msg.channelId) {
      initialized = true;
      state.channelId = msg.channelId;
      buildShell(msg.theme === "dark" ? "dark" : "light", msg.mode === "inline" ? "inline" : "overlay");
      handleInit(msg);
    }
    if (!initialized || msg.channelId !== state.channelId) return;
    if (msg.type === "lavish-whiteboard:sourceChanged") handleSourceChanged(msg);
    if (msg.type === "lavish-whiteboard:prepareTeardown") prepareTeardown(msg);
    if (msg.type === "lavish-whiteboard:flush") flushSaveNow(msg);
    if (msg.type === "lavish-whiteboard:saveResult") handleSaveResult(msg);
    if (msg.type === "lavish-whiteboard:queueResult") {
      resetQueueButton();
      if (msg.ok) {
        const note = /** @type {HTMLInputElement | null} */ (document.getElementById("wbNote"));
        if (note) note.value = "";
        showStatus("Queued. Review it in the conversation panel, then Send to Agent.");
      } else {
        showStatus(`Queue failed: ${String(msg.error || "unknown error")}`, { transient: false });
      }
    }
  });
  post({ type: "lavish-whiteboard:ready" });
}

main();
