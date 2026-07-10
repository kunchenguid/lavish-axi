import crypto from "node:crypto";

// Server-side extraction of Mermaid diagram sources from raw artifact HTML.
//
// The design snippet (`lavish-axi design`) renders diagrams from elements with
// class="mermaid" via `mermaid.run(...)`, replacing each element's text content
// with a rendered SVG in the live DOM. The artifact file on disk still holds
// the original sources, so the server - which already reads the file for every
// artifact route - is the authoritative place to recover them. Diagrams are
// identified by their position among `.mermaid` elements in document order,
// matching `document.querySelectorAll(".mermaid")` in the browser.

const MERMAID_OPEN_TAG_RE = /<([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*\bclass\s*=\s*("[^"]*"|'[^']*')[^>]*>/g;

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

function hasMermaidClass(quotedClassValue) {
  const value = quotedClassValue.slice(1, -1);
  return value.split(/\s+/).includes("mermaid");
}

// Extract Mermaid sources from raw artifact HTML in document order. Returns
// `[{ index, source }]` where `index` matches the element's position among
// `.mermaid` elements (the browser-side `diagramIndex`). Comments are stripped
// first so a commented-out diagram cannot shift the numbering.
export function extractMermaidSources(html) {
  const searchable = String(html || "").replace(/<!--[\s\S]*?-->/g, "");
  const sources = [];
  MERMAID_OPEN_TAG_RE.lastIndex = 0;
  let match;
  while ((match = MERMAID_OPEN_TAG_RE.exec(searchable)) !== null) {
    const [openTag, tagName, classValue] = match;
    if (!hasMermaidClass(classValue)) continue;
    const contentStart = match.index + openTag.length;
    const closeRe = new RegExp(`</${tagName}\\s*>`, "gi");
    closeRe.lastIndex = contentStart;
    const close = closeRe.exec(searchable);
    if (!close) continue;
    const raw = searchable.slice(contentStart, close.index);
    // Mermaid containers hold plain text; drop any stray inner markup defensively.
    const text = decodeHtmlEntities(raw.replace(/<[^>]*>/g, ""));
    sources.push({ index: sources.length, source: normalizeMermaidSource(text) });
    MERMAID_OPEN_TAG_RE.lastIndex = close.index + close[0].length;
  }
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
