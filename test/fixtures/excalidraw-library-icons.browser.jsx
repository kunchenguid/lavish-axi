/* global document, location, window */

import { parseMermaidToExcalidraw } from "@excalidraw/mermaid-to-excalidraw";
import { convertToExcalidrawElements, Excalidraw, exportToCanvas, restore } from "@excalidraw/excalidraw";
import React from "react";
import { createRoot } from "react-dom/client";
import "@excalidraw/excalidraw/index.css";

import {
  placeLibraryIcons,
  prepareLibraryIconSkeletons,
  restoreMermaidLabelLineBreaks,
  summarizeSceneEdits,
} from "../../src/whiteboard-core.js";
import {
  findLibraryItem,
  parseExcalidrawLibrary,
  parseLibraryIconDirectives,
  toExcalidrawLibraryItems,
} from "../../src/whiteboard-libraries.js";

window.EXCALIDRAW_ASSET_PATH = `${location.origin}/whiteboard-assets/`;

// A hand-made library: plain shapes authored for this test.
const libraries = [
  parseExcalidrawLibrary(
    JSON.stringify({
      type: "excalidrawlib",
      version: 2,
      libraryItems: [
        {
          name: "Gear",
          elements: [
            { id: "gear-body", type: "ellipse", x: 0, y: 0, width: 100, height: 100, strokeColor: "#1e1e1e" },
            { id: "gear-hub", type: "rectangle", x: 35, y: 35, width: 30, height: 30, strokeColor: "#e8590c" },
          ],
        },
      ],
    }),
    { id: "fixture" },
  ),
];

const sources = {
  lr: `flowchart LR
  %% lavish-icon api fixture/Gear
  user([Customer]) --> api[Orders API]
  api --> db[(Orders table)]`,
  td: `flowchart TD
  %% lavish-icon api fixture/gear
  user[Customer] --> api[Orders API]
  api --> db[Orders table]`,
};

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function bounds(element) {
  if (Array.isArray(element.points)) {
    const xs = element.points.map((point) => element.x + point[0]);
    const ys = element.points.map((point) => element.y + point[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  return [element.x, element.y, element.x + element.width, element.y + element.height];
}

function distanceToBox(point, box) {
  const dx = Math.max(box.x - point[0], 0, point[0] - (box.x + box.width));
  const dy = Math.max(box.y - point[1], 0, point[1] - (box.y + box.height));
  return Math.hypot(dx, dy);
}

function strictlyInside(point, box) {
  return (
    point[0] > box.x + 1 &&
    point[0] < box.x + box.width - 1 &&
    point[1] > box.y + 1 &&
    point[1] < box.y + box.height - 1
  );
}

async function convert(source) {
  const parsed = await parseMermaidToExcalidraw(source, { themeVariables: { fontSize: "16px" } });
  const icons = parseLibraryIconDirectives(source).map((directive) => ({
    ...directive,
    item: findLibraryItem(libraries, directive.ref),
  }));
  const { skeletons, missing } = prepareLibraryIconSkeletons(restoreMermaidLabelLineBreaks(parsed.elements), icons);
  if (missing.length > 0) throw new Error(`icons were missing: ${JSON.stringify(missing)}`);
  const materialized = restoreMermaidLabelLineBreaks(convertToExcalidrawElements(skeletons, { regenerateIds: false }));
  const placed = placeLibraryIcons(materialized, (ref) => findLibraryItem(libraries, ref));
  return restore({ elements: placed, appState: {}, files: parsed.files || {} }, null, null, { repairBindings: true })
    .elements;
}

function checkIconNode(elements, layout) {
  const node = elements.find((element) => element.id === "api");
  if (!node) throw new Error(`${layout}: icon node lost its Mermaid id`);
  if (node.strokeColor !== "transparent") throw new Error(`${layout}: icon node box is still drawn`);
  const icon = elements.filter((element) => element.customData?.lavishLibraryRef === "fixture/Gear");
  if (icon.length !== 2) throw new Error(`${layout}: expected 2 icon elements, got ${icon.length}`);
  const label = elements.find((element) => element.type === "text" && element.containerId === "api");
  if (!label) throw new Error(`${layout}: icon node lost its label`);
  if (label.strokeColor === "transparent") throw new Error(`${layout}: icon node label is invisible`);
  const iconBottom = Math.max(...icon.map((element) => bounds(element)[3]));
  if (iconBottom > label.y) throw new Error(`${layout}: icon overlaps the label (${iconBottom} > ${label.y})`);
  for (const element of icon) {
    const [minX, minY, maxX, maxY] = bounds(element);
    if (
      minX < node.x - 0.5 ||
      maxX > node.x + node.width + 0.5 ||
      minY < node.y - 0.5 ||
      maxY > node.y + node.height + 0.5
    ) {
      throw new Error(`${layout}: icon element ${element.id} sits outside its node`);
    }
  }
  const arrows = elements.filter(
    (element) =>
      element.type === "arrow" &&
      (element.startBinding?.elementId === "api" || element.endBinding?.elementId === "api"),
  );
  if (arrows.length !== 2) throw new Error(`${layout}: expected 2 arrows bound to the icon node, got ${arrows.length}`);
  for (const arrow of arrows) {
    const endpoint =
      arrow.endBinding?.elementId === "api"
        ? [arrow.x + arrow.points.at(-1)[0], arrow.y + arrow.points.at(-1)[1]]
        : [arrow.x + arrow.points[0][0], arrow.y + arrow.points[0][1]];
    if (strictlyInside(endpoint, node)) throw new Error(`${layout}: arrow ${arrow.id} ends inside the grown node`);
    const gap = distanceToBox(endpoint, node);
    if (gap > 8) throw new Error(`${layout}: arrow ${arrow.id} stops ${gap}px short of the node`);
  }
  return { nodeHeight: Math.round(node.height), arrows: arrows.length };
}

async function insertFromLibraryPanel(elements) {
  let api;
  const host = document.createElement("div");
  host.style.width = "1000px";
  host.style.height = "700px";
  document.body.append(host);
  createRoot(host).render(
    <Excalidraw
      initialData={{
        elements,
        appState: { viewBackgroundColor: "#ffffff" },
        libraryItems: toExcalidrawLibraryItems(libraries),
        scrollToContent: true,
      }}
      excalidrawAPI={(value) => {
        api = value;
      }}
    />,
  );
  for (let attempt = 0; attempt < 100 && !api; attempt += 1) await sleep(25);
  if (!api) throw new Error("Excalidraw API did not mount");
  api.toggleSidebar({ name: "default", tab: "library", force: true });
  let unit = null;
  for (let attempt = 0; attempt < 100 && !unit; attempt += 1) {
    await sleep(25);
    unit = document.querySelector(".library-unit__dragger");
  }
  if (!unit) throw new Error("library panel did not list the fixture item");
  const panelItems = document.querySelectorAll(".library-unit__dragger").length;
  unit.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(300);
  const after = api.getSceneElements().map((element) => structuredClone(element));
  const dropped = after.filter(
    (element) =>
      element.customData?.lavishLibraryRef === "fixture/Gear" && !elements.some((before) => before.id === element.id),
  );
  if (dropped.length !== 2) throw new Error(`library insert kept ${dropped.length} tagged elements`);
  if (new Set(dropped.map((element) => element.groupIds.at(-1))).size !== 1) {
    throw new Error("inserted item elements do not share a group");
  }
  const summary = summarizeSceneEdits(elements, after);
  if (summary.lines.length !== 1 || !summary.lines[0].startsWith("Added library item fixture/Gear near")) {
    throw new Error(`unexpected summary: ${JSON.stringify(summary.lines)}`);
  }
  return { panelItems, dropped: dropped.length, summary: summary.lines[0] };
}

async function run() {
  const lr = await convert(sources.lr);
  const td = await convert(sources.td);
  const lrNode = checkIconNode(lr, "LR");
  const tdNode = checkIconNode(td, "TD");
  const canvas = await exportToCanvas({ elements: lr, appState: { exportBackground: false }, files: null });
  if (canvas.width === 0 || canvas.height === 0) throw new Error("icon scene did not render");
  const inserted = await insertFromLibraryPanel(lr);
  return { pass: true, lrNode, tdNode, ...inserted };
}

function report(result) {
  location.replace(`/result?value=${encodeURIComponent(JSON.stringify(result))}`);
}

run().then(
  (result) => report(result),
  (error) => report({ pass: false, error: error?.stack || String(error) }),
);
