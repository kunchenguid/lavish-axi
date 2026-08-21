import assert from "node:assert/strict";
import test from "node:test";

import {
  collectRevisionMarkedElements,
  isAddressableRevisionId,
  MAX_REVISION_RAW_ENTRIES,
  MAX_REVISION_RAW_SECTIONS,
  normalizeRevisionEntry,
  parseRevisionRegistry,
  resolveElementRevisionId,
  REVISION_PALETTE,
  revisionColorForIndex,
  revisionIsValidTimestamp,
  revisionTintFromHex,
  revisionTruncate,
  createArtifactSdk,
} from "../src/artifact-sdk.js";

// ---------------------------------------------------------------------------
// Minimal fake-DOM helpers, matching the hand-built-stub convention used by
// mermaid-node.test.js and chrome-client-queue.test.js rather than a DOM
// library: only the surface parseRevisionRegistry/collectRevisionMarkedElements
// touch (querySelector, querySelectorAll, getAttribute, textContent).
// ---------------------------------------------------------------------------

function markedElement(attrValue) {
  return {
    getAttribute(name) {
      return name === "data-lavish-revision" ? attrValue : null;
    },
  };
}

/** @param {{ scriptTextContent?: string, markedElements?: unknown[] }} [options] */
function fakeDoc({ scriptTextContent, markedElements = [] } = {}) {
  return {
    querySelector(sel) {
      if (sel === "script[data-lavish-revisions]" && scriptTextContent !== undefined) {
        return { textContent: scriptTextContent };
      }
      return null;
    },
    querySelectorAll(sel) {
      return sel === "[data-lavish-revision]" ? markedElements : [];
    },
  };
}

// ---------------------------------------------------------------------------
// parseRevisionRegistry - legacy/no-metadata path
// ---------------------------------------------------------------------------

test("parseRevisionRegistry returns an empty array for a missing/invalid doc", () => {
  assert.deepEqual(parseRevisionRegistry(null), []);
  assert.deepEqual(parseRevisionRegistry(undefined), []);
  assert.deepEqual(parseRevisionRegistry({}), []);
});

test("parseRevisionRegistry returns [] when the artifact has no revisions script tag (legacy artifact)", () => {
  assert.deepEqual(parseRevisionRegistry(fakeDoc()), []);
});

test("parseRevisionRegistry returns [] for invalid JSON instead of throwing", () => {
  assert.deepEqual(parseRevisionRegistry(fakeDoc({ scriptTextContent: "{not valid json" })), []);
});

test("parseRevisionRegistry returns [] when the JSON payload is not an array", () => {
  assert.deepEqual(parseRevisionRegistry(fakeDoc({ scriptTextContent: '{"id":"1"}' })), []);
});

// ---------------------------------------------------------------------------
// parseRevisionRegistry - persistence / multiple revisions
// ---------------------------------------------------------------------------

test("parseRevisionRegistry normalizes a full multi-revision registry", () => {
  const registry = [
    { id: "1", label: "Initial draft", timestamp: "2026-07-29T10:00:00Z", summary: "First pass", sections: ["Hero"] },
    { id: "2", label: "Pricing fix", timestamp: "2026-07-30T09:00:00Z", summary: "Fixed pricing copy" },
  ];
  const parsed = parseRevisionRegistry(fakeDoc({ scriptTextContent: JSON.stringify(registry) }));

  assert.equal(parsed.length, 2);
  assert.deepEqual(
    parsed.map((r) => r.id),
    ["1", "2"],
  );
  assert.equal(parsed[0].label, "Initial draft");
  assert.equal(parsed[0].summary, "First pass");
  assert.deepEqual(parsed[0].sections, ["Hero"]);
  assert.equal(parsed[1].sections.length, 0);
  assert.deepEqual(parsed[0].color, REVISION_PALETTE[0]);
  assert.deepEqual(parsed[1].color, REVISION_PALETTE[1]);
});

test("parseRevisionRegistry fills defaults for a minimal entry", () => {
  const parsed = parseRevisionRegistry(fakeDoc({ scriptTextContent: JSON.stringify([{}]) }));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].id, "1");
  assert.equal(parsed[0].label, "Revision 1");
  assert.equal(parsed[0].timestamp, "");
  assert.equal(parsed[0].summary, "");
  assert.deepEqual(parsed[0].sections, []);
});

test("parseRevisionRegistry dedupes duplicate ids, keeping the first occurrence", () => {
  const registry = [
    { id: "1", label: "First" },
    { id: "1", label: "Second (duplicate id, dropped)" },
    { id: "2", label: "Third" },
  ];
  const parsed = parseRevisionRegistry(fakeDoc({ scriptTextContent: JSON.stringify(registry) }));
  assert.deepEqual(
    parsed.map((r) => r.label),
    ["First", "Third"],
  );
});

test("parseRevisionRegistry keeps ID-less revisions after an explicit fallback-id collision", () => {
  const parsed = parseRevisionRegistry(
    fakeDoc({ scriptTextContent: JSON.stringify([{ id: "2", label: "Explicit" }, {}, {}]) }),
  );

  assert.deepEqual(
    parsed.map((revision) => revision.id),
    ["2", "3"],
  );
});

test("parseRevisionRegistry drops whitespace-containing ids that cannot be referenced by revision tokens", () => {
  const parsed = parseRevisionRegistry(
    fakeDoc({
      scriptTextContent: JSON.stringify([
        { id: "pricing update", label: "Unaddressable revision" },
        { id: "pricing-update", label: "Addressable revision" },
      ]),
    }),
  );

  assert.deepEqual(
    parsed.map((revision) => revision.id),
    ["pricing-update"],
  );
});

test("parseRevisionRegistry caps the registry at 50 entries", () => {
  const registry = Array.from({ length: 80 }, (_, i) => ({ id: String(i) }));
  const parsed = parseRevisionRegistry(fakeDoc({ scriptTextContent: JSON.stringify(registry) }));
  assert.equal(parsed.length, 50);
});

test("parseRevisionRegistry drops a '*' id so it cannot collide with the all-revisions wildcard", () => {
  const parsed = parseRevisionRegistry(
    fakeDoc({
      scriptTextContent: JSON.stringify([
        { id: "*", label: "Wildcard squatter" },
        { id: "real", label: "Addressable revision" },
      ]),
    }),
  );

  assert.deepEqual(
    parsed.map((revision) => revision.id),
    ["real"],
  );
});

test("parseRevisionRegistry stops examining raw entries at the raw cap, even when none is accepted", () => {
  // Rejected entries never advance the accepted-entry cap, so a flood of them
  // is what proves the raw cap exists: the addressable entries sit past it and
  // must therefore never be reached.
  const registry = [
    ...Array.from({ length: MAX_REVISION_RAW_ENTRIES }, () => ({ id: "unaddressable id" })),
    ...Array.from({ length: 60 }, (_, i) => ({ id: `late-${i}`, label: `Late ${i}` })),
  ];

  const parsed = parseRevisionRegistry(fakeDoc({ scriptTextContent: JSON.stringify(registry) }));

  assert.deepEqual(parsed, []);
});

test("isAddressableRevisionId rejects the wildcard, whitespace, and empty ids", () => {
  assert.equal(isAddressableRevisionId("pricing-update"), true);
  assert.equal(isAddressableRevisionId("*"), false);
  assert.equal(isAddressableRevisionId("pricing update"), false);
  assert.equal(isAddressableRevisionId(""), false);
  assert.equal(isAddressableRevisionId(null), false);
});

test("parseRevisionRegistry cycles the color palette once revisions exceed its length", () => {
  const registry = Array.from({ length: REVISION_PALETTE.length + 2 }, (_, i) => ({ id: String(i) }));
  const parsed = parseRevisionRegistry(fakeDoc({ scriptTextContent: JSON.stringify(registry) }));
  assert.deepEqual(parsed[REVISION_PALETTE.length].color, REVISION_PALETTE[0]);
  assert.deepEqual(parsed[REVISION_PALETTE.length + 1].color, REVISION_PALETTE[1]);
});

// ---------------------------------------------------------------------------
// normalizeRevisionEntry
// ---------------------------------------------------------------------------

test("normalizeRevisionEntry treats a non-object entry as empty", () => {
  assert.equal(normalizeRevisionEntry(null, 0).id, "1");
  assert.equal(normalizeRevisionEntry("nope", 2).id, "3");
});

test("normalizeRevisionEntry rejects an invalid timestamp", () => {
  const entry = normalizeRevisionEntry({ timestamp: "not a date" }, 0);
  assert.equal(entry.timestamp, "");
});

test("normalizeRevisionEntry accepts a valid ISO timestamp", () => {
  const entry = normalizeRevisionEntry({ timestamp: "2026-07-29T10:00:00Z" }, 0);
  assert.equal(entry.timestamp, "2026-07-29T10:00:00Z");
});

test("normalizeRevisionEntry caps summary, label, id, and section field lengths", () => {
  const entry = normalizeRevisionEntry(
    {
      id: "x".repeat(80),
      label: "y".repeat(200),
      summary: "z".repeat(1000),
      sections: ["s".repeat(200)],
    },
    0,
  );
  assert.equal(entry.id.length, 40);
  assert.equal(entry.label.length, 80);
  assert.equal(entry.summary.length, 500);
  assert.equal(entry.sections[0].length, 80);
});

test("normalizeRevisionEntry caps the sections array at 12 and drops non-string/number entries", () => {
  const entry = normalizeRevisionEntry(
    { sections: [...Array.from({ length: 20 }, (_, i) => `Section ${i}`), null, {}, undefined] },
    0,
  );
  assert.equal(entry.sections.length, 12);
  assert.equal(entry.sections[0], "Section 0");
});

test("normalizeRevisionEntry stops examining raw sections at the raw cap, even when none is accepted", () => {
  // The 12-section cap counts ACCEPTED sections, so a flood of rejected ones
  // never advances it. Without a raw bound the whole nested array is walked,
  // which is a per-entry amplifier on top of the raw-entry cap.
  const entry = normalizeRevisionEntry(
    {
      sections: [...Array.from({ length: MAX_REVISION_RAW_SECTIONS }, () => null), "Late section"],
    },
    0,
  );

  assert.deepEqual(entry.sections, []);
});

test("normalizeRevisionEntry reads no more raw sections than the raw cap allows", () => {
  let reads = 0;
  const sections = new Proxy(
    Array.from({ length: MAX_REVISION_RAW_SECTIONS * 4 }, () => null),
    {
      get(target, prop, receiver) {
        if (typeof prop === "string" && /^\d+$/.test(prop)) reads += 1;
        return Reflect.get(target, prop, receiver);
      },
    },
  );

  normalizeRevisionEntry({ sections }, 0);

  assert.ok(
    reads <= MAX_REVISION_RAW_SECTIONS,
    `read ${reads} raw sections, expected at most ${MAX_REVISION_RAW_SECTIONS}`,
  );
});

// ---------------------------------------------------------------------------
// revisionColorForIndex
// ---------------------------------------------------------------------------

test("revisionColorForIndex is deterministic and cycles the palette", () => {
  assert.deepEqual(revisionColorForIndex(0), REVISION_PALETTE[0]);
  assert.deepEqual(revisionColorForIndex(REVISION_PALETTE.length), REVISION_PALETTE[0]);
  assert.deepEqual(revisionColorForIndex(REVISION_PALETTE.length + 1), REVISION_PALETTE[1]);
});

test("revisionColorForIndex handles negative indexes without throwing", () => {
  assert.deepEqual(revisionColorForIndex(-1), REVISION_PALETTE[REVISION_PALETTE.length - 1]);
});

// ---------------------------------------------------------------------------
// resolveElementRevisionId - multi-revision precedence on one element
// ---------------------------------------------------------------------------

test("resolveElementRevisionId resolves a single known token", () => {
  assert.equal(resolveElementRevisionId("2", ["1", "2", "3"]), "2");
});

test("resolveElementRevisionId picks the most recent (highest-order) known revision", () => {
  assert.equal(resolveElementRevisionId("1 3", ["1", "2", "3", "4"]), "3");
  assert.equal(resolveElementRevisionId("3 1", ["1", "2", "3", "4"]), "3");
});

test("resolveElementRevisionId ignores unknown tokens", () => {
  assert.equal(resolveElementRevisionId("typo-id 2", ["1", "2"]), "2");
});

test("resolveElementRevisionId returns null for empty/whitespace or all-unknown tokens", () => {
  assert.equal(resolveElementRevisionId("", ["1"]), null);
  assert.equal(resolveElementRevisionId("   ", ["1"]), null);
  assert.equal(resolveElementRevisionId("unknown", ["1"]), null);
  assert.equal(resolveElementRevisionId(null, ["1"]), null);
});

// ---------------------------------------------------------------------------
// collectRevisionMarkedElements
// ---------------------------------------------------------------------------

test("collectRevisionMarkedElements returns [] for a missing/invalid doc", () => {
  assert.deepEqual(collectRevisionMarkedElements(null), []);
  assert.deepEqual(collectRevisionMarkedElements({}), []);
});

test("collectRevisionMarkedElements returns every element the querySelectorAll match yields", () => {
  const elements = [markedElement("1"), markedElement("2")];
  assert.deepEqual(collectRevisionMarkedElements(fakeDoc({ markedElements: elements })), elements);
});

// ---------------------------------------------------------------------------
// Palette accessibility contract
// ---------------------------------------------------------------------------

test("no two palette entries share a non-color signal at the width they render at", () => {
  // Both render sites are 2px (applyRevisionOutline's outline and
  // .revision-swatch's border-width), and a border narrower than 3px paints
  // `double` as a plain solid line - which would silently leave two entries
  // separated by hue alone.
  const RENDERS_DISTINCTLY_AT_2PX = new Set(["solid", "dashed", "dotted"]);
  const pairs = new Set();
  for (const entry of REVISION_PALETTE) {
    assert.ok(
      RENDERS_DISTINCTLY_AT_2PX.has(entry.borderStyle),
      `border-style "${entry.borderStyle}" does not render distinctly at 2px`,
    );
    const pair = `${entry.borderStyle}/${entry.pattern}`;
    assert.equal(pairs.has(pair), false, `two palette entries share the color-independent pair ${pair}`);
    pairs.add(pair);
  }
});

// ---------------------------------------------------------------------------
// SDK highlight application against a live-ish artifact document
// ---------------------------------------------------------------------------

/**
 * A minimal artifact-document harness for the in-closure highlight code: one
 * marked element, a stylesheet whose declarations can change after the SDK has
 * already run, and hooks for the load / mutation passes.
 * @param {{ stylesheet?: Record<string, string>, attributes?: Record<string, string> }} [options]
 */
function createRevisionSdkHarness({ stylesheet = {}, attributes: authored = {} } = {}) {
  const globals = /** @type {any} */ (globalThis);
  const originalGlobals = {
    document: globalThis.document,
    window: globalThis.window,
    parent: globalThis.parent,
    MutationObserver: globalThis.MutationObserver,
    getComputedStyle: globals.getComputedStyle,
  };
  const sheet = {
    backgroundImage: "none",
    backgroundSize: "auto",
    backgroundRepeat: "repeat",
    backgroundPosition: "0% 0%",
    backgroundClip: "border-box",
    backgroundOrigin: "padding-box",
    backgroundAttachment: "scroll",
    backgroundBlendMode: "normal",
    ...stylesheet,
  };
  const windowListeners = new Map();
  const parentMessages = [];
  const timers = [];
  const styleValues = new Map();
  const attributes = new Map([["data-lavish-revision", "1"], ...Object.entries(authored)]);
  let observerCallback = /** @type {(records: any[]) => void} */ (() => {});

  const parent = {
    postMessage(message) {
      parentMessages.push(message);
    },
  };
  const element = {
    style: {
      getPropertyValue(property) {
        return styleValues.get(property)?.value || "";
      },
      getPropertyPriority(property) {
        return styleValues.get(property)?.priority || "";
      },
      setProperty(property, value, priority = "") {
        styleValues.set(property, { value, priority });
      },
      removeProperty(property) {
        styleValues.delete(property);
      },
    },
    // `title` is an attribute reflection on a real element, so writing the
    // property has to be observable through getAttribute for a test to prove
    // anything about the accessible name.
    get title() {
      return attributes.get("title") ?? "";
    },
    set title(value) {
      attributes.set("title", String(value));
    },
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
    hasAttribute(name) {
      return attributes.has(name);
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
  };
  const document = {
    readyState: "loading",
    documentElement: {},
    head: { appendChild() {} },
    querySelector(selector) {
      if (selector === "script[data-lavish-revisions]") {
        return { textContent: JSON.stringify([{ id: "1", label: "Draft" }]) };
      }
      return null;
    },
    querySelectorAll(selector) {
      return selector === "[data-lavish-revision]" ? [element] : [];
    },
    getElementById() {
      return null;
    },
    createElement() {
      return { style: {}, remove() {} };
    },
    addEventListener() {},
  };
  const window = {
    addEventListener(type, listener) {
      const listeners = windowListeners.get(type) || [];
      listeners.push(listener);
      windowListeners.set(type, listeners);
    },
    setTimeout(fn) {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout() {},
  };

  return {
    element,
    sheet,
    parentMessages,
    backgroundImage: () => element.style.getPropertyValue("background-image"),
    start() {
      globals.document = document;
      globals.window = window;
      globals.parent = parent;
      globals.MutationObserver = class {
        constructor(callback) {
          observerCallback = callback;
        }
        observe() {}
      };
      // The element's effective background comes from the stylesheet unless our
      // own inline declaration is present, exactly like a real cascade.
      globals.getComputedStyle = () => {
        const computed = {};
        for (const camel of Object.keys(sheet)) {
          const property = camel.replace(/[A-Z]/g, (upper) => `-${upper.toLowerCase()}`);
          computed[camel] = styleValues.get(property)?.value || sheet[camel];
        }
        return computed;
      };
      createArtifactSdk(
        () => "",
        () => false,
        /** @type {any} */ ({
          isMermaidSvg: () => false,
          mermaidNodeFrom: () => null,
          mermaidNodeElement: () => null,
        }),
        0,
        "revision-load-token",
      );
    },
    sendToSdk(data) {
      for (const listener of windowListeners.get("message") || []) listener({ source: parent, data });
    },
    triggerLoad() {
      for (const listener of [...(windowListeners.get("load") || [])]) listener({});
    },
    mutate(records) {
      observerCallback(records);
    },
    flushTimers() {
      const pending = timers.splice(0, timers.length);
      for (const fn of pending) fn();
    },
    restore() {
      globals.document = originalGlobals.document;
      globals.window = originalGlobals.window;
      globals.parent = originalGlobals.parent;
      globals.MutationObserver = originalGlobals.MutationObserver;
      globals.getComputedStyle = originalGlobals.getComputedStyle;
    },
  };
}

const LATE_GRADIENT = "linear-gradient(180deg, rgb(255, 0, 0), rgb(0, 0, 255))";

test("a stylesheet applied after SDK parse still paints through the revision tint on the load pass", () => {
  const harness = createRevisionSdkHarness();
  try {
    harness.start();
    assert.match(harness.backgroundImage(), /repeating-linear-gradient/);

    // The Tailwind browser runtime (and any lazily injected stylesheet) lands
    // after the end-of-body SDK script has already captured the background.
    harness.sheet.backgroundImage = LATE_GRADIENT;
    assert.doesNotMatch(harness.backgroundImage(), /rgb\(255, 0, 0\)/);

    harness.triggerLoad();
    harness.flushTimers();

    assert.match(harness.backgroundImage(), /repeating-linear-gradient/);
    assert.ok(
      harness.backgroundImage().includes(LATE_GRADIENT),
      `artifact gradient lost under the highlight: ${harness.backgroundImage()}`,
    );
  } finally {
    harness.restore();
  }
});

test("an injected <style> element re-captures the artifact background through the mutation observer", () => {
  const harness = createRevisionSdkHarness();
  try {
    harness.start();
    harness.sheet.backgroundImage = LATE_GRADIENT;

    harness.mutate([{ type: "childList", target: {}, addedNodes: [{ tagName: "STYLE" }] }]);
    harness.flushTimers();

    assert.ok(harness.backgroundImage().includes(LATE_GRADIENT));
  } finally {
    harness.restore();
  }
});

test("an unrelated DOM mutation does not trigger a background re-capture", () => {
  const harness = createRevisionSdkHarness();
  try {
    harness.start();
    harness.sheet.backgroundImage = LATE_GRADIENT;

    harness.mutate([{ type: "childList", target: {}, addedNodes: [{ tagName: "DIV" }] }]);
    harness.flushTimers();

    assert.doesNotMatch(harness.backgroundImage(), /rgb\(255, 0, 0\)/);
  } finally {
    harness.restore();
  }
});

test("the highlight re-declares every per-layer background property so its layers are not governed by the artifact's", () => {
  const harness = createRevisionSdkHarness({
    stylesheet: {
      backgroundImage: "url(hero.png)",
      backgroundRepeat: "no-repeat",
      backgroundPosition: "center",
      // A `bg-clip-text` heading: a single `text` would otherwise cycle onto
      // the pattern and tint layers and clip both to the glyph shapes.
      backgroundClip: "text",
      backgroundOrigin: "content-box",
      backgroundAttachment: "fixed",
      backgroundBlendMode: "multiply",
    },
  });
  try {
    harness.start();

    const style = harness.element.style;
    assert.equal(style.getPropertyValue("background-repeat"), "repeat, repeat, no-repeat");
    assert.equal(style.getPropertyValue("background-position"), "0% 0%, 0% 0%, center");
    assert.equal(style.getPropertyValue("background-clip"), "border-box, border-box, text");
    assert.equal(style.getPropertyValue("background-origin"), "padding-box, padding-box, content-box");
    assert.equal(style.getPropertyValue("background-attachment"), "scroll, scroll, fixed");
    assert.equal(style.getPropertyValue("background-blend-mode"), "normal, normal, multiply");

    harness.sendToSdk({ type: "lavish:setRevisionVisibility", id: "1", visible: false });

    for (const property of [
      "background-repeat",
      "background-position",
      "background-clip",
      "background-origin",
      "background-attachment",
      "background-blend-mode",
    ]) {
      assert.equal(style.getPropertyValue(property), "", `${property} was not restored`);
    }
  } finally {
    harness.restore();
  }
});

test("a multi-layer artifact background keeps each of its own layers' values under the highlight", () => {
  // A hero section: two background-image layers, but a single `cover` size and
  // a single `no-repeat`, because the browser cycles the shorter lists. Once
  // two highlight layers are prepended, a three-entry list would wrap back onto
  // the artifact's second layer and tile the photo at the pattern's 9px size.
  const harness = createRevisionSdkHarness({
    stylesheet: {
      backgroundImage: "linear-gradient(rgba(0, 0, 0, 0.5), rgba(0, 0, 0, 0.5)), url(hero.jpg)",
      backgroundSize: "cover",
      backgroundRepeat: "no-repeat",
      backgroundPosition: "center",
      backgroundClip: "content-box",
    },
  });
  try {
    harness.start();

    const style = harness.element.style;
    assert.equal(style.getPropertyValue("background-size"), "auto, auto, cover, cover");
    assert.equal(style.getPropertyValue("background-repeat"), "repeat, repeat, no-repeat, no-repeat");
    assert.equal(style.getPropertyValue("background-position"), "0% 0%, 0% 0%, center, center");
    assert.equal(style.getPropertyValue("background-clip"), "border-box, border-box, content-box, content-box");

    harness.sendToSdk({ type: "lavish:setRevisionVisibility", id: "1", visible: false });
    assert.equal(style.getPropertyValue("background-size"), "");
  } finally {
    harness.restore();
  }
});

test("expanding a multi-layer background never splits a gradient or a quoted url at its inner commas", () => {
  const gradient = "linear-gradient(90deg, rgb(1, 2, 3) 0%, rgb(4, 5, 6) 100%)";
  const quotedUrl = 'url("hero,with,commas.jpg")';
  const harness = createRevisionSdkHarness({
    stylesheet: { backgroundImage: `${gradient}, ${quotedUrl}`, backgroundSize: "cover" },
  });
  try {
    harness.start();

    const image = harness.element.style.getPropertyValue("background-image");
    assert.ok(image.endsWith(`${gradient}, ${quotedUrl}`), `artifact layers were mangled: ${image}`);
    // Two artifact layers, so exactly one duplication of `cover` - not one per
    // comma inside the gradient or the quoted url.
    assert.equal(harness.element.style.getPropertyValue("background-size"), "auto, auto, cover, cover");
  } finally {
    harness.restore();
  }
});

test("removing a theme stylesheet re-captures the artifact background", () => {
  const harness = createRevisionSdkHarness({ stylesheet: { backgroundImage: LATE_GRADIENT } });
  try {
    harness.start();
    assert.ok(harness.backgroundImage().includes(LATE_GRADIENT));

    // A theme switch that only removes a sheet adds nothing and never targets
    // one, so without a removedNodes scan the snapshot stays stale and the
    // `!important` inline keeps painting the removed sheet's gradient.
    harness.sheet.backgroundImage = "none";
    harness.mutate([{ type: "childList", target: {}, addedNodes: [], removedNodes: [{ tagName: "STYLE" }] }]);
    harness.flushTimers();

    assert.doesNotMatch(harness.backgroundImage(), /rgb\(255, 0, 0\)/);
  } finally {
    harness.restore();
  }
});

test("toggling annotation mode does not trigger a background re-capture", () => {
  const harness = createRevisionSdkHarness();
  try {
    harness.start();
    harness.sheet.backgroundImage = LATE_GRADIENT;

    // setAnnotationMode appends and removes <style id="lavish-cursor-style"> on
    // every Cmd+I toggle; it sets only `cursor`, so it can never move a
    // background and must not cost a pass over every marked element.
    const cursorSheet = { tagName: "STYLE", id: "lavish-cursor-style" };
    harness.mutate([{ type: "childList", target: {}, addedNodes: [cursorSheet], removedNodes: [] }]);
    harness.mutate([{ type: "childList", target: {}, addedNodes: [], removedNodes: [cursorSheet] }]);
    harness.flushTimers();

    assert.doesNotMatch(harness.backgroundImage(), /rgb\(255, 0, 0\)/);
  } finally {
    harness.restore();
  }
});

test("the all-revisions toggle travels in its own field, not as a '*' revision id", () => {
  const harness = createRevisionSdkHarness();
  try {
    harness.start();
    assert.match(harness.backgroundImage(), /repeating-linear-gradient/);

    harness.sendToSdk({ type: "lavish:setRevisionVisibility", all: true, visible: false });
    assert.equal(harness.backgroundImage(), "");

    harness.sendToSdk({ type: "lavish:setRevisionVisibility", all: true, visible: true });
    assert.match(harness.backgroundImage(), /repeating-linear-gradient/);

    // A bare "*" id is no longer a wildcard, and it is not an addressable id
    // either, so it changes nothing.
    harness.sendToSdk({ type: "lavish:setRevisionVisibility", id: "*", visible: false });
    assert.match(harness.backgroundImage(), /repeating-linear-gradient/);
  } finally {
    harness.restore();
  }
});

test("an authored title survives the highlight, so a marked control keeps its accessible name", () => {
  // Highlights are on by default, and `title` is the only accessible-name
  // source an icon-only control has. Replacing it would rename the artifact's
  // own control for the whole review session.
  const harness = createRevisionSdkHarness({ attributes: { title: "Delete row" } });
  try {
    harness.start();
    assert.match(harness.backgroundImage(), /repeating-linear-gradient/);
    assert.equal(harness.element.getAttribute("title"), "Delete row");

    // Still authored after a re-apply pass (a late stylesheet re-capture).
    harness.triggerLoad();
    harness.flushTimers();
    assert.equal(harness.element.getAttribute("title"), "Delete row");

    harness.sendToSdk({ type: "lavish:setRevisionVisibility", all: true, visible: false });
    assert.equal(harness.element.getAttribute("title"), "Delete row");
  } finally {
    harness.restore();
  }
});

test("an element with no authored title gets the revision detail as its tooltip", () => {
  const harness = createRevisionSdkHarness();
  try {
    harness.start();
    assert.equal(harness.element.getAttribute("title"), "Draft");

    // Hiding the highlight retires a tooltip Lavish alone introduced.
    harness.sendToSdk({ type: "lavish:setRevisionVisibility", all: true, visible: false });
    assert.equal(harness.element.hasAttribute("title"), false);
  } finally {
    harness.restore();
  }
});

test("revision visibility restores an element's authored inline presentation and title", () => {
  const globals = /** @type {any} */ (globalThis);
  const originalGlobals = {
    document: globalThis.document,
    window: globalThis.window,
    parent: globalThis.parent,
    MutationObserver: globalThis.MutationObserver,
  };
  const windowListeners = new Map();
  const documentListeners = new Map();
  const parentMessages = [];
  const parent = {
    postMessage(message) {
      parentMessages.push(message);
    },
  };
  const attributes = new Map([
    ["data-lavish-revision", "1"],
    ["title", "Authored tooltip"],
  ]);
  const styleValues = new Map([
    ["outline", { value: "1px solid rebeccapurple", priority: "important" }],
    ["outline-offset", { value: "3px", priority: "" }],
    ["background-image", { value: "url(authored-texture.svg)", priority: "important" }],
    ["background-size", { value: "cover", priority: "" }],
  ]);
  const styleWrites = [];
  const element = {
    style: {
      outline: "1px solid rebeccapurple",
      outlineOffset: "3px",
      backgroundImage: "url(authored-texture.svg)",
      backgroundSize: "cover",
      getPropertyValue(property) {
        return styleValues.get(property)?.value || "";
      },
      getPropertyPriority(property) {
        return styleValues.get(property)?.priority || "";
      },
      setProperty(property, value, priority = "") {
        styleWrites.push({ property, value, priority });
        styleValues.set(property, { value, priority });
      },
      removeProperty(property) {
        styleValues.delete(property);
      },
    },
    get title() {
      return attributes.get("title") ?? "";
    },
    set title(value) {
      attributes.set("title", String(value));
    },
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
    hasAttribute(name) {
      return attributes.has(name);
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
  };
  const document = {
    readyState: "loading",
    documentElement: {},
    head: { appendChild() {} },
    querySelector(selector) {
      if (selector === "script[data-lavish-revisions]") {
        return { textContent: JSON.stringify([{ id: "1", label: "Draft" }]) };
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "[data-lavish-revision]") return [element];
      return [];
    },
    getElementById() {
      return null;
    },
    createElement() {
      return { style: {}, remove() {} };
    },
    addEventListener(type, listener) {
      const listeners = documentListeners.get(type) || [];
      listeners.push(listener);
      documentListeners.set(type, listeners);
    },
  };
  const window = {
    addEventListener(type, listener) {
      const listeners = windowListeners.get(type) || [];
      listeners.push(listener);
      windowListeners.set(type, listeners);
    },
    setTimeout() {
      return 0;
    },
    clearTimeout() {},
  };

  try {
    globals.document = document;
    globals.window = window;
    globals.parent = parent;
    globals.MutationObserver = class {
      observe() {}
    };

    createArtifactSdk(
      () => "",
      () => false,
      /** @type {any} */ ({
        isMermaidSvg: () => false,
        mermaidNodeFrom: () => null,
        mermaidNodeElement: () => null,
      }),
      0,
      "revision-load-token",
    );

    assert.equal(parentMessages[0].type, "lavish:revisions");
    assert.equal(parentMessages[0].artifact_load_token, "revision-load-token");
    assert.match(element.style.getPropertyValue("background-image"), /url\(authored-texture\.svg\)/);
    assert.match(element.style.getPropertyValue("background-image"), /repeating-linear-gradient/);
    assert.ok(styleWrites.some((write) => write.property === "outline" && write.priority === "important"));
    assert.ok(styleWrites.some((write) => write.property === "background-image" && write.priority === "important"));

    for (const handler of documentListeners.get("mouseover") || []) handler({ target: element });
    for (const handler of documentListeners.get("mouseout") || []) handler({ target: element });
    assert.equal(element.style.getPropertyValue("outline"), "2px solid #0072B2");

    for (const listener of windowListeners.get("message") || []) {
      listener({ source: parent, data: { type: "lavish:setRevisionVisibility", id: "1", visible: true } });
    }
    assert.equal(
      (element.style.getPropertyValue("background-image").match(/repeating-linear-gradient/g) || []).length,
      1,
    );

    for (const listener of windowListeners.get("message") || []) {
      listener({ source: parent, data: { type: "lavish:setRevisionVisibility", id: "1", visible: false } });
    }

    assert.equal(element.style.getPropertyValue("outline"), "1px solid rebeccapurple");
    assert.equal(element.style.getPropertyValue("outline-offset"), "3px");
    assert.equal(element.style.getPropertyValue("background-image"), "url(authored-texture.svg)");
    assert.equal(element.style.getPropertyValue("background-size"), "cover");
    assert.equal(element.getAttribute("title"), "Authored tooltip");
    assert.deepEqual(styleValues.get("outline"), { value: "1px solid rebeccapurple", priority: "important" });
    assert.deepEqual(styleValues.get("background-image"), {
      value: "url(authored-texture.svg)",
      priority: "important",
    });
  } finally {
    globals.document = originalGlobals.document;
    globals.window = originalGlobals.window;
    globals.parent = originalGlobals.parent;
    globals.MutationObserver = originalGlobals.MutationObserver;
  }
});

// ---------------------------------------------------------------------------
// revisionTruncate / revisionIsValidTimestamp / revisionTintFromHex
// ---------------------------------------------------------------------------

test("revisionTruncate leaves short values untouched and cuts long ones to max", () => {
  assert.equal(revisionTruncate("short", 10), "short");
  assert.equal(revisionTruncate("x".repeat(20), 10).length, 10);
  assert.equal(revisionTruncate(null, 10), "");
  assert.equal(revisionTruncate(undefined, 10), "");
});

test("revisionIsValidTimestamp accepts ISO strings and rejects garbage", () => {
  assert.equal(revisionIsValidTimestamp("2026-07-29T10:00:00Z"), true);
  assert.equal(revisionIsValidTimestamp("not a date"), false);
  assert.equal(revisionIsValidTimestamp(""), false);
  assert.equal(revisionIsValidTimestamp(null), false);
  assert.equal(revisionIsValidTimestamp(12345), false);
});

test("revisionTintFromHex renders a low-alpha rgba string for a valid hex", () => {
  assert.equal(revisionTintFromHex("#0072B2", 0.14), "rgba(0, 114, 178, 0.14)");
});

test("revisionTintFromHex falls back to transparent for a malformed hex", () => {
  assert.equal(revisionTintFromHex("not-a-color"), "rgba(0,0,0,0)");
  assert.equal(revisionTintFromHex(""), "rgba(0,0,0,0)");
  assert.equal(revisionTintFromHex(null), "rgba(0,0,0,0)");
});
