// Render-free check for the one authoring failure that makes a review surface silently
// unusable: an artifact that never paints its own page background, so its text renders
// over whatever surface hosts it (the Lavish chrome, a shared page, a captain's light
// theme) and can be invisible. The check is deliberately fail-open - any stylesheet
// link, @import, Tailwind runtime script, or root paint signal suppresses the warning -
// because a wrong warning here is noise on every open. It must stay a warning:
// never block the open, never auto-repair.

const ROOT_TAG_RE = /<(?:html|body)\b([^>]*)>/gi;
const STYLE_BLOCK_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const CSS_RULE_RE = /([^{}]+)\{([^{}]*)\}/g;
const ROOT_SELECTOR_TOKEN_RE = /(^|[\s,>~+])(html|body|:root|\*)(?![\w-])/i;

export const SELF_PAINT_WARNING =
  "This artifact never paints its own page surface: no background on html/body/:root, no bg-* class or data-theme on html/body, and no stylesheet that could set one. Lavish injects no design system, so text that assumes a dark or light host surface can render invisible. Set an explicit background and readable text.";

/**
 * @param {string} html
 * @returns {{ painted: boolean, signal: string | null }}
 */
export function analyzeSelfPaint(html) {
  const source = typeof html === "string" ? html : "";
  if (/<link\b[^>]*\brel\s*=\s*["']?[^"'>]*stylesheet/i.test(source)) {
    return { painted: true, signal: "stylesheet-link" };
  }
  if (/<script\b[^>]*\bsrc\s*=\s*["']?[^"'>]*tailwind/i.test(source)) {
    return { painted: true, signal: "tailwind-runtime" };
  }
  if (/<meta\b[^>]*\bname\s*=\s*["']?color-scheme/i.test(source)) {
    return { painted: true, signal: "color-scheme" };
  }

  for (const [, attrs] of source.matchAll(ROOT_TAG_RE)) {
    if (/\bdata-theme\s*=/i.test(attrs)) return { painted: true, signal: "data-theme" };
    const className = attrValue(attrs, "class");
    if (className && /(^|[^\w-])bg-/i.test(className)) return { painted: true, signal: "background-class" };
    const style = attrValue(attrs, "style");
    if (style && /background/i.test(style)) return { painted: true, signal: "inline-background" };
    if (style && /color-scheme\s*:/i.test(style)) return { painted: true, signal: "color-scheme" };
  }

  for (const [, css] of source.matchAll(STYLE_BLOCK_RE)) {
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
    if (/@import\b/i.test(stripped)) return { painted: true, signal: "css-import" };
    if (/color-scheme\s*:/i.test(stripped)) return { painted: true, signal: "color-scheme" };
    for (const [, selector, declarations] of stripped.matchAll(CSS_RULE_RE)) {
      if (!/background/i.test(declarations)) continue;
      if (ROOT_SELECTOR_TOKEN_RE.test(selector)) return { painted: true, signal: "root-background-rule" };
    }
  }

  return { painted: false, signal: null };
}

function attrValue(attrs, name) {
  const match = attrs.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}
