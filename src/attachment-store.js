import crypto from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
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
// A bounded default disk quota: without a cap the reference-aware sweeper only
// enforces the TTL, so a same-origin confused-deputy artifact (see chrome-client's
// upload mediation) could grow attachment storage without bound. Capping the total
// by default lets the sweeper evict oldest UNREFERENCED bytes; `off`/`0` disables.
export const DEFAULT_MAX_ATTACHMENT_DISK_BYTES = 512 * 1024 * 1024; // 512 MiB

// Attachments are user screenshots: they can capture anything on screen, and the
// state dir sits in a home directory that is commonly traversable by other local
// users. The process umask (typically 0022) would otherwise leave them 0644 in
// 0755 dirs, so every mode is set explicitly rather than inherited.
const ATTACHMENT_FILE_MODE = 0o600;
const ATTACHMENT_DIR_MODE = 0o700;

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

// Floor BEFORE the bounds check, never after: a fractional value like `0.5` is
// > 0 and so passes a positivity test, then floors to 0 - a limit of zero, which
// disables uploads server-side while the SDK still advertises its own default cap.
// A configured limit that cannot mean "at least one" is a typo, so fall back.
function positiveIntEnv(raw, fallback) {
  const trimmed = String(raw ?? "").trim();
  if (trimmed === "") return fallback;
  const value = Math.floor(Number(trimmed));
  return Number.isFinite(value) && value >= 1 ? value : fallback;
}

function durationEnv(raw, fallback) {
  const trimmed = String(raw ?? "").trim();
  if (trimmed === "") return fallback;
  if (trimmed === "0" || trimmed.toLowerCase() === "off") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function diskCapEnv(raw, fallback = DEFAULT_MAX_ATTACHMENT_DISK_BYTES) {
  const trimmed = String(raw ?? "").trim();
  if (trimmed === "") return fallback;
  if (trimmed === "0" || trimmed.toLowerCase() === "off") return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  // Same floor-first discipline as positiveIntEnv: only `0`/`off` may mean "no
  // cap", so an MB value too small to round up to a single byte is a typo, not a
  // zero-byte quota that would evict every unreferenced file on the next sweep.
  const bytes = Math.floor(value * 1024 * 1024);
  return bytes >= 1 ? bytes : fallback;
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
    if (marker === 0x01 || marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
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

// D6 dims sidecar: a tiny JSON file written beside the image at upload time so the
// trust boundary (resolveAttachment, called on every /prompts) and the thumbnail
// GET never re-read the whole image just to recover its pixel geometry. The `.meta`
// suffix keeps it outside ID_RE, so listAttachments/the sweeper ignore it as an
// attachment; it is removed alongside its image on delete/sweep.
function sidecarPath(file) {
  return `${file}.meta`;
}

async function writeSidecar(file, meta) {
  try {
    await writeFileAtomically(sidecarPath(file), JSON.stringify(meta));
  } catch {
    // Dimensions are a display hint only; a sidecar write miss just means
    // resolveAttachment falls back to a one-off header parse.
  }
}

async function readSidecarDims(file) {
  try {
    const parsed = JSON.parse(await readFile(sidecarPath(file), "utf8"));
    const width = Number(parsed?.width);
    const height = Number(parsed?.height);
    if (Number.isFinite(width) && Number.isFinite(height) && (width > 0 || height > 0)) {
      return { width, height };
    }
  } catch {
    // No sidecar (pre-D6 upload) or unreadable - signal a full-parse fallback.
  }
  return null;
}

async function writeFileAtomically(file, content) {
  const temporary = `${file}.${process.pid}.${++temporaryFileId}.tmp`;
  try {
    // The mode is applied at creation, and rename preserves it, so the final file
    // is never briefly world-readable the way a create-then-chmod would leave it.
    await writeFile(temporary, content, { mode: ATTACHMENT_FILE_MODE });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

// Create the session's attachment dir (and the root above it) owner-only. `mkdir`
// only applies its mode to dirs it actually creates, so the modes are also
// re-asserted: an install that uploaded before this hardening already has 0755
// dirs on disk, and leaving those exposes the screenshots already stored in them.
async function ensureAttachmentDir(stateDir, key) {
  const root = path.join(stateDir, "attachments");
  const dir = attachmentsDir(stateDir, key);
  await mkdir(dir, { recursive: true, mode: ATTACHMENT_DIR_MODE });
  for (const target of [root, dir]) {
    // Best effort: a dir owned by another user can't be chmod'ed, but then it is
    // not ours to police either - the create mode above still covers our own dirs.
    await chmod(target, ATTACHMENT_DIR_MODE).catch(() => {});
  }
  return dir;
}

function statusError(message, statusCode) {
  /** @type {Error & { statusCode: number }} */
  const error = Object.assign(new Error(message), { statusCode });
  return error;
}

// Validate (size + magic bytes, magic bytes authoritative), content-hash, and
// write the bytes atomically. Identical content dedupes to the same file. Errors
// carry an HTTP statusCode so the server's error handler surfaces 413/415/400.
export async function writeAttachment(
  stateDir,
  key,
  buffer,
  { maxBytes = DEFAULT_MAX_ATTACHMENT_BYTES, touchFile = utimes } = {},
) {
  if (!isValidAttachmentKey(key)) throw statusError(`invalid attachment session key: ${key}`, 400);
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw statusError("empty attachment upload", 400);
  if (buffer.length > maxBytes) throw statusError(`attachment exceeds the ${maxBytes} byte limit`, 413);
  const type = detectImageType(buffer);
  if (!type) throw statusError("unsupported image type (expected PNG, JPEG, or WebP)", 415);
  const id = `${crypto.createHash("sha256").update(buffer).digest("hex")}.${type.ext}`;
  await ensureAttachmentDir(stateDir, key);
  const file = attachmentFile(stateDir, key, id);
  const dims = imageDimensions(buffer, type.mime);
  if (!(await pathExists(file))) {
    await writeFileAtomically(file, buffer);
  } else {
    // B3: dedup re-upload of identical content must refresh the mtime so a new
    // reference restarts the TTL clock. Otherwise an aged-but-re-referenced file
    // is reaped by the very next sweep, breaking the fresh prompt's thumbnail.
    const now = new Date();
    try {
      await touchFile(file, now, now);
    } catch {
      // The refresh is load-bearing, so a failure must never be swallowed into a
      // success: the caller would queue a prompt against an id the very next sweep
      // can still reap. Rewriting the identical bytes refreshes the mtime through a
      // different syscall path, and it is atomic (temp + rename), so a concurrent
      // reader never observes a partial file. If that fails too, report the failure.
      await writeFileAtomically(file, buffer);
    }
  }
  await writeSidecar(file, {
    v: 1,
    mime: type.mime,
    bytes: buffer.length,
    width: dims?.width || 0,
    height: dims?.height || 0,
  });
  return buildMetadata(id, file, type.mime, buffer.length, dims);
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
  // D6: prefer the dims sidecar (a few bytes) over re-reading the whole image.
  const dims = (await readSidecarDims(file)) ?? (await readDimensions(file, mime));
  return buildMetadata(id, file, mime, info.size, dims);
}

// Lightweight serve resolution for the thumbnail GET: confirm the file exists and
// derive the mime from the (already-validated) id extension, WITHOUT reading the
// image bytes to recompute dimensions the route never uses. Returns { file, mime }
// or null. Pairs with sendFile so a render is one stat + one streamed read, not two
// full reads (see D6 in AGENTS.md).
export async function statAttachmentForServe(stateDir, key, id) {
  if (!isValidAttachmentKey(key) || !isValidAttachmentId(id)) return null;
  const file = attachmentFile(stateDir, key, id);
  try {
    const info = await stat(file);
    if (!info.isFile()) return null;
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
  return { file, mime: MIME_BY_EXT[id.slice(id.lastIndexOf(".") + 1)] };
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
    await rm(sidecarPath(file), { force: true }).catch(() => {});
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      await rm(sidecarPath(file), { force: true }).catch(() => {});
      return false;
    }
    throw error;
  }
}

// Enumerate every stored attachment as { key, id, path, bytes, mtimeMs }. Only
// well-formed session dirs and content-hash ids are reported, so stray temp files
// or foreign entries are ignored.
export async function listAttachments(stateDir) {
  const root = path.join(stateDir, "attachments");
  const sessionDirs = await readdirSafe(root);
  const files = [];
  for (const dirent of sessionDirs) {
    if (!dirent.isDirectory() || !isValidAttachmentKey(dirent.name)) continue;
    const dir = path.join(root, dirent.name);
    for (const entry of await readdirSafe(dir)) {
      if (!entry.isFile() || !isValidAttachmentId(entry.name)) continue;
      const filePath = path.join(dir, entry.name);
      try {
        const info = await stat(filePath);
        files.push({ key: dirent.name, id: entry.name, path: filePath, bytes: info.size, mtimeMs: info.mtimeMs });
      } catch {
        // Raced with a delete; skip it.
      }
    }
  }
  return files;
}

// Reference-aware cleanup. A file is removed only when it is BOTH older than the
// TTL AND not referenced by any pending prompt (`referenced` holds `key/id`
// strings), so an attachment that belongs to a queued-but-undelivered prompt
// (including a send-and-end batch) is never reaped, whatever its age. When a disk
// cap is set, oldest UNREFERENCED files are then evicted until under the cap;
// referenced files are never evicted even if that leaves the total over budget.
export async function sweepAttachments(stateDir, options = {}) {
  const { ttlMs = DEFAULT_ATTACHMENT_TTL_MS, maxDiskBytes = null, referenced = new Set(), now = Date.now() } = options;
  const files = await listAttachments(stateDir);
  let deleted = 0;
  let freedBytes = 0;
  const survivors = [];
  for (const file of files) {
    const isReferenced = referenced.has(`${file.key}/${file.id}`);
    const expired = ttlMs != null && now - file.mtimeMs > ttlMs;
    if (!isReferenced && expired) {
      if (await removeFile(file.path)) {
        deleted += 1;
        freedBytes += file.bytes;
      } else {
        // The delete failed, so these bytes are still on disk. Omitting the file
        // here would hide them from the disk-cap accounting below, letting the
        // quota stay exceeded while nothing gets evicted. It stays unreferenced,
        // so the cap pass may retry it.
        survivors.push({ ...file, referenced: false });
      }
    } else {
      survivors.push({ ...file, referenced: isReferenced });
    }
  }
  if (maxDiskBytes != null) {
    let total = survivors.reduce((sum, file) => sum + file.bytes, 0);
    const evictable = survivors.filter((file) => !file.referenced).sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const file of evictable) {
      if (total <= maxDiskBytes) break;
      if (await removeFile(file.path)) {
        deleted += 1;
        freedBytes += file.bytes;
        total -= file.bytes;
      }
    }
  }
  await pruneEmptyDirs(path.join(stateDir, "attachments"));
  return { deleted, freedBytes };
}

async function readdirSafe(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function removeFile(file) {
  try {
    await rm(file, { force: true });
    await rm(sidecarPath(file), { force: true }).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

async function pruneEmptyDirs(root) {
  for (const dirent of await readdirSafe(root)) {
    if (!dirent.isDirectory()) continue;
    const dir = path.join(root, dirent.name);
    try {
      if ((await readdir(dir)).length === 0) await rm(dir, { recursive: true, force: true });
    } catch {
      // Best effort - a non-empty or vanished dir is fine to leave alone.
    }
  }
}
