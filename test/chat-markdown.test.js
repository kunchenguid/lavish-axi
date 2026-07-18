import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { renderAgentChatMarkdown } from "../src/chat-markdown.js";

function env() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  return { document: dom.window.document, window: dom.window };
}

function render(text, overrides = {}) {
  return renderAgentChatMarkdown(text, { ...env(), ...overrides });
}

function fragmentHtml(node) {
  const wrap = node.ownerDocument.createElement("div");
  wrap.appendChild(node.cloneNode(true));
  return wrap.innerHTML;
}

function tagsIn(node) {
  return [...node.querySelectorAll("*")].map((el) => el.tagName.toLowerCase());
}

test("renders bold, italic, inline code, and safe https links", () => {
  const result = render("**bold** and *italic* and `code` and [docs](https://example.com/path)");
  assert.equal(result.ok, true);
  assert.ok(result.node);
  assert.equal(result.node.nodeType, result.node.DOCUMENT_FRAGMENT_NODE);
  assert.ok(result.node.querySelector("strong"), "expected strong");
  assert.ok(result.node.querySelector("em"), "expected em");
  assert.ok(result.node.querySelector("code"), "expected code");
  const anchor = result.node.querySelector("a");
  assert.ok(anchor);
  assert.equal(anchor.getAttribute("href"), "https://example.com/path");
  assert.equal(anchor.getAttribute("rel"), "noopener noreferrer");
  assert.equal(anchor.getAttribute("target"), "_blank");
  assert.match(result.node.textContent || "", /bold/);
  assert.match(result.node.textContent || "", /italic/);
  assert.match(result.node.textContent || "", /code/);
  assert.match(result.node.textContent || "", /docs/);
});

test("preserves paragraphs and single-newline breaks", () => {
  const result = render("line one\nline two\n\nsecond paragraph");
  assert.equal(result.ok, true);
  const html = fragmentHtml(result.node);
  assert.match(html, /<br\s*\/?>/i);
  assert.ok((result.node.querySelectorAll("p").length || 0) >= 1);
  assert.match(result.node.textContent || "", /line one/);
  assert.match(result.node.textContent || "", /line two/);
  assert.match(result.node.textContent || "", /second paragraph/);
});

test("renders unordered and ordered lists", () => {
  const result = render("- alpha\n- beta\n\n1. one\n2. two");
  assert.equal(result.ok, true);
  assert.ok(result.node.querySelector("ul"));
  assert.ok(result.node.querySelector("ol"));
  assert.equal(result.node.querySelectorAll("li").length >= 4, true);
});

test("fenced code containing script markup stays text, not a script node", () => {
  const result = render("```\n<script>alert(1)</script>\n```");
  assert.equal(result.ok, true);
  assert.equal(result.node.querySelectorAll("script").length, 0);
  assert.ok(result.node.querySelector("pre") || result.node.querySelector("code"));
  assert.match(result.node.textContent || "", /script/);
  assert.match(result.node.textContent || "", /alert\(1\)/);
});

test("heading tags are stripped while heading text remains readable", () => {
  const result = render("# Heading one\n\n## Heading two");
  assert.equal(result.ok, true);
  const tags = tagsIn(result.node);
  assert.equal(
    tags.some((t) => /^h[1-6]$/.test(t)),
    false,
  );
  assert.match(result.node.textContent || "", /Heading one/);
  assert.match(result.node.textContent || "", /Heading two/);
});

test("raw script, img onerror, svg onload, iframe, form, and style produce no dangerous nodes", () => {
  const result = render(
    [
      "<script>alert(1)</script>",
      '<img src=x onerror="alert(1)">',
      '<svg onload="alert(1)"><circle r="1"></circle></svg>',
      '<iframe src="https://evil.example"></iframe>',
      '<form action="https://evil.example"><button>go</button></form>',
      "<style>body{display:none}</style>",
      "safe text",
    ].join("\n"),
  );
  assert.equal(result.ok, true);
  const tags = new Set(tagsIn(result.node));
  for (const bad of ["script", "img", "svg", "iframe", "form", "style", "button"]) {
    assert.equal(tags.has(bad), false, `unexpected tag ${bad}`);
  }
  assert.equal(result.node.querySelectorAll("[onerror],[onload], [onclick]").length, 0);
  assert.match(result.node.textContent || "", /safe text/);
});

test("dangerous and non-http(s) link schemes are not navigable", () => {
  const result = render(
    [
      "[js](javascript:alert(1))",
      "[JS](JaVaScRiPt:alert(1))",
      "[data](data:text/html,hi)",
      "[file](file:///etc/passwd)",
      "[mail](mailto:a@b.c)",
      "[proto](//evil.example/path)",
      "[rel](/relative/path)",
      "[ok](https://safe.example/x)",
    ].join("\n"),
  );
  assert.equal(result.ok, true);
  const anchors = [...result.node.querySelectorAll("a")];
  const hrefs = anchors.map((a) => a.getAttribute("href"));
  for (const href of hrefs) {
    if (href == null) continue;
    assert.match(href, /^https:\/\//i, `unexpected href ${href}`);
  }
  assert.ok(anchors.some((a) => a.getAttribute("href") === "https://safe.example/x"));
  for (const a of anchors) {
    if (!a.getAttribute("href")) continue;
    assert.equal(a.getAttribute("rel"), "noopener noreferrer");
    assert.equal(a.getAttribute("target"), "_blank");
  }
});

test("attacker-controlled target, style, id, event, and data attributes do not survive", () => {
  const result = render(
    '<a href="https://safe.example" target="_self" style="color:red" id="x" onclick="alert(1)" data-evil="1">link</a>',
  );
  assert.equal(result.ok, true);
  const a = result.node.querySelector("a");
  assert.ok(a);
  assert.equal(a.getAttribute("href"), "https://safe.example");
  assert.equal(a.getAttribute("target"), "_blank");
  assert.equal(a.getAttribute("rel"), "noopener noreferrer");
  assert.equal(a.getAttribute("style"), null);
  assert.equal(a.getAttribute("id"), null);
  assert.equal(a.getAttribute("onclick"), null);
  assert.equal(a.getAttribute("data-evil"), null);
});

test("success path returns a DocumentFragment, not an HTML string field", () => {
  const result = render("**hi**");
  assert.equal(result.ok, true);
  assert.equal("html" in result, false);
  assert.equal(typeof result.node, "object");
  assert.equal(result.node.nodeType, 11);
});

test("empty input returns ok false with empty plainText", () => {
  assert.deepEqual(render(""), { ok: false, plainText: "" });
  assert.deepEqual(render(null), { ok: false, plainText: "" });
  assert.deepEqual(render(undefined), { ok: false, plainText: "" });
});

test("falls back to plainText when document is unavailable", () => {
  const result = renderAgentChatMarkdown("**bold**", /** @type {any} */ ({}));
  assert.equal(result.ok, false);
  assert.equal(result.plainText, "**bold**");
});

test("falls back to plainText when window is required but missing for sanitize", () => {
  const { document } = env();
  const result = renderAgentChatMarkdown("**bold**", { document });
  // window optional when document.defaultView exists (jsdom); force no window path
  Object.defineProperty(document, "defaultView", { value: null, configurable: true });
  const result2 = renderAgentChatMarkdown("**bold**", { document });
  assert.equal(result2.ok, false);
  assert.equal(result2.plainText, "**bold**");
  // baseline still works with defaultView
  assert.equal(result.ok, true);
});
