/* global document, window, FileReader, location */

// Browser entry for the whiteboard frame - the page the chrome hosts in a
// dedicated sandboxed iframe (`allow-scripts allow-popups`, no
// `allow-same-origin`) when the user opens a Mermaid diagram as an editable
// Excalidraw whiteboard. Bundled by `scripts/build.js` (esbuild) together with
// Excalidraw, the Mermaid converter, its own exactly-pinned mermaid, and React
// into `dist/whiteboard/whiteboard.js`, so nothing here loads from the network.
//
// The frame owns all whiteboard UI. It holds no server access: every byte in
// and out travels over postMessage with the chrome, which does the same-origin
// fetches. Untrusted Mermaid text therefore renders only inside this opaque
// origin, exactly like the artifact iframe.

import { parseMermaidToExcalidraw } from "@excalidraw/mermaid-to-excalidraw";
import { convertToExcalidrawElements, Excalidraw, exportToBlob, restore } from "@excalidraw/excalidraw";
import React from "react";
import { createRoot } from "react-dom/client";
import "@excalidraw/excalidraw/index.css";
import "./whiteboard-frame.css";

import {
  findDuplicateElementIds,
  sanitizeSceneLink,
  sceneIsImageFallback,
  summarizeSceneEdits,
} from "./whiteboard-core.js";

const SAVE_DEBOUNCE_MS = 800;

const state = {
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
  api: null,
  saveTimer: 0,
  queueBusy: false,
};

function post(message) {
  window.parent.postMessage(message, "*");
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

function buildShell(theme) {
  document.body.dataset.lavishWhiteboardTheme = theme;
  const shell = el("div", { id: "wbShell" });
  const header = el("header", { id: "wbHeader" });
  const title = el("div", { id: "wbTitle", textContent: "Whiteboard" });
  const note = el("input", {
    id: "wbNote",
    placeholder: "Optional note for the agent about these edits...",
    autocomplete: "off",
  });
  const queueButton = el("button", { id: "wbQueue", type: "button", textContent: "Queue feedback" });
  // The chrome overlay renders the close control on top of this header's
  // right edge (it must work even when this frame fails to boot), so the
  // header reserves that space via CSS instead of adding its own close.
  header.append(title, note, queueButton);
  const fallbackBanner = el("div", { id: "wbFallbackBanner", className: "wb-banner", hidden: true });
  const staleBanner = el("div", { id: "wbStaleBanner", className: "wb-banner wb-banner-warn", hidden: true });
  const status = el("div", { id: "wbStatus", className: "wb-status", hidden: true });
  const editor = el("div", { id: "wbEditor" });
  shell.append(header, fallbackBanner, staleBanner, status, editor);
  document.body.append(shell);

  queueButton.onclick = () => queueFeedback().catch((error) => showStatus(`Queue failed: ${describeError(error)}`));
  note.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      queueButton.click();
    }
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
    appState: {
      viewBackgroundColor: appState.viewBackgroundColor,
      scrollX: appState.scrollX,
      scrollY: appState.scrollY,
      zoom: appState.zoom,
    },
    files: state.api.getFiles() || {},
  };
}

function scheduleSave() {
  window.clearTimeout(state.saveTimer);
  state.saveTimer = window.setTimeout(() => {
    const scene = currentScene();
    if (!scene) return;
    post({
      type: "lavish-whiteboard:save",
      diagramIndex: state.diagramIndex,
      sourceHash: state.sceneSourceHash,
      scene,
      baseline: { elements: state.baselineElements },
    });
  }, SAVE_DEBOUNCE_MS);
}

function onLinkOpen(element, event) {
  event.preventDefault();
  const safe = sanitizeSceneLink(element?.link);
  if (!safe) {
    showStatus("Blocked a link with an unsupported or unsafe scheme.");
    return;
  }
  if (window.confirm(`Open this link in a new tab?\n\n${safe}`)) {
    window.open(safe, "_blank", "noopener,noreferrer");
  }
}

function mountEditor({ elements, appState, files, theme }) {
  const editorHost = document.getElementById("wbEditor");
  const root = createRoot(editorHost);
  root.render(
    React.createElement(
      "div",
      { style: { width: "100%", height: "100%" } },
      React.createElement(Excalidraw, {
        initialData: { elements, appState, files: files || undefined, scrollToContent: true },
        theme,
        onChange: scheduleSave,
        onLinkOpen,
        excalidrawAPI: (api) => {
          state.api = api;
        },
        UIOptions: {
          canvasActions: {
            loadScene: false,
            saveToActiveFile: false,
            toggleTheme: false,
          },
        },
      }),
    ),
  );
}

async function convertSource(source) {
  const { elements: skeletons, files } = await parseMermaidToExcalidraw(source, {
    themeVariables: { fontSize: "16px" },
  });
  // Preserve Mermaid node/edge identity for edit summaries; regenerate only
  // when upstream emitted colliding ids (parallel edges), where uniqueness
  // matters more than identity.
  let elements = convertToExcalidrawElements(skeletons, { regenerateIds: false });
  if (findDuplicateElementIds(elements).length > 0) {
    elements = convertToExcalidrawElements(skeletons, { regenerateIds: true });
  }
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
  if (imageFallback) {
    setBanner(
      "wbFallbackBanner",
      "This diagram type is not natively editable, so it is shown as an image - draw, annotate, and add shapes on top.",
    );
  }
  mountEditor({ elements, appState: defaultAppState(), files, theme: init.theme });
  scheduleSave();
}

function startFromSavedScene(init) {
  const saved = init.saved;
  // restore() is Excalidraw's defensive loader: it fills missing fields with
  // defaults and repairs bindings, so a stale or hand-edited sidecar cannot
  // crash the editor.
  const restored = restore(
    {
      elements: Array.isArray(saved.scene?.elements) ? saved.scene.elements : [],
      appState: saved.scene?.appState || {},
      files: saved.scene?.files || {},
    },
    null,
    null,
    { repairBindings: true },
  );
  state.baselineElements = Array.isArray(saved.baseline?.elements)
    ? JSON.parse(JSON.stringify(saved.baseline.elements))
    : JSON.parse(JSON.stringify(restored.elements));
  state.files = restored.files || saved.scene?.files || {};
  state.imageFallback = sceneIsImageFallback(restored.elements);
  state.sceneSourceHash = saved.source_hash || init.sourceHash;
  if (state.imageFallback) {
    setBanner(
      "wbFallbackBanner",
      "This diagram type is not natively editable, so it is shown as an image - draw, annotate, and add shapes on top.",
    );
  }
  // Strip any persisted theme: the live theme comes from the chrome via the
  // <Excalidraw theme> prop, and a theme inside appState double-applies the
  // dark-mode filter into a washed-out canvas.
  const savedAppState = { ...(saved.scene?.appState || {}) };
  delete savedAppState.theme;
  mountEditor({
    elements: restored.elements,
    appState: { ...defaultAppState(), ...savedAppState },
    files: state.files,
    theme: init.theme,
  });
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
      sourceHash: state.sceneSourceHash,
      imageFallback: state.imageFallback,
      note: String(/** @type {HTMLInputElement} */ (document.getElementById("wbNote")).value || "").trim(),
      summaryLines: summary.lines,
      stats: summary.stats,
      scene,
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
      startFromSavedScene({ ...init, saved, theme });
      return;
    }
    const choice = await offerStaleChoice();
    if (choice === "keep") {
      startFromSavedScene({ ...init, saved, theme });
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
  let initialized = false;
  window.addEventListener("message", (event) => {
    const msg = event.data || {};
    if (msg.type === "lavish-whiteboard:init" && !initialized) {
      initialized = true;
      buildShell(msg.theme === "dark" ? "dark" : "light");
      handleInit(msg);
    }
    if (msg.type === "lavish-whiteboard:sourceChanged") handleSourceChanged(msg);
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
