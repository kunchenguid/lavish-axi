// The conversation transcript's two shapes: what a prompt becomes when it enters `session.chat`
// (`chatEntryForPrompt`), and how a stored entry is rendered for the chrome (`serializeChat`,
// `renderChatMarkdown`). Both live on the server because `chrome-client.js` is served as a raw
// file and cannot import modules - the same reason layout-warning display strings and share
// passwords are computed server-side. State keeps only text; `html` exists only on the wire, and
// only for agent entries: a reviewer's own words are never parsed.

// `session.chat` lives in state.json, which is rewritten wholesale on every store operation, so
// an entry keeps only what the chrome shows, bounded.
const EXCERPT_MAX = 120;
const SELECTOR_MAX = 512;
const LABEL_MAX = 40;

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const BLOCK_START = /^(?:```|~~~|#{1,6}\s|\s*(?:[-*+]|\d+[.)])\s+)/;
const FENCE_OPEN = /^(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Inline rules run on text that is already escaped, so no rule can be tricked into emitting
// markup that was not one of these. Code spans are split out first so nothing else touches
// their contents; link targets are limited to http(s) and open in a new tab.
function renderInline(text) {
  return text
    .split(/(`[^`\n]+`|!\[[^\]\n]*\]\([^\s)\n]+\))/)
    .map((part) => {
      if (part.startsWith("`") && part.endsWith("`")) {
        return "<code>" + escapeHtml(part.slice(1, -1)) + "</code>";
      }
      if (part.startsWith("![")) return escapeHtml(part);
      let s = escapeHtml(part);
      s = s.replace(
        /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
        (_match, label, url) => '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + "</a>",
      );
      s = s.replace(
        /(^|[\s(])(https?:\/\/[^\s<)]+)/g,
        (_match, before, url) =>
          before + '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + "</a>",
      );
      s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
      s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
      s = s.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
      return s;
    })
    .join("");
}

// Items nest by indentation; a change of marker at the same depth starts a new list, as
// CommonMark does.
function renderListItems(items) {
  const root = { children: [] };
  const stack = [{ node: root, indent: -1 }];
  for (const item of items) {
    const node = { ...item, children: [] };
    while (stack.length > 1 && item.indent <= stack[stack.length - 1].indent) stack.pop();
    stack[stack.length - 1].node.children.push(node);
    stack.push({ node, indent: item.indent });
  }
  const render = (nodes) => {
    let html = "";
    let i = 0;
    while (i < nodes.length) {
      const ordered = nodes[i].ordered;
      const tag = ordered ? "ol" : "ul";
      let inner = "";
      while (i < nodes.length && nodes[i].ordered === ordered) {
        inner += "<li>" + renderInline(nodes[i].text) + render(nodes[i].children) + "</li>";
        i += 1;
      }
      html += "<" + tag + ">" + inner + "</" + tag + ">";
    }
    return html;
  };
  return render(root.children);
}

// A deliberate subset of Markdown: what makes an agent reply scannable in a 360px column, and
// nothing that needs a type scale or a wide table. Blocks: paragraphs on blank lines with a
// single newline as a line break (the chat convention - agents write one thought per line),
// headings of any level as one bold lead line, nested bullet and numbered lists, and fenced code.
// Inline: bold, italic, code, links. Everything else - including tables, images, quotes, rules,
// and raw HTML - comes out as the text the agent wrote.
export function renderChatMarkdown(text) {
  const lines = String(text || "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      const buffer = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith(fence[1])) {
        buffer.push(lines[i]);
        i += 1;
      }
      i += 1;
      out.push("<pre><code>" + escapeHtml(buffer.join("\n")) + "</code></pre>");
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      out.push('<p class="chat-h">' + renderInline(heading[2]) + "</p>");
      i += 1;
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const items = [];
      while (i < lines.length && LIST_ITEM.test(lines[i])) {
        const item = LIST_ITEM.exec(lines[i]);
        items.push({ indent: item[1].length, ordered: /\d/.test(item[2]), text: item[3] });
        i += 1;
        while (i < lines.length && lines[i].trim() && /^\s{2,}/.test(lines[i]) && !LIST_ITEM.test(lines[i])) {
          items[items.length - 1].text += " " + lines[i].trim();
          i += 1;
        }
      }
      out.push(renderListItems(items));
      continue;
    }
    const buffer = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() && !BLOCK_START.test(lines[i])) {
      buffer.push(lines[i]);
      i += 1;
    }
    out.push("<p>" + buffer.map((entry) => renderInline(entry.trim())).join("<br>") + "</p>");
  }
  return out.join("");
}

function bound(value, max) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

function withSelector(anchor, selector) {
  if (selector) anchor.selector = selector;
  return anchor;
}

// The anchor names what a note was attached to, in the annotation card's own words: the card
// said "Annotate <h2>", "Annotate text", "Annotate cell: ...", or "Annotate node: ...", so the
// transcript says `<h2>`, `text`, `cell`, `node`. A cell without a provable row or column label
// falls back to the element form rather than inventing a name, the rule the card follows too.
function promptAnchor(prompt, kind) {
  if (kind === "message") return null;
  const target = prompt.target && typeof prompt.target === "object" ? prompt.target : null;
  const selector = bound(prompt.selector, SELECTOR_MAX);
  if (kind === "whiteboard") {
    const index = Number(target?.diagramIndex);
    const excerpt = Number.isInteger(index) && index >= 0 ? "Diagram " + (index + 1) : prompt.text;
    return { kind: "whiteboard", label: "whiteboard", excerpt: bound(excerpt, EXCERPT_MAX) };
  }
  if (kind === "layout-warnings") {
    const count = Array.isArray(target?.warnings) ? target.warnings.length : 0;
    const excerpt = count > 0 ? count + (count === 1 ? " issue" : " issues") : prompt.text;
    return { kind: "layout", label: "layout", excerpt: bound(excerpt, EXCERPT_MAX) };
  }
  const type = String(target?.type || "");
  if (type === "text-range") {
    return withSelector(
      { kind: "text", label: "text", excerpt: bound(target.text || prompt.text, EXCERPT_MAX) },
      selector,
    );
  }
  if (type === "table-cell") {
    const semantic = [target.rowLabel, target.columnLabel]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .join(" → ");
    if (semantic) return withSelector({ kind: "cell", label: "cell", excerpt: bound(semantic, EXCERPT_MAX) }, selector);
  }
  if (type === "mermaid-node") {
    return withSelector(
      { kind: "node", label: "node", excerpt: bound(target.label || prompt.text, EXCERPT_MAX) },
      selector,
    );
  }
  const tag = String(prompt.tag || "").trim();
  if (!tag) return null;
  return withSelector(
    { kind: "element", label: bound("<" + tag + ">", LABEL_MAX), excerpt: bound(prompt.text, EXCERPT_MAX) },
    selector,
  );
}

// What an accepted prompt becomes in `session.chat`. Every kind of prompt enters the transcript,
// so the conversation shows what the reviewer said and not only what the agent answered. Only the
// client-visible attachment fields are kept: the resolved path, mime, and size stay in the prompt.
// A prompt with neither text nor images has nothing to show and makes no entry.
export function chatEntryForPrompt(prompt, at) {
  if (!prompt || typeof prompt !== "object") return null;
  const text = String(prompt.prompt || "");
  const attachments = Array.isArray(prompt.attachments)
    ? prompt.attachments
        .filter((attachment) => attachment && typeof attachment === "object" && attachment.id)
        .map((attachment) =>
          attachment.name
            ? { id: String(attachment.id), name: String(attachment.name) }
            : { id: String(attachment.id) },
        )
    : [];
  if (!text && attachments.length === 0) return null;
  const tag = String(prompt.tag || "");
  const kind =
    tag === "message"
      ? "message"
      : tag === "whiteboard"
        ? "whiteboard"
        : tag === "layout-warnings"
          ? "layout-warnings"
          : "annotation";
  const entry = { role: "user", kind, text, at: String(at || new Date().toISOString()) };
  const anchor = promptAnchor(prompt, kind);
  if (anchor) entry.anchor = anchor;
  if (attachments.length) entry.attachments = attachments;
  return entry;
}

// The transcript as the chrome renders it. Agent entries carry their rendered `html`; user
// entries never do, and an entry stored before `kind` existed is a composer message.
export function serializeChat(chat) {
  if (!Array.isArray(chat)) return [];
  const serialized = [];
  for (const item of chat) {
    if (!item || typeof item !== "object") continue;
    const text = String(item.text || "");
    if (item.role === "agent") {
      serialized.push({ ...item, role: "agent", text, html: renderChatMarkdown(text) });
      continue;
    }
    const entry = {
      ...item,
      role: "user",
      text,
      kind: typeof item.kind === "string" && item.kind ? item.kind : "message",
    };
    delete entry.html;
    serialized.push(entry);
  }
  return serialized;
}
