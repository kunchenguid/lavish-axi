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
  colon: ":",
  gt: ">",
  lt: "<",
  nbsp: "\u00a0",
  newline: "\n",
  quot: '"',
  sol: "/",
  tab: "\t",
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
const RCDATA_SEGMENT_RE = new RegExp(
  String.raw`^<(textarea|title)(?=\s|\/|>)(${TAG_ATTRS_PATTERN})>([\s\S]*?)(<\/\1\s*>)$`,
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
    const startTag = await transformRawTextStartTag("style", attrs, baseDir, ctx);
    if (!isCssStyleElementType(attrs)) {
      warnUnsupportedStyleElementType(attrs, css, baseDir, ctx);
      return `${startTag}${css}</style>`;
    }
    return `${startTag}${escapeRawText(await inlineCss(css, baseDir, ctx, 0, baseDir), "style")}</style>`;
  }
  const script = segment.match(SCRIPT_SEGMENT_RE);
  if (script) {
    const [, attrs, body] = script;
    return inlineScript(attrs, body, baseDir, ctx);
  }
  const rcdata = segment.match(RCDATA_SEGMENT_RE);
  if (rcdata) {
    const [, tag, attrs, body, endTag] = rcdata;
    return `${await transformMarkup(`<${tag}${attrs}>`, baseDir, ctx)}${body}${endTag}`;
  }
  return segment;
}

async function transformRawTextStartTag(tag, attrs, baseDir, ctx) {
  return transformMarkup(formatStartTag(tag, attrs, false), baseDir, ctx);
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
  result = await inlineRenderResourceTags(result, baseDir, ctx);
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

async function inlineRenderResourceTags(markup, baseDir, ctx) {
  return replaceAsync(markup, START_TAG_RE, async (match, tag, attrs) => {
    const tagName = tag.toLowerCase();
    if (tagName === "object") {
      return formatStartTag(tag, await inlineRenderAttr(attrs, "data", baseDir, ctx), isSelfClosingTag(match));
    }
    if (tagName === "embed") {
      return formatStartTag(tag, await inlineRenderAttr(attrs, "src", baseDir, ctx), isSelfClosingTag(match));
    }
    if (tagName === "input") {
      if (getAttr(attrs, "type").trim().toLowerCase() !== "image") return match;
      return formatStartTag(tag, await inlineRenderAttr(attrs, "src", baseDir, ctx), isSelfClosingTag(match));
    }
    if (tagName === "iframe") {
      return formatStartTag(tag, warnFrameSrc(attrs, baseDir, ctx), isSelfClosingTag(match));
    }
    return match;
  });
}

async function inlineRenderAttr(attrs, name, baseDir, ctx) {
  const value = getAttr(attrs, name);
  if (value && containsFileUrl(value)) return attrs;
  return inlineAttr(attrs, name, baseDir, ctx);
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
        const decoded = decodeHtmlCharacterReferences(value);
        const rewritten = await inlineCssUrls(decoded, baseDir, ctx, baseDir, { decodeHtmlEntities: false });
        return rewritten === decoded ? attrMatch : `${boundary}${prefix}${quoteAttrValue(rewritten, quote)}`;
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
    if (!isCssStylesheetType(attrs)) {
      warnUnsupportedStylesheetType(href, baseDir, ctx, HTML_REF_OPTIONS);
      return replaceUnresolvedAttrRef(match, "href", href);
    }
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

function isCssStylesheetType(attrs) {
  const type = getAttr(attrs, "type").trim().toLowerCase();
  if (!type) return true;
  return type.split(";")[0].trim() === "text/css";
}

function isCssStyleElementType(attrs) {
  return isCssStylesheetType(attrs);
}

async function inlineScript(attrs, body, baseDir, ctx) {
  const src = getAttr(attrs, "src");
  if (!src) {
    if (isModuleScript(attrs)) warnInlineModuleImports(body, baseDir, ctx);
    return `${await transformRawTextStartTag("script", attrs, baseDir, ctx)}${body}</script>`;
  }
  if (isInjectedLavishSdkSrc(src)) return "";
  if (isModuleScript(attrs)) {
    warnExternalModuleScript(src, baseDir, ctx, HTML_REF_OPTIONS);
    const startTag = await transformMarkup(replaceUnresolvedAttrRef(`<script${attrs}>`, "src", src), baseDir, ctx);
    return `${startTag}${body}</script>`;
  }
  if (!isClassicScript(attrs)) {
    warnUnsupportedScriptType(src, baseDir, ctx, HTML_REF_OPTIONS);
    const startTag = await transformMarkup(replaceUnresolvedAttrRef(`<script${attrs}>`, "src", src), baseDir, ctx);
    return `${startTag}${body}</script>`;
  }
  if (hasAttr(attrs, "defer") || hasAttr(attrs, "async")) {
    warnUnsupportedScriptTiming(src, baseDir, ctx, HTML_REF_OPTIONS);
    const startTag = await transformMarkup(replaceUnresolvedAttrRef(`<script${attrs}>`, "src", src), baseDir, ctx);
    return `${startTag}${body}</script>`;
  }

  const loaded = await loadText(src, baseDir, ctx, HTML_REF_OPTIONS);
  if (!loaded) {
    const startTag = await transformMarkup(replaceUnresolvedAttrRef(`<script${attrs}>`, "src", src), baseDir, ctx);
    return `${startTag}${body}</script>`;
  }
  const cleanedAttrs = removeAttrs(attrs, ["src", "integrity", "crossorigin"]);
  const startTag = await transformRawTextStartTag("script", cleanedAttrs, baseDir, ctx);
  return `${startTag}${escapeRawText(loaded.text, "script")}</script>`;
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
  return inlineCssUrls(withImports.css, baseDir, ctx, outputBaseDir);
}

async function inlineCssImports(css, baseDir, ctx, depth, outputBaseDir) {
  const prelude = collectCssPrelude(css);
  const imports = prelude.segments.filter((segment) => segment.type === "import");
  const startBytes = ctx.inlinedBytes;
  const prepared = new Map();
  const classifications = new Map();
  let complete = true;
  let failureIndex = -1;
  let failureCause = "";

  if (prelude.hasNamespace && imports.length > 0) {
    complete = false;
    failureIndex = 0;
    failureCause = "namespace";
  } else {
    for (let importIndex = 0; importIndex < imports.length; importIndex += 1) {
      const item = imports[importIndex];
      const classification = classifyCssImport(item.parsed, baseDir, ctx, depth);
      classifications.set(item, classification);
      if (classification.kind !== "candidate") {
        complete = false;
        failureIndex = importIndex;
        failureCause = classification.kind;
        break;
      }
      const loaded = await loadTextFromDescriptor(classification.descriptor, item.parsed.ref, ctx);
      if (!loaded) {
        complete = false;
        failureIndex = importIndex;
        failureCause = "load";
        break;
      }
      const inner = await prepareCssImportInline(loaded.text, loaded.baseDir, ctx, depth + 1, outputBaseDir);
      if (!inner.inlineable) {
        complete = false;
        failureIndex = importIndex;
        failureCause = inner.reason || "nested";
        break;
      }
      prepared.set(item, item.parsed.media ? `@media ${item.parsed.media}{${inner.css}}` : inner.css);
    }
  }

  if (!complete) ctx.inlinedBytes = startBytes;

  let result = "";
  for (const segment of prelude.segments) {
    if (segment.type !== "import") {
      result += segment.text;
      continue;
    }
    if (complete) {
      result += prepared.has(segment) ? prepared.get(segment) : segment.rule;
      continue;
    }
    warnExternalizedCssImport(
      segment,
      baseDir,
      ctx,
      depth,
      imports.indexOf(segment),
      failureIndex,
      failureCause,
      classifications.get(segment),
    );
    result += rebaseCssImportRule(segment.rule, segment.parsed, baseDir, outputBaseDir);
  }

  const body = rewriteLateCssImports(css.slice(prelude.bodyStart), baseDir, ctx, outputBaseDir);
  return { css: result + body.css, complete: complete && body.complete, hasNamespace: prelude.hasNamespace };
}

async function prepareCssImportInline(css, baseDir, ctx, depth, outputBaseDir) {
  const withImports = await inlineCssImports(css, baseDir, ctx, depth, outputBaseDir);
  if (!withImports.complete)
    return { inlineable: false, css: "", reason: withImports.hasNamespace ? "namespace" : "nested" };
  if (withImports.hasNamespace) return { inlineable: false, css: "", reason: "namespace" };
  return { inlineable: true, css: await inlineCssUrls(withImports.css, baseDir, ctx, outputBaseDir) };
}

function collectCssPrelude(css) {
  const segments = [];
  let index = 0;
  while (index < css.length) {
    const start = index;
    const commentEnd = css.startsWith("/*", index) ? findCssCommentEnd(css, index) : -1;
    if (commentEnd !== -1) {
      segments.push({ type: "text", text: css.slice(index, commentEnd) });
      index = commentEnd;
      continue;
    }
    if (/\s/.test(css[index])) {
      index += 1;
      while (index < css.length && /\s/.test(css[index])) index += 1;
      segments.push({ type: "text", text: css.slice(start, index) });
      continue;
    }
    if (startsCssKeyword(css, index, "@import")) {
      const ruleEnd = findCssAtRuleEnd(css, index);
      if (ruleEnd === -1) break;
      const rule = css.slice(index, ruleEnd + 1);
      const parsed = parseCssImportRule(rule);
      if (!parsed) break;
      segments.push({ type: "import", rule, parsed });
      index = ruleEnd + 1;
      continue;
    }
    if (startsCssKeyword(css, index, "@charset")) {
      const ruleEnd = findCssAtRuleEnd(css, index);
      if (ruleEnd === -1) break;
      segments.push({ type: "text", text: css.slice(index, ruleEnd + 1) });
      index = ruleEnd + 1;
      continue;
    }
    if (startsCssKeyword(css, index, "@layer")) {
      const statementEnd = findCssPreludeStatementEnd(css, index);
      if (statementEnd !== -1 && css[statementEnd] === ";") {
        segments.push({ type: "text", text: css.slice(index, statementEnd + 1) });
        index = statementEnd + 1;
        continue;
      }
    }
    if (startsCssKeyword(css, index, "@namespace")) {
      const ruleEnd = findCssAtRuleEnd(css, index);
      if (ruleEnd === -1) break;
      segments.push({ type: "namespace", text: css.slice(index, ruleEnd + 1) });
      index = ruleEnd + 1;
      continue;
    }
    break;
  }
  return { segments, bodyStart: index, hasNamespace: segments.some((segment) => segment.type === "namespace") };
}

function classifyCssImport(parsed, baseDir, ctx, depth) {
  if (depth >= ctx.maxDepth) return { kind: "depth" };
  if (parsed.media && !isPlainCssMediaQueryList(parsed.media)) return { kind: "unsupported" };
  const descriptor = resolveRef(parsed.ref, baseDir, ctx, { cssSyntax: true });
  return descriptor.kind === "file" ? { kind: "candidate", descriptor } : { kind: descriptor.kind, descriptor };
}

function warnExternalizedCssImport(item, baseDir, ctx, depth, importIndex, failureIndex, failureCause, classification) {
  classification = classification || classifyCssImport(item.parsed, baseDir, ctx, depth);
  if (classification.kind === "candidate") {
    if (importIndex === failureIndex && failureCause === "load") return;
    warnCssImportOrder(item.parsed.ref, classification.descriptor, ctx);
    return;
  }
  if (classification.kind === "depth") {
    warnCssImportDepth(item.parsed.ref, baseDir, ctx);
  } else if (classification.kind === "unsupported") {
    warnUnsupportedCssImport(item.parsed.ref, baseDir, ctx, item.parsed.media);
  } else if (classification.kind === "escape") {
    ctx.warnings.push({ kind: "outside-root", ref: item.parsed.ref });
  }
}

function rewriteLateCssImports(css, baseDir, ctx, outputBaseDir) {
  let result = "";
  let index = 0;
  let complete = true;
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
      const rule = css.slice(index, ruleEnd + 1);
      const parsed = parseCssImportRule(rule);
      if (parsed) {
        complete = false;
        warnLateCssImport(parsed.ref, baseDir, ctx);
        result += rebaseCssImportRule(rule, parsed, baseDir, outputBaseDir);
      } else {
        result += rule;
      }
      index = ruleEnd + 1;
      continue;
    }

    result += css[index];
    index += 1;
  }
  return { css: result, complete };
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

    if (startsCssKeyword(css, index, "@namespace")) {
      const ruleEnd = findCssAtRuleEnd(css, index);
      if (ruleEnd === -1) {
        result += css.slice(index);
        break;
      }
      result += css.slice(index, ruleEnd + 1);
      index = ruleEnd + 1;
      continue;
    }

    const imageSet = parseCssImageSetFunction(css, index);
    if (imageSet) {
      result += css.slice(index, imageSet.argsStart);
      result += await inlineCssImageSetArgs(
        css.slice(imageSet.argsStart, imageSet.argsEnd),
        baseDir,
        ctx,
        outputBaseDir,
        options,
      );
      result += css.slice(imageSet.argsEnd, imageSet.end);
      index = imageSet.end;
      continue;
    }

    const token = parseCssUrlToken(css, index);
    if (!token) {
      result += css[index];
      index += 1;
      continue;
    }

    result += await rewriteCssUrlToken(token, baseDir, ctx, outputBaseDir, options);
    index = token.end;
  }
  return result;
}

async function rewriteCssUrlToken(token, baseDir, ctx, outputBaseDir, options = {}) {
  const trimmed = token.ref.trim();
  const refForResolution = options.decodeHtmlEntities ? decodeHtmlCharacterReferences(trimmed) : trimmed;
  if (isInert(refForResolution)) return token.raw;
  const dataUri = await loadDataUri(trimmed, baseDir, ctx, { ...options, cssSyntax: true });
  return dataUri ? `url(${token.quote}${dataUri}${token.quote})` : rebaseCssUrlToken(token, baseDir, outputBaseDir);
}

async function inlineCssImageSetArgs(args, baseDir, ctx, outputBaseDir, options = {}) {
  let result = "";
  let index = 0;
  let depth = 0;
  while (index < args.length) {
    const commentEnd = args.startsWith("/*", index) ? findCssCommentEnd(args, index) : -1;
    if (commentEnd !== -1) {
      result += args.slice(index, commentEnd);
      index = commentEnd;
      continue;
    }

    if (depth === 0) {
      const token = parseCssUrlToken(args, index);
      if (token) {
        result += await rewriteCssUrlToken(token, baseDir, ctx, outputBaseDir, options);
        index = token.end;
        continue;
      }
    }

    if (args[index] === '"' || args[index] === "'") {
      const token = parseCssString(args, index);
      if (depth === 0) {
        const rewritten = await rewriteCssStringUrlOperand(token.value, baseDir, ctx, outputBaseDir, options);
        result += rewritten.changed ? quoteCssString(rewritten.value, args[index]) : args.slice(index, token.end);
      } else {
        result += args.slice(index, token.end);
      }
      index = token.end;
      continue;
    }

    if (args[index] === "(") depth += 1;
    if (args[index] === ")") depth = Math.max(0, depth - 1);
    result += args[index];
    index += 1;
  }
  return result;
}

function findCssResourceRefs(css) {
  const refs = [];
  let index = 0;
  while (index < css.length) {
    const commentEnd = css.startsWith("/*", index) ? findCssCommentEnd(css, index) : -1;
    if (commentEnd !== -1) {
      index = commentEnd;
      continue;
    }

    if (css[index] === '"' || css[index] === "'") {
      index = findCssStringEnd(css, index);
      continue;
    }

    if (startsCssKeyword(css, index, "@import")) {
      const ruleEnd = findCssAtRuleEnd(css, index);
      if (ruleEnd === -1) break;
      const parsed = parseCssImportRule(css.slice(index, ruleEnd + 1));
      if (parsed) refs.push(parsed.ref);
      index = ruleEnd + 1;
      continue;
    }

    if (startsCssKeyword(css, index, "@namespace")) {
      const ruleEnd = findCssAtRuleEnd(css, index);
      if (ruleEnd === -1) break;
      index = ruleEnd + 1;
      continue;
    }

    const imageSet = parseCssImageSetFunction(css, index);
    if (imageSet) {
      refs.push(...findCssImageSetArgRefs(css.slice(imageSet.argsStart, imageSet.argsEnd)));
      index = imageSet.end;
      continue;
    }

    const token = parseCssUrlToken(css, index);
    if (token) {
      refs.push(token.ref);
      index = token.end;
      continue;
    }

    index += 1;
  }
  return refs;
}

function findCssImageSetArgRefs(args) {
  const refs = [];
  let index = 0;
  let depth = 0;
  while (index < args.length) {
    const commentEnd = args.startsWith("/*", index) ? findCssCommentEnd(args, index) : -1;
    if (commentEnd !== -1) {
      index = commentEnd;
      continue;
    }

    if (depth === 0) {
      const token = parseCssUrlToken(args, index);
      if (token) {
        refs.push(token.ref);
        index = token.end;
        continue;
      }
    }

    if (args[index] === '"' || args[index] === "'") {
      const token = parseCssString(args, index);
      if (depth === 0) refs.push(token.value);
      index = token.end;
      continue;
    }

    if (args[index] === "(") depth += 1;
    if (args[index] === ")") depth = Math.max(0, depth - 1);
    index += 1;
  }
  return refs;
}

async function rewriteCssStringUrlOperand(ref, baseDir, ctx, outputBaseDir, options = {}) {
  const trimmed = String(ref || "").trim();
  const refForResolution = normalizeRefForResolution(trimmed, { ...options, cssSyntax: true }).trim();
  if (isInert(refForResolution)) return { changed: false, value: ref };
  const dataUri = await loadDataUri(trimmed, baseDir, ctx, { ...options, cssSyntax: true });
  if (dataUri) return { changed: true, value: dataUri };
  if (shouldRedactUnresolvedRef(trimmed, { ...options, cssSyntax: true }))
    return { changed: true, value: REDACTED_FILE_REF };
  const rebased = rebaseLocalCssRef(trimmed, baseDir, outputBaseDir, { ...options, cssSyntax: true });
  return rebased ? { changed: true, value: rebased } : { changed: false, value: ref };
}

function rebaseCssUrlToken(token, baseDir, outputBaseDir) {
  if (shouldRedactUnresolvedRef(token.ref, { cssSyntax: true })) {
    return `url(${token.quote}${REDACTED_FILE_REF}${token.quote})`;
  }
  const rebased = rebaseLocalCssRef(token.ref, baseDir, outputBaseDir, { cssSyntax: true });
  return rebased ? `url(${token.quote}${rebased}${token.quote})` : token.raw;
}

function rebaseCssImportRule(rule, parsed, baseDir, outputBaseDir) {
  if (shouldRedactUnresolvedRef(parsed.ref, { cssSyntax: true })) {
    return `${rule.slice(0, parsed.refStart)}${REDACTED_FILE_REF}${rule.slice(parsed.refEnd)}`;
  }
  const rebased = rebaseLocalCssRef(parsed.ref, baseDir, outputBaseDir, { cssSyntax: true });
  if (!rebased) return rule;
  return `${rule.slice(0, parsed.refStart)}${rebased}${rule.slice(parsed.refEnd)}`;
}

function rebaseLocalCssRef(ref, baseDir, outputBaseDir, options = {}) {
  const trimmed = normalizeRefForResolution(ref, options).trim();
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
  let index = cssKeywordEnd(rule, 0, "@import");
  if (index === -1) return null;
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
  const keywordEnd = cssKeywordEnd(css, index, "url");
  const paren = keywordEnd === -1 ? -1 : skipCssWhitespaceAndComments(css, keywordEnd);
  if (keywordEnd === -1 || css[paren] !== "(") return null;
  let cursor = skipCssWhitespaceAndComments(css, paren + 1);
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
    cursor = skipCssWhitespaceAndComments(css, token.end);
    if (css[cursor] !== ")") return null;
    cursor += 1;
  } else {
    const start = cursor;
    while (cursor < css.length && css[cursor] !== ")") {
      if (css[cursor] === '"' || css[cursor] === "'") return null;
      if (css.startsWith("/*", cursor) || /\s/.test(css[cursor])) {
        const close = skipCssWhitespaceAndComments(css, cursor);
        if (css[close] !== ")") return null;
        ref = css.slice(start, cursor);
        refStart = start;
        refEnd = cursor;
        cursor = close + 1;
        return { raw: css.slice(index, cursor), ref, quote, end: cursor, refStart, refEnd };
      }
      cursor = css[cursor] === "\\" ? readCssEscape(css, cursor).end : cursor + 1;
    }
    if (css[cursor] !== ")") return null;
    ref = css.slice(start, cursor);
    refStart = start;
    refEnd = cursor;
    cursor += 1;
  }
  return { raw: css.slice(index, cursor), ref, quote, end: cursor, refStart, refEnd };
}

function parseCssImageSetFunction(css, index) {
  let keywordEnd = cssKeywordEnd(css, index, "image-set");
  if (keywordEnd === -1) keywordEnd = cssKeywordEnd(css, index, "-webkit-image-set");
  const paren = keywordEnd === -1 ? -1 : skipCssWhitespaceAndComments(css, keywordEnd);
  if (keywordEnd === -1 || css[paren] !== "(") return null;
  const close = findCssFunctionEnd(css, paren);
  return close === -1 ? null : { argsStart: paren + 1, argsEnd: close, end: close + 1 };
}

function findCssFunctionEnd(css, openParen) {
  let cursor = openParen;
  let depth = 0;
  while (cursor < css.length) {
    if (css.startsWith("/*", cursor)) {
      cursor = findCssCommentEnd(css, cursor);
      continue;
    }
    if (css[cursor] === '"' || css[cursor] === "'") {
      cursor = findCssStringEnd(css, cursor);
      continue;
    }
    if (css[cursor] === "(") depth += 1;
    if (css[cursor] === ")") {
      depth -= 1;
      if (depth === 0) return cursor;
    }
    cursor += 1;
  }
  return -1;
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

function findCssPreludeStatementEnd(css, index) {
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
    if (css[cursor] === ";" || css[cursor] === "{") return cursor;
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
  return cssKeywordEnd(css, index, keyword) !== -1;
}

function cssKeywordEnd(css, index, keyword) {
  if (!hasCssIdentifierBoundaryBefore(css, index)) return -1;
  const expected = String(keyword).toLowerCase();
  if (expected.startsWith("@")) {
    if (css[index] !== "@") return -1;
    const ident = consumeCssIdentifier(css, index + 1);
    if (!ident || `@${ident.value.toLowerCase()}` !== expected) return -1;
    return ident.end;
  }
  const ident = consumeCssIdentifier(css, index);
  if (!ident || ident.value.toLowerCase() !== expected) return -1;
  return ident.end;
}

function hasCssIdentifierBoundaryBefore(css, index) {
  const before = css[index - 1] || "";
  return before !== "\\" && !isCssIdentChar(before);
}

function isPlainCssMediaQueryList(tail) {
  return !startsUnsupportedCssImportTail(tail);
}

function startsUnsupportedCssImportTail(tail) {
  const index = skipCssWhitespaceAndComments(tail, 0);
  const ident = consumeCssIdentifier(tail, index);
  if (!ident) return false;
  const cursor = ident.end;
  const value = ident.value.toLowerCase();
  if (value === "layer") return true;
  return tail[cursor] === "(";
}

function isCssIdentChar(char) {
  return Boolean(char) && /[a-z0-9_-]/i.test(char);
}

function consumeCssIdentifier(css, index) {
  let cursor = index;
  let value = "";
  while (cursor < css.length) {
    if (css[cursor] === "\\") {
      const escaped = readCssEscape(css, cursor);
      value += escaped.value;
      cursor = escaped.end;
      continue;
    }
    if (!isCssIdentChar(css[cursor])) break;
    value += css[cursor];
    cursor += 1;
  }
  return cursor === index ? null : { value, end: cursor };
}

function readCssEscape(input, index) {
  if (index + 1 >= input.length) return { value: "\\", end: index + 1 };
  const next = input[index + 1];
  if (next === "\r" && input[index + 2] === "\n") return { value: "", end: index + 3 };
  if (/[\n\r\f]/.test(next)) return { value: "", end: index + 2 };
  if (/[\da-f]/i.test(next)) {
    let cursor = index + 1;
    let hex = "";
    while (cursor < input.length && hex.length < 6 && /[\da-f]/i.test(input[cursor])) {
      hex += input[cursor];
      cursor += 1;
    }
    const value = decodeNumericCharacterReference(Number.parseInt(hex, 16), "");
    if (cursor < input.length && /[\t\n\f\r ]/.test(input[cursor])) cursor += 1;
    return { value, end: cursor };
  }
  return { value: next, end: index + 2 };
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
  const schemeRef = normalizeRefForScheme(ref, options);
  const base = normalizeRefBase(baseDir);
  if (isInert(schemeRef || trimmed)) return { kind: "skip" };

  // Remote: http(s) and protocol-relative URLs are left as references for the browser to load.
  if (schemeRef.startsWith("//") || /^https?:\/\//i.test(schemeRef)) return { kind: "skip" };

  // Local file: URLs are inlined like any other local asset, subject to the confinement guard.
  if (isFileSchemeRef(ref, options)) {
    try {
      const resolved = fileURLToPath(schemeRef.replace(/#.*$/, ""));
      if (ctx.confineDir && isOutside(ctx.confineDir, resolved)) return { kind: "escape", path: resolved };
      return { kind: "file", path: resolved };
    } catch {
      return { kind: "skip" };
    }
  }

  // Any other explicit scheme (ftp:, ws:, custom:) is left as a reference.
  if (/^[a-z][a-z0-9+.-]*:/i.test(schemeRef)) return { kind: "skip" };

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

function warnUnsupportedScriptType(ref, baseDir, ctx, options = {}) {
  const descriptor = resolveRef(ref, baseDir, ctx, options);
  if (descriptor.kind === "file") {
    ctx.warnings.push({
      kind: "unsupported-script-type",
      ref,
      reason: "non-classic script types are left as references",
    });
  } else if (descriptor.kind === "escape") {
    ctx.warnings.push({ kind: "outside-root", ref });
  }
}

function warnUnsupportedStylesheetType(ref, baseDir, ctx, options = {}) {
  const descriptor = resolveRef(ref, baseDir, ctx, options);
  if (descriptor.kind === "file") {
    ctx.warnings.push({
      kind: "unsupported-stylesheet-type",
      ref,
      reason: "non-CSS stylesheet links are left as references",
    });
  } else if (descriptor.kind === "escape") {
    ctx.warnings.push({ kind: "outside-root", ref });
  }
}

function warnUnsupportedStyleElementType(attrs, css, baseDir, ctx) {
  const seen = new Set();
  for (const ref of findCssResourceRefs(css)) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    const descriptor = resolveRef(ref, baseDir, ctx, { cssSyntax: true });
    if (descriptor.kind === "file") {
      ctx.warnings.push({
        kind: "unsupported-style-type",
        ref,
        reason: "non-CSS style elements are left unchanged",
      });
    } else if (descriptor.kind === "escape") {
      ctx.warnings.push({ kind: "outside-root", ref });
    }
  }
}

function warnFrameSrc(attrs, baseDir, ctx) {
  const ref = getAttr(attrs, "src");
  if (!ref) return attrs;
  if (containsFileUrl(ref)) return attrs;
  warnUnsupportedFrame(ref, baseDir, ctx, HTML_REF_OPTIONS);
  return replaceUnresolvedAttrRef(attrs, "src", ref);
}

function warnUnsupportedFrame(ref, baseDir, ctx, options = {}) {
  const descriptor = resolveRef(ref, baseDir, ctx, options);
  if (descriptor.kind === "file") {
    ctx.warnings.push({
      kind: "unsupported-frame",
      ref,
      reason: "iframe documents are left as references because nested HTML is not bundled",
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
  const descriptor = resolveRef(ref, baseDir, ctx, { cssSyntax: true });
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
  const descriptor = resolveRef(ref, baseDir, ctx, { cssSyntax: true });
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

function warnLateCssImport(ref, baseDir, ctx) {
  const descriptor = resolveRef(ref, baseDir, ctx, { cssSyntax: true });
  if (descriptor.kind === "file") {
    ctx.warnings.push({
      kind: "late-css-import",
      ref,
      reason: "CSS @import appears outside the valid top-level import prelude and is left unchanged",
    });
  } else if (descriptor.kind === "escape") {
    ctx.warnings.push({ kind: "outside-root", ref });
  }
}

function isModuleScript(attrs) {
  return getAttr(attrs, "type").trim().toLowerCase() === "module";
}

function isClassicScript(attrs) {
  const type = getAttr(attrs, "type").trim().toLowerCase();
  if (!type) return true;
  const mime = type.split(";")[0].trim();
  return CLASSIC_SCRIPT_MIME_TYPES.has(mime);
}

const CLASSIC_SCRIPT_MIME_TYPES = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/x-ecmascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/javascript",
  "text/javascript1.0",
  "text/javascript1.1",
  "text/javascript1.2",
  "text/javascript1.3",
  "text/javascript1.4",
  "text/javascript1.5",
  "text/jscript",
  "text/livescript",
  "text/x-ecmascript",
  "text/x-javascript",
]);

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
    if (source[cursor] === "`") {
      const token = parseJsTemplateImport(source, cursor);
      return { refs: token.value ? [token.value] : [], end: token.end };
    }
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

function parseJsTemplateImport(source, index) {
  const end = skipJsTemplate(source, index);
  return { value: source.slice(index + 1, Math.max(index + 1, end - 1)), end };
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

function shouldRedactUnresolvedRef(ref, options = {}) {
  return isFileSchemeRef(ref, options);
}

function containsFileUrl(ref) {
  return /(^|[^a-z0-9+.-])file:/i.test(normalizeHtmlRefForScheme(ref));
}

function isFileSchemeRef(ref, options = {}) {
  return /^file:/i.test(normalizeRefForScheme(ref, options));
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
  let value = String(ref);
  if (options.decodeHtmlEntities) value = decodeHtmlCharacterReferences(value);
  return options.cssSyntax ? decodeCssEscapes(value) : value;
}

function normalizeRefForScheme(ref, options = {}) {
  return options.cssSyntax ? normalizeCssRefForScheme(ref, options) : normalizeHtmlRefForScheme(ref);
}

function normalizeHtmlRefForScheme(ref) {
  return decodeHtmlCharacterReferences(String(ref || ""))
    .replace(/[\t\n\r]/g, "")
    .trim();
}

function normalizeCssRefForScheme(ref, options = {}) {
  const value = options.decodeHtmlEntities ? decodeHtmlCharacterReferences(String(ref || "")) : String(ref || "");
  return decodeCssEscapes(value)
    .replace(/[\t\n\f\r ]/g, "")
    .trim();
}

function decodeHtmlCharacterReferences(value) {
  return String(value).replace(/&(?:#(\d+);?|#x([\da-f]+);?|([a-z][a-z0-9]+);)/gi, (match, decimal, hex, named) => {
    if (decimal) return decodeNumericCharacterReference(Number.parseInt(decimal, 10), match);
    if (hex) return decodeNumericCharacterReference(Number.parseInt(hex, 16), match);
    return HTML_ENTITY_MAP[named.toLowerCase()] ?? match;
  });
}

function decodeCssEscapes(value) {
  const input = String(value);
  let result = "";
  let index = 0;
  while (index < input.length) {
    if (input[index] !== "\\") {
      result += input[index];
      index += 1;
      continue;
    }
    if (index + 1 >= input.length) {
      result += "\\";
      break;
    }
    const next = input[index + 1];
    if (next === "\r" && input[index + 2] === "\n") {
      index += 3;
      continue;
    }
    if (/[\n\r\f]/.test(next)) {
      index += 2;
      continue;
    }
    if (/[\da-f]/i.test(next)) {
      const escaped = readCssEscape(input, index);
      result += escaped.value;
      index = escaped.end;
      continue;
    }
    result += next;
    index += 2;
  }
  return result;
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

function quoteAttrValue(value, preferredQuote) {
  const quote = preferredQuote === "'" ? "'" : '"';
  return `${quote}${escapeAttrForQuote(value, quote)}${quote}`;
}

function escapeAttrForQuote(value, quote) {
  let escaped = String(value).replace(/&/g, "&amp;");
  escaped = quote === '"' ? escaped.replace(/"/g, "&quot;") : escaped.replace(/'/g, "&#39;");
  return escaped;
}

function quoteCssString(value, quote) {
  return `${quote}${String(value)
    .replace(/\\/g, "\\\\")
    .replace(new RegExp(escapeRegExp(quote), "g"), `\\${quote}`)
    .replace(/\n/g, "\\a ")
    .replace(/\r/g, "\\d ")}${quote}`;
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
