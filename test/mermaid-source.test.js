import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeHtmlEntities,
  extractMermaidSources,
  mermaidSourceHash,
  normalizeMermaidSource,
} from "../src/mermaid-source.js";

test("extractMermaidSources finds .mermaid elements in document order", () => {
  const html = `<html><body>
    <pre class="mermaid">flowchart TD
  A --> B</pre>
    <p>prose</p>
    <div class="mermaid">sequenceDiagram
  A->>B: hi</div>
  </body></html>`;
  const sources = extractMermaidSources(html);
  assert.equal(sources.length, 2);
  assert.equal(sources[0].index, 0);
  assert.equal(sources[0].source, "flowchart TD\n  A --> B");
  assert.equal(sources[1].index, 1);
  assert.equal(sources[1].source, "sequenceDiagram\n  A->>B: hi");
});

test("extractMermaidSources decodes HTML entities in diagram text", () => {
  const html = `<pre class="mermaid">flowchart LR
  A --&gt; B{&quot;ok?&quot;}
  B --&gt; C[&amp;done&#39;]</pre>`;
  const [diagram] = extractMermaidSources(html);
  assert.equal(diagram.source, `flowchart LR\n  A --> B{"ok?"}\n  B --> C[&done']`);
});

test("extractMermaidSources preserves text exactly as parsed by the browser", () => {
  const [diagram] = extractMermaidSources(`<div class="mermaid">graph TD; A --&amp;gt; B</div>`);
  assert.equal(diagram.source, "graph TD; A --&gt; B");
});

test("extractMermaidSources requires the exact mermaid class token", () => {
  const html = `
    <div class="mermaid-like">graph TD; X-->Y</div>
    <div class="not mermaid diagram">graph TD; A-->B</div>
    <div class="mermaidish">graph TD; P-->Q</div>`;
  const sources = extractMermaidSources(html);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].source, "graph TD; A-->B");
});

test("extractMermaidSources ignores commented-out diagrams so indexes match the browser", () => {
  const html = `
    <!-- <div class="mermaid">graph TD; HIDDEN-->X</div> -->
    <div class="mermaid">graph TD; A-->B</div>`;
  const sources = extractMermaidSources(html);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].index, 0);
  assert.equal(sources[0].source, "graph TD; A-->B");
});

test("extractMermaidSources strips stray inner markup", () => {
  const html = `<div class="mermaid">graph TD; A-->B<span></span></div>`;
  assert.equal(extractMermaidSources(html)[0].source, "graph TD; A-->B");
});

test("extractMermaidSources handles single-quoted class attributes and empty input", () => {
  assert.equal(extractMermaidSources(`<div class='mermaid x'>graph TD; A-->B</div>`).length, 1);
  assert.deepEqual(extractMermaidSources(""), []);
  assert.deepEqual(extractMermaidSources(null), []);
});

test("extractMermaidSources follows HTML class attribute casing and quoting", () => {
  const html = `<div class=mermaid>graph TD; A-->B</div>
    <div CLASS="diagram mermaid">graph TD; B-->C</div>
    <div class=mermaid-like>graph TD; C-->D</div>`;
  const sources = extractMermaidSources(html);
  assert.deepEqual(
    sources.map(({ source }) => source),
    ["graph TD; A-->B", "graph TD; B-->C"],
  );
});

test("extractMermaidSources ignores raw-text and template markup", () => {
  const html = `<script>const example = '<div class="mermaid">graph TD; SCRIPT-->X</div>';</script>
    <template><div class="mermaid">graph TD; TEMPLATE-->X</div></template>
    <style>.example::after { content: '<div class="mermaid">'; }</style>
    <div class="mermaid">graph TD; A-->B</div>`;
  assert.deepEqual(extractMermaidSources(html), [{ index: 0, source: "graph TD; A-->B" }]);
});

test("normalizeMermaidSource trims outer blank space but keeps inner structure", () => {
  assert.equal(normalizeMermaidSource("\n  flowchart TD\n    A --> B\n  "), "  flowchart TD\n    A --> B");
  assert.equal(normalizeMermaidSource(""), "");
});

test("mermaidSourceHash is stable across edge whitespace and differs across content", () => {
  const a = mermaidSourceHash("flowchart TD\n  A --> B");
  const b = mermaidSourceHash("\nflowchart TD\n  A --> B   \n");
  const c = mermaidSourceHash("flowchart TD\n  A --> C");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{16}$/);
});

test("decodeHtmlEntities decodes numeric references and double-encoded ampersands last", () => {
  assert.equal(decodeHtmlEntities("A&#39;s &#x2192; B"), "A's → B");
  assert.equal(decodeHtmlEntities("a &amp;&amp; b"), "a && b");
});
