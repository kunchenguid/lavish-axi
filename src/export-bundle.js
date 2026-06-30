import { readFile, realpath } from "node:fs/promises";
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

/**
 * @param {string} html
 * @param {object} [options]
 * @param {string} [options.baseDir] Directory to resolve relative references against.
 * @param {(absPath: string) => Promise<Uint8Array>} [options.readLocalFile] Read a local file (default applies the real-path confinement guard).
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
    readLocalFile: options.readLocalFile || ((absPath) => guardedRead(absPath, confineDir)),
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
  const baseDir = ctx.baseDir;
  let result = stripLavishSdk(html);
  result = await replaceAsync(result, /<style\b([^>]*)>([\s\S]*?)<\/style>/gi, async (match, attrs, css) => {
    return `<style${attrs}>${escapeRawText(await inlineCss(css, baseDir, ctx, 0), "style")}</style>`;
  });
  result = await replaceAsync(result, /<link\b([^>]*?)\/?>/gi, (match, attrs) =>
    inlineLink(match, attrs, baseDir, ctx),
  );
  result = await replaceAsync(result, /<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (match, attrs, body) =>
    inlineScript(match, attrs, body, baseDir, ctx),
  );
  result = await replaceAsync(result, /<(img|source|video|audio)\b([^>]*?)\/?>/gi, async (match, tag, attrs) => {
    return `<${tag}${await inlineMediaAttrs(attrs, baseDir, ctx)}>`;
  });
  result = await replaceAsync(result, /<(use|image)\b([^>]*?)\/?>/gi, async (match, tag, attrs) => {
    let next = await inlineAttr(attrs, "href", baseDir, ctx);
    next = await inlineAttr(next, "xlink:href", baseDir, ctx);
    return `<${tag}${next}>`;
  });
  result = await replaceAsync(result, /style\s*=\s*("([^"]*)"|'([^']*)')/gi, async (match, _quoted, dq, sq) => {
    const quote = dq !== undefined ? '"' : "'";
    const value = dq !== undefined ? dq : sq;
    if (!/url\(/i.test(value)) return match;
    return `style=${quote}${await inlineCssUrls(value, baseDir, ctx)}${quote}`;
  });
  return result;
}

// The SDK is appended only when the server serves the artifact; a file read from disk should
// not carry it, but strip defensively so an exported page never points back at /sdk.js.
function stripLavishSdk(html) {
  return html.replace(
    /<script\b[^>]*\bsrc\s*=\s*("[^"]*\/sdk\.js[^"]*"|'[^']*\/sdk\.js[^']*')[^>]*>\s*<\/script>/gi,
    "",
  );
}

async function inlineLink(match, attrs, baseDir, ctx) {
  const rel = (getAttr(attrs, "rel") || "").toLowerCase().split(/\s+/);
  const href = getAttr(attrs, "href");
  if (!href) return match;

  if (rel.includes("stylesheet")) {
    const loaded = await loadText(href, baseDir, ctx);
    if (!loaded) return match;
    const css = await inlineCss(loaded.text, loaded.baseDir, ctx, 0);
    const media = getAttr(attrs, "media");
    return `<style${media ? ` media="${escapeAttr(media)}"` : ""}>${escapeRawText(css, "style")}</style>`;
  }

  if (rel.some((value) => ["icon", "shortcut", "apple-touch-icon", "mask-icon"].includes(value))) {
    const dataUri = await loadDataUri(href, baseDir, ctx);
    if (!dataUri) return match;
    return replaceAttrValue(match, "href", dataUri);
  }

  return match;
}

async function inlineScript(match, attrs, body, baseDir, ctx) {
  const src = getAttr(attrs, "src");
  if (!src) return match;
  if (/\/sdk\.js(\?|"|'|$)/i.test(src)) return "";

  const loaded = await loadText(src, baseDir, ctx);
  if (!loaded) return match;
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
  const dataUri = await loadDataUri(value, baseDir, ctx);
  if (!dataUri) return attrs;
  return replaceAttrValue(attrs, name, dataUri);
}

async function inlineSrcset(attrs, baseDir, ctx) {
  const value = getAttr(attrs, "srcset");
  if (!value) return attrs;
  // srcset is a comma-separated list of "url descriptor"; load candidates sequentially so the
  // per-bundle byte budget is honored rather than racing many reads at once.
  const out = [];
  for (const candidate of value.split(",")) {
    const parts = candidate.trim().split(/\s+/);
    if (!parts[0]) {
      out.push(candidate.trim());
      continue;
    }
    const dataUri = await loadDataUri(parts[0], baseDir, ctx);
    out.push(dataUri ? [dataUri, ...parts.slice(1)].join(" ") : candidate.trim());
  }
  return replaceAttrValue(attrs, "srcset", out.join(", "));
}

async function inlineCss(css, baseDir, ctx, depth) {
  const withImports = await replaceAsync(
    css,
    /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)([^;]*);/gi,
    async (match, _q1, urlRef, _q2, strRef, mediaRaw) => {
      const ref = urlRef ?? strRef;
      if (depth >= ctx.maxDepth) return match;
      const loaded = await loadText(ref, baseDir, ctx);
      if (!loaded) return match;
      const inner = await inlineCss(loaded.text, loaded.baseDir, ctx, depth + 1);
      const media = (mediaRaw || "").trim();
      return media ? `@media ${media}{${inner}}` : inner;
    },
  );
  return inlineCssUrls(withImports, baseDir, ctx);
}

async function inlineCssUrls(css, baseDir, ctx) {
  return replaceAsync(css, /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, async (match, quote, ref) => {
    const trimmed = ref.trim();
    if (isInert(trimmed)) return match;
    const dataUri = await loadDataUri(trimmed, baseDir, ctx);
    if (!dataUri) return match;
    return `url(${quote}${dataUri}${quote})`;
  });
}

// --- resolution + loading ---------------------------------------------------

// Classify a reference. Remote and unsupported-scheme refs resolve to `skip`, meaning "leave the
// reference exactly as written" - they are not fetched. Only local refs become `file`.
function resolveRef(ref, baseDir, ctx) {
  const trimmed = String(ref).trim();
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

  const localRef = stripQueryAndHash(trimmed);
  if (trimmed.startsWith("/")) {
    const mapped = ctx.resolveAbsolute(localRef);
    return mapped ? { kind: "file", path: mapped } : { kind: "skip" };
  }
  const resolved = path.resolve(baseDir, localRef);
  if (ctx.confineDir && isOutside(ctx.confineDir, resolved)) return { kind: "escape", path: resolved };
  return { kind: "file", path: resolved };
}

async function loadText(ref, baseDir, ctx) {
  const descriptor = resolveRef(ref, baseDir, ctx);
  if (descriptor.kind !== "file") {
    if (descriptor.kind === "escape") ctx.warnings.push({ kind: "outside-root", ref });
    return null;
  }
  const buffer = await readBudgeted(descriptor.path, ref, ctx);
  if (!buffer) return null;
  return { text: buffer.toString("utf8"), baseDir: path.dirname(descriptor.path) };
}

async function loadDataUri(ref, baseDir, ctx) {
  const descriptor = resolveRef(ref, baseDir, ctx);
  if (descriptor.kind !== "file") {
    if (descriptor.kind === "escape") ctx.warnings.push({ kind: "outside-root", ref });
    return null;
  }
  const buffer = await readBudgeted(descriptor.path, ref, ctx);
  if (!buffer) return null;
  return toDataUri(buffer, pickMime(descriptor.path));
}

// Read a local file, enforcing per-asset and per-bundle size caps so a huge local asset cannot
// blow up memory or the bundle. The real-path confinement guard lives in the default readLocalFile.
async function readBudgeted(absPath, ref, ctx) {
  let buffer;
  try {
    buffer = toBuffer(await ctx.readLocalFile(absPath));
  } catch (error) {
    if (error && error.code === "OUTSIDE_ROOT") {
      ctx.warnings.push({ kind: "outside-root", ref });
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
  if (ctx.inlinedBytes + buffer.length > ctx.maxBundleBytes) {
    ctx.warnings.push({ kind: "too-large", ref, reason: `would exceed per-bundle cap ${ctx.maxBundleBytes}` });
    return null;
  }
  ctx.inlinedBytes += buffer.length;
  return buffer;
}

// Default local read: resolve the real (symlink-followed) path and refuse to read anything that
// escapes the artifact directory, so a symlink inside the directory cannot exfiltrate an outside
// file (e.g. ~/.ssh/id_rsa) into an exported or publicly shared bundle.
async function guardedRead(absPath, confineDir) {
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
  return readFile(real);
}

// --- helpers ----------------------------------------------------------------

function isInert(ref) {
  // `#a` and its percent-encoded form `%23a` are in-document fragment references (e.g. SVG
  // filter/mask ids), not fetchable resources, so leave them untouched.
  return !ref || ref.startsWith("#") || /^%23/i.test(ref) || /^(data|blob|about|javascript|mailto|tel):/i.test(ref);
}

function isOutside(root, target) {
  const relative = path.relative(root, target);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function stripQueryAndHash(ref) {
  return ref.replace(/[?#].*$/, "");
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

function replaceAttrValue(source, name, value) {
  const re = new RegExp(`(^|\\s)(${escapeRegExp(name)}\\s*=\\s*)("[^"]*"|'[^']*'|[^\\s"'>]+)`, "i");
  return source.replace(re, `$1$2"${escapeAttr(value)}"`);
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
