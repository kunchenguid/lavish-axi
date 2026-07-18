import createDOMPurify from "dompurify";
import { marked, Renderer } from "marked";

const ALLOWED_TAGS = ["p", "br", "strong", "em", "code", "pre", "ul", "ol", "li", "a"];
const ALLOWED_ATTR = ["href", "title", "start"];

// Escape raw HTML tokens at the parser layer so fail-closed does not rely on
// DOMPurify alone (defense in depth for chrome-origin agent replies).
const markedRenderer = new Renderer();
markedRenderer.html = ({ text }) =>
  String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const markedOptions = {
  async: false,
  breaks: true,
  gfm: true,
  renderer: markedRenderer,
};

/**
 * Render agent chat Markdown into a sanitizer-produced DocumentFragment.
 *
 * Empty / nullish input returns `{ ok: false, plainText: "" }` so callers can
 * align with `addChat`'s `if (!text) return` without treating empty as HTML.
 *
 * On any failure, returns `{ ok: false, plainText }` for the plain escaped /
 * textContent path — never an HTML string for innerHTML.
 *
 * @param {string} text
 * @param {{ document: Document, window?: Window }} env
 * @returns {{ ok: true, node: DocumentFragment } | { ok: false, plainText: string }}
 */
export function renderAgentChatMarkdown(text, env) {
  if (text == null || text === "") {
    return { ok: false, plainText: "" };
  }

  const plainText = String(text);
  try {
    const document = env?.document;
    if (!document || typeof document.createElement !== "function") {
      return { ok: false, plainText };
    }
    const win = env.window || document.defaultView;
    if (!win) {
      return { ok: false, plainText };
    }

    const dirty = /** @type {string} */ (marked.parse(plainText, markedOptions));
    const purify = createDOMPurify(/** @type {any} */ (win));
    const fragment = purify.sanitize(dirty, {
      RETURN_DOM_FRAGMENT: true,
      ALLOWED_TAGS,
      ALLOWED_ATTR,
      ALLOW_DATA_ATTR: false,
      FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form", "input", "button", "img", "svg", "math"],
      FORBID_ATTR: ["style", "src", "srcset", "xlink:href"],
    });

    if (!fragment || fragment.nodeType !== 11) {
      return { ok: false, plainText };
    }

    // Fully stripped / empty sanitize output would paint a blank bubble and hide
    // the original reply — fall back to plain text instead of ok:true emptiness.
    if (!hasMeaningfulContent(fragment)) {
      return { ok: false, plainText };
    }

    applyTrustedLinkDefaults(fragment);
    applyTrustedOrderedListStarts(fragment);
    return { ok: true, node: /** @type {DocumentFragment} */ (fragment) };
  } catch {
    return { ok: false, plainText };
  }
}

/**
 * @param {ParentNode} root
 */
function hasMeaningfulContent(root) {
  if ((root.textContent || "").trim()) return true;
  return Boolean(root.querySelector?.("br"));
}

/**
 * @param {ParentNode} root
 */
function applyTrustedLinkDefaults(root) {
  const anchors = root.querySelectorAll?.("a") || [];
  for (const anchor of anchors) {
    const href = anchor.getAttribute("href") || "";
    if (!isAllowedHttpUrl(href)) {
      anchor.removeAttribute("href");
      continue;
    }
    // Never accept attacker-controlled target/rel; always re-apply trusted defaults.
    anchor.setAttribute("href", href);
    anchor.setAttribute("rel", "noopener noreferrer");
    anchor.setAttribute("target", "_blank");
  }
}

/**
 * @param {ParentNode} root
 */
function applyTrustedOrderedListStarts(root) {
  const starts = root.querySelectorAll?.("[start]") || [];
  for (const element of starts) {
    const value = element.getAttribute("start") || "";
    if (element.tagName !== "OL" || !/^-?\d+$/.test(value)) {
      element.removeAttribute("start");
    }
  }
}

/**
 * http(s) absolute URLs only. Rejects relative, protocol-relative, and other schemes.
 * @param {string} href
 */
function isAllowedHttpUrl(href) {
  if (!href || /^\s/.test(href)) return false;
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
