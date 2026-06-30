import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Builds a portable copy of a Lavish artifact by inlining only its LOCAL assets - files on disk
// the artifact references by relative path or file:// URL - as inline <style>/<script> blocks and
// data URIs. Remote references (http(s) CDN/font URLs, protocol-relative URLs, CSS url() pointing
// at the network) are deliberately LEFT AS-IS: the browser loads them at render time, so the export
// and the hosted share render correctly wherever there is network access. Because nothing remote is
// ever fetched, the transform makes no outbound requests (no SSRF) and stays a small, deterministic
// local-file rewrite. The only security surface is local file reading, which is confined to the
// artifact directory (lexically and via real-path/symlink resolution) so a shared bundle can never
// embed a file from outside that directory.

const EXT_MIME = {
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ogg": "video/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".vtt": "text/vtt",
  ".json": "application/json",
  ".txt": "text/plain",
  ".pdf": "application/pdf",
};

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_ASSET_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_BUNDLE_BYTES = 25 * 1024 * 1024;
const REDACTED_FILE_REF = "about:blank";
const HTML_REF_OPTIONS = { decodeHtmlEntities: true };
const HTML_ENTITY_MAP = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: "\u00a0",
  quot: '"',
};
const TAG_ATTRS_PATTERN = String.raw`(?:"[^"]*"|'[^']*'|[^"'>])*`;
const TAG_ATTRS_PATTERN_LAZY = String.raw`(?:"[^"]*"|'[^']*'|[^"'>])*?`;
const RAW_TEXT_OR_COMMENT_RE = new RegExp(
  [
    String.raw`<!--[\s\S]*?-->`,
    rawTextElementPattern("style"),
    rawTextElementPattern("script"),
    rawTextElementPattern("textarea"),
    rawTextElementPattern("title"),
  ].join("|"),
  "gi",
);
const STYLE_SEGMENT_RE = new RegExp(String.raw`^<style(?=\s|\/|>)(${TAG_ATTRS_PATTERN})>([\s\S]*?)<\/style\s*>$`, "i");
const SCRIPT_SEGMENT_RE = new RegExp(
  String.raw`^<script(?=\s|\/|>)(${TAG_ATTRS_PATTERN})>([\s\S]*?)<\/script\s*>$`,
  "i",
);
const MEDIA_TAG_RE = new RegExp(
  String.raw`<(img|source|video|audio|track)(?=\s|\/|>)(${TAG_ATTRS_PATTERN_LAZY})\/?>`,
  "gi",
);
const SVG_REF_TAG_RE = new RegExp(String.raw`<(use|image)(?=\s|\/|>)(${TAG_ATTRS_PATTERN_LAZY})\/?>`, "gi");
const LINK_TAG_RE = new RegExp(String.raw`<link(?=\s|\/|>)(${TAG_ATTRS_PATTERN_LAZY})\/?>`, "gi");
const START_TAG_RE = new RegExp(String.raw`<([a-z][\w:-]*)(?=\s|\/|>)(${TAG_ATTRS_PATTERN_LAZY})\/?>`, "gi");
const MARKUP_TAG_RE = new RegExp(String.raw`<\/?([a-z][\w:-]*)(?=\s|\/|>)(${TAG_ATTRS_PATTERN_LAZY})\/?>`, "gi");
const ATTR_VALUE_RE = /(^|\s)([^\s"'<>/=]+)(\s*=\s*)("[^"]*"|'[^']*'|[^\s"'>]+)/g;

function rawTextElementPattern(tag) {
  return String.raw`<${tag}(?=\s|\/|>)${TAG_ATTRS_PATTERN}>[\s\S]*?<\/${tag}\s*>`;
}

/**
 * @param {string} html
 * @param {object} [options]
 * @param {string} [options.baseDir] Directory to resolve relative references against.
 * @param {(absPath: string, readOptions?: { allowOutsideRoot?: boolean, maxAssetBytes?: number, maxBundleBytes?: number, maxBundleRemaining?: number }) => Promise<Uint8Array>} [options.readLocalFile] Read a local file (default applies the real-path confinement guard).
 * @param {(refPath: string) => (string|null)} [options.resolveAbsolute] Map a root-absolute ref (e.g. /design/x.css) to a local path.
 * @param {string} [options.confineDir] Reject local refs that resolve (lexically or via symlink) outside this directory.
 * @param {number} [options.maxAssetBytes] Per-asset inline cap; larger local files are left as references with a warning.
 * @param {number} [options.maxBundleBytes] Per-bundle inline cap across all inlined local assets.
 * @param {number} [options.maxDepth] Local stylesheet-import recursion guard.
 * @returns {Promise<{ html: string, warnings: Array<{ kind: string, ref: string, reason?: string }> }>}
 */
export async function buildSelfContainedHtml(html, options = {}) {
  const confineDir = options.confineDir ? path.resolve(options.confineDir) : null;
  const ctx = {
    baseDir: options.baseDir || process.cwd(),
    confineDir,
    readLocalFile:
      options.readLocalFile ||
      ((absPath, readOptions = {}) =>
        guardedRead(absPath, readOptions.allowOutsideRoot ? null : confineDir, readOptions)),
    resolveAbsolute: typeof options.resolveAbsolute === "function" ? options.resolveAbsolute : () => null,
    maxAssetBytes: resolveBytes(
      options.maxAssetBytes,
      process.env.LAVISH_AXI_EXPORT_MAX_ASSET_BYTES,
      DEFAULT_MAX_ASSET_BYTES,
    ),
    maxBundleBytes: resolveBytes(
      options.maxBundleBytes,
      process.env.LAVISH_AXI_EXPORT_MAX_BUNDLE_BYTES,
      DEFAULT_MAX_BUNDLE_BYTES,
    ),
    maxDepth: Number.isFinite(options.maxDepth) ? options.maxDepth : DEFAULT_MAX_DEPTH,
    inlinedBytes: 0,
    warnings: /** @type {Array<{ kind: string, ref: string, reason?: string }>} */ ([]),
  };
  const out = await transform(html, ctx);
  return { html: out, warnings: ctx.warnings };
}

/** Derive a portable download name for an exported artifact (report.html -> report.export.html). */
export function exportFileName(file) {
  const base = path.basename(String(file || "artifact.html"));
  const stem = base.replace(/\.html?$/i, "");
  return `${stem || "artifact"}.export.html`;
}

async function transform(html, ctx) {
  const documentBase = resolveDocumentRefBase(html, ctx);
  let result = "";
  let lastIndex = 0;
  for (const match of html.matchAll(RAW_TEXT_OR_COMMENT_RE)) {
    const offset = match.index || 0;
    result += await transformMarkup(html.slice(lastIndex, offset), documentBase, ctx);
    result += await transformRawTextOrComment(match[0], documentBase, ctx);
    lastIndex = offset + match[0].length;
  }
  result += await transformMarkup(html.slice(lastIndex), documentBase, ctx);
  return result;
}

async function transformRawTextOrComment(segment, baseDir, ctx) {
  if (segment.startsWith("<!--")) return segment;
  const style = segment.match(STYLE_SEGMENT_RE);
  if (style) {
    const [, attrs, css] = style;
    return `<style${attrs}>${escapeRawText(await inlineCss(css, baseDir, ctx, 0, baseDir), "style")}</style>`;
  }
  const script = segment.match(SCRIPT_SEGMENT_RE);
  if (script) {
    const [, attrs, body] = script;
    return inlineScript(segment, attrs, body, baseDir, ctx);
  }
  return segment;
}

async function transformMarkup(markup, baseDir, ctx) {
  let result = markup;
  result = await replaceAsync(result, MEDIA_TAG_RE, async (match, tag, attrs) => {
    return formatStartTag(tag, await inlineMediaAttrs(attrs, baseDir, ctx), isSelfClosingTag(match));
  });
  result = await replaceAsync(result, SVG_REF_TAG_RE, async (match, tag, attrs) => {
    let next = await inlineAttr(attrs, "href", baseDir, ctx);
    next = await inlineAttr(next, "xlink:href", baseDir, ctx);
    return formatStartTag(tag, next, isSelfClosingTag(match));
  });
  result = await inlineStyleAttrs(result, baseDir, ctx);
  result = await replaceAsync(result, LINK_TAG_RE, (match, attrs) => inlineLink(match, attrs, baseDir, ctx));
  result = scrubFileUrlAttrs(result, ctx);
  return result;
}

function scrubFileUrlAttrs(markup, ctx) {
  return markup.replace(START_TAG_RE, (match, tag, attrs) => {
    let changed = false;
    const next = attrs.replace(ATTR_VALUE_RE, (attrMatch, boundary, name, eq, raw) => {
      const value = unquoteAttrValue(raw);
      if (!containsFileUrl(value)) return attrMatch;
      changed = true;
      ctx.warnings.push({ kind: "file-url-redacted", ref: value });
      const quote = raw.startsWith("'") ? "'" : '"';
      return `${boundary}${name}${eq}${quoteAttrValuePreservingEntities(REDACTED_FILE_REF, quote)}`;
    });
    return changed ? formatStartTag(tag, next, isSelfClosingTag(match)) : match;
  });
}

async function inlineStyleAttrs(markup, baseDir, ctx) {
  return replaceAsync(markup, START_TAG_RE, async (match, tag, attrs) => {
    if (!/(^|\s)style\s*=/i.test(attrs)) return match;
    const next = await replaceAsync(
      attrs,
      /(^|\s)(style\s*=\s*)("([^"]*)"|'([^']*)'|([^\s"'>]+))/gi,
      async (attrMatch, boundary, prefix, _raw, dq, sq, unquoted) => {
        const quote = sq !== undefined ? "'" : '"';
        const value = dq ?? sq ?? unquoted;
        if (!/url\(/i.test(value)) return attrMatch;
        return `${boundary}${prefix}${quote}${await inlineCssUrls(value, baseDir, ctx, baseDir, HTML_REF_OPTIONS)}${quote}`;
      },
    );
    return formatStartTag(tag, next, isSelfClosingTag(match));
  });
}

async function inlineLink(match, attrs, baseDir, ctx) {
  const rel = (getAttr(attrs, "rel") || "").toLowerCase().split(/\s+/);
  const href = getAttr(attrs, "href");
  if (!href) return match;

  if (rel.includes("stylesheet")) {
    if (isInactiveStylesheet(attrs, rel)) {
      warnInactiveStylesheet(href, baseDir, ctx, HTML_REF_OPTIONS);
      return replaceUnresolvedAttrRef(match, "href", href);
    }
    const loaded = await loadText(href, baseDir, ctx, HTML_REF_OPTIONS);
    if (!loaded) return replaceUnresolvedAttrRef(match, "href", href);
    const css = await inlineCss(loaded.text, loaded.baseDir, ctx, 0, baseDir);
    const media = getAttr(attrs, "media");
    return `<style${media ? ` media="${escapeAttr(media)}"` : ""}>${escapeRawText(css, "style")}</style>`;
  }

  if (rel.some((value) => ["icon", "shortcut", "apple-touch-icon", "mask-icon"].includes(value))) {
    const dataUri = await loadDataUri(href, baseDir, ctx, HTML_REF_OPTIONS);
    if (!dataUri) return replaceUnresolvedAttrRef(match, "href", href);
    return replaceAttrValue(match, "href", dataUri);
  }

  return match;
}

function isInactiveStylesheet(attrs, rel) {
  return hasAttr(attrs, "disabled") || rel.includes("alternate");
}

async function inlineScript(match, attrs, body, baseDir, ctx) {
  const src = getAttr(attrs, "src");
  if (!src) {
    if (isModuleScript(attrs)) warnInlineModuleImports(body, baseDir, ctx);
    return match;
  }
  if (isInjectedLavishSdkSrc(src)) return "";
  if (isModuleScript(attrs)) {
    warnExternalModuleScript(src, baseDir, ctx, HTML_REF_OPTIONS);
    return replaceUnresolvedAttrRef(match, "src", src);
  }
  if (hasAttr(attrs, "defer") || hasAttr(attrs, "async")) {
    warnUnsupportedScriptTiming(src, baseDir, ctx, HTML_REF_OPTIONS);
    return replaceUnresolvedAttrRef(match, "src", src);
  }

  const loaded = await loadText(src, baseDir, ctx, HTML_REF_OPTIONS);
  if (!loaded) return replaceUnresolvedAttrRef(match, "src", src);
  const cleanedAttrs = removeAttrs(attrs, ["src", "integrity", "crossorigin"]);
  return `<script${cleanedAttrs}>${escapeRawText(loaded.text, "script")}</script>`;
}

async function inlineMediaAttrs(attrs, baseDir, ctx) {
  let next = await inlineAttr(attrs, "src", baseDir, ctx);
  next = await inlineAttr(next, "poster", baseDir, ctx);
  next = await inlineSrcset(next, baseDir, ctx);
  return next;
}

async function inlineAttr(attrs, name, baseDir, ctx) {
  const value = getAttr(attrs, name);
  if (!value) return attrs;
  const dataUri = await loadDataUri(value, baseDir, ctx, HTML_REF_OPTIONS);
  if (!dataUri) return replaceUnresolvedAttrRef(attrs, name, value);
  return replaceAttrValue(attrs, name, dataUri);
}

async function inlineSrcset(attrs, baseDir, ctx) {
  const value = getAttr(attrs, "srcset");
  if (!value) return attrs;
  const candidates = parseSrcsetCandidates(value);
  let result = "";
  let lastIndex = 0;
  let changed = false;
  for (const candidate of candidates) {
    result += value.slice(lastIndex, candidate.urlStart);
    const ref = value.slice(candidate.urlStart, candidate.urlEnd);
    if (isInert(decodeHtmlCharacterReferences(ref.trim()))) {
      result += ref;
    } else {
      const dataUri = await loadDataUri(ref, baseDir, ctx, HTML_REF_OPTIONS);
      if (dataUri) {
        changed = true;
        result += dataUri;
      } else if (shouldRedactUnresolvedRef(ref)) {
        changed = true;
        result += REDACTED_FILE_REF;
      } else {
        result += ref;
      }
    }
    lastIndex = candidate.urlEnd;
  }
  result += value.slice(lastIndex);
  return changed ? replaceAttrValuePreservingEntities(attrs, "srcset", result) : attrs;
}

function parseSrcsetCandidates(value) {
  const candidates = [];
  let index = 0;
  while (index < value.length) {
    while (index < value.length && (isHtmlSpace(value[index]) || value[index] === ",")) index += 1;
    if (index >= value.length) break;

    const urlStart = index;
    const dataUrl = value.slice(index, index + "data:".length).toLowerCase() === "data:";
    let sawDataPayloadComma = false;
    while (index < value.length) {
      const char = value[index];
      if (isHtmlSpace(char)) break;
      if (char === ",") {
        if (!dataUrl) break;
        if (!sawDataPayloadComma) {
          sawDataPayloadComma = true;
        } else if (isSrcsetCandidateSeparator(value, index)) {
          break;
        }
      }
      index += 1;
    }
    let urlEnd = index;
    while (urlEnd > urlStart && value[urlEnd - 1] === ",") urlEnd -= 1;
    if (urlEnd > urlStart) candidates.push({ urlStart, urlEnd });

    while (index < value.length && value[index] !== ",") index += 1;
    if (index < value.length && value[index] === ",") index += 1;
  }
  return candidates;
}

function isSrcsetCandidateSeparator(value, commaIndex) {
  let cursor = commaIndex + 1;
  while (cursor < value.length && isHtmlSpace(value[cursor])) cursor += 1;
  return cursor >= value.length || cursor > commaIndex + 1;
}

function isHtmlSpace(char) {
  return /[\t\n\f\r ]/.test(char);
}

async function inlineCss(css, baseDir, ctx, depth, outputBaseDir) {
  const withImports = await inlineCssImports(css, baseDir, ctx, depth, outputBaseDir);
  return inlineCssUrls(withImports, baseDir, ctx, outputBaseDir);
}

async function inlineCssImports(css, baseDir, ctx, depth, outputBaseDir) {
  let result = "";
  let index = 0;
  let pending = [];

  const flushPendingAsExternal = () => {
    for (const item of pending) {
      warnCssImportOrder(item.parsed.ref, item.descriptor, ctx);
      result += rebaseCssImportRule(item.rule, item.parsed, baseDir, outputBaseDir);
    }
    pending = [];
  };

  const flushPendingInline = async () => {
    if (!pending.length) return;
    const prepared = [];
    const startBytes = ctx.inlinedBytes;
    let failed = false;

    for (let pendingIndex = 0; pendingIndex < pending.length; pendingIndex += 1) {
      const item = pending[pendingIndex];
      const loaded = await loadTextFromDescriptor(item.descriptor, item.parsed.ref, ctx);
      prepared.push({ ...item, loaded });
      if (!loaded) {
        failed = true;
        for (const remaining of pending.slice(pendingIndex + 1)) {
          prepared.push({ ...remaining, loaded: null, skipped: true });
        }
        break;
      }
    }

    if (!failed) {
      for (const item of prepared) {
        const inner = await inlineCss(item.loaded.text, item.loaded.baseDir, ctx, depth + 1, outputBaseDir);
        result += item.parsed.media ? `@media ${item.parsed.media}{${inner}}` : inner;
      }
    } else {
      ctx.inlinedBytes = startBytes;
      for (const item of prepared) {
        if (item.loaded || item.skipped) warnCssImportOrder(item.parsed.ref, item.descriptor, ctx);
        result += rebaseCssImportRule(item.rule, item.parsed, baseDir, outputBaseDir);
      }
    }
    pending = [];
  };

  while (index < css.length) {
    const commentEnd = css.startsWith("/*", index) ? findCssCommentEnd(css, index) : -1;
    if (commentEnd !== -1) {
      result += css.slice(index, commentEnd);
      index = commentEnd;
      continue;
    }

    if (/\s/.test(css[index])) {
      result += css[index];
      index += 1;
      continue;
    }

    if (css[index] === '"' || css[index] === "'") {
      await flushPendingInline();
      const stringEnd = findCssStringEnd(css, index);
      result += css.slice(index, stringEnd);
      index = stringEnd;
      continue;
    }

    if (startsCssKeyword(css, index, "@import")) {
      const ruleEnd = findCssAtRuleEnd(css, index);
      if (ruleEnd === -1) {
        result += css.slice(index);
        break;
      }
      const rule = css.slice(index, ruleEnd + 1);
      const parsed = parseCssImportRule(rule);
      if (!parsed) {
        flushPendingAsExternal();
        result += rule;
      } else if (depth >= ctx.maxDepth) {
        flushPendingAsExternal();
        warnCssImportDepth(parsed.ref, baseDir, ctx);
        result += rebaseCssImportRule(rule, parsed, baseDir, outputBaseDir);
      } else if (parsed.media && !isPlainCssMediaQueryList(parsed.media)) {
        flushPendingAsExternal();
        warnUnsupportedCssImport(parsed.ref, baseDir, ctx, parsed.media);
        result += rebaseCssImportRule(rule, parsed, baseDir, outputBaseDir);
      } else {
        const descriptor = resolveRef(parsed.ref, baseDir, ctx);
        if (descriptor.kind !== "file") {
          flushPendingAsExternal();
          if (descriptor.kind === "escape") ctx.warnings.push({ kind: "outside-root", ref: parsed.ref });
          result += rebaseCssImportRule(rule, parsed, baseDir, outputBaseDir);
        } else {
          pending.push({ rule, parsed, descriptor });
        }
      }
      index = ruleEnd + 1;
      continue;
    }

    await flushPendingInline();
    result += css[index];
    index += 1;
  }
  await flushPendingInline();
  return result;
}

async function inlineCssUrls(css, baseDir, ctx, outputBaseDir, options = {}) {
  let result = "";
  let index = 0;
  while (index < css.length) {
    const commentEnd = css.startsWith("/*", index) ? findCssCommentEnd(css, index) : -1;
    if (commentEnd !== -1) {
      result += css.slice(index, commentEnd);
      index = commentEnd;
      continue;
    }

    if (css[index] === '"' || css[index] === "'") {
      const stringEnd = findCssStringEnd(css, index);
      result += css.slice(index, stringEnd);
      index = stringEnd;
      continue;
    }

    if (startsCssKeyword(css, index, "@import")) {
      const ruleEnd = findCssAtRuleEnd(css, index);
      if (ruleEnd === -1) {
        result += css.slice(index);
        break;
      }
      result += css.slice(index, ruleEnd + 1);
      index = ruleEnd + 1;
      continue;
    }

    const token = parseCssUrlToken(css, index);
    if (!token) {
      result += css[index];
      index += 1;
      continue;
    }

    const trimmed = token.ref.trim();
    const refForResolution = options.decodeHtmlEntities ? decodeHtmlCharacterReferences(trimmed) : trimmed;
    if (isInert(refForResolution)) {
      result += token.raw;
      index = token.end;
      continue;
    }
    const dataUri = await loadDataUri(trimmed, baseDir, ctx, options);
    result += dataUri
      ? `url(${token.quote}${dataUri}${token.quote})`
      : rebaseCssUrlToken(token, baseDir, outputBaseDir);
    index = token.end;
  }
  return result;
}

function rebaseCssUrlToken(token, baseDir, outputBaseDir) {
  if (shouldRedactUnresolvedRef(token.ref)) return `url(${token.quote}${REDACTED_FILE_REF}${token.quote})`;
  const rebased = rebaseLocalCssRef(token.ref, baseDir, outputBaseDir);
  return rebased ? `url(${token.quote}${rebased}${token.quote})` : token.raw;
}

function rebaseCssImportRule(rule, parsed, baseDir, outputBaseDir) {
  if (shouldRedactUnresolvedRef(parsed.ref)) {
    return `${rule.slice(0, parsed.refStart)}${REDACTED_FILE_REF}${rule.slice(parsed.refEnd)}`;
  }
  const rebased = rebaseLocalCssRef(parsed.ref, baseDir, outputBaseDir);
  if (!rebased) return rule;
  return `${rule.slice(0, parsed.refStart)}${rebased}${rule.slice(parsed.refEnd)}`;
}

function rebaseLocalCssRef(ref, baseDir, outputBaseDir) {
  const trimmed = String(ref || "").trim();
  const base = normalizeRefBase(baseDir);
  const outputBase = normalizeRefBase(outputBaseDir);
  if (base.kind !== "local" || outputBase.kind !== "local") return "";
  if (path.resolve(base.dir) === path.resolve(outputBase.dir)) return "";
  if (!isRelativeLocalRef(trimmed)) return "";
  const { pathPart, suffix } = splitRefSuffix(trimmed);
  if (!pathPart) return "";
  const absPath = path.resolve(base.dir, decodeLocalPath(pathPart));
  const relative = path.relative(path.resolve(outputBase.dir), absPath);
  if (!relative || path.isAbsolute(relative)) return "";
  return `${encodeRelativeRef(relative.split(path.sep).join("/"))}${suffix}`;
}

function isRelativeLocalRef(ref) {
  if (isInert(ref)) return false;
  if (ref.startsWith("/") || ref.startsWith("//") || /^https?:\/\//i.test(ref)) return false;
  return !/^[a-z][a-z0-9+.-]*:/i.test(ref);
}

function splitRefSuffix(ref) {
  const match = String(ref).match(/^([^?#]*)(.*)$/s);
  return { pathPart: match ? match[1] : ref, suffix: match ? match[2] : "" };
}

function encodeRelativeRef(ref) {
  return String(ref)
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function parseCssImportRule(rule) {
  let index = "@import".length;
  index = skipCssWhitespaceAndComments(rule, index);
  let ref;
  let refStart;
  let refEnd;
  if (startsCssKeyword(rule, index, "url")) {
    const token = parseCssUrlToken(rule, index);
    if (!token) return null;
    ref = token.ref.trim();
    refStart = token.refStart;
    refEnd = token.refEnd;
    index = token.end;
  } else if (rule[index] === '"' || rule[index] === "'") {
    refStart = index + 1;
    const token = parseCssString(rule, index);
    ref = token.value;
    refEnd = token.end - 1;
    index = token.end;
  } else {
    return null;
  }
  const semicolon = rule.lastIndexOf(";");
  if (semicolon === -1) return null;
  const media = rule.slice(skipCssWhitespaceAndComments(rule, index), semicolon).trim();
  return { ref, media, refStart, refEnd };
}

function parseCssUrlToken(css, index) {
  if (!startsCssKeyword(css, index, "url") || css[index + 3] !== "(") return null;
  let cursor = skipCssWhitespace(css, index + 4);
  let quote = "";
  let ref;
  let refStart;
  let refEnd;
  if (css[cursor] === '"' || css[cursor] === "'") {
    refStart = cursor + 1;
    const token = parseCssString(css, cursor);
    quote = css[cursor];
    ref = token.value;
    refEnd = token.end - 1;
    cursor = skipCssWhitespace(css, token.end);
    if (css[cursor] !== ")") return null;
    cursor += 1;
  } else {
    const start = cursor;
    while (cursor < css.length && css[cursor] !== ")") {
      if (css[cursor] === '"' || css[cursor] === "'") return null;
      cursor += css[cursor] === "\\" ? 2 : 1;
    }
    if (css[cursor] !== ")") return null;
    ref = css.slice(start, cursor);
    refStart = start;
    refEnd = cursor;
    cursor += 1;
  }
  return { raw: css.slice(index, cursor), ref, quote, end: cursor, refStart, refEnd };
}

function parseCssString(css, index) {
  const quote = css[index];
  let cursor = index + 1;
  let value = "";
  while (cursor < css.length) {
    const char = css[cursor];
    if (char === "\\") {
      value += css.slice(cursor, Math.min(cursor + 2, css.length));
      cursor += 2;
      continue;
    }
    if (char === quote) {
      return { value, end: cursor + 1 };
    }
    value += char;
    cursor += 1;
  }
  return { value, end: css.length };
}

function findCssStringEnd(css, index) {
  return parseCssString(css, index).end;
}

function findCssCommentEnd(css, index) {
  const end = css.indexOf("*/", index + 2);
  return end === -1 ? css.length : end + 2;
}

function findCssAtRuleEnd(css, index) {
  let cursor = index;
  while (cursor < css.length) {
    if (css.startsWith("/*", cursor)) {
      cursor = findCssCommentEnd(css, cursor);
      continue;
    }
    if (css[cursor] === '"' || css[cursor] === "'") {
      cursor = findCssStringEnd(css, cursor);
      continue;
    }
    if (css[cursor] === ";") return cursor;
    cursor += 1;
  }
  return -1;
}

function skipCssWhitespace(css, index) {
  let cursor = index;
  while (cursor < css.length && /\s/.test(css[cursor])) cursor += 1;
  return cursor;
}

function skipCssWhitespaceAndComments(css, index) {
  let cursor = index;
  while (cursor < css.length) {
    const next = skipCssWhitespace(css, cursor);
    if (!css.startsWith("/*", next)) return next;
    cursor = findCssCommentEnd(css, next);
  }
  return cursor;
}

function startsCssKeyword(css, index, keyword) {
  if (css.slice(index, index + keyword.length).toLowerCase() !== keyword.toLowerCase()) return false;
  const before = css[index - 1] || "";
  const after = css[index + keyword.length] || "";
  return !isCssIdentChar(before) && !isCssIdentChar(after);
}

function isPlainCssMediaQueryList(tail) {
  return !startsUnsupportedCssImportTail(tail);
}

function startsUnsupportedCssImportTail(tail) {
  const index = skipCssWhitespaceAndComments(tail, 0);
  if (!isCssIdentChar(tail[index])) return false;
  let cursor = index;
  while (cursor < tail.length && isCssIdentChar(tail[cursor])) cursor += 1;
  const ident = tail.slice(index, cursor).toLowerCase();
  const afterIdent = skipCssWhitespaceAndComments(tail, cursor);
  if (ident === "layer" && afterIdent >= tail.length) return true;
  return tail[cursor] === "(" && (ident === "layer" || ident === "supports" || cursor > index);
}

function isCssIdentChar(char) {
  return Boolean(char) && /[a-z0-9_-]/i.test(char);
}

// --- resolution + loading ---------------------------------------------------

function resolveDocumentRefBase(html, ctx) {
  const href = findFirstDocumentBaseHref(html);
  if (!href) return localRefBase(ctx.baseDir);
  return refBaseFromHref(href, ctx.baseDir);
}

function findFirstDocumentBaseHref(html) {
  let lastIndex = 0;
  let templateDepth = 0;
  for (const match of html.matchAll(RAW_TEXT_OR_COMMENT_RE)) {
    const scanned = scanMarkupForBaseHref(html.slice(lastIndex, match.index || 0), templateDepth);
    if (scanned.href !== null) return scanned.href;
    templateDepth = scanned.templateDepth;
    lastIndex = (match.index || 0) + match[0].length;
  }
  const scanned = scanMarkupForBaseHref(html.slice(lastIndex), templateDepth);
  return scanned.href;
}

function scanMarkupForBaseHref(markup, templateDepth) {
  let depth = templateDepth;
  for (const match of markup.matchAll(MARKUP_TAG_RE)) {
    const tag = match[1].toLowerCase();
    const isClose = /^<\//.test(match[0]);
    if (tag === "template") {
      if (isClose) {
        depth = Math.max(0, depth - 1);
      } else if (!/\/\s*>$/.test(match[0])) {
        depth += 1;
      }
      continue;
    }
    if (!isClose && depth === 0 && tag === "base") {
      const href = getAttr(match[2], "href");
      if (href) return { href, templateDepth: depth };
    }
  }
  return { href: null, templateDepth: depth };
}

function refBaseFromHref(href, documentDir) {
  const trimmed = decodeHtmlCharacterReferences(String(href || "").trim());
  if (!trimmed || isInert(trimmed)) return localRefBase(documentDir);
  if (trimmed.startsWith("//") || /^https?:\/\//i.test(trimmed)) return { kind: "remote" };
  if (/^file:\/\//i.test(trimmed)) {
    try {
      const fileHref = stripQueryAndHash(trimmed);
      return localRefBase(directoryFromBasePath(fileURLToPath(fileHref), fileHref));
    } catch {
      return { kind: "remote" };
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return { kind: "remote" };
  const { pathPart } = splitRefSuffix(trimmed);
  if (!pathPart) return localRefBase(documentDir);
  if (trimmed.startsWith("/")) return { kind: "root", path: rootDirectoryFromBasePath(pathPart) };
  return localRefBase(directoryFromBasePath(path.resolve(documentDir, decodeLocalPath(pathPart)), pathPart));
}

function directoryFromBasePath(absPath, ref) {
  const value = String(ref || "");
  return value.endsWith("/") ? absPath : path.dirname(absPath);
}

function rootDirectoryFromBasePath(ref) {
  const decoded = decodeLocalPath(ref);
  if (!decoded || decoded === "/") return "/";
  const normalized = path.posix.normalize(decoded);
  const directory = decoded.endsWith("/") ? normalized : path.posix.dirname(normalized);
  return directory.endsWith("/") ? directory : `${directory}/`;
}

function localRefBase(dir) {
  return { kind: "local", dir: path.resolve(dir) };
}

function normalizeRefBase(base) {
  if (base && typeof base === "object" && typeof base.kind === "string") return base;
  return localRefBase(base);
}

function rootRelativeRef(basePath, ref) {
  const { pathPart, suffix } = splitRefSuffix(ref);
  const joined = path.posix.normalize(path.posix.join(basePath, decodeLocalPath(pathPart)));
  return `${joined.startsWith("/") ? joined : `/${joined}`}${suffix}`;
}

// Classify a reference. Remote and unsupported-scheme refs resolve to `skip`, meaning "leave the
// reference exactly as written" - they are not fetched. Only local refs become `file`.
function resolveRef(ref, baseDir, ctx, options = {}) {
  const trimmed = normalizeRefForResolution(ref, options).trim();
  const base = normalizeRefBase(baseDir);
  if (isInert(trimmed)) return { kind: "skip" };

  // Remote: http(s) and protocol-relative URLs are left as references for the browser to load.
  if (trimmed.startsWith("//") || /^https?:\/\//i.test(trimmed)) return { kind: "skip" };

  // Local file:// URLs are inlined like any other local asset, subject to the confinement guard.
  if (/^file:\/\//i.test(trimmed)) {
    try {
      const resolved = fileURLToPath(trimmed.replace(/#.*$/, ""));
      if (ctx.confineDir && isOutside(ctx.confineDir, resolved)) return { kind: "escape", path: resolved };
      return { kind: "file", path: resolved };
    } catch {
      return { kind: "skip" };
    }
  }

  // Any other explicit scheme (ftp:, ws:, custom:) is left as a reference.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return { kind: "skip" };

  if (base.kind === "remote") return { kind: "skip" };
  const effectiveRef = base.kind === "root" && !trimmed.startsWith("/") ? rootRelativeRef(base.path, trimmed) : trimmed;
  const localPath = decodeLocalPath(stripQueryAndHash(effectiveRef));
  if (effectiveRef.startsWith("/")) {
    const mapped = ctx.resolveAbsolute(localPath);
    return mapped ? { kind: "file", path: mapped, allowOutsideRoot: true } : { kind: "skip" };
  }
  const resolved = path.resolve(base.dir, localPath);
  if (ctx.confineDir && isOutside(ctx.confineDir, resolved)) return { kind: "escape", path: resolved };
  return { kind: "file", path: resolved };
}

async function loadText(ref, baseDir, ctx, options = {}) {
  const descriptor = resolveRef(ref, baseDir, ctx, options);
  return loadTextFromDescriptor(descriptor, ref, ctx);
}

async function loadTextFromDescriptor(descriptor, ref, ctx, options = {}) {
  if (descriptor.kind !== "file") {
    if (descriptor.kind === "escape") ctx.warnings.push({ kind: "outside-root", ref });
    return null;
  }
  const buffer = await readBudgeted(descriptor, ref, ctx, options);
  if (!buffer) return null;
  return { text: buffer.toString("utf8"), baseDir: path.dirname(descriptor.path), byteLength: buffer.length };
}

async function loadDataUri(ref, baseDir, ctx, options = {}) {
  const descriptor = resolveRef(ref, baseDir, ctx, options);
  if (descriptor.kind !== "file") {
    if (descriptor.kind === "escape") ctx.warnings.push({ kind: "outside-root", ref });
    return null;
  }
  const buffer = await readBudgeted(descriptor, ref, ctx);
  if (!buffer) return null;
  const mime = pickMime(descriptor.path);
  return `${toDataUri(buffer, mime)}${mime === "image/svg+xml" ? fragmentSuffix(normalizeRefForResolution(ref, options)) : ""}`;
}

function warnUnsupportedScriptTiming(ref, baseDir, ctx, options = {}) {
  const descriptor = resolveRef(ref, baseDir, ctx, options);
  if (descriptor.kind === "file") {
    ctx.warnings.push({
      kind: "unsupported-script-timing",
      ref,
      reason: "defer and async scripts are left as references to preserve execution timing",
    });
  } else if (descriptor.kind === "escape") {
    ctx.warnings.push({ kind: "outside-root", ref });
  }
}

function warnInactiveStylesheet(ref, baseDir, ctx, options = {}) {
  const descriptor = resolveRef(ref, baseDir, ctx, options);
  if (descriptor.kind === "file") {
    ctx.warnings.push({
      kind: "inactive-stylesheet",
      ref,
      reason: "inactive stylesheet links are left as references to preserve disabled or alternate state",
    });
  } else if (descriptor.kind === "escape") {
    ctx.warnings.push({ kind: "outside-root", ref });
  }
}

function warnExternalModuleScript(ref, baseDir, ctx, options = {}) {
  const descriptor = resolveRef(ref, baseDir, ctx, options);
  if (descriptor.kind === "file") {
    ctx.warnings.push({
      kind: "module-external",
      ref,
      reason: "module scripts are left as references to preserve relative imports",
    });
  } else if (descriptor.kind === "escape") {
    ctx.warnings.push({ kind: "outside-root", ref });
  }
}

function warnInlineModuleImports(body, baseDir, ctx) {
  for (const ref of findInlineModuleImportRefs(body)) {
    if (!isRelativeModuleImport(ref)) continue;
    warnInlineModuleImport(ref, baseDir, ctx);
  }
}

function warnInlineModuleImport(ref, baseDir, ctx) {
  const descriptor = resolveRef(ref, baseDir, ctx);
  if (descriptor.kind === "file") {
    ctx.warnings.push({
      kind: "inline-module-import",
      ref,
      reason: "inline module imports are left as references",
    });
  } else if (descriptor.kind === "escape") {
    ctx.warnings.push({ kind: "outside-root", ref });
  }
}

function warnUnsupportedCssImport(ref, baseDir, ctx, tail) {
  const descriptor = resolveRef(ref, baseDir, ctx);
  if (descriptor.kind === "file") {
    ctx.warnings.push({
      kind: "unsupported-css-import",
      ref,
      reason: `CSS @import tail is left unchanged: ${tail}`,
    });
  } else if (descriptor.kind === "escape") {
    ctx.warnings.push({ kind: "outside-root", ref });
  }
}

function warnCssImportDepth(ref, baseDir, ctx) {
  const descriptor = resolveRef(ref, baseDir, ctx);
  if (descriptor.kind === "file") {
    ctx.warnings.push({
      kind: "css-import-depth",
      ref,
      reason: `CSS @import recursion reached max depth ${ctx.maxDepth}`,
    });
  } else if (descriptor.kind === "escape") {
    ctx.warnings.push({ kind: "outside-root", ref });
  }
}

function warnCssImportOrder(ref, descriptor, ctx) {
  if (descriptor.kind === "file") {
    ctx.warnings.push({
      kind: "css-import-order",
      ref,
      reason: "CSS @import is left as a reference to preserve import ordering",
    });
  } else if (descriptor.kind === "escape") {
    ctx.warnings.push({ kind: "outside-root", ref });
  }
}

function isModuleScript(attrs) {
  return getAttr(attrs, "type").trim().toLowerCase() === "module";
}

function findInlineModuleImportRefs(source) {
  const refs = [];
  let index = 0;
  while (index < source.length) {
    const skipped = skipJsIgnored(source, index);
    if (skipped !== index) {
      index = skipped;
      continue;
    }
    if (startsJsKeyword(source, index, "import")) {
      const parsed = parseJsImport(source, index);
      refs.push(...parsed.refs);
      index = Math.max(parsed.end, index + "import".length);
      continue;
    }
    if (startsJsKeyword(source, index, "export")) {
      const parsed = parseJsExport(source, index);
      refs.push(...parsed.refs);
      index = Math.max(parsed.end, index + "export".length);
      continue;
    }
    index += 1;
  }
  return refs;
}

function parseJsImport(source, index) {
  let cursor = skipJsWhitespaceAndComments(source, index + "import".length);
  if (source[cursor] === ".") return { refs: [], end: cursor + 1 };
  if (source[cursor] === "(") {
    cursor = skipJsWhitespaceAndComments(source, cursor + 1);
    if (source[cursor] !== '"' && source[cursor] !== "'") return { refs: [], end: cursor + 1 };
    const token = parseJsString(source, cursor);
    return { refs: [token.value], end: token.end };
  }
  if (source[cursor] === '"' || source[cursor] === "'") {
    const token = parseJsString(source, cursor);
    return { refs: [token.value], end: token.end };
  }
  const found = findJsImportFromRef(source, cursor);
  return { refs: found.ref ? [found.ref] : [], end: found.end };
}

function parseJsExport(source, index) {
  const cursor = skipJsWhitespaceAndComments(source, index + "export".length);
  const found = findJsImportFromRef(source, cursor);
  return { refs: found.ref ? [found.ref] : [], end: found.end };
}

function findJsImportFromRef(source, index) {
  let cursor = index;
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  while (cursor < source.length) {
    const skipped = skipJsIgnored(source, cursor);
    if (skipped !== cursor) {
      cursor = skipped;
      continue;
    }
    if (source[cursor] === "{") braceDepth += 1;
    if (source[cursor] === "}") braceDepth = Math.max(0, braceDepth - 1);
    if (source[cursor] === "[") bracketDepth += 1;
    if (source[cursor] === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    if (source[cursor] === "(") parenDepth += 1;
    if (source[cursor] === ")") parenDepth = Math.max(0, parenDepth - 1);
    const topLevel = braceDepth === 0 && bracketDepth === 0 && parenDepth === 0;
    if (topLevel && source[cursor] === ";") return { ref: "", end: cursor + 1 };
    if (
      topLevel &&
      cursor !== index &&
      (startsJsKeyword(source, cursor, "import") || startsJsKeyword(source, cursor, "export"))
    ) {
      return { ref: "", end: cursor };
    }
    if (topLevel && startsJsKeyword(source, cursor, "from")) {
      const refStart = skipJsWhitespaceAndComments(source, cursor + "from".length);
      if (source[refStart] === '"' || source[refStart] === "'") {
        const token = parseJsString(source, refStart);
        return { ref: token.value, end: token.end };
      }
    }
    cursor += 1;
  }
  return { ref: "", end: cursor };
}

function isRelativeModuleImport(ref) {
  return /^\.{1,2}\//.test(String(ref || "").trim());
}

function skipJsWhitespaceAndComments(source, index) {
  let cursor = index;
  while (cursor < source.length) {
    while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
    if (source.startsWith("//", cursor)) {
      const next = source.indexOf("\n", cursor + 2);
      cursor = next === -1 ? source.length : next + 1;
      continue;
    }
    if (source.startsWith("/*", cursor)) {
      const next = source.indexOf("*/", cursor + 2);
      cursor = next === -1 ? source.length : next + 2;
      continue;
    }
    break;
  }
  return cursor;
}

function skipJsIgnored(source, index) {
  if (source.startsWith("//", index)) {
    const next = source.indexOf("\n", index + 2);
    return next === -1 ? source.length : next + 1;
  }
  if (source.startsWith("/*", index)) {
    const next = source.indexOf("*/", index + 2);
    return next === -1 ? source.length : next + 2;
  }
  if (source[index] === "/" && isLikelyJsRegexStart(source, index)) return skipJsRegex(source, index);
  if (source[index] === '"' || source[index] === "'") return parseJsString(source, index).end;
  if (source[index] === "`") return skipJsTemplate(source, index);
  return index;
}

function parseJsString(source, index) {
  const quote = source[index];
  let cursor = index + 1;
  let value = "";
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === "\\") {
      value += source.slice(cursor, Math.min(cursor + 2, source.length));
      cursor += 2;
      continue;
    }
    if (char === quote) return { value, end: cursor + 1 };
    value += char;
    cursor += 1;
  }
  return { value, end: source.length };
}

function skipJsTemplate(source, index) {
  let cursor = index + 1;
  while (cursor < source.length) {
    if (source[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (source[cursor] === "`") return cursor + 1;
    cursor += 1;
  }
  return source.length;
}

function isLikelyJsRegexStart(source, index) {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/.test(source[cursor])) cursor -= 1;
  if (cursor < 0) return true;
  return /[([{=:;,!?&|+\-*~^<>%]/.test(source[cursor]);
}

function skipJsRegex(source, index) {
  let cursor = index + 1;
  let inClass = false;
  while (cursor < source.length) {
    if (source[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (source[cursor] === "[") inClass = true;
    if (source[cursor] === "]") inClass = false;
    if (source[cursor] === "/" && !inClass) {
      cursor += 1;
      while (cursor < source.length && /[a-z]/i.test(source[cursor])) cursor += 1;
      return cursor;
    }
    cursor += 1;
  }
  return source.length;
}

function startsJsKeyword(source, index, keyword) {
  if (source.slice(index, index + keyword.length) !== keyword) return false;
  const before = source[index - 1] || "";
  const after = source[index + keyword.length] || "";
  return !isJsIdentChar(before) && !isJsIdentChar(after);
}

function isJsIdentChar(char) {
  return Boolean(char) && /[a-z0-9_$]/i.test(char);
}

// Read a local file, enforcing per-asset and per-bundle size caps so a huge local asset cannot
// blow up memory or the bundle. The real-path confinement guard lives in the default readLocalFile.
async function readBudgeted(descriptor, ref, ctx, options = {}) {
  const countBytes = options.countBytes !== false;
  const remainingBundleBytes = ctx.maxBundleBytes - ctx.inlinedBytes;
  if (remainingBundleBytes <= 0) {
    ctx.warnings.push({ kind: "too-large", ref, reason: `would exceed per-bundle cap ${ctx.maxBundleBytes}` });
    return null;
  }
  let buffer;
  try {
    buffer = toBuffer(
      await ctx.readLocalFile(descriptor.path, {
        allowOutsideRoot: Boolean(descriptor.allowOutsideRoot),
        maxAssetBytes: ctx.maxAssetBytes,
        maxBundleBytes: ctx.maxBundleBytes,
        maxBundleRemaining: remainingBundleBytes,
      }),
    );
  } catch (error) {
    if (error && error.code === "OUTSIDE_ROOT") {
      ctx.warnings.push({ kind: "outside-root", ref });
    } else if (error && error.code === "TOO_LARGE") {
      ctx.warnings.push({ kind: "too-large", ref, reason: error instanceof Error ? error.message : String(error) });
    } else {
      ctx.warnings.push({ kind: "load-failed", ref, reason: error instanceof Error ? error.message : String(error) });
    }
    return null;
  }
  if (buffer.length > ctx.maxAssetBytes) {
    ctx.warnings.push({
      kind: "too-large",
      ref,
      reason: `${buffer.length} bytes exceeds per-asset cap ${ctx.maxAssetBytes}`,
    });
    return null;
  }
  if (countBytes && ctx.inlinedBytes + buffer.length > ctx.maxBundleBytes) {
    ctx.warnings.push({ kind: "too-large", ref, reason: `would exceed per-bundle cap ${ctx.maxBundleBytes}` });
    return null;
  }
  if (countBytes) ctx.inlinedBytes += buffer.length;
  return buffer;
}

// Default local read: resolve the real (symlink-followed) path and refuse to read anything that
// escapes the artifact directory, so a symlink inside the directory cannot exfiltrate an outside
// file (e.g. ~/.ssh/id_rsa) into an exported or publicly shared bundle.
async function guardedRead(absPath, confineDir, readOptions = {}) {
  const real = await realpath(absPath);
  if (confineDir) {
    let root;
    try {
      root = await realpath(confineDir);
    } catch {
      root = path.resolve(confineDir);
    }
    if (isOutside(root, real)) {
      throw Object.assign(new Error(`refusing to read ${absPath} outside the artifact directory`), {
        code: "OUTSIDE_ROOT",
      });
    }
  }
  const stats = await stat(real);
  if (Number.isFinite(readOptions.maxAssetBytes) && stats.size > readOptions.maxAssetBytes) {
    throw Object.assign(new Error(`${stats.size} bytes exceeds per-asset cap ${readOptions.maxAssetBytes}`), {
      code: "TOO_LARGE",
    });
  }
  if (Number.isFinite(readOptions.maxBundleRemaining) && stats.size > readOptions.maxBundleRemaining) {
    throw Object.assign(new Error(`would exceed per-bundle cap ${readOptions.maxBundleBytes}`), {
      code: "TOO_LARGE",
    });
  }
  return readFile(real);
}

// --- helpers ----------------------------------------------------------------

function isInert(ref) {
  // `#a` and its percent-encoded form `%23a` are in-document fragment references (e.g. SVG
  // filter/mask ids), not fetchable resources, so leave them untouched.
  return !ref || ref.startsWith("#") || /^%23/i.test(ref) || /^(data|blob|about|javascript|mailto|tel):/i.test(ref);
}

function shouldRedactUnresolvedRef(ref) {
  const value = String(ref || "").trim();
  return /^file:\/\//i.test(value) || /^file:\/\//i.test(decodeHtmlCharacterReferences(value));
}

function containsFileUrl(ref) {
  const value = String(ref || "");
  return /file:\/\//i.test(value) || /file:\/\//i.test(decodeHtmlCharacterReferences(value));
}

function replaceUnresolvedAttrRef(source, name, ref) {
  return shouldRedactUnresolvedRef(ref) ? replaceAttrValue(source, name, REDACTED_FILE_REF) : source;
}

function isInjectedLavishSdkSrc(src) {
  const value = String(src || "").trim();
  if (!value.startsWith("/sdk.js?")) return false;
  const params = new URLSearchParams(value.slice("/sdk.js?".length));
  return params.has("key");
}

function isOutside(root, target) {
  const relative = path.relative(root, target);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function stripQueryAndHash(ref) {
  return ref.replace(/[?#].*$/, "");
}

function fragmentSuffix(ref) {
  const value = String(ref).trim();
  const hashIndex = value.indexOf("#");
  return hashIndex === -1 ? "" : value.slice(hashIndex);
}

function normalizeRefForResolution(ref, options = {}) {
  const value = String(ref);
  return options.decodeHtmlEntities ? decodeHtmlCharacterReferences(value) : value;
}

function decodeHtmlCharacterReferences(value) {
  return String(value).replace(/&(#(\d+)|#x([\da-f]+)|[a-z]+);/gi, (match, entity, decimal, hex) => {
    if (decimal) return decodeNumericCharacterReference(Number.parseInt(decimal, 10), match);
    if (hex) return decodeNumericCharacterReference(Number.parseInt(hex, 16), match);
    return HTML_ENTITY_MAP[entity.toLowerCase()] ?? match;
  });
}

function decodeNumericCharacterReference(codePoint, fallback) {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return fallback;
  }
}

function decodeLocalPath(ref) {
  return String(ref)
    .split("/")
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    })
    .join("/");
}

function pickMime(locator) {
  const ext = path.extname(stripQueryAndHash(locator)).toLowerCase();
  return EXT_MIME[ext] || "application/octet-stream";
}

function toDataUri(buffer, mime) {
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return Buffer.from(value);
}

function isSelfClosingTag(tag) {
  return /\/\s*>$/.test(tag);
}

function formatStartTag(tag, attrs, selfClosing) {
  if (selfClosing) return `<${tag}${String(attrs).replace(/\s+$/, "")} />`;
  return `<${tag}${attrs}>`;
}

// Break the closing tag of raw-text content (script/style) so inlined text containing `</script>`
// or `</style>` cannot terminate the element early. The escape (`<\/script`) is valid inside the
// JS/CSS string where such a token can legitimately appear.
function escapeRawText(text, tag) {
  return String(text).replace(new RegExp(`</(${tag})`, "gi"), "<\\/$1");
}

function getAttr(attrs, name) {
  const match = String(attrs).match(
    new RegExp(`(?:^|\\s)${escapeRegExp(name)}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i"),
  );
  if (!match) return "";
  return match[2] ?? match[3] ?? match[4] ?? "";
}

function hasAttr(attrs, name) {
  return new RegExp(`(?:^|\\s)${escapeRegExp(name)}(?:\\s*=|(?=\\s|$))`, "i").test(String(attrs));
}

function replaceAttrValue(source, name, value) {
  const re = new RegExp(`(^|\\s)(${escapeRegExp(name)}\\s*=\\s*)("[^"]*"|'[^']*'|[^\\s"'>]+)`, "i");
  return source.replace(re, `$1$2"${escapeAttr(value)}"`);
}

function replaceAttrValuePreservingEntities(source, name, value) {
  const re = new RegExp(`(^|\\s)(${escapeRegExp(name)}\\s*=\\s*)("[^"]*"|'[^']*'|[^\\s"'>]+)`, "i");
  return source.replace(re, (match, boundary, prefix, raw) => {
    const preferredQuote = raw.startsWith("'") ? "'" : '"';
    return `${boundary}${prefix}${quoteAttrValuePreservingEntities(value, preferredQuote)}`;
  });
}

function unquoteAttrValue(raw) {
  const value = String(raw || "");
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function removeAttrs(attrs, names) {
  let result = attrs;
  for (const name of names) {
    result = result.replace(
      new RegExp(`(^|\\s)${escapeRegExp(name)}(\\s*=\\s*("[^"]*"|'[^']*'|[^\\s"'>]+))?`, "gi"),
      "$1",
    );
  }
  const trimmed = result.trim();
  return trimmed ? ` ${trimmed}` : "";
}

function escapeAttr(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function quoteAttrValuePreservingEntities(value, preferredQuote) {
  const text = String(value);
  if (!text.includes(preferredQuote)) return `${preferredQuote}${text}${preferredQuote}`;
  const alternateQuote = preferredQuote === '"' ? "'" : '"';
  if (!text.includes(alternateQuote)) return `${alternateQuote}${text}${alternateQuote}`;
  return `"${text.replace(/"/g, "&quot;")}"`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveBytes(optionValue, envValue, fallback) {
  if (Number.isFinite(optionValue) && optionValue > 0) return optionValue;
  const parsed = Number(envValue);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  return fallback;
}

async function replaceAsync(input, regex, replacer) {
  const matches = [];
  input.replace(regex, (...args) => {
    matches.push(args);
    return "";
  });
  let result = "";
  let lastIndex = 0;
  for (const args of matches) {
    const match = args[0];
    const offset = args[args.length - 2];
    result += input.slice(lastIndex, offset);
    result += await replacer(...args);
    lastIndex = offset + match.length;
  }
  result += input.slice(lastIndex);
  return result;
}
