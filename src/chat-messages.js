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
const HEADING = /^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/;

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Inline rules run on text that is already escaped, so no rule can be tricked into emitting
// markup that was not one of these. Code spans and images are split out first so nothing else
// touches their contents; link targets are limited to http(s) and open in a new tab.
function renderEmphasis(text) {
  return text
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
}

function destinationEnd(text, start) {
  let depth = 0;
  let i = start;
  while (i < text.length && !/[\s<]/.test(text[i])) {
    if (text[i] === "(") depth += 1;
    if (text[i] === ")") {
      if (depth === 0) break;
      depth -= 1;
    }
    i += 1;
  }
  return { end: i, balanced: depth === 0 };
}

function imageEnd(text, start) {
  if (!text.startsWith("![", start)) return -1;
  const labelEnd = text.indexOf("](", start + 2);
  if (labelEnd === -1 || text.slice(start + 2, labelEnd).includes("\n")) return -1;
  const destinationStart = labelEnd + 2;
  const destination = destinationEnd(text, destinationStart);
  if (!destination.balanced) return -1;
  if (text[destination.end] === ")") return destination.end + 1;
  let titleStart = destination.end;
  while (text[titleStart] === " " || text[titleStart] === "\t") titleStart += 1;
  if (text[titleStart] === ")") return titleStart + 1;
  const quote = text[titleStart];
  let titleEnd = -1;
  if (quote === '"' || quote === "'") {
    titleEnd = text.indexOf(quote, titleStart + 1);
    if (titleEnd === -1 || text.slice(titleStart + 1, titleEnd).includes("\n")) return -1;
    titleEnd += 1;
  } else if (quote === "(") {
    let depth = 1;
    titleEnd = titleStart + 1;
    while (titleEnd < text.length && depth > 0 && text[titleEnd] !== "\n") {
      if (text[titleEnd] === "(") depth += 1;
      if (text[titleEnd] === ")") depth -= 1;
      titleEnd += 1;
    }
    if (depth !== 0) return -1;
  } else {
    return -1;
  }
  let close = titleEnd;
  while (text[close] === " " || text[close] === "\t") close += 1;
  return text[close] === ")" ? close + 1 : -1;
}

function markdownLinkAt(text, start) {
  if (text[start] !== "[") return null;
  const labelEnd = text.indexOf("](", start + 1);
  if (labelEnd === -1 || text.slice(start + 1, labelEnd).includes("\n")) return null;
  const destinationStart = labelEnd + 2;
  if (!text.startsWith("http://", destinationStart) && !text.startsWith("https://", destinationStart)) return null;
  const destination = destinationEnd(text, destinationStart);
  if (!destination.balanced || text[destination.end] !== ")") return null;
  return {
    end: destination.end + 1,
    label: text.slice(start + 1, labelEnd),
    url: text.slice(destinationStart, destination.end),
  };
}

function bareUrlEnd(text, start) {
  let end = destinationEnd(text, start).end;
  while (end > start) {
    if (text.slice(start, end).endsWith("&quot;")) {
      end -= "&quot;".length;
    } else if (/&(?:amp|lt|gt);$/.test(text.slice(start, end))) {
      break;
    } else if (/[.,;:!?'”’]/.test(text[end - 1])) {
      end -= 1;
    } else {
      break;
    }
  }
  return end;
}

function renderLinksAndEmphasis(text) {
  let html = "";
  let offset = 0;
  let i = 0;
  while (i < text.length) {
    const markdownLink = markdownLinkAt(text, i);
    const bareUrl =
      (i === 0 || /[\s(]/.test(text[i - 1])) && (text.startsWith("http://", i) || text.startsWith("https://", i));
    if (!markdownLink && !bareUrl) {
      i += 1;
      continue;
    }
    html += renderEmphasis(text.slice(offset, i));
    if (markdownLink) {
      html +=
        '<a href="' + markdownLink.url + '" target="_blank" rel="noopener noreferrer">' + markdownLink.label + "</a>";
      i = markdownLink.end;
    } else {
      const end = bareUrlEnd(text, i);
      const url = text.slice(i, end);
      html += '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + "</a>";
      i = end;
    }
    offset = i;
  }
  return html + renderEmphasis(text.slice(offset));
}

function renderInline(text) {
  let html = "";
  let offset = 0;
  let i = 0;
  while (i < text.length) {
    let end = -1;
    let code = false;
    if (text[i] === "`") {
      const close = text.indexOf("`", i + 1);
      if (close !== -1 && !text.slice(i + 1, close).includes("\n")) {
        end = close + 1;
        code = true;
      }
    } else {
      end = imageEnd(text, i);
    }
    if (end === -1) {
      i += 1;
      continue;
    }
    html += renderLinksAndEmphasis(escapeHtml(text.slice(offset, i)));
    html += code ? "<code>" + escapeHtml(text.slice(i + 1, end - 1)) + "</code>" : escapeHtml(text.slice(i, end));
    i = end;
    offset = end;
  }
  return html + renderLinksAndEmphasis(escapeHtml(text.slice(offset)));
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
      const start = ordered && nodes[i].start !== "1" ? ' start="' + nodes[i].start + '"' : "";
      let inner = "";
      while (i < nodes.length && nodes[i].ordered === ordered) {
        inner += "<li>" + renderInline(nodes[i].text) + render(nodes[i].children) + "</li>";
        i += 1;
      }
      html += "<" + tag + start + ">" + inner + "</" + tag + ">";
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
        const ordered = /\d/.test(item[2]);
        const start = ordered ? item[2].replace(/[.)]$/, "").replace(/^0+(?=\d)/, "") : "";
        items.push({ indent: item[1].length, ordered, start, text: item[3] });
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
