import assert from "node:assert/strict";
import test from "node:test";

import {
  CLEAN_FONT_FAMILY,
  createWhiteboardPersistencePayload,
  finalizeMermaidScene,
  findDuplicateElementIds,
  normalizeExcalidrawSceneTarget,
  repairSavedSceneTextMetrics,
  restoreMermaidLabelLineBreaks,
  sanitizeSceneLink,
  sceneIsImageFallback,
  summarizeSceneEdits,
  SUMMARY_MAX_LINE_CHARS,
} from "../src/whiteboard-core.js";

function rect(id, opts = {}) {
  return { id, type: "rectangle", x: 0, y: 0, width: 100, height: 40, ...opts };
}

function boundLabel(id, containerId, text) {
  return { id, type: "text", containerId, text, x: 10, y: 10, width: 80, height: 20 };
}

// ---------------------------------------------------------------------------
// sanitizeSceneLink
// ---------------------------------------------------------------------------

test("sanitizeSceneLink allows http(s) and mailto only", () => {
  assert.equal(sanitizeSceneLink("https://example.com/a?b=1"), "https://example.com/a?b=1");
  assert.equal(sanitizeSceneLink("http://localhost:3000"), "http://localhost:3000");
  assert.equal(sanitizeSceneLink("mailto:kun@example.com"), "mailto:kun@example.com");
});

test("sanitizeSceneLink rejects dangerous or unknown schemes", () => {
  assert.equal(sanitizeSceneLink("javascript:alert(1)"), "");
  assert.equal(sanitizeSceneLink("JAVASCRIPT:alert(1)"), "");
  assert.equal(sanitizeSceneLink("data:text/html,<script>1</script>"), "");
  assert.equal(sanitizeSceneLink("file:///etc/passwd"), "");
  assert.equal(sanitizeSceneLink("vbscript:x"), "");
  assert.equal(sanitizeSceneLink("relative/path"), "");
  assert.equal(sanitizeSceneLink(""), "");
  assert.equal(sanitizeSceneLink(null), "");
});

// ---------------------------------------------------------------------------
// sceneIsImageFallback
// ---------------------------------------------------------------------------

test("sceneIsImageFallback is true only for a non-empty all-image scene", () => {
  assert.equal(sceneIsImageFallback([{ id: "i1", type: "image" }]), true);
  assert.equal(sceneIsImageFallback([{ id: "i1", type: "image" }, rect("r1")]), false);
  assert.equal(sceneIsImageFallback([]), false);
  assert.equal(sceneIsImageFallback(null), false);
});

test("sceneIsImageFallback ignores deleted elements", () => {
  assert.equal(
    sceneIsImageFallback([
      { id: "i1", type: "image" },
      { ...rect("r1"), isDeleted: true },
    ]),
    true,
  );
});

// ---------------------------------------------------------------------------
// findDuplicateElementIds
// ---------------------------------------------------------------------------

test("findDuplicateElementIds finds repeated ids (parallel-edge upstream bug)", () => {
  assert.deepEqual(findDuplicateElementIds([rect("A"), rect("B"), rect("A")]), ["A"]);
  assert.deepEqual(findDuplicateElementIds([rect("A"), rect("B")]), []);
  assert.deepEqual(findDuplicateElementIds([]), []);
});

// ---------------------------------------------------------------------------
// repairSavedSceneTextMetrics
// ---------------------------------------------------------------------------

test("saved text repair only expands metrics", () => {
  const text = {
    id: "label",
    type: "text",
    x: 42,
    y: 17,
    width: 80,
    height: 20,
    text: "Edited label",
    originalText: "Edited label",
    containerId: "box",
    strokeColor: "#e03131",
    boundElements: [{ id: "arrow", type: "arrow" }],
    customData: { userEdit: true },
  };
  const { elements, repaired } = repairSavedSceneTextMetrics([text, rect("box")], {
    measure: () => ({ width: 118.5, height: 24 }),
  });
  assert.equal(repaired, 1);
  assert.deepEqual(elements[0], { ...text, width: 118.5, height: 24 });
  assert.strictEqual(elements[1].id, "box");
});

test("whiteboard persistence payload keeps migration and baseline fields together", () => {
  const scene = { elements: [rect("edited")] };
  const baselineElements = [rect("original")];
  assert.deepEqual(
    createWhiteboardPersistencePayload({ sceneSourceHash: "hash-1", textMetricsVersion: 1, baselineElements }, scene),
    {
      sourceHash: "hash-1",
      textMetricsVersion: 1,
      scene,
      baseline: { elements: baselineElements },
    },
  );
});

// ---------------------------------------------------------------------------
// summarizeSceneEdits
// ---------------------------------------------------------------------------

test("summarizeSceneEdits reports no changes for an identical scene", () => {
  const baseline = [rect("Login"), boundLabel("t1", "Login", "Login page")];
  const { stats, totalChanges, lines } = summarizeSceneEdits(baseline, structuredClone(baseline));
  assert.deepEqual(stats, { added: 0, removed: 0, moved: 0, relabeled: 0, drawn: 0 });
  assert.equal(totalChanges, 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /No element changes/);
});

test("summarizeSceneEdits counts moved and resized elements once", () => {
  const baseline = [rect("Auth")];
  const edited = [rect("Auth", { x: 120, y: -35, width: 140 })];
  const { stats, lines } = summarizeSceneEdits(baseline, edited);
  assert.equal(stats.moved, 1);
  assert.match(lines[0], /Moved by \(120, -35\) and resized by \(40, 0\)/);
  assert.match(lines[0], /\(Auth\)/);
});

test("summarizeSceneEdits ignores sub-epsilon jitter", () => {
  const baseline = [rect("Auth")];
  const edited = [rect("Auth", { x: 1.4, y: -1.2 })];
  assert.equal(summarizeSceneEdits(baseline, edited).totalChanges, 0);
});

test("summarizeSceneEdits reports relabeled bound text against the container", () => {
  const baseline = [rect("Auth"), boundLabel("t1", "Auth", "Valid?")];
  const edited = [rect("Auth"), boundLabel("t1", "Auth", "Session valid?")];
  const { stats, lines } = summarizeSceneEdits(baseline, edited);
  assert.deepEqual(stats, { added: 0, removed: 0, moved: 0, relabeled: 1, drawn: 0 });
  assert.match(lines[0], /Relabeled rectangle \(Auth\): "Valid\?" -> "Session valid\?"/);
});

test("summarizeSceneEdits reports added arrows with their endpoints", () => {
  const baseline = [rect("Home"), rect("Logout")];
  const edited = [
    ...structuredClone(baseline),
    {
      id: "arrow-1",
      type: "arrow",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      startBinding: { elementId: "Home" },
      endBinding: { elementId: "Logout" },
    },
  ];
  const { stats, lines } = summarizeSceneEdits(baseline, edited);
  assert.equal(stats.added, 1);
  assert.match(lines[0], /Added arrow \(arrow-1\) from rectangle \(Home\) to rectangle \(Logout\)/);
});

test("summarizeSceneEdits classifies freedraw strokes as drawn", () => {
  const baseline = [rect("A")];
  const edited = [...structuredClone(baseline), { id: "fd1", type: "freedraw", x: 33.7, y: 41.2 }];
  const { stats, lines } = summarizeSceneEdits(baseline, edited);
  assert.deepEqual(stats, { added: 0, removed: 0, moved: 0, relabeled: 0, drawn: 1 });
  assert.match(lines[0], /Drew a freehand mark near \(34, 41\)/);
});

test("summarizeSceneEdits reports removals, treating isDeleted as removed", () => {
  const baseline = [rect("A"), rect("B")];
  const edited = [rect("A"), { ...rect("B"), isDeleted: true }];
  const { stats, lines } = summarizeSceneEdits(baseline, edited);
  assert.equal(stats.removed, 1);
  assert.match(lines[0], /Removed rectangle \(B\)/);
});

test("summarizeSceneEdits does not report a new container's label as a separate add", () => {
  const baseline = [rect("A")];
  const edited = [...structuredClone(baseline), rect("New1"), boundLabel("t9", "New1", "Logout")];
  const { stats, lines } = summarizeSceneEdits(baseline, edited);
  assert.equal(stats.added, 1);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Added rectangle "Logout" \(New1\)/);
});

test("summarizeSceneEdits bounds output lines and clamps line length", () => {
  const baseline = [];
  const edited = Array.from({ length: 60 }, (_, i) => rect(`el-${i}`, { text: "x".repeat(500) }));
  const { lines, stats } = summarizeSceneEdits(baseline, edited, { maxLines: 10 });
  assert.equal(stats.added, 60);
  assert.equal(lines.length, 11);
  assert.match(lines[10], /and 50 more changes/);
  assert.ok(lines[0].length <= SUMMARY_MAX_LINE_CHARS);
});

// ---------------------------------------------------------------------------
// normalizeExcalidrawSceneTarget
// ---------------------------------------------------------------------------

test("normalizeExcalidrawSceneTarget strips to the fixed shape", () => {
  const out = normalizeExcalidrawSceneTarget({
    type: "excalidraw-scene",
    diagramIndex: 2,
    diagramId: "mermaid-3",
    sourceHash: "abc123",
    scenePath: "/state/whiteboards/k/2.excalidraw",
    previewPath: "/state/whiteboards/k/2.png",
    imageFallback: false,
    stats: { added: 3, removed: 1, moved: 2, relabeled: 1, drawn: 4 },
    injected: "nope",
    __proto__: null,
  });
  assert.deepEqual(out, {
    type: "excalidraw-scene",
    diagramIndex: 2,
    diagramId: "mermaid-3",
    sourceHash: "abc123",
    scenePath: "/state/whiteboards/k/2.excalidraw",
    previewPath: "/state/whiteboards/k/2.png",
    imageFallback: false,
    stats: { added: 3, removed: 1, moved: 2, relabeled: 1, drawn: 4 },
  });
});

test("normalizeExcalidrawSceneTarget coerces hostile values to bounded safe ones", () => {
  const out = normalizeExcalidrawSceneTarget({
    diagramIndex: "999999",
    diagramId: 42,
    stats: { added: -5, removed: "1e9", moved: NaN, relabeled: 2.7, drawn: { evil: true } },
  });
  assert.equal(out.diagramIndex, 999);
  assert.equal(out.diagramId, "42");
  assert.equal(out.scenePath, "");
  assert.equal(out.imageFallback, false);
  assert.deepEqual(out.stats, { added: 0, removed: 10_000, moved: 0, relabeled: 3, drawn: 0 });
});

// ---------------------------------------------------------------------------
// Mermaid -> Excalidraw label line breaks
// parseMermaidToExcalidraw copies vertex.text into skeleton label.text, leaving
// literal <br> tags and two-character \n sequences in place. convertToExcalidrawElements
// then wraps that string as ordinary characters, so "classify<br>checks" becomes
// the fused "classifychecks" once the tag is not a real newline.
// These cases use the skeleton/text shapes that conversion actually emits.
// ---------------------------------------------------------------------------

function assertConvertedLines(element, expectedLines) {
  const original = String(element.originalText ?? element.label?.text ?? element.text ?? "");
  const text = String(element.text ?? element.label?.text ?? "");
  for (const value of [original, text]) {
    assert.equal(value.includes("<br"), false, `HTML break tags must not remain: ${JSON.stringify(value)}`);
    assert.deepEqual(
      value.split("\n"),
      expectedLines,
      `expected newline-separated lines, got ${JSON.stringify(value)}`,
    );
  }
  const fused = expectedLines.join("");
  assert.equal(original.includes(fused), false, `adjacent words were fused: ${JSON.stringify(original)}`);
  assert.equal(text.includes(fused), false, `adjacent words were fused: ${JSON.stringify(text)}`);
}

test("restoreMermaidLabelLineBreaks turns <br> and <br/> into real newlines without fusing words", () => {
  const skeletons = [
    {
      id: "br",
      type: "rectangle",
      x: 0,
      y: 0,
      width: 140,
      height: 40,
      label: { text: "first line<br>second line", fontSize: 16 },
    },
    {
      id: "brslash",
      type: "rectangle",
      x: 0,
      y: 0,
      width: 140,
      height: 40,
      label: { text: "first line<br/>second line", fontSize: 16 },
    },
    {
      id: "live",
      type: "rectangle",
      x: 0,
      y: 0,
      width: 260,
      height: 54,
      label: {
        text: "1  Scan + classify<br>checks - compliance - mergeable - blast radius - risky paths<br>FLEET_TOKEN, deterministic",
        fontSize: 16,
      },
    },
  ];
  const [br, brslash, live] = restoreMermaidLabelLineBreaks(skeletons);
  assertConvertedLines(br, ["first line", "second line"]);
  assertConvertedLines(brslash, ["first line", "second line"]);
  assertConvertedLines(live, [
    "1  Scan + classify",
    "checks - compliance - mergeable - blast radius - risky paths",
    "FLEET_TOKEN, deterministic",
  ]);
  assert.equal(live.label.text.includes("classifychecks"), false);
  assert.equal(live.label.text.includes("pathsFLEET_TOKEN"), false);
});

test("restoreMermaidLabelLineBreaks turns mermaid \\n label breaks into real newlines", () => {
  const [node] = restoreMermaidLabelLineBreaks([
    {
      id: "nl",
      type: "rectangle",
      x: 0,
      y: 0,
      width: 216,
      height: 54,
      label: { text: "first line\\nsecond line", fontSize: 16 },
    },
  ]);
  assertConvertedLines(node, ["first line", "second line"]);
});

test("restoreMermaidLabelLineBreaks rewrites materialized text elements and sizes to the line set", () => {
  const box = rect("A", { x: 10, y: 20, width: 80, height: 24 });
  const label = {
    id: "t1",
    type: "text",
    containerId: "A",
    x: 14,
    y: 24,
    width: 72,
    height: 20,
    fontSize: 16,
    lineHeight: 1.25,
    text: "classify<br>checks",
    originalText: "classify<br>checks",
  };
  const measure = (element) => {
    const lines = String(element.text || "").split("\n");
    return {
      width: Math.max(...lines.map((line) => line.length * 10)),
      height: lines.length * (Number(element.fontSize) || 16) * (Number(element.lineHeight) || 1.25),
    };
  };
  const [container, text] = restoreMermaidLabelLineBreaks([box, label], { measure });
  assertConvertedLines(text, ["classify", "checks"]);
  assert.equal(text.width, 80);
  assert.equal(text.height, 40);
  assert.ok(container.width >= text.width, "container must be at least as wide as the multiline label");
  assert.ok(container.height >= text.height, "container must be at least as tall as the multiline label");
});

test("restoreMermaidLabelLineBreaks recenters bound text when container growth shifts the box", () => {
  const box = rect("A", { x: 10, y: 20, width: 80, height: 24 });
  const label = {
    id: "t1",
    type: "text",
    containerId: "A",
    x: 14,
    y: 24,
    width: 72,
    height: 20,
    fontSize: 16,
    lineHeight: 1.25,
    textAlign: "center",
    verticalAlign: "middle",
    text: "classify<br>checks",
    originalText: "classify<br>checks",
  };
  const measure = (element) => {
    const lines = String(element.text || "").split("\n");
    return {
      width: Math.max(...lines.map((line) => line.length * 10)),
      height: lines.length * (Number(element.fontSize) || 16) * (Number(element.lineHeight) || 1.25),
    };
  };
  const [container, text] = restoreMermaidLabelLineBreaks([box, label], { measure });
  assert.ok(container.height > box.height, "container must grow so the recenter assertion is load-bearing");
  assert.ok(container.y < box.y, "expandBoxToFit grows from the center, moving the container origin");
  assert.equal(text.x, container.x + (container.width - text.width) / 2);
  assert.equal(text.y, container.y + (container.height - text.height) / 2);
});

test("finalizeMermaidScene loads and measures the final clean font", async () => {
  const box = rect("A", { width: 80, height: 24 });
  const label = {
    id: "t1",
    type: "text",
    containerId: "A",
    width: 60,
    height: 20,
    fontFamily: 1,
    fontSize: 16,
    lineHeight: 1.25,
    text: "wide label",
    originalText: "wide label",
  };
  let fontsLoaded = false;
  const [, text] = await finalizeMermaidScene([box, label], {
    loadFonts: async (elements) => {
      assert.equal(elements[1].fontFamily, CLEAN_FONT_FAMILY);
      fontsLoaded = true;
    },
    measure: (element) => {
      assert.equal(fontsLoaded, true);
      assert.equal(element.fontFamily, CLEAN_FONT_FAMILY);
      return { width: 120, height: 20 };
    },
  });

  assert.equal(text.fontFamily, CLEAN_FONT_FAMILY);
  assert.equal(text.width, 120);
});

test("restoreMermaidLabelLineBreaks leaves labelled-arrow geometry and path-midpoint labels alone", () => {
  const shortArrow = {
    id: "edge-short",
    type: "arrow",
    x: 100,
    y: 50,
    width: 80,
    height: 8,
    points: [
      [0, 0],
      [80, 8],
    ],
    startBinding: { elementId: "A", focus: 0, gap: 1 },
    endBinding: { elementId: "B", focus: 0, gap: 1 },
  };
  const shortLabel = {
    id: "edge-short-label",
    type: "text",
    containerId: "edge-short",
    x: 118,
    y: 36,
    width: 44,
    height: 20,
    textAlign: "center",
    verticalAlign: "middle",
    text: "yes",
    originalText: "yes",
  };
  const elbowArrow = {
    id: "edge-elbow",
    type: "arrow",
    x: 200,
    y: 80,
    width: 120,
    height: 60,
    points: [
      [0, 0],
      [60, 60],
      [120, 0],
    ],
  };
  const elbowLabel = {
    id: "edge-elbow-label",
    type: "text",
    containerId: "edge-elbow",
    x: 240,
    y: 70,
    width: 40,
    height: 20,
    textAlign: "center",
    verticalAlign: "middle",
    text: "maybe",
    originalText: "maybe",
  };
  const [outShort, outShortLabel, outElbow, outElbowLabel] = restoreMermaidLabelLineBreaks(
    [shortArrow, shortLabel, elbowArrow, elbowLabel],
    { measure: (element) => ({ width: element.width, height: element.height }) },
  );
  assert.equal(outShort.x, shortArrow.x);
  assert.equal(outShort.y, shortArrow.y);
  assert.equal(outShort.width, shortArrow.width);
  assert.equal(outShort.height, shortArrow.height);
  assert.deepEqual(outShort.points, shortArrow.points);
  assert.equal(outShortLabel.x, shortLabel.x);
  assert.equal(outShortLabel.y, shortLabel.y);
  assert.equal(outElbow.x, elbowArrow.x);
  assert.equal(outElbow.y, elbowArrow.y);
  assert.deepEqual(outElbow.points, elbowArrow.points);
  assert.equal(outElbowLabel.x, elbowLabel.x);
  assert.equal(outElbowLabel.y, elbowLabel.y);
  assert.notEqual(elbowLabel.y, elbowArrow.y + (elbowArrow.height - elbowLabel.height) / 2);
});

test("restoreMermaidLabelLineBreaks leaves single-line labels and non-label fields alone", () => {
  const box = rect("A", { width: 100, height: 40, customData: { keep: true } });
  const label = boundLabel("t1", "A", "Ready?");
  const arrow = {
    id: "a1",
    type: "arrow",
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    label: { text: "yes" },
  };
  const out = restoreMermaidLabelLineBreaks([box, label, arrow]);
  assert.deepEqual(out[0], box);
  assert.deepEqual(out[1], label);
  assert.equal(out[2].label.text, "yes");
  assert.equal(out[2].id, "a1");
});
