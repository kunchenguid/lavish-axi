/* global document, location, window */

import { parseMermaidToExcalidraw } from "@excalidraw/mermaid-to-excalidraw";
import { convertToExcalidrawElements, exportToCanvas, FONT_FAMILY } from "@excalidraw/excalidraw";

import {
  convertExcalidrawSkeletonsAfterFontsLoad,
  findDuplicateElementIds,
  repairSavedSceneTextMetrics,
} from "../../src/whiteboard-core.js";
import fixture from "./excalidraw-label-clipping.json" with { type: "json" };

/** @type {any} */ (window).EXCALIDRAW_ASSET_PATH = `${location.origin}/whiteboard-assets/`;

const metricsCanvas = document.createElement("canvas");
const metricsContext = metricsCanvas.getContext("2d");

function fontFamilyName(fontFamily) {
  return Object.entries(FONT_FAMILY).find(([, value]) => value === fontFamily)?.[0] || "Segoe UI Emoji";
}

function fontString(element) {
  const family = fontFamilyName(element.fontFamily);
  const families = family === "Excalifont" ? [family, "Xiaolai", "Segoe UI Emoji"] : [family, "Segoe UI Emoji"];
  return `${Number(element.fontSize) || 20}px ${families.map((value) => JSON.stringify(value)).join(", ")}`;
}

function measureText(element) {
  metricsContext.font = fontString(element);
  const lines = String(element.text || "").split("\n");
  return {
    width: Math.max(...lines.map((line) => metricsContext.measureText(line || " ").width)),
    height: lines.length * (Number(element.fontSize) || 20) * (Number(element.lineHeight) || 1.25),
  };
}

async function loadFonts(elements, files) {
  await exportToCanvas({
    elements,
    appState: { exportBackground: false },
    files,
    maxWidthOrHeight: 1,
  });
  const labels = elements.filter((element) => element.type === "text" && !element.isDeleted);
  await Promise.all(labels.map((element) => document.fonts.load(fontString(element), String(element.text || ""))));
  await document.fonts.ready;
}

function materialize(skeletons) {
  let elements = convertToExcalidrawElements(skeletons, { regenerateIds: false });
  if (findDuplicateElementIds(elements).length > 0) {
    elements = convertToExcalidrawElements(skeletons, { regenerateIds: true });
  }
  return elements;
}

function labelByText(elements, expected) {
  const normalize = (value) =>
    String(value || "")
      .replace(/<br\s*\/?\s*>/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  return elements.find(
    (element) =>
      element.type === "text" &&
      [element.originalText, element.text].some((candidate) => normalize(candidate) === normalize(expected)),
  );
}

function withoutMetrics(element) {
  const copy = { ...element };
  delete copy.width;
  delete copy.height;
  return copy;
}

async function run() {
  const parsed = await parseMermaidToExcalidraw(fixture.source, { themeVariables: { fontSize: "16px" } });
  let fallbackElements = [];
  const elements = await convertExcalidrawSkeletonsAfterFontsLoad(parsed.elements, {
    convert: materialize,
    loadFonts: async (firstPass) => {
      fallbackElements = structuredClone(firstPass);
      await loadFonts(firstPass, parsed.files || null);
    },
  });
  const expectedLabels = [...fixture.edgeLabels, fixture.multilineLabel];
  const labels = expectedLabels.map((text) => labelByText(elements, text));
  if (labels.some((label) => !label)) {
    const actual = elements
      .filter((element) => element.type === "text")
      .map((element) => element.originalText || element.text);
    throw new Error(`fixture labels were missing from the converted scene: ${JSON.stringify(actual)}`);
  }
  if (labels.filter((label) => label.containerId).length < 4) {
    throw new Error("fixture node labels were not bound to diagram boxes");
  }
  const fallbackLabels = expectedLabels.map((text) => labelByText(fallbackElements, text));
  if (!labels.some((label, index) => label.width > fallbackLabels[index].width + 1)) {
    throw new Error("cold conversion did not reproduce fallback-sized text");
  }
  const geometry = labels.map((label) => ({ label, measured: measureText(label) }));
  if (
    geometry.some(({ label, measured }) => measured.width > label.width + 0.1 || measured.height > label.height + 0.1)
  ) {
    throw new Error("loaded glyph metrics exceed a converted text box");
  }
  const multiline = labelByText(elements, fixture.multilineLabel);
  if (!multiline.text.includes("\n") || measureText(multiline).height > multiline.height + 0.1) {
    throw new Error("multiline label geometry is clipped");
  }
  const rendered = await exportToCanvas({
    elements,
    appState: { exportBackground: false, exportPadding: 12 },
    files: parsed.files || null,
  });
  const renderedPixels = rendered.getContext("2d").getImageData(0, 0, rendered.width, rendered.height).data;
  let opaquePixels = 0;
  for (let index = 3; index < renderedPixels.length; index += 4) {
    if (renderedPixels[index] > 0) opaquePixels += 1;
  }
  if (opaquePixels < 1000) throw new Error("Excalidraw canvas did not render the fixture");

  const stale = elements.map((element) =>
    element.type === "text"
      ? {
          ...element,
          width: Math.max(1, element.width - 32),
          height: Math.max(1, element.height - 8),
          customData: { ...(element.customData || {}), preservedUserEdit: true },
        }
      : element,
  );
  const staleSnapshot = structuredClone(stale);
  const repaired = repairSavedSceneTextMetrics(stale, { measure: measureText });
  if (repaired.repaired < labels.length) throw new Error("saved-scene migration missed stale labels");
  if (
    repaired.elements.some(
      (element, index) =>
        JSON.stringify(withoutMetrics(element)) !== JSON.stringify(withoutMetrics(staleSnapshot[index])),
    )
  ) {
    throw new Error("saved-scene migration changed user-edited element data");
  }
  const repairedLabels = expectedLabels.map((text) => labelByText(repaired.elements, text));
  if (
    repairedLabels.some((label) => {
      const measured = measureText(label);
      return measured.width > label.width + 0.1 || measured.height > label.height + 0.1;
    })
  ) {
    throw new Error("saved-scene migration left clipped glyph geometry");
  }
  const repairedCanvas = await exportToCanvas({
    elements: repaired.elements,
    appState: { exportBackground: false, exportPadding: 12 },
    files: parsed.files || null,
  });
  if (repairedCanvas.width === 0 || repairedCanvas.height === 0) throw new Error("repaired scene did not render");
  return {
    pass: true,
    fontReady: document.fonts.check(fontString(labels[0]), labels[0].text),
    edgeLabels: fixture.edgeLabels.length,
    multilineLines: multiline.text.split("\n").length,
    repaired: repaired.repaired,
    opaquePixels,
  };
}

run().then(
  (result) => {
    document.body.dataset.result = JSON.stringify(result);
  },
  (error) => {
    document.body.dataset.result = JSON.stringify({ pass: false, error: error?.stack || String(error) });
  },
);
