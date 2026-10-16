import assert from "node:assert/strict";
import test from "node:test";

import {
  collectRevisionMarks,
  isAddressableRevisionId,
  exactRevisionText,
  isUniqueElementId,
  normalizeRevisionEntry,
  parseRevisionRegistry,
  readArtifactRevisions,
  revisionLimits,
  revisionPalette,
  revisionPresentationForIndex,
  revisionSelectorFor,
} from "../src/artifact-revisions.js";

// Hand-built DOM stubs, matching the convention in mermaid-node.test.js and
// table-cell.test.js: the helpers duck-type what they touch, so a fake keeps
// the tests honest about which properties the browser path actually needs.
function element(tag, attrs = {}, children = []) {
  const node = {
    tagName: tag.toUpperCase(),
    nodeType: 1,
    parentElement: null,
    children,
    textContent: attrs.textContent || "",
    getAttribute: (name) => (Object.prototype.hasOwnProperty.call(attrs, name) ? String(attrs[name]) : null),
  };
  for (const child of children) child.parentElement = node;
  return node;
}

// Marks are read out of a live document, so a fixture's marked elements must
// hang off a root or `revisionSelectorFor` rightly refuses to name them.
// Elements that already have a parent keep the tree the test built for them.
function doc({ registry = null, marked = [], ids = {} } = {}) {
  const loose = marked.filter((node) => !node.parentElement);
  if (loose.length > 0) element("html", {}, [element("body", {}, loose)]);
  return {
    querySelector: (selector) =>
      selector === "script[data-lavish-revisions]" && registry !== null ? { textContent: registry } : null,
    querySelectorAll: (selector) => {
      if (selector === "[data-lavish-revision]") return marked;
      // `ids` says how many elements in this fake document carry each id, so a
      // test can express a document with duplicate ids. Unlisted ids that some
      // element actually carries are unique by default.
      if (selector.startsWith("#")) {
        const id = selector.slice(1);
        const count = Object.prototype.hasOwnProperty.call(ids, id) ? ids[id] : 1;
        return new Array(count).fill(null);
      }
      return [];
    },
  };
}

function marked(id, { tag = "p", text = "" } = {}) {
  return element(tag, { "data-lavish-revision": id, textContent: text });
}

function registryJson(entries) {
  return JSON.stringify(entries);
}

test("an artifact with no registry declares no revisions and no marks", () => {
  const result = readArtifactRevisions(doc());

  assert.deepEqual(result.revisions, []);
  assert.deepEqual(result.marks, []);
});

test("a reload that changed nothing marks nothing, even with a registry present", () => {
  const result = readArtifactRevisions(doc({ registry: registryJson([{ id: "r1", label: "First pass" }]) }));

  assert.equal(result.revisions.length, 1);
  assert.equal(result.revisions[0].mark_count, 0);
  assert.deepEqual(result.marks, []);
});

test("an edited block is attributed to the revision that claims it", () => {
  const result = readArtifactRevisions(
    doc({
      registry: registryJson([{ id: "r1", label: "First pass" }]),
      marked: [marked("r1", { tag: "section", text: "  Pricing   changed  " })],
    }),
  );

  assert.equal(result.marks.length, 1);
  assert.equal(result.marks[0].revision_id, "r1");
  assert.equal(result.marks[0].tag, "section");
  assert.equal(result.marks[0].excerpt, "Pricing changed");
  assert.equal(result.revisions[0].mark_count, 1);
});

test("a block added in a later revision is attributed to that revision, not the earlier one", () => {
  const result = readArtifactRevisions(
    doc({
      registry: registryJson([
        { id: "r1", label: "First pass" },
        { id: "r2", label: "Second pass" },
      ]),
      marked: [marked("r1"), marked("r2"), marked("r2")],
    }),
  );

  assert.deepEqual(
    result.revisions.map((revision) => [revision.id, revision.mark_count]),
    [
      ["r1", 1],
      ["r2", 2],
    ],
  );
  assert.deepEqual(
    result.marks.map((mark) => mark.revision_id),
    ["r1", "r2", "r2"],
  );
});

test("a mark naming a revision the registry never declared is left out rather than shown unattributed", () => {
  const result = readArtifactRevisions({
    ...doc({ registry: registryJson([{ id: "r1" }]) }),
    querySelectorAll: () => [marked("r9")],
  });

  assert.deepEqual(result.marks, []);
  assert.equal(result.revisions[0].mark_count, 0);
});

test("a malformed registry costs the reader a legend, not the page", () => {
  for (const registry of ["{not json", '{"id":"r1"}', "null", '"r1"', "[]", "   "]) {
    const result = readArtifactRevisions(doc({ registry, marked: [marked("r1")] }));
    assert.deepEqual(result.revisions, [], `registry ${registry} should yield no revisions`);
    assert.deepEqual(result.marks, [], `registry ${registry} should yield no marks`);
  }
});

test("a registry larger than the byte cap is ignored instead of parsed", () => {
  const limits = revisionLimits();
  const filler = "x".repeat(limits.registryBytes);
  const registry = registryJson([{ id: "r1", summary: filler }]);
  assert.ok(registry.length > limits.registryBytes);

  assert.deepEqual(parseRevisionRegistry(doc({ registry })), []);
});

test("duplicate and unaddressable revision ids are dropped, keeping the first of each id", () => {
  const revisions = parseRevisionRegistry(
    doc({
      registry: registryJson([
        { id: "r1", label: "kept" },
        { id: "r1", label: "duplicate" },
        { id: "  ", label: "blank" },
        { id: "has space", label: "unaddressable" },
        { label: "no id" },
        { id: "r2", label: "also kept" },
      ]),
    }),
  );

  assert.deepEqual(
    revisions.map((revision) => [revision.id, revision.label]),
    [
      ["r1", "kept"],
      ["r2", "also kept"],
    ],
  );
});

test("rejected entries count against the scan budget, so a huge registry cannot walk the main thread", () => {
  const limits = revisionLimits();
  const rejected = Array.from({ length: limits.rawEntries }, () => ({ id: "dup" }));
  const reachableOnlyIfUnbounded = Array.from({ length: limits.entries }, (_, index) => ({ id: `late${index}` }));
  const revisions = parseRevisionRegistry(doc({ registry: registryJson([...rejected, ...reachableOnlyIfUnbounded]) }));

  // The first entry is the only accepted one; everything after it is a
  // duplicate, and the scan stops at the raw budget before the late ids.
  assert.deepEqual(
    revisions.map((revision) => revision.id),
    ["dup"],
  );
});

test("the registry yields at most the number of rows the legend can distinguish", () => {
  const limits = revisionLimits();
  const entries = Array.from({ length: limits.entries + 4 }, (_, index) => ({ id: `r${index}` }));

  assert.equal(parseRevisionRegistry(doc({ registry: registryJson(entries) })).length, limits.entries);
});

test("marks stop at the cap so one artifact cannot flood the legend", () => {
  const limits = revisionLimits();
  const marks = collectRevisionMarks(doc({ marked: Array.from({ length: limits.marks + 50 }, () => marked("r1")) }), [
    { id: "r1", mark_count: 0 },
  ]);

  assert.equal(marks.length, limits.marks);
});

// Regression: the cap was a written-down 8 while the palette held 6, so
// revisions 7 and 8 were handed revision 1 and 2's colour, border style and
// pattern - three identical signals, and no way to tell the rounds apart.
test("the registry accepts no more revisions than the palette can distinguish", () => {
  const limits = revisionLimits();
  assert.equal(limits.entries, revisionPalette().length);

  const entries = Array.from({ length: limits.entries + 4 }, (_, index) => ({ id: `r${index}` }));
  const revisions = parseRevisionRegistry(doc({ registry: registryJson(entries) }));

  // Index is what the chrome looks the swatch up by, so distinct indexes within
  // the palette length is exactly the distinguishability guarantee.
  const swatches = revisions.map((revision) => revisionPresentationForIndex(revision.index));
  assert.equal(
    new Set(swatches.map((entry) => `${entry.hex}/${entry.borderStyle}/${entry.pattern}`)).size,
    revisions.length,
  );
});

// Regression: the chrome used to render `raw.color` and `raw.border_style`
// straight off the message, so artifact JavaScript could give every revision
// the same swatch and erase the distinction the legend promises. The SDK no
// longer sends presentation at all.
test("presentation never travels in the revision message", () => {
  const revisions = parseRevisionRegistry(
    doc({ registry: registryJson([{ id: "r1", color: "#ff0000", border_style: "dotted", pattern: "dots" }]) }),
  );

  for (const field of ["color", "border_style", "pattern"]) {
    assert.equal(Object.hasOwn(revisions[0], field), false, `${field} must not be sent to the chrome`);
  }
  assert.equal(revisions[0].index, 0);
});

test("every palette entry is distinguishable without colour", () => {
  const signals = revisionPalette().map((entry) => `${entry.borderStyle}/${entry.pattern}`);

  assert.equal(new Set(signals).size, signals.length);
  assert.equal(new Set(revisionPalette().map((entry) => entry.hex)).size, signals.length);
});

test("a revision keeps its colour for as long as its registry position holds, and the palette cycles", () => {
  const palette = revisionPalette();

  assert.deepEqual(revisionPresentationForIndex(0), palette[0]);
  assert.deepEqual(revisionPresentationForIndex(palette.length), palette[0]);
  assert.deepEqual(revisionPresentationForIndex(-1), palette[0]);
  assert.deepEqual(revisionPresentationForIndex(2), palette[2]);
});

test("a unique author-set id wins the selector because it survives edits to the surrounding tree", () => {
  const target = element("section", { id: "pricing" });
  const body = element("body", {}, [element("header"), target]);
  element("html", {}, [body]);

  assert.equal(revisionSelectorFor(target, doc({ marked: [target] })), "#pricing");
});

// Regression: any syntactically valid id became `#id`, which resolves to the
// first element carrying it. Generated HTML repeats ids, so Reveal could flash
// an earlier duplicate instead of the block the agent marked.
test("an id shared with another element is not used, because it names the other one", () => {
  const target = element("section", { id: "pricing" });
  const body = element("body", {}, [element("section", { id: "pricing" }), target]);
  element("html", {}, [body]);

  const document = doc({ marked: [target], ids: { pricing: 2 } });
  assert.equal(revisionSelectorFor(target, document), "html > body > section:nth-of-type(2)");
});

test("an id is not trusted when the document cannot be asked whether it is unique", () => {
  const target = element("section", { id: "pricing" });
  const body = element("body", {}, [target]);
  element("html", {}, [body]);

  assert.equal(revisionSelectorFor(target, null), "html > body > section");
  assert.equal(isUniqueElementId(null, "pricing"), false);
  assert.equal(isUniqueElementId({}, "pricing"), false);
});

test("an unlabelled block gets an nth-of-type chain that resolves back to it", () => {
  const first = element("p");
  const second = element("p");
  const body = element("body", {}, [first, second]);
  element("html", {}, [body]);

  const document = doc({ marked: [first, second] });
  assert.equal(revisionSelectorFor(second, document), "html > body > p:nth-of-type(2)");
  assert.equal(revisionSelectorFor(first, document), "html > body > p:nth-of-type(1)");
});

// Regression: the walk stopped at 12 ancestors and returned the partial chain
// it had, e.g. `div > p`. That resolves against the first similar subtree
// anywhere in the document, so Reveal would flash a block the agent never
// marked. An unrooted chain is now discarded instead.
test("a block nested past the ancestor budget yields no selector rather than an unrooted one", () => {
  const limits = revisionLimits();
  const target = element("p");
  let node = target;
  for (let depth = 0; depth < limits.selectorDepth + 2; depth += 1) {
    node = element("div", {}, [node]);
  }
  const body = element("body", {}, [node]);
  element("html", {}, [body]);

  assert.equal(revisionSelectorFor(target, doc({ marked: [target] })), "");
});

test("a detached subtree yields no selector, because its chain names no document root", () => {
  const target = element("p");
  element("div", {}, [target]);

  assert.equal(revisionSelectorFor(target, doc({ marked: [target] })), "");
});

test("a mark whose selector cannot be rooted is dropped instead of revealed wrongly", () => {
  const limits = revisionLimits();
  const target = element("p", { "data-lavish-revision": "r1" });
  let node = target;
  for (let depth = 0; depth < limits.selectorDepth + 2; depth += 1) {
    node = element("div", {}, [node]);
  }
  const body = element("body", {}, [node]);
  element("html", {}, [body]);

  const revisions = [{ id: "r1", mark_count: 0 }];
  assert.deepEqual(collectRevisionMarks(doc({ marked: [target] }), revisions), []);
  assert.equal(revisions[0].mark_count, 0);
});

test("an id that is not a bare CSS identifier falls back to the structural chain", () => {
  const target = element("section", { id: "2 pricing" });
  const body = element("body", {}, [target]);
  element("html", {}, [body]);

  assert.equal(revisionSelectorFor(target, doc({ marked: [target] })), "html > body > section");
});

test("normalizeRevisionEntry caps each field and falls back to the id for a missing label", () => {
  const limits = revisionLimits();
  const entry = normalizeRevisionEntry(
    { id: "r1", summary: "s".repeat(limits.summary + 40), timestamp: "t".repeat(limits.timestamp + 10) },
    0,
  );

  assert.equal(entry.label, "r1");
  assert.equal(entry.summary.length, limits.summary);
  assert.equal(entry.timestamp.length, limits.timestamp);
  assert.equal(entry.mark_count, 0);
});

test("normalizeRevisionEntry refuses anything that is not an object with a usable id", () => {
  for (const value of [null, undefined, 3, "r1", [], { id: "" }, { id: " r 1 " }]) {
    assert.equal(normalizeRevisionEntry(value, 0), null);
  }
});

// Regression: ids were truncated to the length budget before deduplication, so
// two ids sharing their first 60 characters collapsed into one revision and the
// second round's blocks showed up under the first. Identity is now rejected
// when it is too long, never shortened.
test("two long ids sharing a prefix stay separate revisions instead of merging", () => {
  const limits = revisionLimits();
  const prefix = "r".repeat(limits.id);
  const revisions = parseRevisionRegistry(
    doc({
      registry: registryJson([
        { id: `${prefix}1`, label: "one" },
        { id: `${prefix}2`, label: "two" },
      ]),
    }),
  );

  assert.deepEqual(revisions, []);
});

test("an id within the budget is kept whole, and one over it is refused", () => {
  const limits = revisionLimits();
  const exact = "r".repeat(limits.id);

  assert.equal(exactRevisionText(exact, limits.id), exact);
  assert.equal(exactRevisionText(`${exact}x`, limits.id), "");
  assert.equal(exactRevisionText("  spaced  ", 40), "spaced");
  assert.equal(exactRevisionText(null, 40), "");
});

test("a mark whose id is too long matches no revision rather than the nearest one", () => {
  const limits = revisionLimits();
  const overlong = "r".repeat(limits.id + 1);
  const target = marked(overlong);
  const revisions = [{ id: "r1", mark_count: 0 }];

  assert.deepEqual(collectRevisionMarks(doc({ marked: [target] }), revisions), []);
  assert.equal(revisions[0].mark_count, 0);
});

test("isAddressableRevisionId matches what a data attribute can carry back", () => {
  assert.equal(isAddressableRevisionId("r1"), true);
  assert.equal(isAddressableRevisionId(""), false);
  assert.equal(isAddressableRevisionId(" r1"), false);
  assert.equal(isAddressableRevisionId("r 1"), false);
  assert.equal(isAddressableRevisionId(null), false);
});

// `__proto__` is an ordinary revision id by every rule this module states: it
// is non-empty, carries no whitespace, and round-trips through a data
// attribute. It is only special to a plain-object dictionary, where assigning
// it never becomes an own property - so a registry keyed that way would both
// accept a duplicate of it and lose every block it marked.
test("a revision named __proto__ is deduplicated like any other id", () => {
  const revisions = parseRevisionRegistry(
    doc({
      registry: registryJson([
        { id: "__proto__", label: "kept" },
        { id: "__proto__", label: "duplicate" },
      ]),
    }),
  );

  assert.deepEqual(
    revisions.map((revision) => [revision.id, revision.label]),
    [["__proto__", "kept"]],
  );
});

test("a block marked for a revision named __proto__ is still attributed to it", () => {
  const target = marked("__proto__", { text: "revised copy" });
  const revisions = [{ id: "__proto__", mark_count: 0 }];
  const marks = collectRevisionMarks(doc({ marked: [target] }), revisions);

  assert.deepEqual(
    marks.map((mark) => [mark.revision_id, mark.excerpt]),
    [["__proto__", "revised copy"]],
  );
  assert.equal(revisions[0].mark_count, 1);
});
