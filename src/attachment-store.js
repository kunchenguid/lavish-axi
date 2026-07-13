import crypto from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

// Content-addressed storage for annotation image attachments, kept out of
// `state.json` on purpose: `SessionStore` rewrites the whole state file on every
// operation, so multi-MB image bytes would turn each unrelated store write into a
// large rewrite (and blow past the 2 MB JSON cap on the prompts route). Bytes live
// as one file per (session key, content hash) under `<state-dir>/attachments/`,
// next to the whiteboard sidecars.
//
// The id is `<sha256-of-bytes>.<ext>` and the on-disk file is the whole identity:
// the client never dictates the path or id, and every field the agent receives is
// re-derived from disk (see `resolveAttachment`) rather than trusted from the
// payload, so a crafted prompt can't point an attachment at an arbitrary file.

const KEY_RE = /^[0-9a-f]{16}$/;
const ID_RE = /^[0-9a-f]{64}\.(png|jpg|webp)$/;

// Magic-byte detection is authoritative; a lying Content-Type is ignored. Only
// these three raster formats are accepted for v1 (SVG is an active-content
// surface; animated GIF is out on size/semantics).
const MIME_BY_EXT = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

export const DEFAULT_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MiB per image
export const DEFAULT_MAX_ATTACHMENTS_PER_PROMPT = 4;
export const DEFAULT_MAX_PROMPT_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MiB per annotation
export const DEFAULT_ATTACHMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

let temporaryFileId = 0;

export function isValidAttachmentKey(key) {
  return KEY_RE.test(String(key || ""));
}

export function isValidAttachmentId(id) {
  return ID_RE.test(String(id || ""));
}

export function attachmentsDir(stateDir, key) {
  return path.join(stateDir, "attachments", String(key));
}

function attachmentFile(stateDir, key, id) {
  return path.join(attachmentsDir(stateDir, key), id);
}

// Limits are configurable in the LAVISH_AXI_* style, mirroring the idle-timeout
// resolver: unset falls back to the default, `0`/`off` disables a duration, and a
// non-positive or unparseable value falls back rather than throwing.
export function resolveAttachmentConfig(env = process.env) {
  return {
    maxBytes: positiveIntEnv(env.LAVISH_AXI_MAX_ATTACHMENT_BYTES, DEFAULT_MAX_ATTACHMENT_BYTES),
    maxPerPrompt: positiveIntEnv(env.LAVISH_AXI_MAX_ATTACHMENTS_PER_PROMPT, DEFAULT_MAX_ATTACHMENTS_PER_PROMPT),
    maxPromptBytes: positiveIntEnv(env.LAVISH_AXI_MAX_PROMPT_ATTACHMENT_BYTES, DEFAULT_MAX_PROMPT_ATTACHMENT_BYTES),
    ttlMs: durationEnv(env.LAVISH_AXI_ATTACHMENT_TTL_MS, DEFAULT_ATTACHMENT_TTL_MS),
    maxDiskBytes: diskCapEnv(env.LAVISH_AXI_MAX_ATTACHMENT_DISK_MB),
  };
}

function positiveIntEnv(raw, fallback) {
  const trimmed = String(raw ?? "").trim();
  if (trimmed === "") return fallback;
  const value = Number(trimmed);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function durationEnv(raw, fallback) {
  const trimmed = String(raw ?? "").trim();
  if (trimmed === "") return fallback;
  if (trimmed === "0" || trimmed.toLowerCase() === "off") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function diskCapEnv(raw) {
  const trimmed = String(raw ?? "").trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value > 0 ? Math.floor(value * 1024 * 1024) : null;
}

// Detect the image format from magic bytes alone. Returns { mime, ext } or null.
export function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { mime: "image/png", ext: "png" };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return { mime: "image/webp", ext: "webp" };
  }
  return null;
}

// Parse intrinsic pixel dimensions from the image header. Best-effort: returns
// { width, height } or null (a display hint only, so a parse miss is harmless).
export function imageDimensions(buffer, mime) {
  if (!Buffer.isBuffer(buffer)) return null;
  try {
    if (mime === "image/png") return pngDimensions(buffer);
    if (mime === "image/jpeg") return jpegDimensions(buffer);
    if (mime === "image/webp") return webpDimensions(buffer);
  } catch {
    return null;
  }
  return null;
}

function pngDimensions(b) {
  if (b.length < 24 || b.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function jpegDimensions(b) {
  const len = b.length;
  let offset = 2;
  while (offset + 1 < len) {
    if (b[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    let marker = b[offset + 1];
    // Skip fill bytes (0xff padding between markers).
    while (marker === 0xff && offset + 2 < len) {
      offset += 1;
      marker = b[offset + 1];
    }
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= len) break;
    const segmentLength = b.readUInt16BE(offset);
    // SOF0-SOF15 carry the frame geometry; SOF4/SOF8/SOF12 are not frame headers.
    const isFrameHeader = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrameHeader) {
      if (offset + 7 >= len) break;
      return { height: b.readUInt16BE(offset + 3), width: b.readUInt16BE(offset + 5) };
    }
    offset += segmentLength;
  }
  return null;
}

function webpDimensions(b) {
  if (b.length < 25) return null;
  const fourcc = b.toString("ascii", 12, 16);
  if (fourcc === "VP8 " && b.length >= 30) {
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (fourcc === "VP8L") {
    const b0 = b[21];
    const b1 = b[22];
    const b2 = b[23];
    const b3 = b[24];
    return {
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
    };
  }
  if (fourcc === "VP8X" && b.length >= 30) {
    return {
      width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)),
      height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)),
    };
  }
  return null;
}

function buildMetadata(id, file, mime, bytes, dims) {
  return {
    id,
    type: "image",
    path: file,
    mime,
    bytes,
    width: dims?.width || 0,
    height: dims?.height || 0,
  };
}

async function pathExists(file) {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function writeFileAtomically(file, content) {
  const temporary = `${file}.${process.pid}.${++temporaryFileId}.tmp`;
  try {
    await writeFile(temporary, content);
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function statusError(message, statusCode) {
  /** @type {Error & { statusCode: number }} */
  const error = Object.assign(new Error(message), { statusCode });
  return error;
}

// Validate (size + magic bytes, magic bytes authoritative), content-hash, and
// write the bytes atomically. Identical content dedupes to the same file. Errors
// carry an HTTP statusCode so the server's error handler surfaces 413/415/400.
export async function writeAttachment(stateDir, key, buffer, { maxBytes = DEFAULT_MAX_ATTACHMENT_BYTES } = {}) {
  if (!isValidAttachmentKey(key)) throw statusError(`invalid attachment session key: ${key}`, 400);
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw statusError("empty attachment upload", 400);
  if (buffer.length > maxBytes) throw statusError(`attachment exceeds the ${maxBytes} byte limit`, 413);
  const type = detectImageType(buffer);
  if (!type) throw statusError("unsupported image type (expected PNG, JPEG, or WebP)", 415);
  const id = `${crypto.createHash("sha256").update(buffer).digest("hex")}.${type.ext}`;
  const dir = attachmentsDir(stateDir, key);
  await mkdir(dir, { recursive: true });
  const file = attachmentFile(stateDir, key, id);
  if (!(await pathExists(file))) await writeFileAtomically(file, buffer);
  return buildMetadata(id, file, type.mime, buffer.length, imageDimensions(buffer, type.mime));
}

// The trust boundary: resolve a client-supplied id to server-vetted metadata by
// reading the file on disk. Every field (absolute path, mime, byte size,
// dimensions) is derived here, never taken from the caller. Returns null when the
// id is malformed or no such file exists for this session.
export async function resolveAttachment(stateDir, key, id) {
  if (!isValidAttachmentKey(key) || !isValidAttachmentId(id)) return null;
  const file = attachmentFile(stateDir, key, id);
  let info;
  try {
    info = await stat(file);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile()) return null;
  const mime = MIME_BY_EXT[id.slice(id.lastIndexOf(".") + 1)];
  const dims = await readDimensions(file, mime);
  return buildMetadata(id, file, mime, info.size, dims);
}

async function readDimensions(file, mime) {
  try {
    return imageDimensions(await readFile(file), mime);
  } catch {
    return null;
  }
}

// Absolute on-disk path for a stored attachment, or null if the id is malformed.
// Used by the fetch endpoint, which independently confirms the file exists.
export function attachmentPath(stateDir, key, id) {
  if (!isValidAttachmentKey(key) || !isValidAttachmentId(id)) return null;
  return attachmentFile(stateDir, key, id);
}

export async function removeAttachment(stateDir, key, id) {
  if (!isValidAttachmentKey(key) || !isValidAttachmentId(id)) return false;
  const file = attachmentFile(stateDir, key, id);
  try {
    await rm(file);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}
