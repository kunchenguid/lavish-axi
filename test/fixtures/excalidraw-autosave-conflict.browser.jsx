/* global document, location, window */

import { parseMermaidToExcalidraw } from "@excalidraw/mermaid-to-excalidraw";
import { convertToExcalidrawElements, Excalidraw, restore } from "@excalidraw/excalidraw";
import React from "react";
import { createRoot } from "react-dom/client";
import "@excalidraw/excalidraw/index.css";

import { resolveWhiteboardInitAction, sanitizeWhiteboardAppState } from "../../src/whiteboard-core.js";

window.EXCALIDRAW_ASSET_PATH = `${location.origin}/whiteboard-assets/`;

const source = `flowchart LR
  A[Collect] --> B[Review]
  B --> C[Ship]`;

function restoredScene(elements, appState, files) {
  return restore(
    {
      elements,
      appState: sanitizeWhiteboardAppState(appState),
      files: files || {},
    },
    null,
    null,
    { repairBindings: true },
  );
}

function normalizedSaved(scene, baseline, files) {
  const restored = restoredScene(scene.elements, scene.appState, files);
  const restoredBaseline = restoredScene(baseline, { viewBackgroundColor: "#ffffff" }, files);
  return {
    source_hash: "hash-old",
    scene: { ...scene, elements: restored.elements },
    baseline: { elements: restoredBaseline.elements },
  };
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function run() {
  const parsed = await parseMermaidToExcalidraw(source, { themeVariables: { fontSize: "16px" } });
  const converted = convertToExcalidrawElements(parsed.elements, { regenerateIds: false });
  const initial = restoredScene(converted, { viewBackgroundColor: "#ffffff" }, parsed.files);
  const baseline = structuredClone(initial.elements);

  let api;
  const host = document.createElement("div");
  host.style.width = "900px";
  host.style.height = "600px";
  document.body.append(host);
  createRoot(host).render(
    <Excalidraw
      initialData={{
        elements: initial.elements,
        appState: { viewBackgroundColor: "#ffffff" },
        files: initial.files,
        scrollToContent: true,
      }}
      excalidrawAPI={(value) => {
        api = value;
      }}
    />,
  );

  for (let attempt = 0; attempt < 100 && !api; attempt += 1) await sleep(25);
  if (!api) throw new Error("Excalidraw API did not mount");
  api.scrollToContent(api.getSceneElements(), { fitToContent: true });
  await sleep(500);

  const mountedScene = {
    elements: api.getSceneElements().map((element) => structuredClone(element)),
    appState: sanitizeWhiteboardAppState(api.getAppState()),
    files: api.getFiles(),
  };
  const preMountBaselineAction = resolveWhiteboardInitAction(
    { source_hash: "hash-old", scene: mountedScene, baseline: { elements: converted } },
    "hash-new",
  );
  const viewOnlyAction = resolveWhiteboardInitAction(
    normalizedSaved(mountedScene, baseline, initial.files),
    "hash-new",
  );

  const target = api.getSceneElements().find((element) => element.type !== "text" && !element.isDeleted);
  if (!target) throw new Error("converted scene did not contain an editable shape");
  api.updateScene({
    elements: api
      .getSceneElements()
      .map((element) => (element.id === target.id ? { ...element, angle: Math.PI / 4 } : element)),
  });
  await sleep(250);
  const editedScene = {
    elements: api.getSceneElements().map((element) => structuredClone(element)),
    appState: sanitizeWhiteboardAppState(api.getAppState()),
    files: api.getFiles(),
  };
  const editedAction = resolveWhiteboardInitAction(
    normalizedSaved(editedScene, baseline, initial.files),
    "hash-new",
  );

  if (preMountBaselineAction !== "prompt") {
    throw new Error(`fixture did not reproduce the pre-mount baseline conflict: ${preMountBaselineAction}`);
  }
  if (viewOnlyAction !== "convert") throw new Error(`view-only autosave resolved to ${viewOnlyAction}`);
  if (editedAction !== "prompt") throw new Error(`rotated scene resolved to ${editedAction}`);
  return { pass: true, preMountBaselineAction, viewOnlyAction, editedAction };
}

function report(result) {
  location.replace(`/result?value=${encodeURIComponent(JSON.stringify(result))}`);
}

run().then(
  (result) => report(result),
  (error) => report({ pass: false, error: error?.stack || String(error) }),
);
