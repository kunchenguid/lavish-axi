import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { chatEntryForPrompt, renderChatMarkdown, serializeChat } from "../src/chat-messages.js";

// The renderer is what turns an agent's `--agent-reply` into something a reviewer can scan in a
// 360px column. It is a deliberate subset: every rule below is one the reply needs, and anything
// outside it must come out as the text the agent wrote, never as markup it did not write.

test("paragraphs split on blank lines and a single newline is a line break", () => {
  assert.equal(
    renderChatMarkdown("first line\nsecond line\n\nnext paragraph"),
    "<p>first line<br>second line</p><p>next paragraph</p>",
  );
});

test("headings strip only whitespace-separated closing markers", () => {
  assert.equal(
    renderChatMarkdown("# Title\n### Sub ##\n## C#\ntext"),
    '<p class="chat-h">Title</p><p class="chat-h">Sub</p><p class="chat-h">C#</p><p>text</p>',
  );
});

test("lists nest by indentation, switch marker type, and preserve an ordered start", () => {
  assert.equal(
    renderChatMarkdown("- a\n  - b\n  1. c\n- d\n3. third\n4) fourth"),
    '<ul><li>a<ul><li>b</li></ul><ol><li>c</li></ol></li><li>d</li></ul><ol start="3"><li>third</li><li>fourth</li></ol>',
  );
});

test("an indented continuation line joins its list item", () => {
  assert.equal(
    renderChatMarkdown("- first\n  still first\n- second"),
    "<ul><li>first still first</li><li>second</li></ul>",
  );
});

test("fenced code keeps its contents literal and escaped", () => {
  assert.equal(
    renderChatMarkdown("before\n```css\n.bubble { white-space: pre-wrap; }\n**not bold** <b>\n```\nafter"),
    "<p>before</p><pre><code>.bubble { white-space: pre-wrap; }\n**not bold** &lt;b&gt;</code></pre><p>after</p>",
  );
});

test("an unterminated fence runs to the end without throwing", () => {
  assert.equal(renderChatMarkdown("```\nopen"), "<pre><code>open</code></pre>");
});

test("inline code protects the markers inside it", () => {
  assert.equal(
    renderChatMarkdown("use `**literal**` and **bold** and *it* and _it2_ and snake_case_name"),
    "<p>use <code>**literal**</code> and <strong>bold</strong> and <em>it</em> and <em>it2</em> and snake_case_name</p>",
  );
});

test("links and bare https urls open in a new tab and only http(s) becomes a link", () => {
  assert.equal(
    renderChatMarkdown("see [docs](https://example.com/a?b=1&c=2) or https://x.y/z) and [bad](javascript:alert(1))"),
    '<p>see <a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">docs</a> or <a href="https://x.y/z" target="_blank" rel="noopener noreferrer">https://x.y/z</a>) and [bad](javascript:alert(1))</p>',
  );
});

test("link labels and targets are protected from emphasis rendering", () => {
  assert.equal(
    renderChatMarkdown(
      "[*label*](https://example.test/path_*_?q=_value_&x=*star*) and https://example.test/?q=_raw_&x=*plain*",
    ),
    '<p><a href="https://example.test/path_*_?q=_value_&amp;x=*star*" target="_blank" rel="noopener noreferrer">*label*</a> and <a href="https://example.test/?q=_raw_&amp;x=*plain*" target="_blank" rel="noopener noreferrer">https://example.test/?q=_raw_&amp;x=*plain*</a></p>',
  );
});

test("links preserve balanced parentheses and leave trailing punctuation outside", () => {
  assert.equal(
    renderChatMarkdown(
      '[docs](https://example.test/Foo_(bar)) and See https://example.test/docs. (https://example.test/Foo_(bar)). https://example.test/quoted"',
    ),
    '<p><a href="https://example.test/Foo_(bar)" target="_blank" rel="noopener noreferrer">docs</a> and See <a href="https://example.test/docs" target="_blank" rel="noopener noreferrer">https://example.test/docs</a>. (<a href="https://example.test/Foo_(bar)" target="_blank" rel="noopener noreferrer">https://example.test/Foo_(bar)</a>). <a href="https://example.test/quoted" target="_blank" rel="noopener noreferrer">https://example.test/quoted</a>&quot;</p>',
  );
});

test("Markdown images with optional titles remain literal text", () => {
  assert.equal(
    renderChatMarkdown(
      'before ![*alt*](https://example.com/image_(1).png "*caption*") and ![_alt_](image.png \'_caption_\') and ![**last**](image.png (caption)) and ![*empty*]() and ![_titled_]( "title") and ![*angle*](<https://example.test/a b.png> "caption") and ![*ref*][logo] and ![_collapsed_][] and ![**shortcut**] after',
    ),
    "<p>before ![*alt*](https://example.com/image_(1).png &quot;*caption*&quot;) and ![_alt_](image.png '_caption_') and ![**last**](image.png (caption)) and ![*empty*]() and ![_titled_]( &quot;title&quot;) and ![*angle*](&lt;https://example.test/a b.png&gt; &quot;caption&quot;) and ![*ref*][logo] and ![_collapsed_][] and ![**shortcut**] after</p>",
  );
});

test("long runs of unmatched link and image brackets stay literal without stalling", () => {
  const text = "[".repeat(30_000) + " " + "![".repeat(30_000);
  const started = performance.now();
  const html = renderChatMarkdown(text);
  const elapsed = performance.now() - started;
  assert.equal(html, `<p>${text}</p>`);
  assert.ok(elapsed < 1_000, `render took ${Math.round(elapsed)}ms`);
});

test("raw html is escaped, never interpreted", () => {
  assert.equal(
    renderChatMarkdown('<img src=x onerror=alert(1)> and & and "q"'),
    "<p>&lt;img src=x onerror=alert(1)&gt; and &amp; and &quot;q&quot;</p>",
  );
});

test("tables are left as the lines the agent wrote", () => {
  assert.equal(renderChatMarkdown("| a | b |\n|---|---|\n| 1 | 2 |"), "<p>| a | b |<br>|---|---|<br>| 1 | 2 |</p>");
});

test("unsupported quotes and rules remain text, and CRLF input is normalized", () => {
  assert.equal(
    renderChatMarkdown("> quoted **bold**\r\n> second\r\n\r\n---\r\n\r\nend"),
    "<p>&gt; quoted <strong>bold</strong><br>&gt; second</p><p>---</p><p>end</p>",
  );
});

test("empty and non-string input render nothing", () => {
  assert.equal(renderChatMarkdown(""), "");
  assert.equal(renderChatMarkdown(undefined), "");
  assert.equal(renderChatMarkdown("\n\n  \n"), "");
});

// What a prompt becomes when it enters the conversation. Only the fields the chrome shows are
// kept, bounded, because `session.chat` lives in state.json, which is rewritten wholesale on
// every store operation.

const at = "2026-09-15T12:00:00.000Z";

test("a composer message becomes a user entry with no anchor", () => {
  assert.deepEqual(
    chatEntryForPrompt(
      { uid: "", prompt: "Keep the table", selector: "", tag: "message", text: "Freeform message" },
      at,
    ),
    {
      role: "user",
      kind: "message",
      text: "Keep the table",
      at,
    },
  );
});

test("an element note anchors to its tag and text in the annotation card's words", () => {
  assert.deepEqual(
    chatEntryForPrompt(
      { uid: "1", prompt: "Rename this", selector: "h2#phase-1", tag: "h2", text: "Phase 1: Inventory" },
      at,
    ),
    {
      role: "user",
      kind: "annotation",
      text: "Rename this",
      at,
      anchor: { kind: "element", label: "<h2>", excerpt: "Phase 1: Inventory", selector: "h2#phase-1" },
    },
  );
});

test("a text selection anchors to the selected words", () => {
  const entry = chatEntryForPrompt(
    {
      uid: "",
      prompt: "Say design system",
      selector: "main > p",
      tag: "text",
      text: "marketing site",
      target: { type: "text-range", text: "marketing site", selector: "main > p", start: {}, end: {} },
    },
    at,
  );
  assert.deepEqual(entry.anchor, { kind: "text", label: "text", excerpt: "marketing site", selector: "main > p" });
});

test("a table cell anchors to its row and column when both are provable, else to the element", () => {
  const cell = { uid: "3", prompt: "Downgrade", selector: "td", tag: "td", text: "Annotation card" };
  assert.deepEqual(
    chatEntryForPrompt(
      { ...cell, target: { type: "table-cell", rowLabel: "Annotation card", columnLabel: "Risk" } },
      at,
    ).anchor,
    { kind: "cell", label: "cell", excerpt: "Annotation card → Risk", selector: "td" },
  );
  assert.deepEqual(chatEntryForPrompt({ ...cell, target: { type: "table-cell" } }, at).anchor, {
    kind: "element",
    label: "<td>",
    excerpt: "Annotation card",
    selector: "td",
  });
});

test("a diagram node anchors to its label", () => {
  const entry = chatEntryForPrompt(
    {
      uid: "",
      prompt: "Earlier",
      selector: "svg g.node",
      tag: "mermaid-node",
      text: "Classify",
      target: { type: "mermaid-node", diagramId: "d1", nodeId: "n1", label: "Classify checks", selector: "svg g.node" },
    },
    at,
  );
  assert.deepEqual(entry.anchor, { kind: "node", label: "node", excerpt: "Classify checks", selector: "svg g.node" });
});

test("whiteboard and layout batches anchor to the diagram and the issue count", () => {
  const whiteboard = chatEntryForPrompt(
    {
      uid: "",
      prompt: "Whiteboard edits...",
      selector: "",
      tag: "whiteboard",
      text: "Whiteboard: diagram 2",
      target: { type: "excalidraw-scene", diagramIndex: 1 },
    },
    at,
  );
  assert.equal(whiteboard.kind, "whiteboard");
  assert.deepEqual(whiteboard.anchor, { kind: "whiteboard", label: "whiteboard", excerpt: "Diagram 2" });

  const layout = chatEntryForPrompt(
    {
      uid: "",
      prompt: "Fix these 2 layout issues...",
      selector: "",
      tag: "layout-warnings",
      text: "2 layout issues",
      target: { type: "layout-warnings", warnings: [{ id: "a" }, { id: "b" }] },
    },
    at,
  );
  assert.equal(layout.kind, "layout-warnings");
  assert.deepEqual(layout.anchor, { kind: "layout", label: "layout", excerpt: "2 issues" });
  assert.equal(
    chatEntryForPrompt(
      { ...layout, prompt: "x", tag: "layout-warnings", target: { type: "layout-warnings", warnings: [{ id: "a" }] } },
      at,
    ).anchor.excerpt,
    "1 issue",
  );
});

test("anchor fields are bounded and attachments keep only their id and name", () => {
  const entry = chatEntryForPrompt(
    {
      uid: "",
      prompt: "note",
      selector: "s".repeat(600),
      tag: "x".repeat(60),
      text: "t".repeat(200),
      attachments: [
        { id: "a".repeat(64) + ".png", name: "shot.png", path: "/secret/path", mime: "image/png", bytes: 9 },
      ],
    },
    at,
  );
  assert.equal(entry.anchor.excerpt.length, 120);
  assert.ok(entry.anchor.excerpt.endsWith("…"));
  assert.equal(entry.anchor.selector.length, 512);
  assert.equal(entry.anchor.label.length, 40);
  assert.deepEqual(entry.attachments, [{ id: "a".repeat(64) + ".png", name: "shot.png" }]);
});

test("a prompt with neither text nor images makes no entry, but an image-only message does", () => {
  assert.equal(chatEntryForPrompt({ uid: "", prompt: "", selector: "", tag: "message", text: "" }, at), null);
  const imageOnly = chatEntryForPrompt(
    { uid: "", prompt: "", selector: "", tag: "message", text: "", attachments: [{ id: "b".repeat(64) + ".png" }] },
    at,
  );
  assert.equal(imageOnly.text, "");
  assert.deepEqual(imageOnly.attachments, [{ id: "b".repeat(64) + ".png" }]);
});

// The chrome cannot import this module, so the transcript it renders is computed here: agent
// entries carry their rendered `html`, user entries never do.

test("serializeChat renders agent entries and passes user entries through as text", () => {
  const chat = [
    { role: "agent", text: "Done.\n\n- one\n- two", at },
    {
      role: "user",
      kind: "annotation",
      text: "<b>note</b>",
      at,
      anchor: { kind: "element", label: "<h2>", excerpt: "x", selector: "h2" },
    },
    { role: "user", text: "legacy message" },
  ];
  assert.deepEqual(serializeChat(chat), [
    { role: "agent", text: "Done.\n\n- one\n- two", at, html: "<p>Done.</p><ul><li>one</li><li>two</li></ul>" },
    {
      role: "user",
      kind: "annotation",
      text: "<b>note</b>",
      at,
      anchor: { kind: "element", label: "<h2>", excerpt: "x", selector: "h2" },
    },
    { role: "user", kind: "message", text: "legacy message" },
  ]);
  assert.deepEqual(serializeChat(undefined), []);
});
