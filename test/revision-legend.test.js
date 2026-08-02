import assert from "node:assert/strict";
import test from "node:test";

import {
  collectRevisionMarkedElements,
  normalizeRevisionEntry,
  parseRevisionRegistry,
  resolveElementRevisionId,
  REVISION_PALETTE,
  revisionColorForIndex,
  revisionHighlightBackground,
  revisionIsValidTimestamp,
  revisionTintFromHex,
  revisionTruncate,
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
// parseRevisionRegistry — legacy/no-metadata path
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
// parseRevisionRegistry — persistence / multiple revisions
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

test("parseRevisionRegistry caps the registry at 50 entries", () => {
  const registry = Array.from({ length: 80 }, (_, i) => ({ id: String(i) }));
  const parsed = parseRevisionRegistry(fakeDoc({ scriptTextContent: JSON.stringify(registry) }));
  assert.equal(parsed.length, 50);
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
// resolveElementRevisionId — multi-revision precedence on one element
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

test("revisionHighlightBackground preserves stylesheet-defined background layers", () => {
  assert.deepEqual(
    revisionHighlightBackground(
      "repeating-linear-gradient(45deg, black 0, transparent 1px)",
      "auto",
      "rgba(0, 114, 178, 0.14)",
      'url("hero.png")',
      "cover",
    ),
    {
      image:
        'repeating-linear-gradient(45deg, black 0, transparent 1px), linear-gradient(rgba(0, 114, 178, 0.14), rgba(0, 114, 178, 0.14)), url("hero.png")',
      size: "auto, auto, cover",
    },
  );
});
