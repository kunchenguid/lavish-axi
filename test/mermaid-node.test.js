import assert from "node:assert/strict";
import test from "node:test";

import {
  isMermaidSvg,
  mermaidNodeElement,
  mermaidNodeFrom,
  normalizeMermaidNodeTarget,
  readNodeLabel,
} from "../src/mermaid-node.js";

// readNodeLabel swaps <br> for `document.createTextNode(" ")`; provide the
// minimal document surface it needs so the multi-line path runs under node:test.
globalThis.document = /** @type {any} */ ({
  createTextNode(text) {
    return {
      tagName: "#text",
      nodeType: 3,
      _text: String(text),
      get textContent() {
        return this._text;
      },
      parentElement: null,
    };
  },
});

// ---------------------------------------------------------------------------
// Minimal fake-DOM helpers. The repo tests browser-side code with hand-built
// element stubs rather than a DOM library (see chrome-client-queue.test.js); we
// follow that convention and build only the surface these functions touch:
// tagName, id, textContent, getAttribute, closest, querySelector(All),
// cloneNode, and (for <br>) replaceWith.
// ---------------------------------------------------------------------------

function el(tag, opts = {}) {
  const node = {
    tagName: tag.toUpperCase(),
    nodeType: 1,
    id: opts.id || "",
    className: opts.className || "",
    parentElement: null,
    children: [],
    attrs: { ...(opts.attrs || {}) },
    _text: opts.text || "",

    getAttribute(name) {
      return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null;
    },
    get textContent() {
      if (this.children.length === 0) return this._text;
      // <br> contributes nothing to textContent (matches real DOM).
      return this.children.map((c) => (c.tagName === "BR" ? "" : c.textContent)).join("");
    },
    closest(selectorList) {
      let current = this;
      while (current) {
        if (matchesSelectorList(current, selectorList)) return current;
        current = current.parentElement;
      }
      return null;
    },
    matches(selectorList) {
      return matchesSelectorList(this, selectorList);
    },
    querySelector(selectorList) {
      return descendants(this).find((d) => matchesSelectorList(d, selectorList)) || null;
    },
    querySelectorAll(selectorList) {
      return descendants(this).filter((d) => matchesSelectorList(d, selectorList));
    },
    cloneNode() {
      const clone = el(tag, {
        id: this.id,
        className: this.className,
        attrs: this.attrs,
        text: this._text,
      });
      for (const child of this.children) append(clone, child.cloneNode(true));
      return clone;
    },
    replaceWith(replacement) {
      const parent = this.parentElement;
      if (!parent) return;
      const idx = parent.children.indexOf(this);
      if (idx >= 0) parent.children.splice(idx, 1, replacement);
      replacement.parentElement = parent;
    },
  };
  for (const child of opts.children || []) append(node, child);
  return node;
}

function append(parent, child) {
  child.parentElement = parent;
  parent.children.push(child);
  return child;
}

function descendants(node) {
  const out = [];
  for (const child of node.children) {
    out.push(child);
    out.push(...descendants(child));
  }
  return out;
}

function matchesSelectorList(node, selectorList) {
  return selectorList.split(",").some((sel) => matchesSelector(node, sel.trim()));
}

function matchesSelector(node, selector) {
  // tag
  if (/^[a-z]+$/i.test(selector)) return node.tagName.toLowerCase() === selector.toLowerCase();
  // .class
  if (selector.startsWith(".")) return classList(node).includes(selector.slice(1));
  // [attr] or [attr='v']
  const attrMatch = selector.match(/^\[([a-z-]+)(?:='([^']*)')?\]$/i);
  if (attrMatch) {
    const value = node.getAttribute(attrMatch[1]);
    if (attrMatch[2] === undefined) return value !== null;
    return value === attrMatch[2];
  }
  // "g.node" style tag.class
  const tagClass = selector.match(/^([a-z]+)\.([a-z0-9_-]+)$/i);
  if (tagClass)
    return node.tagName.toLowerCase() === tagClass[1].toLowerCase() && classList(node).includes(tagClass[2]);
  // "g.nodes > g" — treat as: a <g> whose parent has class "nodes"
  if (selector === "g.nodes > g") {
    return node.tagName.toLowerCase() === "g" && node.parentElement && classList(node.parentElement).includes("nodes");
  }
  return false;
}

function classList(node) {
  return (node.className || "").split(/\s+/).filter(Boolean);
}

function label(text, { multiline = false } = {}) {
  if (!multiline) return el("span", { className: "nodeLabel", text });
  const [a, b] = text.split(" ");
  return el("span", {
    className: "nodeLabel",
    children: [el("p", { children: [el("span", { text: a }), el("br"), el("span", { text: b })] })],
  });
}

// ---------------------------------------------------------------------------
// isMermaidSvg
// ---------------------------------------------------------------------------

test("isMermaidSvg matches the mermaid id prefix", () => {
  assert.equal(isMermaidSvg(el("svg", { id: "mermaid-1782877720504" })), true);
  assert.equal(isMermaidSvg(el("svg", { id: "mermaid_underscore" })), true);
});

test("isMermaidSvg matches aria-roledescription and .mermaid ancestor", () => {
  assert.equal(isMermaidSvg(el("svg", { attrs: { "aria-roledescription": "flowchart-v2" } })), true);
  const svg = el("svg");
  el("div", { className: "mermaid", children: [svg] });
  assert.equal(isMermaidSvg(svg), true);
});

test("isMermaidSvg matches the data-lavish-mermaid opt-in wrapper", () => {
  const svg = el("svg");
  el("figure", { attrs: { "data-lavish-mermaid": "" }, children: [svg] });
  assert.equal(isMermaidSvg(svg), true);
});

test("isMermaidSvg rejects a plain unrelated svg and null", () => {
  assert.equal(isMermaidSvg(el("svg", { id: "logo" })), false);
  assert.equal(isMermaidSvg(null), false);
});

// ---------------------------------------------------------------------------
// readNodeLabel
// ---------------------------------------------------------------------------

test("readNodeLabel reads a single-line label", () => {
  assert.equal(readNodeLabel(label("HomeAgentChat")), "HomeAgentChat");
});

test("readNodeLabel joins multi-line <br> labels with a space", () => {
  // The exact bug the complex chart surfaced: "A<br/>B" must become "A B".
  assert.equal(readNodeLabel(label("AnonDiagnosisChat 2415LOC", { multiline: true })), "AnonDiagnosisChat 2415LOC");
});

test("readNodeLabel collapses whitespace and truncates to 120 chars", () => {
  const long = "x".repeat(200);
  assert.equal(readNodeLabel(el("span", { text: "  a   b  " })), "a b");
  assert.equal(readNodeLabel(el("span", { text: long })).length, 120);
});

test("readNodeLabel returns empty string for a missing label element", () => {
  assert.equal(readNodeLabel(null), "");
  assert.equal(readNodeLabel(undefined), "");
});

// ---------------------------------------------------------------------------
// mermaidNodeElement
// ---------------------------------------------------------------------------

test("mermaidNodeElement resolves the <g> node from an inner element and itself", () => {
  const { rect, g } = diagram();
  assert.equal(mermaidNodeElement(rect), g);
  assert.equal(mermaidNodeElement(g), g);
});

test("mermaidNodeElement returns null outside a mermaid node", () => {
  assert.equal(mermaidNodeElement(null), null);
  assert.equal(mermaidNodeElement(el("g", { className: "node" })), null); // no svg ancestor

  const g = el("g", { id: "n1", className: "node" });
  el("svg", { id: "hand-drawn", children: [g] });
  assert.equal(mermaidNodeElement(g), null); // non-mermaid svg
});

// ---------------------------------------------------------------------------
// mermaidNodeFrom
// ---------------------------------------------------------------------------

function diagram({
  nodeId = "mermaid-7-flowchart-HomeAgentChat-1",
  labelText = "HomeAgentChat",
  multiline = false,
} = {}) {
  const labelEl = label(labelText, { multiline });
  const rect = el("rect");
  const g = el("g", { id: nodeId, className: "node", children: [rect, labelEl] });
  const svg = el("svg", { id: "mermaid-7", children: [g] });
  return { svg, g, rect, labelEl };
}

test("mermaidNodeFrom resolves a node from a click on its inner rect", () => {
  const { rect } = diagram();
  const target = mermaidNodeFrom(rect, (node) => "g#" + node.id);
  assert.deepEqual(target, {
    type: "mermaid-node",
    diagramId: "mermaid-7",
    nodeId: "mermaid-7-flowchart-HomeAgentChat-1",
    label: "HomeAgentChat",
    selector: "g#mermaid-7-flowchart-HomeAgentChat-1",
  });
});

test("mermaidNodeFrom uses the injected selector fn, defaulting to empty", () => {
  const { g } = diagram();
  assert.equal(mermaidNodeFrom(g, () => "sel!").selector, "sel!");
  assert.equal(mermaidNodeFrom(g, undefined).selector, "");
});

test("mermaidNodeFrom carries the space-joined multi-line label", () => {
  const { rect } = diagram({ labelText: "useWorkflowChat 1198LOC", multiline: true });
  assert.equal(mermaidNodeFrom(rect, () => "").label, "useWorkflowChat 1198LOC");
});

test("mermaidNodeFrom returns null outside any node", () => {
  const svg = el("svg", { id: "mermaid-7", children: [el("g", { className: "edgePaths" })] });
  const stray = svg.children[0];
  assert.equal(
    mermaidNodeFrom(stray, () => ""),
    null,
  );
});

test("mermaidNodeFrom returns null when the svg is not a mermaid svg", () => {
  const labelEl = label("Box");
  const g = el("g", { id: "n1", className: "node", children: [labelEl] });
  el("svg", { id: "hand-drawn", children: [g] });
  assert.equal(
    mermaidNodeFrom(g, () => ""),
    null,
  );
});

test("mermaidNodeFrom returns null for null/detached input", () => {
  assert.equal(
    mermaidNodeFrom(null, () => ""),
    null,
  );
  assert.equal(
    mermaidNodeFrom(el("g", { className: "node" }), () => ""),
    null,
  ); // no svg ancestor
});

// ---------------------------------------------------------------------------
// normalizeMermaidNodeTarget
// ---------------------------------------------------------------------------

test("normalizeMermaidNodeTarget keeps the fixed shape and drops extra fields", () => {
  const out = normalizeMermaidNodeTarget({
    type: "mermaid-node",
    diagramId: "mermaid-7",
    nodeId: "flowchart-X-1",
    label: "X",
    selector: "g#x",
    injected: { nested: "nope" },
  });
  assert.deepEqual(out, {
    type: "mermaid-node",
    diagramId: "mermaid-7",
    nodeId: "flowchart-X-1",
    label: "X",
    selector: "g#x",
  });
});

test("normalizeMermaidNodeTarget coerces missing/non-string fields to strings", () => {
  const out = normalizeMermaidNodeTarget({ diagramId: 123, nodeId: null, label: undefined });
  assert.deepEqual(out, {
    type: "mermaid-node",
    diagramId: "123",
    nodeId: "",
    label: "",
    selector: "",
  });
});
