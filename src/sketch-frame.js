/* global document, window */

// The sketch layer: one Excalidraw editor the chrome lays over the artifact iframe, so the
// reviewer can draw on the page and comment on any one sketch. It runs in the whiteboard frame
// page (same sandbox, bundle, and channel token) with `?sketch=1`, and like that frame it has no
// server access: the chrome persists the scene and queues comments.
//
// Scene coordinates are artifact document coordinates. Zoom stays at 1 and the scene scroll
// mirrors the artifact's scroll, which the chrome relays from the SDK; wheel and canvas panning are
// sent back as artifact scrolling, so a sketch stays on the content it was drawn over.

import { Excalidraw, exportToBlob, hashElementsVersion, restore } from "@excalidraw/excalidraw";
import React from "react";
import { createRoot } from "react-dom/client";

import { isModeToggleHotkeyEvent } from "./artifact-sdk.js";
import { describeSketchSelection } from "./whiteboard-core.js";

const SAVE_RETRY_MS = 2000;
// Red reads on light and dark pages alike; the canvas is never theme-inverted, so what the
// reviewer draws is what the scene stores.
const SKETCH_STROKE_COLOR = "#e03131";

const state = {
  channelId: "",
  /** @type {any} */
  api: null,
  scroll: { x: 0, y: 0 },
  /** @type {null | number} */
  saving: null,
  savedVersion: -1,
  unsaved: false,
  commentDraft: false,
  reportedDraft: false,
  /** @type {null | ((active: boolean) => void)} */
  setActive: null,
  /** @type {Map<string, (result: { ok: boolean, error?: string }) => void>} */
  commentResults: new Map(),
  /** @type {null | (() => void)} */
  onScroll: null,
};

function post(message) {
  window.top.postMessage(
    {
      ...message,
      ...(state.channelId
        ? { channelId: state.channelId }
        : { channelToken: String(/** @type {any} */ (window).__lavishWhiteboardChannelToken || "") }),
    },
    "*",
  );
}

function liveSelectedIds(appState) {
  const selected = appState?.selectedElementIds || {};
  return Object.keys(selected).filter((id) => selected[id]);
}

function isEditing(appState) {
  return Boolean(
    appState.cursorButton === "down" || appState.newElement || appState.multiElement || appState.editingTextElement,
  );
}

// Each queue attempt owns one chrome-side feedback preparation; the id ties its prepare, release,
// comment, and result together, so overlapping attempts never take each other's.
let nextAttempt = 0;
function mintAttemptId() {
  return "a" + ++nextAttempt + "-" + Math.random().toString(36).slice(2, 8);
}

function reportDraft() {
  const draft = state.commentDraft || state.unsaved;
  if (draft === state.reportedDraft) return;
  state.reportedDraft = draft;
  post({ type: "lavish-sketch:draft", draft });
}

// A finished change saves at once, one save at a time: whatever changes while a save is in flight
// goes out when the chrome acknowledges it, and a failed save is retried.
function saveIfChanged() {
  if (!state.api) return;
  const elements = state.api.getSceneElementsIncludingDeleted();
  const version = hashElementsVersion(elements);
  state.unsaved = version !== state.savedVersion;
  reportDraft();
  if (!state.unsaved || state.saving !== null || isEditing(state.api.getAppState())) return;
  state.saving = version;
  post({
    type: "lavish-sketch:save",
    scene: {
      elements: elements.map((element) => JSON.parse(JSON.stringify(element))),
      files: state.api.getFiles() || {},
    },
  });
}

function handleSaveResult(ok) {
  if (state.saving === null) return;
  if (ok) state.savedVersion = state.saving;
  state.saving = null;
  if (ok) saveIfChanged();
  else window.setTimeout(saveIfChanged, SAVE_RETRY_MS);
}

function applyScroll() {
  state.api?.updateScene({
    appState: /** @type {any} */ ({ scrollX: -state.scroll.x, scrollY: -state.scroll.y, zoom: { value: 1 } }),
  });
}

// Excalidraw pans and zooms its own canvas; here the artifact owns the viewport. A pan becomes
// artifact scrolling (the relayed scroll then moves the scene), and any other drift snaps back.
function onScrollChange(scrollX, scrollY, zoom) {
  const expectedX = -state.scroll.x;
  const expectedY = -state.scroll.y;
  if (zoom?.value === 1 && scrollX === expectedX && scrollY === expectedY) return;
  if (zoom?.value === 1) post({ type: "lavish-sketch:scrollBy", x: expectedX - scrollX, y: expectedY - scrollY });
  applyScroll();
}

function wheelPixels(event) {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
  return { x: event.deltaX * unit, y: event.deltaY * unit };
}

async function selectionPng(ids) {
  const wanted = new Set(ids);
  const elements = state.api
    .getSceneElements()
    .filter((element) => wanted.has(element.id) || wanted.has(element.containerId));
  const blob = await exportToBlob({
    elements,
    appState: { exportBackground: true, viewBackgroundColor: "#ffffff" },
    files: state.api.getFiles() || null,
    mimeType: "image/png",
    exportPadding: 16,
  });
  return new Uint8Array(await blob.arrayBuffer());
}

function CommentCard({ sketch, onClose }) {
  const [text, setText] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const inputRef = React.useRef(/** @type {HTMLTextAreaElement | null} */ (null));
  React.useEffect(() => inputRef.current?.focus(), []);
  // A cancelled card has already closed. Its late success must not close a newer card.
  const mounted = React.useRef(true);
  React.useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const hasText = Boolean(text.trim());
  React.useEffect(() => {
    if (!hasText) return undefined;
    state.commentDraft = true;
    reportDraft();
    return () => {
      state.commentDraft = false;
      reportDraft();
    };
  }, [hasText]);

  async function queue() {
    const comment = text.trim();
    if (!comment || busy) return;
    setBusy(true);
    setError("");
    const attemptId = mintAttemptId();
    try {
      // Tell the chrome a comment is coming before the slow export, so Send & End waits for it.
      post({ type: "lavish-sketch:prepare", attemptId });
      let png;
      try {
        png = await selectionPng(sketch.ids);
      } catch (failure) {
        post({ type: "lavish-sketch:release", attemptId });
        throw failure;
      }
      const result = await new Promise((resolve) => {
        state.commentResults.set(attemptId, resolve);
        post({ type: "lavish-sketch:comment", attemptId, comment, ...sketch, png });
      });
      if (result.ok) {
        if (mounted.current) onClose();
        return;
      }
      setError(String(result.error || "Could not queue this comment."));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
    setBusy(false);
  }

  return React.createElement(
    "div",
    { className: "sk-card", role: "dialog", "aria-label": "Comment on sketch" },
    React.createElement("div", { className: "sk-heading" }, "Comment on sketch: " + sketch.label),
    React.createElement("textarea", {
      ref: inputRef,
      value: text,
      placeholder: "Tell the agent what this sketch means...",
      // Words typed while Queue runs would miss the captured comment and vanish when the card closes.
      readOnly: busy,
      onChange: (event) => setText(event.target.value),
      onKeyDown: (event) => {
        if (event.key === "Escape") onClose();
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          queue();
        }
      },
    }),
    error ? React.createElement("div", { className: "sk-hint sk-error" }, error) : null,
    React.createElement("div", { className: "sk-hint" }, "Enter to queue · Shift+Enter for a new line"),
    React.createElement(
      "div",
      { className: "sk-row" },
      React.createElement("button", { className: "sk-cancel", type: "button", onClick: onClose }, "Cancel"),
      React.createElement(
        "button",
        { className: "sk-queue", type: "button", disabled: busy || !text.trim(), onClick: queue },
        busy ? "Queueing..." : "Queue",
      ),
    ),
  );
}

function SketchApp({ elements, files, startActive }) {
  const [active, setActive] = React.useState(startActive);
  const [sketch, setSketch] = React.useState(/** @type {any} */ (null));
  const [commenting, setCommenting] = React.useState(false);
  const [, setScrollTick] = React.useState(0);
  state.setActive = (next) => {
    setActive(next);
    if (!next) {
      setCommenting(false);
      state.api?.updateScene({ appState: { selectedElementIds: {} } });
    }
  };
  state.onScroll = () => setScrollTick((tick) => tick + 1);
  document.body.dataset.sketchActive = String(active);

  function onChange(sceneElements, appState) {
    saveIfChanged();
    const next = isEditing(appState) ? null : describeSketchSelection(sceneElements, liveSelectedIds(appState));
    setSketch((previous) => {
      if (!next) return null;
      if (previous && JSON.stringify(previous) === JSON.stringify(next)) return previous;
      return next;
    });
    if (!next) setCommenting(false);
  }

  const anchor = sketch && active ? sketch.bounds : null;
  const anchorStyle = anchor
    ? {
        left: Math.max(8, Math.min(anchor.x - state.scroll.x, window.innerWidth - (commenting ? 336 : 110))),
        // 18px clears Excalidraw's selection handles below the shape; the clamp keeps the card
        // (about 200px) or the button above the editor's bottom bar.
        top: Math.max(
          8,
          Math.min(anchor.y + anchor.height - state.scroll.y + 18, window.innerHeight - (commenting ? 220 : 110)),
        ),
      }
    : null;

  return React.createElement(
    "div",
    { className: "sk-root" },
    React.createElement(Excalidraw, {
      initialData: {
        elements,
        files: files || undefined,
        appState: /** @type {any} */ ({
          viewBackgroundColor: "transparent",
          currentItemStrokeColor: SKETCH_STROKE_COLOR,
          scrollX: -state.scroll.x,
          scrollY: -state.scroll.y,
          zoom: { value: 1 },
        }),
      },
      theme: "light",
      viewModeEnabled: !active,
      onChange,
      onScrollChange,
      excalidrawAPI: (api) => {
        state.api = api;
      },
      UIOptions: {
        canvasActions: {
          changeViewBackgroundColor: false,
          export: false,
          loadScene: false,
          saveAsImage: false,
          saveToActiveFile: false,
          toggleTheme: false,
        },
        tools: { image: false },
      },
    }),
    anchorStyle
      ? React.createElement(
          "div",
          { className: "sk-anchor", style: anchorStyle },
          commenting
            ? React.createElement(CommentCard, {
                key: sketch.ids.join(","),
                sketch,
                onClose: () => setCommenting(false),
              })
            : React.createElement(
                "button",
                { className: "sk-comment", type: "button", onClick: () => setCommenting(true) },
                "Comment",
              ),
        )
      : null,
  );
}

function mount(init) {
  const restored = restore(
    { elements: Array.isArray(init.scene?.elements) ? init.scene.elements : [], files: init.scene?.files || {} },
    null,
    null,
  );
  state.savedVersion = hashElementsVersion(restored.elements);
  const host = document.createElement("div");
  host.id = "skEditor";
  document.body.append(host);
  createRoot(host).render(
    React.createElement(SketchApp, {
      elements: restored.elements,
      files: restored.files,
      startActive: Boolean(init.active),
    }),
  );
}

export function startSketchFrame() {
  document.body.dataset.lavishSketch = "true";
  let initialized = false;
  window.addEventListener("message", (event) => {
    if (event.source !== window.top) return;
    const msg = event.data || {};
    if (msg.type === "lavish-sketch:init" && !initialized && typeof msg.channelId === "string" && msg.channelId) {
      initialized = true;
      state.channelId = msg.channelId;
      state.scroll = { x: Number(msg.scroll?.x) || 0, y: Number(msg.scroll?.y) || 0 };
      mount(msg);
      return;
    }
    if (!initialized || msg.channelId !== state.channelId) return;
    if (msg.type === "lavish-sketch:setActive") state.setActive?.(Boolean(msg.active));
    if (msg.type === "lavish-sketch:scroll") {
      state.scroll = { x: Number(msg.x) || 0, y: Number(msg.y) || 0 };
      applyScroll();
      state.onScroll?.();
    }
    if (msg.type === "lavish-sketch:commentResult") {
      const resolve = state.commentResults.get(String(msg.attemptId));
      state.commentResults.delete(String(msg.attemptId));
      resolve?.({ ok: Boolean(msg.ok), error: String(msg.error || "") });
    }
    if (msg.type === "lavish-sketch:saveResult") handleSaveResult(Boolean(msg.ok));
  });
  // The chrome only lets pointer events reach this frame in sketch mode, so every wheel over the
  // canvas is the reviewer scrolling the page under the sketches, never canvas zoom.
  window.addEventListener(
    "wheel",
    (event) => {
      if (!(/** @type {any} */ (event.target)?.classList?.contains("excalidraw__canvas"))) return;
      event.preventDefault();
      event.stopPropagation();
      const { x, y } = wheelPixels(event);
      post({ type: "lavish-sketch:scrollBy", x, y });
    },
    { capture: true, passive: false },
  );
  window.addEventListener(
    "keydown",
    (event) => {
      if (!isModeToggleHotkeyEvent(event)) return;
      // Excalidraw binds `I` to its eyedropper, which would swallow the next wheel and drag.
      event.preventDefault();
      event.stopPropagation();
      post({ type: "lavish-sketch:toggleAnnotationMode" });
    },
    true,
  );
  post({ type: "lavish-sketch:ready" });
}
