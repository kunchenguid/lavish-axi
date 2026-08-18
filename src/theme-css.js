// Reads the custom-property declarations out of the operator theme stylesheet
// (see themeFile in paths.js) so the annotation card - which lives in a shadow
// root inside the sandboxed artifact iframe and can never be reached by
// /chrome.css - can be remapped onto the same tokens the chrome uses.
//
// ONLY custom properties cross that boundary. The operator stylesheet itself is
// never injected into the artifact document: the artifact carries its own theme
// and the two would fight. Everything here is therefore a whitelist - unknown
// syntax is dropped rather than forwarded.

const NAME_RE = /^--[A-Za-z0-9_-]{1,100}$/;
// Selectors an operator theme uses to declare tokens. A token declared on
// anything else is scoped to elements the card does not have, so forwarding it
// would only be misleading.
const ROOT_SELECTORS = new Set([":root", "html", ":host"]);
const MAX_VALUE_LENGTH = 500;
// A var() chain longer than this is a cycle or a mistake; either way, unresolvable.
const MAX_VAR_HOPS = 8;

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

// A value is forwarded verbatim into a `:host{...}` block that the SDK builds, so
// it must not be able to close that block, start an at-rule, or fetch anything.
function isSafeValue(value) {
  if (!value || value.length > MAX_VALUE_LENGTH) return false;
  if (/[{};@<>\\`]/.test(value)) return false;
  if (/\b(?:url|image-set|image|element|expression)\s*\(/i.test(value)) return false;
  let depth = 0;
  for (const char of value) {
    if (char === "(") depth += 1;
    else if (char === ")" && --depth < 0) return false;
  }
  return depth === 0;
}

// Splits a declaration block on top-level semicolons, so a `;` inside parentheses
// (a nested var() fallback, say) does not cut a value in half.
function splitDeclarations(block) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < block.length; i += 1) {
    const char = block[i];
    if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === ";" && depth === 0) {
      parts.push(block.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(block.slice(start));
  return parts;
}

function isRootSelector(selector) {
  return selector
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .some((part) => ROOT_SELECTORS.has(part));
}

/**
 * Collects the custom properties an operator theme declares on :root/html/:host.
 * Later declarations win, matching the cascade the same file gets when it is
 * appended to /chrome.css. At-rules are skipped: a token that only applies under
 * a media query cannot be flattened into a single unconditional block.
 *
 * @param {string} css
 * @returns {Record<string, string>}
 */
export function parseThemeCustomProperties(css) {
  /** @type {Record<string, string>} */
  const tokens = {};
  if (typeof css !== "string" || !css) return tokens;
  const source = stripComments(css);
  let index = 0;
  while (index < source.length) {
    const open = source.indexOf("{", index);
    if (open === -1) break;
    const selector = source.slice(index, open).trim();
    let depth = 1;
    let close = open + 1;
    for (; close < source.length && depth > 0; close += 1) {
      if (source[close] === "{") depth += 1;
      else if (source[close] === "}") depth -= 1;
    }
    const block = source.slice(open + 1, depth === 0 ? close - 1 : source.length);
    index = close;
    if (selector.startsWith("@") || !isRootSelector(selector)) continue;
    for (const declaration of splitDeclarations(block)) {
      const colon = declaration.indexOf(":");
      if (colon === -1) continue;
      const name = declaration.slice(0, colon).trim();
      const value = declaration.slice(colon + 1).trim();
      if (!NAME_RE.test(name) || !isSafeValue(value)) continue;
      tokens[name] = value;
    }
  }
  return tokens;
}

/**
 * Renders parsed tokens back into declarations for a single CSS block.
 *
 * @param {Record<string, string>} tokens
 * @returns {string}
 */
export function serializeCustomProperties(tokens) {
  return Object.entries(tokens || {})
    .map(([name, value]) => `${name}:${value};`)
    .join("");
}

/**
 * Resolves one token to a literal, chasing `var(--other)` references within the
 * same theme. Used where a value must stand alone outside the block that
 * declares the theme's tokens - a var() there would simply dangle. Returns ""
 * when the token is absent or cannot be reduced to a literal.
 *
 * @param {Record<string, string>} tokens
 * @param {string} name
 * @returns {string}
 */
export function resolveCustomProperty(tokens, name) {
  let value = tokens?.[name];
  for (let hop = 0; hop < MAX_VAR_HOPS; hop += 1) {
    if (typeof value !== "string" || !value) return "";
    const reference = /^var\(\s*(--[A-Za-z0-9_-]+)\s*\)$/.exec(value);
    if (!reference) return value.includes("var(") ? "" : value;
    value = tokens[reference[1]];
  }
  return "";
}
