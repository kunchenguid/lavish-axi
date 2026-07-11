import crypto from "node:crypto";

import { parse } from "parse5";

// Server-side extraction of Mermaid diagram sources from raw artifact HTML.
//
// The design snippet (`lavish-axi design`) renders diagrams from elements with
// class="mermaid" via `mermaid.run(...)`, replacing each element's text content
// with a rendered SVG in the live DOM. The artifact file on disk still holds
// the original sources, so the server - which already reads the file for every
// artifact route - is the authoritative place to recover them. Diagrams are
// identified by their position among `.mermaid` elements in document order,
// matching `document.querySelectorAll(".mermaid")` in the browser.

// Decode the entity forms that matter for Mermaid syntax (`--&gt;`, `&quot;...`).
// Numeric references are included so authored `&#39;` quotes survive.
export function decodeHtmlEntities(text) {
  return String(text)
    .replace(/&#(\d+);/g, (_, code) => safeFromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => safeFromCodePoint(Number.parseInt(code, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function safeFromCodePoint(code) {
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
}

function hasMermaidClass(value) {
  return value.split(/[\t\n\f\r ]+/).includes("mermaid");
}

function elementHasMermaidClass(node) {
  const classAttribute = Array.isArray(node.attrs)
    ? node.attrs.find((attribute) => attribute.name.toLowerCase() === "class")
    : null;
  return Boolean(classAttribute && hasMermaidClass(classAttribute.value));
}

function textContent(node) {
  if (node.nodeName === "#text") return String(node.value || "");
  return Array.isArray(node.childNodes) ? node.childNodes.map(textContent).join("") : "";
}

// Extract Mermaid sources from raw artifact HTML in document order. Returns
// `[{ index, source }]` where `index` matches the element's position among
// `.mermaid` elements (the browser-side `diagramIndex`).
export function extractMermaidSources(html) {
  const sources = [];

  function visit(node) {
    if (!Array.isArray(node.childNodes)) return;
    for (const child of node.childNodes) {
      if (child.tagName && elementHasMermaidClass(child)) {
        sources.push({
          index: sources.length,
          source: normalizeMermaidSource(textContent(child)),
        });
      }
      visit(child);
    }
  }

  visit(parse(String(html || "")));
  return sources;
}

// Trim outer blank lines but preserve inner indentation - Mermaid cares about
// line structure, and the hash must be stable across incidental whitespace at
// the edges of the HTML element.
export function normalizeMermaidSource(source) {
  return String(source || "")
    .replace(/^[ \t]*\r?\n/, "")
    .trimEnd();
}

// Stable identity for "did the underlying diagram change" staleness checks.
export function mermaidSourceHash(source) {
  return crypto.createHash("sha256").update(normalizeMermaidSource(source)).digest("hex").slice(0, 16);
}
