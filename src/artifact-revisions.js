// Helpers for reading an artifact's agent-declared revision registry.
//
// The agent already knows what it changed between review rounds, so it says so
// in the file it regenerates: one `<script type="application/json"
// data-lavish-revisions>` registry plus `data-lavish-revision="<id>"` on each
// block it touched. Both are ordinary artifact content, so they survive a
// reload, an export, and opening the file with Lavish absent - the same way
// `data-lavish-question` does. An artifact without the registry is unchanged.
//
// Nothing here writes to the document. The reader sees the revision history in
// the browser chrome's legend, and the served page stays byte-identical to the
// file on disk.
//
// Every helper here is serialized wholesale into the artifact SDK bundle by
// `createSdkJs`, so each one may only reference its own arguments, browser
// globals, or its sibling exports from this module - never a module-private
// binding, which would compile fine and then ReferenceError in the browser.
// For the same reason every export must be a function: `serializeModuleHelpers`
// throws on anything else, because an array or Map would `toString()` into a
// valid-looking `{}` and reach the browser semantically empty.

// One legend has to stay readable, and the supply of colour + border-pattern
// pairs a reader can actually tell apart is small. Colour is never the only
// signal: no two palette entries share a border style *and* a fill pattern, so
// the legend still distinguishes revisions in greyscale or with a colour vision
// deficiency.
export function revisionPalette() {
  return [
    { hex: "#0072b2", borderStyle: "solid", pattern: "none" },
    { hex: "#d55e00", borderStyle: "dashed", pattern: "diagonal" },
    { hex: "#009e73", borderStyle: "dotted", pattern: "none" },
    { hex: "#cc79a7", borderStyle: "double", pattern: "dots" },
    { hex: "#56b4e9", borderStyle: "dashed", pattern: "none" },
    { hex: "#e69f00", borderStyle: "solid", pattern: "diagonal" },
  ];
}

// Deterministic by registry order, so a revision keeps its colour for as long
// as the agent keeps writing the registry in the same order.
export function revisionPresentationForIndex(index) {
  const palette = revisionPalette();
  const position = Number.isInteger(index) && index >= 0 ? index % palette.length : 0;
  return palette[position];
}

// Caps, in one place so the SDK and the chrome's re-validation agree.
//
// `rawEntries` and `rawMarks` bound what is *examined*, not what is accepted.
// Bounding only the accepted count lets a registry of ten thousand duplicate or
// malformed records walk the whole array on the main thread before yielding its
// handful of rows, which costs the reviewer the responsiveness of the page they
// are trying to read.
export function revisionLimits() {
  return {
    // One row per palette entry, derived rather than written down: a cap larger
    // than the palette would hand the seventh revision the first one's colour
    // *and* its border and pattern, which is precisely the case the palette
    // exists to prevent.
    entries: revisionPalette().length,
    rawEntries: 256,
    marks: 200,
    rawMarks: 2000,
    registryBytes: 64 * 1024,
    id: 60,
    label: 80,
    summary: 400,
    timestamp: 40,
    excerpt: 120,
    selector: 400,
    selectorDepth: 32,
  };
}

export function truncateRevisionText(value, max) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const text = String(value).trim();
  const limit = Number.isInteger(max) && max > 0 ? max : 0;
  if (!limit || text.length <= limit) return text;
  return text.slice(0, limit);
}

// An id has to survive being written into a `data-lavish-revision` attribute and
// compared against it, so whitespace-bearing and empty ids are not addressable.
export function isAddressableRevisionId(id) {
  const text = typeof id === "string" || typeof id === "number" ? String(id) : "";
  return text.length > 0 && text === text.trim() && !/\s/.test(text);
}

// Identity is never truncated, only rejected. Cutting an id to a length budget
// merges two ids that share a prefix, and the second revision's blocks would
// then appear under the first - a wrong answer dressed as a right one. The
// same reasoning covers a selector: a truncated one is still valid CSS, and
// still points somewhere else.
export function exactRevisionText(value, max) {
  const text = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  return text.length > 0 && text.length <= max ? text : "";
}

export function normalizeRevisionEntry(entry, index) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const limits = revisionLimits();
  const id = exactRevisionText(entry.id, limits.id);
  if (!isAddressableRevisionId(id)) return null;
  // No colour, border or pattern travels in this message. The chrome derives
  // the swatch from the server-injected palette by registry position, so an
  // artifact cannot hand every revision the same presentation and erase the
  // distinction the legend promises.
  return {
    id,
    index: Number.isInteger(index) && index >= 0 ? index : 0,
    label: truncateRevisionText(entry.label, limits.label) || id,
    timestamp: truncateRevisionText(entry.timestamp, limits.timestamp),
    summary: truncateRevisionText(entry.summary, limits.summary),
    mark_count: 0,
  };
}

// Read the registry out of a document. Fails open in every direction: a missing
// script tag, a tag that is not JSON, JSON that is not an array, and entries
// without a usable id all yield fewer rows rather than an error. A malformed
// registry must cost the reviewer a legend, never a page.
export function parseRevisionRegistry(doc) {
  const script = doc && doc.querySelector ? doc.querySelector("script[data-lavish-revisions]") : null;
  if (!script) return [];
  const limits = revisionLimits();
  const text = String(script.textContent || "").trim();
  if (!text || text.length > limits.registryBytes) return [];

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const revisions = [];
  // A Set, not an object: `__proto__` is a legal revision id, and assigning it
  // as a plain-object key never becomes an own property, so duplicates of it
  // would slip past the check below.
  const seen = new Set();
  let examined = 0;
  for (const raw of parsed) {
    if (examined >= limits.rawEntries || revisions.length >= limits.entries) break;
    examined += 1;
    const entry = normalizeRevisionEntry(raw, revisions.length);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    revisions.push(entry);
  }
  return revisions;
}

// Generated HTML repeats ids more often than anyone would like, and `#id`
// resolves to the first one. An id shared with another element names that
// element, not this one, so it is not a shortcut - it is a wrong answer.
// A document that cannot be asked (no `querySelectorAll`) is treated the same
// way, because an unverifiable id is not a verified one.
export function isUniqueElementId(doc, id) {
  if (!doc || typeof doc.querySelectorAll !== "function") return false;
  try {
    const found = doc.querySelectorAll(`#${id}`);
    return Boolean(found) && found.length === 1;
  } catch {
    return false;
  }
}

// A CSS selector the SDK's existing reveal path can resolve. An author-set id
// wins because it survives edits to the surrounding tree; the nth-of-type chain
// is the fallback for the common case of an unlabelled block.
//
// Only a chain anchored at the document root or at an id says which element it
// means. One that ran out of ancestor budget - or that walked a detached
// subtree - reads like `div > p:nth-of-type(2)`, which `querySelector` happily
// resolves against the first similar subtree anywhere in the page. Revealing
// the wrong block is worse than revealing none, so an unrooted chain is
// discarded and its mark is dropped by the caller.
export function revisionSelectorFor(element, doc) {
  const limits = revisionLimits();
  const parts = [];
  let node = element;
  let depth = 0;
  while (node && node.nodeType === 1) {
    if (depth >= limits.selectorDepth) return "";
    const tag = String(node.tagName || "").toLowerCase();
    if (!tag) return "";
    const id = node.getAttribute ? String(node.getAttribute("id") || "").trim() : "";
    if (id && /^[A-Za-z][-\w]*$/.test(id) && isUniqueElementId(doc, id)) {
      parts.unshift(`#${id}`);
      return parts.join(" > ");
    }
    const parent = node.parentElement;
    let part = tag;
    if (parent && parent.children) {
      const siblings = [];
      for (const child of parent.children) {
        if (String(child.tagName || "").toLowerCase() === tag) siblings.push(child);
      }
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = parent;
    depth += 1;
  }
  return parts[0] === "html" ? parts.join(" > ") : "";
}

// The marked blocks, in document order, for the revisions the registry declared.
// A mark naming an undeclared revision has no colour, no label, and no legend
// row to live under, so it is not shown rather than shown unattributed.
export function collectRevisionMarks(doc, revisions) {
  const limits = revisionLimits();
  // A Map, not an object: see `parseRevisionRegistry`. Keyed on a plain object,
  // a revision declared as `__proto__` would be unreachable here and every one
  // of its marked blocks silently dropped.
  const declared = new Map();
  for (const revision of Array.isArray(revisions) ? revisions : []) {
    if (revision && isAddressableRevisionId(revision.id)) declared.set(revision.id, revision);
  }
  const marks = [];
  const elements = doc && doc.querySelectorAll ? doc.querySelectorAll("[data-lavish-revision]") : [];
  let examined = 0;
  for (const element of elements) {
    if (examined >= limits.rawMarks || marks.length >= limits.marks) break;
    examined += 1;
    const id = element.getAttribute ? exactRevisionText(element.getAttribute("data-lavish-revision"), limits.id) : "";
    if (!declared.has(id)) continue;
    const selector = exactRevisionText(revisionSelectorFor(element, doc), limits.selector);
    if (!selector) continue;
    declared.get(id).mark_count += 1;
    marks.push({
      revision_id: id,
      selector,
      tag: String(element.tagName || "").toLowerCase(),
      excerpt: truncateRevisionText(String(element.textContent || "").replace(/\s+/g, " "), limits.excerpt),
    });
  }
  return marks;
}

// What the SDK hands the chrome. The chrome re-validates it on arrival: this
// travels over postMessage from a sandboxed frame rendering author content, so
// it is untrusted input on the receiving side no matter who built it here.
export function readArtifactRevisions(doc) {
  const revisions = parseRevisionRegistry(doc);
  const marks = collectRevisionMarks(doc, revisions);
  return { revisions, marks };
}
