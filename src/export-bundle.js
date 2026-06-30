import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Builds a portable copy of a Lavish artifact by inlining only its LOCAL assets - files on disk
// the artifact references by relative path, fetchable file:// URL, or a trusted root-absolute
// resolver - as inline <style>/<script> blocks and data URIs. Remote references (http(s) CDN/font URLs,
// protocol-relative URLs, CSS url() pointing at the network) are deliberately LEFT AS-IS: the
// browser loads them at render time, so the export and the hosted share render correctly wherever
// there is network access. Because nothing remote is ever fetched, the transform makes no outbound
// requests (no SSRF) and stays a small, deterministic local-file rewrite. The only security surface
// is local file reading, which is confined to the artifact directory both lexically and by
// real-path/symlink resolution, except for caller-provided trusted resolver mappings such as
// packaged /design assets. File URLs that are not safely inlined as local assets are redacted to
// about:blank before they can leak absolute local paths.

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
const RAW_TEXT_TAGS = new Set(["script", "style", "textarea", "title", "iframe", "xmp", "noembed", "noframes"]);
const PLAINTEXT_TAG = "plaintext";
const INERT_CONTENT_TAGS = new Set(["template", "noscript"]);
const MEDIA_TAGS = new Set(["img", "source", "video", "audio", "track"]);
const SVG_REF_TAGS = new Set(["use", "image", "feimage"]);
const SVG_HTML_INTEGRATION_POINTS = new Set(["foreignobject", "desc", "title"]);
const HTML_VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const INERT_RESOURCE_REASON = "resources inside template or noscript content are left unchanged";
const SRCDOC_RESOURCE_REASON = "iframe srcdoc nested HTML is left unchanged";
const UNRESOLVED_LOCAL_ASSET_WARNING_KINDS = new Set([
  "behavioral-stylesheet",
  "css-import-depth",
  "css-import-order",
  "fetchable-link",
  "file-url-unresolved",
  "inactive-stylesheet",
  "inline-importmap-local-ref",
  "inline-module-import",
  "load-failed",
  "module-external",
  "nested-svg-resource",
  "outside-root",
  "preload-stylesheet",
  "srcdoc-resource",
  "too-large",
  "unmapped-root-absolute",
  "unterminated-script-src",
  "unsupported-css-import",
  "unsupported-frame",
  "unsupported-script-timing",
  "unsupported-script-type",
  "unsupported-style-type",
  "unsupported-stylesheet-type",
]);

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

export function splitExportWarnings(warnings) {
  const unresolved = [];
  const notices = [];
  for (const warning of Array.isArray(warnings) ? warnings : []) {
    if (UNRESOLVED_LOCAL_ASSET_WARNING_KINDS.has(warning?.kind)) unresolved.push(warning);
    else notices.push(warning);
  }
  return { unresolved, notices };
}

export function exportWarningSummaries(warnings) {
  return (Array.isArray(warnings) ? warnings : []).map((warning) => ({
    kind: warning.kind,
    ref: warning.ref,
    ...(warning.reason ? { reason: warning.reason } : {}),
  }));
}

async function transform(html, ctx) {
  const documentBase = resolveDocumentRefBase(html, ctx);
  return transformMarkup(html, documentBase, ctx);
}

async function transformMarkup(markup, baseDir, ctx) {
  let result = "";
  let index = 0;
  const openStack = [];
  while (index < markup.length) {
    const lt = markup.indexOf("<", index);
    if (lt === -1) {
      result += markup.slice(index);
      break;
    }
    result += markup.slice(index, lt);
    const token = readHtmlToken(markup, lt);
    if (!token) {
      result += markup[lt];
      index = lt + 1;
      continue;
    }
    if (token.type === "close") {
      popHtmlParent(openStack, token.tag.toLowerCase());
      result += scrubRawTextFileUrls(token.raw, ctx);
      index = token.end;
      continue;
    }
    if (token.type !== "start") {
      result += token.type === "comment" ? scrubHtmlComment(token.raw, ctx) : scrubRawTextFileUrls(token.raw, ctx);
      index = token.end;
      continue;
    }
    const tagName = token.tag.toLowerCase();
    const elementNamespace = elementNamespaceForTag(tagName, openStack);
    const effectiveSelfClosing = isEffectiveSelfClosingTag(tagName, token.selfClosing, openStack, elementNamespace);
    if (elementNamespace === "html" && tagName === PLAINTEXT_TAG && !effectiveSelfClosing) {
      result += await transformPlaintextElement(token, markup.slice(token.end), baseDir, ctx);
      index = markup.length;
      continue;
    }
    if (elementNamespace === "html" && INERT_CONTENT_TAGS.has(tagName) && !effectiveSelfClosing) {
      const close = findContentClose(markup, token.end, tagName);
      if (close) {
        const body = markup.slice(token.end, close.start);
        result += await transformInertContentElement(token, body, close.raw, baseDir, ctx);
        index = close.end;
        continue;
      }
      warnUnterminatedRawText(tagName, ctx);
      result += await transformInertContentElement(token, markup.slice(token.end), "", baseDir, ctx);
      index = markup.length;
      continue;
    }
    if (isRawTextElementForNamespace(tagName, elementNamespace) && !effectiveSelfClosing) {
      const close = findContentClose(markup, token.end, tagName);
      if (close) {
        const body = markup.slice(token.end, close.start);
        result += await transformRawTextElement(token, body, close.raw, baseDir, ctx, {
          inSvgNamespace: elementNamespace === "svg",
        });
        index = close.end;
        continue;
      }
      warnUnterminatedRawText(tagName, ctx);
      result += await transformUnterminatedRawTextElement(token, markup.slice(token.end), baseDir, ctx, {
        inSvgNamespace: elementNamespace === "svg",
      });
      index = markup.length;
      continue;
    }
    result += await transformStartTag(
      token.tag,
      token.attrs,
      token.selfClosing,
      baseDir,
      ctx,
      currentHtmlParent(openStack),
      elementNamespace,
    );
    if (!effectiveSelfClosing && !HTML_VOID_TAGS.has(tagName)) pushHtmlParent(openStack, tagName, elementNamespace);
    index = token.end;
  }
  return result;
}

function isEffectiveSelfClosingTag(tagName, selfClosing, openStack = [], elementNamespace = null) {
  if (!selfClosing) return false;
  if (HTML_VOID_TAGS.has(tagName)) return true;
  const namespace = elementNamespace || elementNamespaceForTag(tagName, openStack);
  return namespace === "svg" || namespace === "math";
}

function currentHtmlParent(openStack) {
  return openStack.length ? stackTag(openStack[openStack.length - 1]) : "";
}

function popHtmlParent(openStack, tagName) {
  const index = findLastStackIndex(openStack, tagName);
  if (index !== -1) openStack.length = index;
}

function pushHtmlParent(openStack, tagName, elementNamespace) {
  openStack.push({ tag: tagName, namespace: childNamespaceForTag(tagName, elementNamespace) });
}

function findLastStackIndex(openStack, tagName) {
  for (let index = openStack.length - 1; index >= 0; index -= 1) {
    if (stackTag(openStack[index]) === tagName) return index;
  }
  return -1;
}

function stackTag(entry) {
  return typeof entry === "string" ? entry : entry.tag;
}

function currentNamespace(openStack) {
  return openStack.length ? openStack[openStack.length - 1].namespace || "html" : "html";
}

function elementNamespaceForTag(tagName, openStack) {
  const namespace = currentNamespace(openStack);
  if (namespace !== "html") return namespace;
  if (tagName === "svg") return "svg";
  if (tagName === "math") return "math";
  return "html";
}

function childNamespaceForTag(tagName, elementNamespace) {
  if (elementNamespace === "html") {
    if (tagName === "svg") return "svg";
    if (tagName === "math") return "math";
    return "html";
  }
  if (elementNamespace === "svg" && SVG_HTML_INTEGRATION_POINTS.has(tagName)) return "html";
  return elementNamespace;
}

function isRawTextElementForNamespace(tagName, elementNamespace) {
  if (elementNamespace === "html") return RAW_TEXT_TAGS.has(tagName);
  return elementNamespace === "svg" && (tagName === "script" || tagName === "style");
}

async function transformInertContentElement(token, body, closeTag, baseDir, ctx) {
  const tagName = token.tag.toLowerCase();
  const startTag = formatStartTag(token.tag, scrubInertAttrs(tagName, token.attrs, baseDir, ctx), false);
  return `${startTag}${transformInertMarkup(body, baseDir, ctx)}${scrubRawTextFileUrls(closeTag, ctx)}`;
}

async function transformPlaintextElement(token, body, baseDir, ctx) {
  const startTag = await transformStartTag(token.tag, token.attrs, false, baseDir, ctx);
  return `${startTag}${scrubRawTextBodyWithoutInlining(token.tag.toLowerCase(), token.attrs, body, baseDir, ctx)}`;
}

function transformInertMarkup(markup, baseDir, ctx, options = {}) {
  const warnLocalRefs = options.warnLocalRefs !== false;
  let result = "";
  let index = 0;
  const openStack = [];
  while (index < markup.length) {
    const lt = markup.indexOf("<", index);
    if (lt === -1) {
      result += scrubRawTextFileUrls(markup.slice(index), ctx);
      break;
    }
    result += scrubRawTextFileUrls(markup.slice(index, lt), ctx);
    const token = readHtmlToken(markup, lt);
    if (!token) {
      result += markup[lt];
      index = lt + 1;
      continue;
    }
    if (token.type !== "start") {
      if (token.type === "close") popHtmlParent(openStack, token.tag.toLowerCase());
      result += token.type === "comment" ? scrubHtmlComment(token.raw, ctx) : scrubRawTextFileUrls(token.raw, ctx);
      index = token.end;
      continue;
    }
    const tagName = token.tag.toLowerCase();
    const elementNamespace = elementNamespaceForTag(tagName, openStack);
    const effectiveSelfClosing = isEffectiveSelfClosingTag(tagName, token.selfClosing, openStack, elementNamespace);
    if (elementNamespace === "html" && tagName === PLAINTEXT_TAG && !effectiveSelfClosing) {
      if (warnLocalRefs) warnInertStartTagRefs(tagName, token.attrs, baseDir, ctx, options, elementNamespace);
      result += transformInertRawTextElement(token, markup.slice(token.end), "", baseDir, ctx, {
        ...options,
        warnLocalRefs: false,
      });
      index = markup.length;
      continue;
    }
    if (
      ((elementNamespace === "html" && INERT_CONTENT_TAGS.has(tagName)) ||
        isRawTextElementForNamespace(tagName, elementNamespace)) &&
      !effectiveSelfClosing
    ) {
      const close = findContentClose(markup, token.end, tagName);
      const bodyEnd = close ? close.start : markup.length;
      const body = markup.slice(token.end, bodyEnd);
      if (!close) warnUnterminatedRawText(tagName, ctx);
      if (INERT_CONTENT_TAGS.has(tagName)) {
        const attrs = scrubInertAttrs(tagName, token.attrs, baseDir, ctx, options);
        result += `${formatStartTag(token.tag, attrs, false)}${transformInertMarkup(body, baseDir, ctx, options)}${
          close ? scrubRawTextFileUrls(close.raw, ctx) : ""
        }`;
      } else {
        result += transformInertRawTextElement(token, body, close ? close.raw : "", baseDir, ctx, {
          ...options,
          inSvgNamespace: elementNamespace === "svg",
        });
      }
      index = close ? close.end : markup.length;
      continue;
    }
    if (warnLocalRefs) warnInertStartTagRefs(tagName, token.attrs, baseDir, ctx, options, elementNamespace);
    result += formatStartTag(
      token.tag,
      scrubInertAttrs(tagName, token.attrs, baseDir, ctx, { ...options, warnLocalRefs: false }),
      token.selfClosing,
    );
    if (!effectiveSelfClosing && !HTML_VOID_TAGS.has(tagName)) pushHtmlParent(openStack, tagName, elementNamespace);
    index = token.end;
  }
  return result;
}

async function transformRawTextElement(token, body, closeTag, baseDir, ctx, options = {}) {
  const tagName = token.tag.toLowerCase();
  const safeCloseTag = scrubRawTextFileUrls(closeTag, ctx);
  const namespace = options.inSvgNamespace ? "svg" : "html";
  if (tagName === "style") {
    const startTag = await transformStartTag(token.tag, token.attrs, false, baseDir, ctx, "", namespace);
    if (!isCssStyleElementType(token.attrs)) {
      return `${startTag}${scrubUnsupportedStyleElementBody(body, baseDir, ctx)}${safeCloseTag}`;
    }
    return `${startTag}${escapeRawText(await inlineCss(body, baseDir, ctx, 0, baseDir), "style")}${safeCloseTag}`;
  }
  if (tagName === "script" && options.inSvgNamespace)
    return inlineSvgScript(token.tag, token.attrs, body, safeCloseTag, baseDir, ctx);
  if (tagName === "script") return inlineScript(token.tag, token.attrs, body, safeCloseTag, baseDir, ctx);
  return `${await transformStartTag(token.tag, token.attrs, false, baseDir, ctx, "", namespace)}${scrubRawTextBodyWithoutInlining(
    tagName,
    token.attrs,
    body,
    baseDir,
    ctx,
  )}${safeCloseTag}`;
}

async function transformUnterminatedRawTextElement(token, body, baseDir, ctx, options = {}) {
  const tagName = token.tag.toLowerCase();
  if (tagName === "style") {
    const startTag = await transformStartTag(
      token.tag,
      token.attrs,
      false,
      baseDir,
      ctx,
      "",
      options.inSvgNamespace ? "svg" : "html",
    );
    if (!isCssStyleElementType(token.attrs))
      return `${startTag}${scrubUnsupportedStyleElementBody(body, baseDir, ctx)}`;
    return `${startTag}${escapeRawText(await inlineCss(body, baseDir, ctx, 0, baseDir), "style")}`;
  }
  if (tagName === "script") {
    if (options.inSvgNamespace) return inlineSvgScript(token.tag, token.attrs, body, "", baseDir, ctx);
    const src = getAttr(token.attrs, "src");
    if (!src) return inlineScript(token.tag, token.attrs, body, "", baseDir, ctx);
    warnUnterminatedScriptSrc(src, baseDir, ctx, HTML_REF_OPTIONS);
    const startTag = await transformStartTag(
      token.tag,
      replaceUnresolvedAttrRef(token.attrs, "src", src),
      false,
      baseDir,
      ctx,
      "",
      options.inSvgNamespace ? "svg" : "html",
    );
    return `${startTag}${escapeRawText(scrubRawTextFileUrls(body, ctx), "script")}`;
  }
  const startTag = await transformStartTag(
    token.tag,
    token.attrs,
    false,
    baseDir,
    ctx,
    "",
    options.inSvgNamespace ? "svg" : "html",
  );
  return `${startTag}${scrubRawTextBodyWithoutInlining(token.tag.toLowerCase(), token.attrs, body, baseDir, ctx)}`;
}

function transformInertRawTextElement(token, body, closeTag, baseDir, ctx, options = {}) {
  if (options.warnLocalRefs !== false)
    warnInertStartTagRefs(
      token.tag.toLowerCase(),
      token.attrs,
      baseDir,
      ctx,
      options,
      options.inSvgNamespace ? "svg" : "html",
    );
  const startTag = formatStartTag(
    token.tag,
    scrubInertAttrs(token.tag.toLowerCase(), token.attrs, baseDir, ctx, { ...options, warnLocalRefs: false }),
    false,
  );
  return `${startTag}${scrubRawTextBodyWithoutInlining(
    token.tag.toLowerCase(),
    token.attrs,
    body,
    baseDir,
    ctx,
    options,
  )}${scrubRawTextFileUrls(closeTag, ctx)}`;
}

function scrubRawTextBodyWithoutInlining(tagName, attrs, body, baseDir, ctx, options = {}) {
  if (tagName === "style") {
    const warningKind = options.warnLocalRefs === false ? null : options.localWarningKind || "inert-resource";
    return scrubCssRefsWithoutInlining(body, baseDir, ctx, {
      localWarningKind: warningKind,
      localWarningReason: options.localWarningReason || INERT_RESOURCE_REASON,
    });
  }
  if (tagName === "script") {
    let scrubbed = body;
    const warnActiveScriptDependencies = options.localWarningKind === "srcdoc-resource";
    if (isModuleScript(attrs)) {
      scrubbed = redactInlineModuleFileRefs(scrubbed, ctx, { warnUnresolved: warnActiveScriptDependencies });
      if (warnActiveScriptDependencies) warnInlineModuleImports(scrubbed, baseDir, ctx);
      scrubbed = scrubClassicScriptFileUrlComments(scrubbed, ctx);
    }
    if (isImportMapScript(attrs)) {
      scrubbed = redactInlineImportMapFileRefs(scrubbed, ctx, { warnUnresolved: warnActiveScriptDependencies });
      if (warnActiveScriptDependencies) warnInlineImportMapLocalRefs(scrubbed, baseDir, ctx);
    }
    if (warnActiveScriptDependencies && isClassicScript(attrs)) warnClassicScriptDynamicImports(scrubbed, baseDir, ctx);
    return escapeRawText(scrubRawTextFileUrls(scrubbed, ctx), "script");
  }
  return scrubRawTextFileUrls(body, ctx);
}

async function transformStartTag(tag, attrs, selfClosing, baseDir, ctx, parentTag = "", namespace = "html") {
  const tagName = tag.toLowerCase();
  const elementNamespace = namespace || "html";
  const inHtmlNamespace = elementNamespace === "html";
  const inSvgNamespace = elementNamespace === "svg";
  let next = attrs;
  if (inHtmlNamespace && MEDIA_TAGS.has(tagName)) {
    next = await inlineMediaAttrs(tagName, next, baseDir, ctx, parentTag);
  }
  if (SVG_REF_TAGS.has(tagName) && inSvgNamespace) {
    next = await inlineAttr(next, "href", baseDir, ctx);
    next = await inlineAttr(next, "xlink:href", baseDir, ctx);
  }
  if (tagName === "script" && inSvgNamespace) {
    next = await inlineSvgScriptAttrs(next, baseDir, ctx);
  }
  if (inHtmlNamespace) next = await inlineRenderResourceAttrs(tagName, next, baseDir, ctx);
  next = await inlineStyleAttr(next, baseDir, ctx);
  const isCspMetaTag = inHtmlNamespace && tagName === "meta" && isCspMeta(next);
  if (isCspMetaTag) warnCspMeta(next, ctx);
  if (inHtmlNamespace && tagName === "base") warnBaseHref(next, ctx);
  if (inHtmlNamespace && tagName === "link") {
    const linked = await inlineLink(next, baseDir, ctx);
    if (linked.replacement) return linked.replacement;
    next = linked.attrs;
  }
  next = scrubFileUrlAttrs(next, ctx, { skipNames: fileUrlScrubSkipNames(tagName, isCspMetaTag) });
  return formatStartTag(tag, next, selfClosing);
}

function fileUrlScrubSkipNames(tagName, isCspMetaTag) {
  const names = [];
  if (isCspMetaTag) names.push("content");
  if (tagName === "iframe") names.push("srcdoc");
  return names;
}

function warnBaseHref(attrs, ctx) {
  const attr = findHtmlAttr(attrs, "href");
  if (!attr || !attr.hasValue) return;
  const descriptor = resolveRef(attr.value, localRefBase(ctx.baseDir), ctx, HTML_REF_OPTIONS);
  if (descriptor.kind === "unmapped-root") warnUnresolvedDescriptor(descriptor, attr.value, ctx);
}

function scrubFileUrlAttrs(attrs, ctx, options = {}) {
  let result = attrs;
  const parsed = parseHtmlAttrs(attrs);
  const skipNames = new Set((options.skipNames || []).map((name) => String(name).toLowerCase()));
  for (let index = parsed.length - 1; index >= 0; index -= 1) {
    const attr = parsed[index];
    if (skipNames.has(attr.name.toLowerCase())) continue;
    if (!attr.hasValue || !containsFileUrl(attr.value)) continue;
    ctx.warnings.push({ kind: "file-url-redacted", ref: attr.value });
    result = replaceAttrTokenValue(result, attr, REDACTED_FILE_REF, { preserveEntities: true });
  }
  return result;
}

function scrubInertAttrs(tagName, attrs, baseDir, ctx, options = {}) {
  let result = scrubInertStyleAttr(attrs, baseDir, ctx, options);
  if (tagName === "iframe") result = scrubFrameSrcdoc(result, baseDir, ctx, options);
  const isCspMetaTag = tagName === "meta" && isCspMeta(result);
  if (isCspMetaTag) warnCspMeta(result, ctx);
  result = scrubFileUrlAttrs(result, ctx, { skipNames: fileUrlScrubSkipNames(tagName, isCspMetaTag) });
  return result;
}

function scrubInertStyleAttr(attrs, baseDir, ctx, options = {}) {
  const attr = findHtmlAttr(attrs, "style");
  if (!attr || !attr.hasValue) return attrs;
  const decoded = decodeHtmlCharacterReferences(attr.value);
  const scrubbed = scrubCssRefsWithoutInlining(decoded, baseDir, ctx, {
    localWarningKind: options.warnLocalRefs === false ? null : options.localWarningKind || "inert-resource",
    localWarningReason: options.localWarningReason || INERT_RESOURCE_REASON,
  });
  return scrubbed === decoded ? attrs : replaceAttrTokenValue(attrs, attr, scrubbed);
}

async function inlineRenderResourceAttrs(tagName, attrs, baseDir, ctx) {
  if (tagName === "object") return inlineRenderAttr(attrs, "data", baseDir, ctx, { nestedHtml: true });
  if (tagName === "embed") return inlineRenderAttr(attrs, "src", baseDir, ctx, { nestedHtml: true });
  if (tagName === "input") {
    if (getDecisionAttr(attrs, "type").trim().toLowerCase() !== "image") return attrs;
    return inlineRenderAttr(attrs, "src", baseDir, ctx);
  }
  if (tagName === "iframe")
    return scrubFrameSrcdoc(warnFrameSrc(attrs, baseDir, ctx), baseDir, ctx, {
      localWarningKind: "srcdoc-resource",
      localWarningReason: SRCDOC_RESOURCE_REASON,
    });
  return attrs;
}

async function inlineRenderAttr(attrs, name, baseDir, ctx, options = {}) {
  const value = getAttr(attrs, name);
  if (!value) return attrs;
  if (options.nestedHtml && (isHtmlDocumentRef(value) || isHtmlDocumentType(attrs))) {
    warnUnsupportedFrame(value, baseDir, ctx, HTML_REF_OPTIONS);
    return replaceUnresolvedAttrRef(attrs, name, value);
  }
  return inlineAttr(attrs, name, baseDir, ctx);
}

async function inlineStyleAttr(attrs, baseDir, ctx) {
  const attr = findHtmlAttr(attrs, "style");
  if (!attr || !attr.hasValue) return attrs;
  const decoded = decodeHtmlCharacterReferences(attr.value);
  const rewritten = await inlineCssUrls(decoded, baseDir, ctx, baseDir, { decodeHtmlEntities: false });
  return rewritten === decoded ? attrs : replaceAttrTokenValue(attrs, attr, rewritten);
}

async function inlineLink(attrs, baseDir, ctx) {
  const rel = getTokenListAttr(attrs, "rel");
  const href = getAttr(attrs, "href");
  if (!href) return { attrs };

  if (rel.includes("stylesheet")) {
    if (!isCssStylesheetType(attrs)) {
      warnUnsupportedStylesheetType(href, baseDir, ctx, HTML_REF_OPTIONS);
      return { attrs: replaceUnresolvedAttrRef(attrs, "href", href) };
    }
    if (isInactiveStylesheet(attrs, rel)) {
      warnInactiveStylesheet(href, baseDir, ctx, HTML_REF_OPTIONS);
      return { attrs: replaceUnresolvedAttrRef(attrs, "href", href) };
    }
    if (hasStylesheetBehaviorAttrs(attrs)) {
      warnBehavioralStylesheet(href, baseDir, ctx, HTML_REF_OPTIONS);
      return { attrs: replaceUnresolvedAttrRef(attrs, "href", href) };
    }
    const loaded = await loadText(href, baseDir, ctx, HTML_REF_OPTIONS);
    if (!loaded) return { attrs: replaceUnresolvedAttrRef(attrs, "href", href) };
    const css = await inlineCss(loaded.text, loaded.baseDir, ctx, 0, baseDir);
    const media = scrubGeneratedHtmlAttrValue(getDecisionAttr(attrs, "media"), ctx);
    return {
      replacement: `<style${media ? ` media="${escapeAttr(media)}"` : ""}>${escapeRawText(css, "style")}</style>`,
    };
  }

  if (rel.includes("preload") && getDecisionAttr(attrs, "as").trim().toLowerCase() === "style") {
    warnPreloadStylesheet(href, baseDir, ctx, HTML_REF_OPTIONS);
    return { attrs: replaceUnresolvedAttrRef(attrs, "href", href) };
  }

  if (rel.some((value) => ["icon", "shortcut", "apple-touch-icon", "mask-icon"].includes(value))) {
    const dataUri = await loadDataUri(href, baseDir, ctx, HTML_REF_OPTIONS);
    if (!dataUri) return { attrs: replaceUnresolvedAttrRef(attrs, "href", href) };
    return { attrs: replaceAttrValue(attrs, "href", dataUri) };
  }

  if (isFetchableLinkRel(rel)) {
    warnFetchableLink(href, baseDir, ctx, HTML_REF_OPTIONS);
    return { attrs: replaceUnresolvedAttrRef(attrs, "href", href) };
  }

  return { attrs };
}

function isFetchableLinkRel(rel) {
  return rel.some((value) => ["preload", "modulepreload", "prefetch", "manifest"].includes(value));
}

function isInactiveStylesheet(attrs, rel) {
  return hasAttr(attrs, "disabled") || rel.includes("alternate");
}

function hasStylesheetBehaviorAttrs(attrs) {
  return parseHtmlAttrs(attrs).some((attr) => attr.name.toLowerCase().startsWith("on"));
}

function scrubGeneratedHtmlAttrValue(value, ctx) {
  const text = String(value || "");
  if (!text || !containsFileUrl(text)) return text;
  ctx.warnings.push({ kind: "file-url-redacted", ref: text });
  return REDACTED_FILE_REF;
}

function isCssStylesheetType(attrs) {
  const type = getDecisionAttr(attrs, "type").trim().toLowerCase();
  if (!type) return true;
  return type.split(";")[0].trim() === "text/css";
}

function isCssStyleElementType(attrs) {
  return isCssStylesheetType(attrs);
}

function warnCspMeta(attrs, ctx) {
  if (!isCspMeta(attrs)) return;
  ctx.warnings.push({
    kind: "csp-meta",
    ref: getAttr(attrs, "content") || "Content-Security-Policy",
    reason: "author-set CSP meta is left unchanged and may block inlined export assets",
  });
}

function isCspMeta(attrs) {
  return getDecisionAttr(attrs, "http-equiv").trim().toLowerCase() === "content-security-policy";
}

async function inlineScript(tag, attrs, body, closeTag, baseDir, ctx) {
  const src = getAttr(attrs, "src");
  if (!src) {
    let inlineBody = body;
    if (isModuleScript(attrs)) {
      inlineBody = redactInlineModuleFileRefs(inlineBody, ctx, { warnUnresolved: true });
      warnInlineModuleImports(inlineBody, baseDir, ctx);
      inlineBody = scrubClassicScriptFileUrlComments(inlineBody, ctx);
    }
    if (isImportMapScript(attrs)) {
      inlineBody = redactInlineImportMapFileRefs(inlineBody, ctx, { warnUnresolved: true });
      warnInlineImportMapLocalRefs(inlineBody, baseDir, ctx);
    }
    if (isClassicScript(attrs)) {
      warnClassicScriptDynamicImports(inlineBody, baseDir, ctx);
      inlineBody = scrubClassicScriptFileUrlComments(inlineBody, ctx);
    }
    if (!isClassicScript(attrs) && !isModuleScript(attrs)) inlineBody = scrubRawTextFileUrls(inlineBody, ctx);
    return `${await transformStartTag(tag, attrs, false, baseDir, ctx)}${escapeRawText(inlineBody, "script")}${closeTag}`;
  }
  if (isInjectedLavishSdkSrc(src)) return "";
  if (isModuleScript(attrs)) {
    warnExternalModuleScript(src, baseDir, ctx, HTML_REF_OPTIONS);
    const startTag = await transformStartTag(tag, replaceUnresolvedAttrRef(attrs, "src", src), false, baseDir, ctx);
    return `${startTag}${escapeRawText(scrubRawTextFileUrls(body, ctx), "script")}${closeTag}`;
  }
  if (!isClassicScript(attrs)) {
    warnUnsupportedScriptType(src, baseDir, ctx, HTML_REF_OPTIONS);
    const startTag = await transformStartTag(tag, replaceUnresolvedAttrRef(attrs, "src", src), false, baseDir, ctx);
    return `${startTag}${escapeRawText(scrubRawTextFileUrls(body, ctx), "script")}${closeTag}`;
  }
  if (hasAttr(attrs, "defer") || hasAttr(attrs, "async")) {
    warnUnsupportedScriptTiming(src, baseDir, ctx, HTML_REF_OPTIONS);
    const startTag = await transformStartTag(tag, replaceUnresolvedAttrRef(attrs, "src", src), false, baseDir, ctx);
    return `${startTag}${escapeRawText(scrubRawTextFileUrls(body, ctx), "script")}${closeTag}`;
  }

  const loaded = await loadText(src, baseDir, ctx, HTML_REF_OPTIONS);
  if (!loaded) {
    const startTag = await transformStartTag(tag, replaceUnresolvedAttrRef(attrs, "src", src), false, baseDir, ctx);
    return `${startTag}${escapeRawText(scrubRawTextFileUrls(body, ctx), "script")}${closeTag}`;
  }
  const cleanedAttrs = removeAttrs(attrs, ["src", "integrity", "crossorigin"]);
  const startTag = await transformStartTag(tag, cleanedAttrs, false, baseDir, ctx);
  warnClassicScriptDynamicImports(loaded.text, loaded.baseDir, ctx);
  return `${startTag}${escapeRawText(scrubClassicScriptFileUrlComments(loaded.text, ctx), "script")}${closeTag}`;
}

async function inlineSvgScript(tag, attrs, body, closeTag, baseDir, ctx) {
  const startTag = await transformStartTag(tag, attrs, false, baseDir, ctx, "", "svg");
  const executable = isClassicScript(attrs) || isModuleScript(attrs);
  if (isClassicScript(attrs)) warnClassicScriptDynamicImports(body, baseDir, ctx);
  const scrubbed = executable ? scrubClassicScriptFileUrlComments(body, ctx) : scrubRawTextFileUrls(body, ctx);
  return `${startTag}${escapeRawText(scrubbed, "script")}${closeTag}`;
}

async function inlineSvgScriptAttrs(attrs, baseDir, ctx) {
  let next = attrs;
  next = await inlineSvgScriptAttr(next, "href", baseDir, ctx);
  next = await inlineSvgScriptAttr(next, "xlink:href", baseDir, ctx);
  return next;
}

async function inlineSvgScriptAttr(attrs, name, baseDir, ctx) {
  const value = getAttr(attrs, name);
  if (!value) return attrs;
  const descriptor = resolveRef(value, baseDir, ctx, HTML_REF_OPTIONS);
  if (descriptor.kind !== "file") {
    warnUnresolvedDescriptor(descriptor, value, ctx);
    return replaceUnresolvedAttrRef(attrs, name, value);
  }
  const buffer = await readBudgeted(descriptor, value, ctx);
  if (!buffer) return replaceUnresolvedAttrRef(attrs, name, value);
  const rawText = buffer.toString("utf8");
  if (isClassicScript(attrs)) warnClassicScriptDynamicImports(rawText, path.dirname(descriptor.path), ctx);
  const text = scrubClassicScriptFileUrlComments(rawText, ctx);
  const dataUri = `${toDataUri(Buffer.from(text, "utf8"), pickMime(descriptor.path))}${fragmentSuffix(
    normalizeRefForResolution(value, HTML_REF_OPTIONS),
  )}`;
  return replaceAttrValue(attrs, name, dataUri);
}

async function inlineMediaAttrs(tagName, attrs, baseDir, ctx, parentTag = "") {
  let next = attrs;
  if (tagName === "track" && parentTag !== "video" && parentTag !== "audio") return next;
  if (tagName !== "source" || parentTag === "video" || parentTag === "audio") {
    next = await inlineAttr(next, "src", baseDir, ctx);
  }
  if (tagName === "video") next = await inlineAttr(next, "poster", baseDir, ctx);
  if (tagName === "img" || (tagName === "source" && parentTag === "picture")) {
    next = await inlineSrcset(next, baseDir, ctx);
  }
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
  } else {
    warnUnresolvedDescriptor(classification.descriptor || { kind: classification.kind }, item.parsed.ref, ctx);
  }
}

function rewriteLateCssImports(css, baseDir, ctx, outputBaseDir) {
  let result = "";
  let index = 0;
  let complete = true;
  while (index < css.length) {
    const commentEnd = css.startsWith("/*", index) ? findCssCommentEnd(css, index) : -1;
    if (commentEnd !== -1) {
      result += scrubCssComment(css.slice(index, commentEnd), ctx);
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
      result += scrubCssComment(css.slice(index, commentEnd), ctx);
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
      result += scrubCopiedCssImportRule(rule, parsed, baseDir, ctx, options);
      index = ruleEnd + 1;
      continue;
    }

    if (startsCssKeyword(css, index, "@namespace")) {
      const ruleEnd = findCssAtRuleEnd(css, index);
      if (ruleEnd === -1) {
        result += css.slice(index);
        break;
      }
      result += rebaseCssNamespaceRule(css.slice(index, ruleEnd + 1), baseDir, outputBaseDir, ctx);
      index = ruleEnd + 1;
      continue;
    }

    const conditionalBlock = parseCssConditionalAtRuleBlock(css, index);
    if (conditionalBlock) {
      result += scrubCssNonFetchPrelude(css.slice(index, conditionalBlock.bodyStart), baseDir, ctx, options);
      result += await inlineCssUrls(
        css.slice(conditionalBlock.bodyStart, conditionalBlock.bodyEnd),
        baseDir,
        ctx,
        outputBaseDir,
        options,
      );
      result += css.slice(conditionalBlock.bodyEnd, conditionalBlock.end);
      index = conditionalBlock.end;
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

function scrubCopiedCssImportRule(rule, parsed, baseDir, ctx, options = {}) {
  if (!parsed) return rule;
  const scrubbed = scrubCssRefWithoutInlining(parsed.ref, baseDir, ctx, {
    ...options,
    localWarningKind: null,
    seen: new Set(),
  });
  return scrubbed.replacement
    ? `${rule.slice(0, parsed.refStart)}${scrubbed.replacement}${rule.slice(parsed.refEnd)}`
    : rule;
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
      result += scrubCssComment(args.slice(index, commentEnd), ctx);
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

function scrubCssRefsWithoutInlining(css, baseDir, ctx, options = {}) {
  return scrubCssRefsWithoutInliningInner(css, baseDir, ctx, { ...options, seen: new Set() });
}

function scrubCssRefsWithoutInliningInner(css, baseDir, ctx, options) {
  let result = "";
  let index = 0;
  while (index < css.length) {
    const commentEnd = css.startsWith("/*", index) ? findCssCommentEnd(css, index) : -1;
    if (commentEnd !== -1) {
      result += scrubCssComment(css.slice(index, commentEnd), ctx);
      index = commentEnd;
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
      const scrubbed = parsed ? scrubCssRefWithoutInlining(parsed.ref, baseDir, ctx, options) : null;
      result +=
        scrubbed && scrubbed.replacement
          ? `${rule.slice(0, parsed.refStart)}${scrubbed.replacement}${rule.slice(parsed.refEnd)}`
          : rule;
      index = ruleEnd + 1;
      continue;
    }

    if (startsCssKeyword(css, index, "@namespace")) {
      const ruleEnd = findCssAtRuleEnd(css, index);
      if (ruleEnd === -1) {
        result += css.slice(index);
        break;
      }
      result += rebaseCssNamespaceRule(css.slice(index, ruleEnd + 1), baseDir, baseDir, ctx);
      index = ruleEnd + 1;
      continue;
    }

    const conditionalBlock = parseCssConditionalAtRuleBlock(css, index);
    if (conditionalBlock) {
      result += scrubCssNonFetchPrelude(css.slice(index, conditionalBlock.bodyStart), baseDir, ctx, options);
      result += scrubCssRefsWithoutInliningInner(
        css.slice(conditionalBlock.bodyStart, conditionalBlock.bodyEnd),
        baseDir,
        ctx,
        options,
      );
      result += css.slice(conditionalBlock.bodyEnd, conditionalBlock.end);
      index = conditionalBlock.end;
      continue;
    }

    const imageSet = parseCssImageSetFunction(css, index);
    if (imageSet) {
      result += css.slice(index, imageSet.argsStart);
      result += scrubCssImageSetArgsWithoutInlining(
        css.slice(imageSet.argsStart, imageSet.argsEnd),
        baseDir,
        ctx,
        options,
      );
      result += css.slice(imageSet.argsEnd, imageSet.end);
      index = imageSet.end;
      continue;
    }

    if (css[index] === '"' || css[index] === "'") {
      const stringEnd = findCssStringEnd(css, index);
      result += css.slice(index, stringEnd);
      index = stringEnd;
      continue;
    }

    const token = parseCssUrlToken(css, index);
    if (token) {
      const scrubbed = scrubCssRefWithoutInlining(token.ref, baseDir, ctx, options);
      result += scrubbed.replacement ? `url(${token.quote}${scrubbed.replacement}${token.quote})` : token.raw;
      index = token.end;
      continue;
    }

    result += css[index];
    index += 1;
  }
  return result;
}

function scrubCssNonFetchPrelude(css, baseDir, ctx, options = {}) {
  return scrubCssRefsWithoutInliningInner(css, baseDir, ctx, {
    ...options,
    localWarningKind: null,
    seen: options.seen || new Set(),
  });
}

function scrubCssImageSetArgsWithoutInlining(args, baseDir, ctx, options) {
  let result = "";
  let index = 0;
  let depth = 0;
  while (index < args.length) {
    const commentEnd = args.startsWith("/*", index) ? findCssCommentEnd(args, index) : -1;
    if (commentEnd !== -1) {
      result += scrubCssComment(args.slice(index, commentEnd), ctx);
      index = commentEnd;
      continue;
    }

    if (depth === 0) {
      const token = parseCssUrlToken(args, index);
      if (token) {
        const scrubbed = scrubCssRefWithoutInlining(token.ref, baseDir, ctx, options);
        result += scrubbed.replacement ? `url(${token.quote}${scrubbed.replacement}${token.quote})` : token.raw;
        index = token.end;
        continue;
      }
    }

    if (args[index] === '"' || args[index] === "'") {
      const token = parseCssString(args, index);
      if (depth === 0) {
        const scrubbed = scrubCssRefWithoutInlining(token.value, baseDir, ctx, options);
        result += scrubbed.replacement
          ? quoteCssString(scrubbed.replacement, args[index])
          : args.slice(index, token.end);
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

function scrubCssRefWithoutInlining(ref, baseDir, ctx, options) {
  const refOptions = { cssSyntax: true, decodeHtmlEntities: Boolean(options.decodeHtmlEntities) };
  if (shouldRedactUnresolvedRef(ref, refOptions)) {
    if (shouldWarnRedactedLocalRefAsUnresolved(options)) {
      pushCssScrubWarning(ctx, options, {
        kind: options.localWarningKind,
        ref,
        reason: options.localWarningReason || SRCDOC_RESOURCE_REASON,
      });
    }
    pushCssScrubWarning(ctx, options, { kind: "file-url-redacted", ref });
    return { replacement: REDACTED_FILE_REF };
  }
  if (!options.localWarningKind) return { replacement: "" };
  const descriptor = resolveRef(ref, baseDir, ctx, refOptions);
  if (descriptor.kind === "file") {
    pushCssScrubWarning(ctx, options, {
      kind: options.localWarningKind,
      ref,
      reason: options.localWarningReason,
    });
  } else if (descriptor.kind === "escape" || descriptor.kind === "unmapped-root") {
    pushCssScrubWarning(ctx, options, unresolvedDescriptorWarning(descriptor, ref));
  }
  return { replacement: "" };
}

function shouldWarnRedactedLocalRefAsUnresolved(options = {}) {
  return options.localWarningKind === "srcdoc-resource" || options.localWarningKind === "nested-svg-resource";
}

function pushCssScrubWarning(ctx, options, warning) {
  const key = `${warning.kind}\0${warning.ref}`;
  if (options.seen.has(key)) return;
  options.seen.add(key);
  ctx.warnings.push(warning);
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

    const conditionalBlock = parseCssConditionalAtRuleBlock(css, index);
    if (conditionalBlock) {
      refs.push(...findCssResourceRefs(css.slice(conditionalBlock.bodyStart, conditionalBlock.bodyEnd)));
      index = conditionalBlock.end;
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

function rebaseCssNamespaceRule(rule, baseDir, outputBaseDir, ctx) {
  const parsed = parseCssNamespaceRule(rule);
  if (!parsed) return rule;
  if (shouldRedactUnresolvedRef(parsed.ref, { cssSyntax: true })) {
    ctx.warnings.push({ kind: "file-url-redacted", ref: parsed.ref });
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

function parseCssNamespaceRule(rule) {
  let index = cssKeywordEnd(rule, 0, "@namespace");
  if (index === -1) return null;
  index = skipCssWhitespaceAndComments(rule, index);
  let parsed = parseCssNamespaceRef(rule, index);
  if (parsed) return parsed;
  const prefix = consumeCssIdentifier(rule, index);
  if (!prefix) return null;
  index = skipCssWhitespaceAndComments(rule, prefix.end);
  parsed = parseCssNamespaceRef(rule, index);
  return parsed;
}

function parseCssNamespaceRef(rule, index) {
  if (startsCssKeyword(rule, index, "url")) {
    const token = parseCssUrlToken(rule, index);
    if (!token) return null;
    return { ref: token.ref.trim(), refStart: token.refStart, refEnd: token.refEnd };
  }
  if (rule[index] === '"' || rule[index] === "'") {
    const token = parseCssString(rule, index);
    return { ref: token.value, refStart: index + 1, refEnd: token.end - 1 };
  }
  return null;
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

function parseCssConditionalAtRuleBlock(css, index) {
  if (
    !startsCssKeyword(css, index, "@supports") &&
    !startsCssKeyword(css, index, "@media") &&
    !startsCssKeyword(css, index, "@container")
  ) {
    return null;
  }
  const open = findCssAtRuleBlockStart(css, index);
  if (open === -1) return null;
  const close = findCssBlockEnd(css, open);
  if (close === -1) return null;
  return { bodyStart: open + 1, bodyEnd: close, end: close + 1 };
}

function findCssAtRuleBlockStart(css, index) {
  let cursor = index;
  let parenDepth = 0;
  while (cursor < css.length) {
    if (css.startsWith("/*", cursor)) {
      cursor = findCssCommentEnd(css, cursor);
      continue;
    }
    if (css[cursor] === '"' || css[cursor] === "'") {
      cursor = findCssStringEnd(css, cursor);
      continue;
    }
    if (css[cursor] === "(") {
      parenDepth += 1;
      cursor += 1;
      continue;
    }
    if (css[cursor] === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      cursor += 1;
      continue;
    }
    if (css[cursor] === ";" && parenDepth === 0) return -1;
    if (css[cursor] === "{" && parenDepth === 0) return cursor;
    cursor += 1;
  }
  return -1;
}

function findCssBlockEnd(css, openParen) {
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
    if (css[cursor] === "{") depth += 1;
    if (css[cursor] === "}") {
      depth -= 1;
      if (depth === 0) return cursor;
    }
    cursor += 1;
  }
  return -1;
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

function scrubHtmlComment(raw, ctx) {
  const text = String(raw);
  const closed = text.endsWith("-->");
  const bodyEnd = closed ? text.length - 3 : text.length;
  return `${text.slice(0, 4)}${scrubFileUrlsInCommentBody(text.slice(4, bodyEnd), ctx)}${closed ? "-->" : ""}`;
}

function scrubCssComment(raw, ctx) {
  const text = String(raw);
  const closed = text.endsWith("*/");
  const bodyEnd = closed ? text.length - 2 : text.length;
  return `${text.slice(0, 2)}${scrubFileUrlsInCommentBody(text.slice(2, bodyEnd), ctx)}${closed ? "*/" : ""}`;
}

function scrubFileUrlsInCommentBody(text, ctx) {
  const input = String(text);
  let result = "";
  let index = 0;
  while (index < input.length) {
    if (isTextUrlDelimiter(input[index])) {
      result += input[index];
      index += 1;
      continue;
    }
    const start = index;
    while (index < input.length && !isTextUrlDelimiter(input[index])) index += 1;
    result += scrubFileUrlsInTextToken(input.slice(start, index), ctx);
  }
  return result;
}

function isTextUrlDelimiter(char) {
  return `\t\n\f\r "'<>()=[]{}`.includes(char);
}

function scrubFileUrlsInTextToken(token, ctx) {
  for (let index = 0; index < token.length; index += 1) {
    if (index > 0 && /[a-z0-9+.-]/i.test(token[index - 1])) continue;
    const ref = token.slice(index);
    if (!isFileSchemeRef(ref, { cssSyntax: true, decodeHtmlEntities: true })) continue;
    ctx.warnings.push({ kind: "file-url-redacted", ref });
    return `${token.slice(0, index)}${REDACTED_FILE_REF}`;
  }
  return token;
}

function scrubRawTextFileUrls(text, ctx) {
  return scrubFileUrlsInCommentBody(text, ctx);
}

function scrubClassicScriptFileUrlComments(source, ctx) {
  const input = String(source);
  let result = "";
  let index = 0;
  while (index < input.length) {
    if (input.startsWith("//", index)) {
      const end = input.indexOf("\n", index + 2);
      const bodyEnd = end === -1 ? input.length : end;
      result += `//${scrubFileUrlsInCommentBody(input.slice(index + 2, bodyEnd), ctx)}`;
      if (end === -1) {
        index = input.length;
      } else {
        result += "\n";
        index = end + 1;
      }
      continue;
    }
    if (input.startsWith("/*", index)) {
      const end = input.indexOf("*/", index + 2);
      const bodyEnd = end === -1 ? input.length : end;
      result += `/*${scrubFileUrlsInCommentBody(input.slice(index + 2, bodyEnd), ctx)}${end === -1 ? "" : "*/"}`;
      index = end === -1 ? input.length : end + 2;
      continue;
    }
    if (input.startsWith("<!--", index)) {
      const end = input.indexOf("\n", index + 4);
      const bodyEnd = end === -1 ? input.length : end;
      result += `<!--${scrubFileUrlsInCommentBody(input.slice(index + 4, bodyEnd), ctx)}`;
      if (end === -1) {
        index = input.length;
      } else {
        result += "\n";
        index = end + 1;
      }
      continue;
    }
    if (input.startsWith("-->", index) && isJsHtmlCloseCommentStart(input, index)) {
      const end = input.indexOf("\n", index + 3);
      const bodyEnd = end === -1 ? input.length : end;
      result += `-->${scrubFileUrlsInCommentBody(input.slice(index + 3, bodyEnd), ctx)}`;
      if (end === -1) {
        index = input.length;
      } else {
        result += "\n";
        index = end + 1;
      }
      continue;
    }
    if (input[index] === '"' || input[index] === "'") {
      const end = parseJsString(input, index).end;
      result += input.slice(index, end);
      index = end;
      continue;
    }
    if (input[index] === "`") {
      const end = skipJsTemplate(input, index);
      result += input.slice(index, end);
      index = end;
      continue;
    }
    if (input[index] === "/" && isLikelyJsRegexStart(input, index)) {
      const end = skipJsRegex(input, index);
      result += input.slice(index, end);
      index = end;
      continue;
    }
    result += input[index];
    index += 1;
  }
  return result;
}

function isJsHtmlCloseCommentStart(input, index) {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const char = input[cursor];
    if (char === "\n" || char === "\r") return true;
    if (char !== " " && char !== "\t" && char !== "\f" && char !== "\v") return false;
  }
  return true;
}

function findCssAtRuleEnd(css, index) {
  let cursor = index;
  let parenDepth = 0;
  while (cursor < css.length) {
    if (css.startsWith("/*", cursor)) {
      cursor = findCssCommentEnd(css, cursor);
      continue;
    }
    if (css[cursor] === '"' || css[cursor] === "'") {
      cursor = findCssStringEnd(css, cursor);
      continue;
    }
    if (css[cursor] === "(") {
      parenDepth += 1;
      cursor += 1;
      continue;
    }
    if (css[cursor] === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      cursor += 1;
      continue;
    }
    if (css[cursor] === ";" && parenDepth === 0) return cursor;
    cursor += 1;
  }
  return -1;
}

function findCssPreludeStatementEnd(css, index) {
  let cursor = index;
  let parenDepth = 0;
  while (cursor < css.length) {
    if (css.startsWith("/*", cursor)) {
      cursor = findCssCommentEnd(css, cursor);
      continue;
    }
    if (css[cursor] === '"' || css[cursor] === "'") {
      cursor = findCssStringEnd(css, cursor);
      continue;
    }
    if (css[cursor] === "(") {
      parenDepth += 1;
      cursor += 1;
      continue;
    }
    if (css[cursor] === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      cursor += 1;
      continue;
    }
    if ((css[cursor] === ";" || css[cursor] === "{") && parenDepth === 0) return cursor;
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

function readHtmlToken(html, index) {
  if (html[index] !== "<") return null;
  if (html.startsWith("<!--", index)) {
    const end = html.indexOf("-->", index + 4);
    const tokenEnd = end === -1 ? html.length : end + 3;
    return { type: "comment", raw: html.slice(index, tokenEnd), end: tokenEnd };
  }
  const next = html[index + 1] || "";
  if (next === "!" || next === "?") {
    const end = findHtmlTagEnd(html, index);
    if (end === -1) return null;
    return { type: "special", raw: html.slice(index, end + 1), end: end + 1 };
  }
  if (next === "/") {
    const name = readHtmlTagName(html, index + 2);
    if (!name) return null;
    const end = findHtmlTagEnd(html, index);
    if (end === -1) return null;
    return { type: "close", tag: name.value, raw: html.slice(index, end + 1), end: end + 1 };
  }
  const name = readHtmlTagName(html, index + 1);
  if (!name) return null;
  const end = findHtmlTagEnd(html, index);
  if (end === -1) return null;
  let attrsEnd = end;
  let cursor = end - 1;
  while (cursor > name.end && isHtmlSpace(html[cursor])) cursor -= 1;
  const selfClosing = html[cursor] === "/" && isSelfClosingSlash(html, name.end, end, cursor);
  if (selfClosing) attrsEnd = cursor;
  return {
    type: "start",
    tag: name.value,
    attrs: html.slice(name.end, attrsEnd),
    selfClosing,
    raw: html.slice(index, end + 1),
    end: end + 1,
  };
}

function isSelfClosingSlash(html, attrsStart, tagEnd, slashIndex) {
  const attrs = html.slice(attrsStart, tagEnd);
  const slashOffset = slashIndex - attrsStart;
  for (const attr of parseHtmlAttrs(attrs)) {
    if (attr.hasValue && !attr.quote && attr.valueRawStart <= slashOffset && slashOffset < attr.valueRawEnd) {
      return false;
    }
  }
  return true;
}

function readHtmlTagName(html, index) {
  if (!/[a-z]/i.test(html[index] || "")) return null;
  let cursor = index + 1;
  while (cursor < html.length && /[\w:-]/.test(html[cursor])) cursor += 1;
  const value = html.slice(index, cursor);
  const next = html[cursor] || "";
  if (next && !/[\t\n\f\r />]/.test(next)) return null;
  return { value, end: cursor };
}

function findHtmlTagEnd(html, index) {
  let quote = "";
  for (let cursor = index + 1; cursor < html.length; cursor += 1) {
    const char = html[cursor];
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") return cursor;
  }
  return -1;
}

function findRawTextClose(html, index, tag) {
  let cursor = index;
  while (cursor < html.length) {
    const lt = html.indexOf("</", cursor);
    if (lt === -1) return null;
    const token = readHtmlToken(html, lt);
    if (token?.type === "close" && token.tag.toLowerCase() === tag) {
      return { start: lt, raw: token.raw, end: token.end };
    }
    cursor = lt + 2;
  }
  return null;
}

function findContentClose(html, index, tag) {
  if (tag === "template") return findTemplateClose(html, index);
  return findRawTextClose(html, index, tag);
}

function findTemplateClose(html, index) {
  let depth = 1;
  let cursor = index;
  while (cursor < html.length) {
    const lt = html.indexOf("<", cursor);
    if (lt === -1) return null;
    const token = readHtmlToken(html, lt);
    if (!token) {
      cursor = lt + 1;
      continue;
    }
    if (token.type === "close" && token.tag.toLowerCase() === "template") {
      depth -= 1;
      if (depth === 0) return { start: lt, raw: token.raw, end: token.end };
      cursor = token.end;
      continue;
    }
    if (token.type === "start") {
      const tagName = token.tag.toLowerCase();
      const effectiveSelfClosing = isEffectiveSelfClosingTag(tagName, token.selfClosing);
      if (tagName === "template" && !effectiveSelfClosing) {
        depth += 1;
        cursor = token.end;
        continue;
      }
      if (tagName === PLAINTEXT_TAG && !effectiveSelfClosing) return null;
      if (RAW_TEXT_TAGS.has(tagName) && !effectiveSelfClosing) {
        const close = findRawTextClose(html, token.end, tagName);
        if (!close) return null;
        cursor = close.end;
        continue;
      }
    }
    cursor = token.end;
  }
  return null;
}

// --- resolution + loading ---------------------------------------------------

function resolveDocumentRefBase(html, ctx) {
  const href = findFirstDocumentBaseHref(html);
  if (!href) return localRefBase(ctx.baseDir);
  return refBaseFromHref(href, ctx.baseDir);
}

function findFirstDocumentBaseHref(html) {
  let index = 0;
  const openStack = [];
  while (index < html.length) {
    const lt = html.indexOf("<", index);
    if (lt === -1) break;
    const token = readHtmlToken(html, lt);
    if (!token) {
      index = lt + 1;
      continue;
    }
    if (token.type === "close") {
      popHtmlParent(openStack, token.tag.toLowerCase());
      index = token.end;
      continue;
    }
    if (token.type === "start") {
      const tag = token.tag.toLowerCase();
      const elementNamespace = elementNamespaceForTag(tag, openStack);
      const effectiveSelfClosing = isEffectiveSelfClosingTag(tag, token.selfClosing, openStack, elementNamespace);
      if (elementNamespace === "html" && tag === "base") {
        const href = getAttr(token.attrs, "href");
        if (href) return href;
      }
      if (elementNamespace === "html" && tag === PLAINTEXT_TAG && !effectiveSelfClosing) break;
      if (elementNamespace === "html" && INERT_CONTENT_TAGS.has(tag) && !effectiveSelfClosing) {
        const close = findContentClose(html, token.end, tag);
        if (close) {
          index = close.end;
          continue;
        }
        break;
      }
      if (isRawTextElementForNamespace(tag, elementNamespace) && !effectiveSelfClosing) {
        const close = findContentClose(html, token.end, tag);
        if (close) {
          index = close.end;
          continue;
        }
        break;
      }
      if (!effectiveSelfClosing && !HTML_VOID_TAGS.has(tag)) pushHtmlParent(openStack, tag, elementNamespace);
    }
    index = token.end;
  }
  return null;
}

function refBaseFromHref(href, documentDir) {
  const trimmed = decodeHtmlCharacterReferences(String(href || "").trim());
  const schemeRef = normalizeRefForScheme(trimmed, HTML_REF_OPTIONS);
  if (!trimmed || isInert(schemeRef || trimmed)) return localRefBase(documentDir);
  if (schemeRef.startsWith("//") || /^https?:\/\//i.test(schemeRef)) return { kind: "remote" };
  if (isFileSchemeRef(trimmed, HTML_REF_OPTIONS)) {
    try {
      const fileHref = stripQueryAndHash(schemeRef);
      return localRefBase(directoryFromBasePath(fileURLToPath(fileHref), fileHref));
    } catch {
      return { kind: "remote" };
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(schemeRef)) return { kind: "remote" };
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
      return { kind: "unparseable-file-url" };
    }
  }

  // Any other explicit scheme (ftp:, ws:, custom:) is left as a reference.
  if (/^[a-z][a-z0-9+.-]*:/i.test(schemeRef)) return { kind: "skip" };

  if (base.kind === "remote") return { kind: "skip" };
  const effectiveRef = base.kind === "root" && !trimmed.startsWith("/") ? rootRelativeRef(base.path, trimmed) : trimmed;
  const localPath = decodeLocalPath(stripQueryAndHash(effectiveRef));
  if (effectiveRef.startsWith("/")) {
    const mapped = ctx.resolveAbsolute(localPath);
    return mapped
      ? { kind: "file", path: mapped, allowOutsideRoot: true }
      : { kind: "unmapped-root", ref: effectiveRef };
  }
  const resolved = resolveLocalPathPreservingTrailingSlash(base.dir, localPath);
  if (ctx.confineDir && isOutside(ctx.confineDir, resolved)) return { kind: "escape", path: resolved };
  return { kind: "file", path: resolved };
}

function resolveLocalPathPreservingTrailingSlash(baseDir, localPath) {
  const resolved = path.resolve(baseDir, localPath);
  return localPath.endsWith("/") && !resolved.endsWith(path.sep) ? `${resolved}${path.sep}` : resolved;
}

function warnUnresolvedDescriptor(descriptor, ref, ctx) {
  const warning = unresolvedDescriptorWarning(descriptor, ref);
  if (warning) ctx.warnings.push(warning);
  if (descriptor.kind === "unparseable-file-url") ctx.warnings.push({ kind: "file-url-redacted", ref });
}

function unresolvedDescriptorWarning(descriptor, ref) {
  if (descriptor.kind === "escape") return { kind: "outside-root", ref };
  if (descriptor.kind === "unparseable-file-url") {
    return {
      kind: "file-url-unresolved",
      ref,
      reason: "file URL could not be resolved to a local file and was redacted",
    };
  }
  if (descriptor.kind === "unmapped-root") {
    return {
      kind: "unmapped-root-absolute",
      ref: descriptor.ref || ref,
      reason: "root-absolute reference has no trusted local mapping and is left unchanged",
    };
  }
  return null;
}

async function loadText(ref, baseDir, ctx, options = {}) {
  const descriptor = resolveRef(ref, baseDir, ctx, options);
  return loadTextFromDescriptor(descriptor, ref, ctx);
}

async function loadTextFromDescriptor(descriptor, ref, ctx, options = {}) {
  if (descriptor.kind !== "file") {
    warnUnresolvedDescriptor(descriptor, ref, ctx);
    return null;
  }
  const buffer = await readBudgeted(descriptor, ref, ctx, options);
  if (!buffer) return null;
  return { text: buffer.toString("utf8"), baseDir: path.dirname(descriptor.path), byteLength: buffer.length };
}

async function loadDataUri(ref, baseDir, ctx, options = {}) {
  const descriptor = resolveRef(ref, baseDir, ctx, options);
  if (descriptor.kind !== "file") {
    warnUnresolvedDescriptor(descriptor, ref, ctx);
    return null;
  }
  const buffer = await readBudgeted(descriptor, ref, ctx);
  if (!buffer) return null;
  const mime = pickMime(descriptor.path);
  if (mime === "image/svg+xml") {
    const svg = sanitizeSvgTextForDataUri(buffer.toString("utf8"), path.dirname(descriptor.path), ctx);
    return `${toDataUri(Buffer.from(svg, "utf8"), mime)}${fragmentSuffix(normalizeRefForResolution(ref, options))}`;
  }
  return toDataUri(buffer, mime);
}

function sanitizeSvgTextForDataUri(svg, baseDir, ctx) {
  return transformInertMarkup(svg, baseDir, ctx, {
    localWarningKind: "nested-svg-resource",
    localWarningReason: "nested SVG resources are left as references inside inlined SVG assets",
  });
}

function warnUnsupportedScriptTiming(ref, baseDir, ctx, options = {}) {
  const descriptor = resolveRef(ref, baseDir, ctx, options);
  if (descriptor.kind === "file") {
    ctx.warnings.push({
      kind: "unsupported-script-timing",
      ref,
      reason: "defer and async scripts are left as references to preserve execution timing",
    });
  } else {
    warnUnresolvedDescriptor(descriptor, ref, ctx);
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
  } else {
    warnUnresolvedDescriptor(descriptor, ref, ctx);
  }
}

function warnBehavioralStylesheet(ref, baseDir, ctx, options = {}) {
  const descriptor = resolveRef(ref, baseDir, ctx, options);
  if (descriptor.kind === "file") {
    ctx.warnings.push({
      kind: "behavioral-stylesheet",
      ref,
      reason: "stylesheet links with event handler attributes are left as references to preserve behavior",
    });
  } else {
    warnUnresolvedDescriptor(descriptor, ref, ctx);
  }
}

function warnPreloadStylesheet(ref, baseDir, ctx, options = {}) {
  const descriptor = resolveRef(ref, baseDir, ctx, options);
  if (descriptor.kind === "file") {
    ctx.warnings.push({
      kind: "preload-stylesheet",
      ref,
      reason: "preload-as-style links are left as references to preserve activation behavior",
    });
  } else {
    warnUnresolvedDescriptor(descriptor, ref, ctx);
  }
}

function warnFetchableLink(ref, baseDir, ctx, options = {}) {
  const descriptor = resolveRef(ref, baseDir, ctx, options);
  if (descriptor.kind === "file") {
    ctx.warnings.push({
      kind: "fetchable-link",
      ref,
      reason: "fetchable link hints are left as references",
    });
  } else {
    warnUnresolvedDescriptor(descriptor, ref, ctx);
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
  } else {
    warnUnresolvedDescriptor(descriptor, ref, ctx);
  }
}

function warnUnterminatedScriptSrc(ref, baseDir, ctx, options = {}) {
  const descriptor = resolveRef(ref, baseDir, ctx, options);
  if (descriptor.kind === "file") {
    ctx.warnings.push({
      kind: "unterminated-script-src",
      ref,
      reason: "unterminated script src is left as a reference to preserve raw-text parsing",
    });
  } else {
    warnUnresolvedDescriptor(descriptor, ref, ctx);
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
  } else {
    warnUnresolvedDescriptor(descriptor, ref, ctx);
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
  } else {
    warnUnresolvedDescriptor(descriptor, ref, ctx);
  }
}

function scrubUnsupportedStyleElementBody(css, baseDir, ctx) {
  return scrubCssRefsWithoutInlining(css, baseDir, ctx, {
    localWarningKind: "unsupported-style-type",
    localWarningReason: "non-CSS style elements are left unchanged",
  });
}

function warnFrameSrc(attrs, baseDir, ctx) {
  const ref = getAttr(attrs, "src");
  if (!ref) return attrs;
  warnUnsupportedFrame(ref, baseDir, ctx, HTML_REF_OPTIONS);
  return replaceUnresolvedAttrRef(attrs, "src", ref);
}

function scrubFrameSrcdoc(attrs, baseDir, ctx, options = {}) {
  const attr = findHtmlAttr(attrs, "srcdoc");
  if (!attr || !attr.hasValue) return attrs;
  const decoded = decodeHtmlCharacterReferences(attr.value);
  const scrubbed = transformInertMarkup(decoded, baseDir, ctx, {
    localWarningKind: options.localWarningKind || "inert-resource",
    localWarningReason: options.localWarningReason || SRCDOC_RESOURCE_REASON,
  });
  return scrubbed === decoded ? attrs : replaceAttrTokenValue(attrs, attr, scrubbed);
}

function warnUnsupportedFrame(ref, baseDir, ctx, options = {}) {
  const descriptor = resolveRef(ref, baseDir, ctx, options);
  if (descriptor.kind === "file") {
    ctx.warnings.push({
      kind: "unsupported-frame",
      ref,
      reason: "iframe documents are left as references because nested HTML is not bundled",
    });
  } else {
    warnUnresolvedDescriptor(descriptor, ref, ctx);
  }
}

function warnInertStartTagRefs(tagName, attrs, baseDir, ctx, options = {}, namespace = "html") {
  const elementNamespace = namespace || "html";
  const inHtmlNamespace = elementNamespace === "html";
  const inSvgNamespace = elementNamespace === "svg";
  if (inHtmlNamespace && MEDIA_TAGS.has(tagName)) {
    warnInertAttrRef(attrs, "src", baseDir, ctx, HTML_REF_OPTIONS, options);
    if (tagName === "video") warnInertAttrRef(attrs, "poster", baseDir, ctx, HTML_REF_OPTIONS, options);
    if (tagName === "img" || tagName === "source") warnInertSrcsetRefs(attrs, baseDir, ctx, options);
  }
  if (SVG_REF_TAGS.has(tagName) && inSvgNamespace) {
    warnInertAttrRef(attrs, "href", baseDir, ctx, HTML_REF_OPTIONS, options);
    warnInertAttrRef(attrs, "xlink:href", baseDir, ctx, HTML_REF_OPTIONS, options);
  }
  if (inHtmlNamespace && tagName === "object") warnInertAttrRef(attrs, "data", baseDir, ctx, HTML_REF_OPTIONS, options);
  if (tagName === "script" && inSvgNamespace) {
    warnInertAttrRef(attrs, "href", baseDir, ctx, HTML_REF_OPTIONS, options);
    warnInertAttrRef(attrs, "xlink:href", baseDir, ctx, HTML_REF_OPTIONS, options);
  }
  if (inHtmlNamespace && (tagName === "embed" || tagName === "script" || tagName === "iframe")) {
    warnInertAttrRef(attrs, "src", baseDir, ctx, HTML_REF_OPTIONS, options);
  }
  if (inHtmlNamespace && tagName === "input" && getDecisionAttr(attrs, "type").trim().toLowerCase() === "image") {
    warnInertAttrRef(attrs, "src", baseDir, ctx, HTML_REF_OPTIONS, options);
  }
  if (inHtmlNamespace && tagName === "link") {
    const rel = getTokenListAttr(attrs, "rel");
    if (
      rel.includes("stylesheet") ||
      rel.some((value) => ["icon", "shortcut", "apple-touch-icon", "mask-icon"].includes(value)) ||
      isFetchableLinkRel(rel)
    ) {
      warnInertAttrRef(attrs, "href", baseDir, ctx, HTML_REF_OPTIONS, options);
    }
  }
  warnInertStyleRefs(attrs, baseDir, ctx, options);
}

function warnInertAttrRef(attrs, name, baseDir, ctx, refOptions = {}, warningOptions = {}) {
  const ref = getAttr(attrs, name);
  if (ref) warnInertResource(ref, baseDir, ctx, refOptions, warningOptions);
}

function warnInertSrcsetRefs(attrs, baseDir, ctx, options = {}) {
  const value = getAttr(attrs, "srcset");
  if (!value) return;
  for (const candidate of parseSrcsetCandidates(value)) {
    warnInertResource(value.slice(candidate.urlStart, candidate.urlEnd), baseDir, ctx, HTML_REF_OPTIONS, options);
  }
}

function warnInertStyleRefs(attrs, baseDir, ctx, options = {}) {
  const attr = findHtmlAttr(attrs, "style");
  if (!attr || !attr.hasValue) return;
  const decoded = decodeHtmlCharacterReferences(attr.value);
  const seen = new Set();
  for (const ref of findCssResourceRefs(decoded)) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    warnInertResource(ref, baseDir, ctx, { cssSyntax: true }, options);
  }
}

function warnInertResource(ref, baseDir, ctx, refOptions = {}, warningOptions = {}) {
  if (shouldRedactUnresolvedRef(ref, refOptions)) {
    if (shouldWarnRedactedLocalRefAsUnresolved(warningOptions)) {
      ctx.warnings.push({
        kind: warningOptions.localWarningKind,
        ref,
        reason: warningOptions.localWarningReason || SRCDOC_RESOURCE_REASON,
      });
    }
    return;
  }
  const descriptor = resolveRef(ref, baseDir, ctx, refOptions);
  if (descriptor.kind !== "file") {
    warnUnresolvedDescriptor(descriptor, ref, ctx);
    return;
  }
  ctx.warnings.push({
    kind: warningOptions.localWarningKind || "inert-resource",
    ref,
    reason: warningOptions.localWarningReason || INERT_RESOURCE_REASON,
  });
}

function warnInlineModuleImports(body, baseDir, ctx) {
  for (const ref of findInlineModuleImportRefs(body)) {
    const normalized = normalizeJsRefForScheme(ref);
    if (!isLocalModuleImport(normalized)) continue;
    warnInlineModuleImport(normalized, baseDir, ctx);
  }
}

function warnClassicScriptDynamicImports(body, baseDir, ctx) {
  for (const ref of findInlineDynamicImportRefs(body)) {
    const normalized = normalizeJsRefForScheme(ref);
    if (!isLocalModuleImport(normalized)) continue;
    warnInlineModuleImport(normalized, baseDir, ctx);
  }
}

function redactInlineModuleFileRefs(body, ctx, options = {}) {
  const refs = findInlineModuleImportRefTokens(body).filter((ref) => isFileSchemeJsRef(ref.value));
  if (refs.length === 0) return body;
  for (const ref of refs) {
    if (options.warnUnresolved) pushInlineModuleImportWarning(ctx, ref.value);
    ctx.warnings.push({ kind: "file-url-redacted", ref: ref.value });
  }
  let result = body;
  for (let index = refs.length - 1; index >= 0; index -= 1) {
    const ref = refs[index];
    result = `${result.slice(0, ref.rawStart)}${quoteJsModuleSpecifier(REDACTED_FILE_REF, ref.quote)}${result.slice(
      ref.rawEnd,
    )}`;
  }
  return result;
}

function warnInlineImportMapLocalRefs(body, baseDir, ctx) {
  for (const ref of findImportMapLocalRefs(body)) {
    const descriptor = resolveRef(ref, baseDir, ctx);
    if (descriptor.kind === "file") {
      pushInlineImportMapLocalRefWarning(ctx, ref);
    } else {
      warnUnresolvedDescriptor(descriptor, ref, ctx);
    }
  }
}

function redactInlineImportMapFileRefs(body, ctx, options = {}) {
  let map;
  try {
    map = JSON.parse(body);
  } catch {
    return body;
  }
  let changed = false;
  const redactImports = (imports) => {
    if (!imports || typeof imports !== "object" || Array.isArray(imports)) return imports;
    let redacted = false;
    const nextImports = {};
    for (const [key, value] of Object.entries(imports)) {
      let nextKey = key;
      let nextValue = value;
      if (isFileSchemeRef(key)) {
        if (options.warnUnresolved) pushInlineImportMapLocalRefWarning(ctx, key);
        ctx.warnings.push({ kind: "file-url-redacted", ref: key });
        nextKey = REDACTED_FILE_REF;
        redacted = true;
      }
      if (typeof value === "string" && isFileSchemeRef(value)) {
        if (options.warnUnresolved) pushInlineImportMapLocalRefWarning(ctx, value);
        ctx.warnings.push({ kind: "file-url-redacted", ref: value });
        nextValue = REDACTED_FILE_REF;
        redacted = true;
      }
      nextImports[nextKey] = nextValue;
    }
    if (redacted) changed = true;
    return redacted ? nextImports : imports;
  };
  if (map && map.imports) map.imports = redactImports(map.imports);
  if (map && map.scopes && typeof map.scopes === "object" && !Array.isArray(map.scopes)) {
    const scopes = {};
    for (const [scopePrefix, scopedImports] of Object.entries(map.scopes)) {
      let nextPrefix = scopePrefix;
      if (isFileSchemeRef(scopePrefix)) {
        if (options.warnUnresolved) pushInlineImportMapLocalRefWarning(ctx, scopePrefix);
        ctx.warnings.push({ kind: "file-url-redacted", ref: scopePrefix });
        nextPrefix = REDACTED_FILE_REF;
        changed = true;
      }
      scopes[nextPrefix] = redactImports(scopedImports);
    }
    map.scopes = scopes;
  }
  return changed ? JSON.stringify(map) : body;
}

function pushInlineModuleImportWarning(ctx, ref) {
  ctx.warnings.push({
    kind: "inline-module-import",
    ref,
    reason: "inline module imports are left as references",
  });
}

function pushInlineImportMapLocalRefWarning(ctx, ref) {
  ctx.warnings.push({
    kind: "inline-importmap-local-ref",
    ref,
    reason: "inline import maps are left unchanged; local mapped modules are not bundled",
  });
}

function warnInlineModuleImport(ref, baseDir, ctx) {
  const descriptor = resolveRef(ref, baseDir, ctx);
  if (descriptor.kind === "file") {
    pushInlineModuleImportWarning(ctx, ref);
  } else {
    warnUnresolvedDescriptor(descriptor, ref, ctx);
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
  } else {
    warnUnresolvedDescriptor(descriptor, ref, ctx);
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
  } else {
    warnUnresolvedDescriptor(descriptor, ref, ctx);
  }
}

function warnCssImportOrder(ref, descriptor, ctx) {
  if (descriptor.kind === "file") {
    ctx.warnings.push({
      kind: "css-import-order",
      ref,
      reason: "CSS @import is left as a reference to preserve import ordering",
    });
  } else {
    warnUnresolvedDescriptor(descriptor, ref, ctx);
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
  } else {
    warnUnresolvedDescriptor(descriptor, ref, ctx);
  }
}

function warnUnterminatedRawText(tagName, ctx) {
  ctx.warnings.push({
    kind: "unterminated-raw-text",
    ref: tagName,
    reason: "raw-text or inert content continues to EOF and is left unbundled",
  });
}

function isModuleScript(attrs) {
  return getDecisionAttr(attrs, "type").trim().toLowerCase() === "module";
}

function isImportMapScript(attrs) {
  return getDecisionAttr(attrs, "type").trim().toLowerCase() === "importmap";
}

function isClassicScript(attrs) {
  const type = getDecisionAttr(attrs, "type").trim().toLowerCase();
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
  return findInlineModuleImportRefTokens(source).map((ref) => ref.value);
}

function findInlineDynamicImportRefs(source) {
  return findInlineModuleImportRefTokens(source)
    .filter((ref) => ref.importKind === "dynamic")
    .map((ref) => ref.value);
}

function findInlineModuleImportRefTokens(source) {
  const refs = [];
  let index = 0;
  while (index < source.length) {
    const skipped = skipJsIgnored(source, index);
    if (skipped !== index) {
      index = skipped;
      continue;
    }
    if (startsJsKeyword(source, index, "import") && !isJsPropertyAccessKeyword(source, index)) {
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

function findImportMapLocalRefs(body) {
  let map;
  try {
    map = JSON.parse(body);
  } catch {
    return [];
  }
  const refs = [];
  const seen = new Set();
  collectImportMapAddressRefs(map && map.imports, refs, seen);
  if (map && map.scopes && typeof map.scopes === "object" && !Array.isArray(map.scopes)) {
    for (const [scopePrefix, scopedImports] of Object.entries(map.scopes)) {
      collectImportMapScopeRef(scopePrefix, refs, seen);
      collectImportMapAddressRefs(scopedImports, refs, seen);
    }
  }
  return refs;
}

function collectImportMapAddressRefs(imports, refs, seen) {
  if (!imports || typeof imports !== "object" || Array.isArray(imports)) return;
  for (const value of Object.values(imports)) {
    if (typeof value !== "string" || !isLocalImportMapAddress(value)) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    refs.push(value);
  }
}

function collectImportMapScopeRef(scopePrefix, refs, seen) {
  if (typeof scopePrefix !== "string" || !isLocalImportMapAddress(scopePrefix)) return;
  if (seen.has(scopePrefix)) return;
  seen.add(scopePrefix);
  refs.push(scopePrefix);
}

function isLocalImportMapAddress(ref) {
  const trimmed = String(ref || "").trim();
  if (!trimmed || isInert(trimmed)) return false;
  if (trimmed.startsWith("//") || /^https?:\/\//i.test(trimmed)) return false;
  if (isFileSchemeRef(trimmed)) return true;
  return !/^[a-z][a-z0-9+.-]*:/i.test(trimmed);
}

function parseJsImport(source, index) {
  let cursor = skipJsWhitespaceAndComments(source, index + "import".length);
  if (source[cursor] === ".") return { refs: [], end: cursor + 1 };
  if (source[cursor] === "(") {
    cursor = skipJsWhitespaceAndComments(source, cursor + 1);
    if (source[cursor] === "`") {
      const token = parseJsTemplateImportToken(source, cursor);
      token.importKind = "dynamic";
      return { refs: token.value ? [token] : [], end: token.end };
    }
    if (source[cursor] !== '"' && source[cursor] !== "'") return { refs: [], end: cursor + 1 };
    const token = parseJsStringToken(source, cursor);
    token.importKind = "dynamic";
    return { refs: [token], end: token.end };
  }
  if (source[cursor] === '"' || source[cursor] === "'") {
    const token = parseJsStringToken(source, cursor);
    token.importKind = "bare";
    return { refs: [token], end: token.end };
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
    if (topLevel && source[cursor] === ";") return { ref: null, end: cursor + 1 };
    if (
      topLevel &&
      cursor !== index &&
      (startsJsKeyword(source, cursor, "import") || startsJsKeyword(source, cursor, "export"))
    ) {
      return { ref: null, end: cursor };
    }
    if (topLevel && startsJsKeyword(source, cursor, "from")) {
      const refStart = skipJsWhitespaceAndComments(source, cursor + "from".length);
      if (source[refStart] === '"' || source[refStart] === "'") {
        const token = parseJsStringToken(source, refStart);
        return { ref: token, end: token.end };
      }
    }
    cursor += 1;
  }
  return { ref: null, end: cursor };
}

function isLocalModuleImport(ref) {
  const trimmed = String(ref || "").trim();
  if (!trimmed || isInert(trimmed)) return false;
  if (trimmed.startsWith("//") || /^https?:\/\//i.test(trimmed)) return false;
  return trimmed.startsWith("/") || /^\.{1,2}\//.test(trimmed);
}

function isFileSchemeJsRef(ref) {
  return /^file:/i.test(normalizeJsRefForScheme(ref));
}

function normalizeJsRefForScheme(ref) {
  return decodeJsEscapes(String(ref || ""))
    .replace(/[\t\n\r]/g, "")
    .trim();
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

function parseJsStringToken(source, index) {
  const parsed = parseJsString(source, index);
  return {
    value: parsed.value,
    quote: source[index],
    rawStart: index,
    rawEnd: parsed.end,
    end: parsed.end,
  };
}

function parseJsTemplateImportToken(source, index) {
  const end = skipJsTemplate(source, index);
  return {
    value: source.slice(index + 1, Math.max(index + 1, end - 1)),
    quote: "`",
    rawStart: index,
    rawEnd: end,
    end,
  };
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

function isJsPropertyAccessKeyword(source, index) {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/.test(source[cursor])) cursor -= 1;
  return source[cursor] === ".";
}

function isJsIdentChar(char) {
  return Boolean(char) && /[a-z0-9_$]/i.test(char);
}

function decodeJsEscapes(value) {
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
    if (/[\n\r]/.test(next)) {
      index += 2;
      continue;
    }
    if (next === "x" && /^[\da-f]{2}$/i.test(input.slice(index + 2, index + 4))) {
      result += decodeNumericCharacterReference(Number.parseInt(input.slice(index + 2, index + 4), 16), "");
      index += 4;
      continue;
    }
    if (next === "u" && input[index + 2] === "{") {
      const close = input.indexOf("}", index + 3);
      const hex = close === -1 ? "" : input.slice(index + 3, close);
      if (/^[\da-f]+$/i.test(hex)) {
        result += decodeNumericCharacterReference(Number.parseInt(hex, 16), "");
        index = close + 1;
        continue;
      }
    }
    if (next === "u" && /^[\da-f]{4}$/i.test(input.slice(index + 2, index + 6))) {
      result += decodeNumericCharacterReference(Number.parseInt(input.slice(index + 2, index + 6), 16), "");
      index += 6;
      continue;
    }
    result += next;
    index += 2;
  }
  return result;
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

function isHtmlDocumentRef(ref) {
  const locator = normalizeRefForResolution(ref, HTML_REF_OPTIONS).trim();
  const { pathPart } = splitRefSuffix(locator);
  return [".html", ".htm", ".xhtml"].includes(path.extname(decodeLocalPath(pathPart)).toLowerCase());
}

function isHtmlDocumentType(attrs) {
  const type = getDecisionAttr(attrs, "type").trim().toLowerCase().split(";")[0].trim();
  return type === "text/html" || type === "application/xhtml+xml";
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
  return String(value).replace(
    /&(?:#(\d+);?|#x([\da-f]+);?|([a-z][a-z0-9]+);|([a-z][a-z0-9]+)(?=[^a-z0-9=]|$))/gi,
    (match, decimal, hex, named, legacyNamed) => {
      if (decimal) return decodeNumericCharacterReference(Number.parseInt(decimal, 10), match);
      if (hex) return decodeNumericCharacterReference(Number.parseInt(hex, 16), match);
      const entity = named || legacyNamed;
      return HTML_ENTITY_MAP[entity.toLowerCase()] ?? match;
    },
  );
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
  const attr = findHtmlAttr(attrs, name);
  return attr && attr.hasValue ? attr.value : "";
}

function getDecisionAttr(attrs, name) {
  const value = getAttr(attrs, name);
  return value ? decodeHtmlCharacterReferences(value) : "";
}

function getTokenListAttr(attrs, name) {
  return getDecisionAttr(attrs, name).toLowerCase().split(/\s+/).filter(Boolean);
}

function hasAttr(attrs, name) {
  return Boolean(findHtmlAttr(attrs, name));
}

function replaceAttrValue(source, name, value) {
  const attr = findHtmlAttr(source, name);
  return attr ? replaceAttrTokenValue(source, attr, value) : source;
}

function replaceAttrValuePreservingEntities(source, name, value) {
  const attr = findHtmlAttr(source, name);
  return attr ? replaceAttrTokenValue(source, attr, value, { preserveEntities: true }) : source;
}

function removeAttrs(attrs, names) {
  const remove = new Set(names.map((name) => String(name).toLowerCase()));
  const parsed = parseHtmlAttrs(attrs);
  let result = "";
  let lastIndex = 0;
  for (const attr of parsed) {
    if (!remove.has(attr.name.toLowerCase())) continue;
    result += attrs.slice(lastIndex, attr.start);
    lastIndex = attr.end;
  }
  result += attrs.slice(lastIndex);
  const trimmed = result.trim();
  return trimmed ? ` ${trimmed}` : "";
}

function findHtmlAttr(attrs, name) {
  const lower = String(name).toLowerCase();
  return parseHtmlAttrs(attrs).find((attr) => attr.name.toLowerCase() === lower) || null;
}

function parseHtmlAttrs(attrs) {
  const input = String(attrs || "");
  const parsed = [];
  let index = 0;
  while (index < input.length) {
    while (index < input.length && isHtmlSpace(input[index])) index += 1;
    if (index >= input.length) break;
    if (input[index] === "/") {
      index += 1;
      continue;
    }
    if (/[<>"'=]/.test(input[index])) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < input.length && !/[\t\n\f\r />"'=]/.test(input[index])) index += 1;
    if (index === start) {
      index += 1;
      continue;
    }
    const name = input.slice(start, index);
    const nameEnd = index;
    let cursor = index;
    while (cursor < input.length && isHtmlSpace(input[cursor])) cursor += 1;
    if (input[cursor] !== "=") {
      parsed.push({
        start,
        end: nameEnd,
        name,
        nameEnd,
        hasValue: false,
        value: "",
        valueRawStart: nameEnd,
        valueRawEnd: nameEnd,
        quote: "",
      });
      index = cursor;
      continue;
    }
    cursor += 1;
    while (cursor < input.length && isHtmlSpace(input[cursor])) cursor += 1;
    const valueRawStart = cursor;
    let valueStart = cursor;
    let valueEnd;
    let valueRawEnd;
    let quote = "";
    if (input[cursor] === '"' || input[cursor] === "'") {
      quote = input[cursor];
      valueStart = cursor + 1;
      cursor += 1;
      while (cursor < input.length && input[cursor] !== quote) cursor += 1;
      valueEnd = cursor;
      valueRawEnd = cursor < input.length ? cursor + 1 : cursor;
    } else {
      while (cursor < input.length && !/[\t\n\f\r >]/.test(input[cursor])) cursor += 1;
      valueEnd = cursor;
      valueRawEnd = cursor;
    }
    parsed.push({
      start,
      end: valueRawEnd,
      name,
      nameEnd,
      hasValue: true,
      value: input.slice(valueStart, valueEnd),
      valueRawStart,
      valueRawEnd,
      quote,
    });
    index = valueRawEnd;
  }
  return parsed;
}

function replaceAttrTokenValue(source, attr, value, options = {}) {
  const quote = attr.quote || '"';
  const raw = options.preserveEntities ? quoteAttrValuePreservingEntities(value, quote) : quoteAttrValue(value, quote);
  if (!attr.hasValue) {
    return `${source.slice(0, attr.nameEnd)}=${raw}${source.slice(attr.nameEnd)}`;
  }
  return `${source.slice(0, attr.valueRawStart)}${raw}${source.slice(attr.valueRawEnd)}`;
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

function quoteJsModuleSpecifier(value, quote) {
  if (quote === "`") {
    return `\`${String(value).replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${")}\``;
  }
  const preferred = quote === "'" ? "'" : '"';
  return `${preferred}${String(value)
    .replace(/\\/g, "\\\\")
    .replace(new RegExp(escapeRegExp(preferred), "g"), `\\${preferred}`)
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")}${preferred}`;
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
