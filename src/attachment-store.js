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

// How long a freshly written attachment is shielded from disk-cap eviction. An
// unreferenced file this new may be a "ready card" the user dropped into the composer
// but has not queued on a prompt yet; evicting it under disk pressure would delete the
// bytes out from under an imminent Send (unrecoverable not-found). It is symmetric with
// `ATTACHMENT_DELIVERY_GRACE_MS` in session-store: recently uploaded and recently
// delivered attachments are both protected for a bounded window. The grace never lets
// the total exceed the cap (admission still refuses new uploads with 507 when only
// referenced/fresh bytes remain); it only makes the cap prefer refusing a new write
// over destroying a ready card. The TTL still reclaims a genuinely abandoned card.
export const ATTACHMENT_EVICTION_GRACE_MS = 60 * 60 * 1000; // 1 hour

// Attachments are user screenshots: they can capture anything on screen, and the
// state dir sits in a home directory that is commonly traversable by other local
// users. The process umask (typically 0022) would otherwise leave them 0644 in
// 0755 dirs, so every mode is set explicitly rather than inherited.
const ATTACHMENT_FILE_MODE = 0o600;
const ATTACHMENT_DIR_MODE = 0o700;

// The unit the disk cap charges per stored object. A 12-byte image plus its ~40-byte
// sidecar occupies two filesystem blocks, not 52 logical bytes: charging logical
// `size` alone let a flood of tiny magic-prefix uploads sit ~683x under the reported
// total while consuming real disk (blocks + inodes). Accounting rounds each file up
// to this block and adds the sidecar's own block, so the cap sees allocated cost.
// 4096 is the near-universal block size; it does not need to match the exact device.
export const ATTACHMENT_ALLOC_BLOCK_BYTES = 4096;

// Round a file's logical size up to whole allocation blocks (min one block for any
// existing file, matching how a filesystem reserves at least a block per inode).
function allocatedBytes(logicalBytes) {
  const n = Math.max(0, Number(logicalBytes) || 0);
  return Math.max(1, Math.ceil(n / ATTACHMENT_ALLOC_BLOCK_BYTES)) * ATTACHMENT_ALLOC_BLOCK_BYTES;
}

// `writeFileAtomically` writes `<name>.<pid>.<n>.tmp` then renames. A crash between
// the two leaves that temp behind, and because it does not match ID_RE it is invisible
// to listAttachments and to every cap - the bytes leak forever (D6). This matches the
// store's own temp names only (two numeric segments + .tmp), never a real id or sidecar.
const TEMP_FILE_RE = /\.\d+\.\d+\.tmp$/;
// Only reap a temp older than this: a live atomic write renames within milliseconds,
// so anything this stale can only be crash debris - never an in-progress write.
const ATTACHMENT_TEMP_GRACE_MS = 5 * 60 * 1000; // 5 minutes
// A dims sidecar is `<id>.meta`; capture the image id so an orphan sidecar (image
// gone) can be reaped. A live upload always writes the image BEFORE its sidecar, so a
// sidecar-without-image is unambiguous crash/failed-delete debris - no grace needed
// (ATTACH-002).
const SIDECAR_ORPHAN_RE = /^([0-9a-f]{64}\.(?:png|jpg|webp))\.meta$/;

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
  const maxDiskBytes = diskCapEnv(env.LAVISH_AXI_MAX_ATTACHMENT_DISK_MB);
  return {
    maxBytes: positiveIntEnv(env.LAVISH_AXI_MAX_ATTACHMENT_BYTES, DEFAULT_MAX_ATTACHMENT_BYTES),
    maxPerPrompt: positiveIntEnv(env.LAVISH_AXI_MAX_ATTACHMENTS_PER_PROMPT, DEFAULT_MAX_ATTACHMENTS_PER_PROMPT),
    maxPromptBytes: positiveIntEnv(env.LAVISH_AXI_MAX_PROMPT_ATTACHMENT_BYTES, DEFAULT_MAX_PROMPT_ATTACHMENT_BYTES),
    ttlMs: durationEnv(env.LAVISH_AXI_ATTACHMENT_TTL_MS, DEFAULT_ATTACHMENT_TTL_MS),
    maxDiskBytes,
    // DERIVED from the disk budget, never a separate knob: the most stored objects
    // the byte cap could ever admit is the budget divided by the minimum per-object
    // charge (an image block + a sidecar block). Deriving it means the object bound
    // can only agree with the byte cap, never contradict it - avoiding a second
    // hand-picked constant that could drift out of sync.
    maxObjects: maxDiskBytes == null ? null : Math.floor(maxDiskBytes / (2 * ATTACHMENT_ALLOC_BLOCK_BYTES)),
    // Fixed safety window (not env-tunable), so the server's periodic sweep and the
    // upload admission both refuse to cap-evict a just-written ready card.
    evictionGraceMs: ATTACHMENT_EVICTION_GRACE_MS,
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

async function writeSidecar(file, serializedMeta) {
  try {
    await writeFileAtomically(sidecarPath(file), serializedMeta);
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

// Root cause B: THE single disk-admission chokepoint. Every write path that can ADD
// bytes to attachment storage must route its charge through here before touching
// disk - a new image+sidecar, and the dedup sidecar repair (a pre-D6 or
// crash-orphaned image whose `.meta` is missing). The dedup mtime-refresh rewrite
// replaces identical bytes in place (net-zero charge) and the sweep only removes, so
// those are the only two byte-adding paths. First reclaim unreferenced/expired bytes
// down toward (cap - newCharge), then measure the TRUE committed allocation that
// survived and refuse when it plus the new charge still exceeds the cap (everything
// left is referenced/fresh). The charge uses the SAME allocated accounting the cap
// measures, so there is no separate counter and no undercount. The caller MUST hold
// the lifecycle lock so the reference snapshot, the reclaim, and the write are one
// atomic critical section.
async function admitAttachmentCharge(
  stateDir,
  newCharge,
  { ttlMs, maxDiskBytes, maxObjects, referenced, evictionGraceMs },
) {
  if (maxDiskBytes == null || newCharge <= 0) return true;
  await sweepAttachments(stateDir, {
    ttlMs,
    maxDiskBytes: Math.max(0, maxDiskBytes - newCharge),
    maxObjects,
    referenced,
    evictionGraceMs,
  });
  // BYTES are the admission invariant (`maxDiskBytes`). The object bound is a
  // derived inode backstop, not reserved here: a new object can transiently sit at
  // `maxObjects + 1` until the next sweep, but since `maxObjects = floor(cap / 8192)`
  // and every object costs >= one block, the byte cap always binds first - the
  // committed-byte total (checked below) can never exceed the cap.
  const committed = await committedChargedBytes(stateDir);
  return committed + newCharge <= maxDiskBytes;
}

// Validate (size + magic bytes, magic bytes authoritative), content-hash, and
// write the bytes atomically. Identical content dedupes to the same file. Errors
// carry an HTTP statusCode so the server's error handler surfaces 413/415/400.
export async function writeAttachment(
  stateDir,
  key,
  buffer,
  {
    maxBytes = DEFAULT_MAX_ATTACHMENT_BYTES,
    touchFile = utimes,
    maxDiskBytes = null,
    maxObjects = null,
    ttlMs = null,
    referenced = new Set(),
    evictionGraceMs = 0,
  } = {},
) {
  if (!isValidAttachmentKey(key)) throw statusError(`invalid attachment session key: ${key}`, 400);
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw statusError("empty attachment upload", 400);
  if (buffer.length > maxBytes) throw statusError(`attachment exceeds the ${maxBytes} byte limit`, 413);
  const type = detectImageType(buffer);
  if (!type) throw statusError("unsupported image type (expected PNG, JPEG, or WebP)", 415);
  const id = `${crypto.createHash("sha256").update(buffer).digest("hex")}.${type.ext}`;
  const file = attachmentFile(stateDir, key, id);
  const dims = imageDimensions(buffer, type.mime);
  const sidecarContent = JSON.stringify({
    v: 1,
    mime: type.mime,
    bytes: buffer.length,
    width: dims?.width || 0,
    height: dims?.height || 0,
  });
  // The admission sweep must never evict the very file this write dedupes into
  // (it may be unreferenced until the prompt referencing it queues), so it is
  // pinned alongside the caller's reference snapshot for the admission run only.
  const protectedRefs = new Set(referenced);
  protectedRefs.add(`${key}/${id}`);
  const admission = { ttlMs, maxDiskBytes, maxObjects, referenced: protectedRefs, evictionGraceMs };
  const isNew = !(await pathExists(file));
  if (isNew) {
    // Admission (hard cap): a NEW object must not push committed storage past the
    // disk cap; refused with 507 (see admitAttachmentCharge). Runs BEFORE
    // ensureAttachmentDir: the sweep prunes empty dirs, so creating the session
    // dir afterwards guarantees it exists for the write below.
    const newCharge = allocatedBytes(buffer.length) + allocatedBytes(sidecarContent.length);
    if (!(await admitAttachmentCharge(stateDir, newCharge, admission))) {
      throw statusError("attachment storage is full", 507);
    }
    await ensureAttachmentDir(stateDir, key);
    await writeFileAtomically(file, buffer);
    await writeSidecar(file, sidecarContent);
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
    // Sidecar repair: a dedup hit whose `.meta` is missing (pre-D6 storage or a
    // crashed sidecar write) would otherwise add a brand-new block with NO quota
    // check. Route the repair through the SAME admission chokepoint; when it is
    // refused (every remaining byte referenced, zero headroom) the repair is skipped
    // - the sidecar is a display cache and resolveAttachment falls back to a header
    // parse - rather than either failing the dedup upload or silently blowing the
    // cap. An EXISTING sidecar is not rewritten at all: identical content would
    // replace identical content.
    if (!(await pathExists(sidecarPath(file)))) {
      if (await admitAttachmentCharge(stateDir, allocatedBytes(sidecarContent.length), admission)) {
        await writeSidecar(file, sidecarContent);
      }
    }
  }
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
  // Sidecar FIRST: it is an uncounted display cache, so a crash after this removal
  // leaves only the counted image, which the TTL/disk/object caps can still reclaim -
  // never an orphan `.meta` that no sweep would have discovered (ATTACH-002). The
  // sweep's orphan-sidecar reap is the backstop for the sidecar half.
  await rm(sidecarPath(file), { force: true }).catch(() => {});
  try {
    await rm(file);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
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
        // Charge the real allocation: the image rounded up to whole blocks, plus the
        // sidecar's own allocation (a sidecar always accompanies a v1 upload; a
        // missing one just contributes nothing). `bytes` stays the logical image
        // size for callers that report freed/original size; `chargedBytes` is what
        // the disk cap measures.
        let sidecarBytes = 0;
        try {
          sidecarBytes = (await stat(sidecarPath(filePath))).size;
        } catch {
          // No sidecar (pre-D6 upload or mid-write); it just adds no charge.
        }
        files.push({
          key: dirent.name,
          id: entry.name,
          path: filePath,
          bytes: info.size,
          chargedBytes: allocatedBytes(info.size) + (sidecarBytes > 0 ? allocatedBytes(sidecarBytes) : 0),
          mtimeMs: info.mtimeMs,
        });
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
  const {
    ttlMs = DEFAULT_ATTACHMENT_TTL_MS,
    maxDiskBytes = null,
    maxObjects = null,
    referenced = new Set(),
    now = Date.now(),
    // A freshly written attachment may be a "ready card" the user dropped into the
    // composer but has not queued on a prompt yet, so it is unreferenced. Cap eviction
    // otherwise deletes it out from under the imminent Send (unrecoverable not-found).
    // Files younger than this grace are never cap-evicted; 0 disables the grace so the
    // pure mechanism (and its tests) evict oldest-unreferenced regardless of age.
    evictionGraceMs = 0,
  } = options;
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
  // Running totals over the survivors, decremented as files are evicted, so neither
  // backstop recomputes over the whole set per candidate. This loop runs under the
  // store's single global mutex, so per-candidate O(n) work would be an E3-class
  // lock hazard - the opposite of what the cap is for. Kept O(n log n) (the sort).
  let chargedTotal = survivors.reduce((sum, file) => sum + file.chargedBytes, 0);
  let objectCount = survivors.length;
  // Oldest-first eviction of UNREFERENCED survivors, shared by both backstops. A
  // referenced file is never a candidate, whatever the pressure. `overBudget` reads
  // the running totals; each removal decrements them exactly once.
  const evictOldestUnreferenced = async (overBudget) => {
    const evictable = survivors
      .filter((file) => {
        if (file.evicted || file.referenced) return false;
        // Protect just-written ready cards: an unreferenced file younger than the
        // grace may be a composer card the user is about to send, and destroying it
        // to reclaim disk is data loss. With the grace disabled (0), age is ignored.
        if (evictionGraceMs > 0 && now - file.mtimeMs < evictionGraceMs) return false;
        return true;
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const file of evictable) {
      if (!overBudget()) break;
      if (await removeFile(file.path)) {
        file.evicted = true;
        deleted += 1;
        freedBytes += file.bytes;
        chargedTotal -= file.chargedBytes;
        objectCount -= 1;
      }
    }
  };
  // Disk cap measured by CHARGED (allocated) cost, not logical image bytes - a flood
  // of tiny files exceeds real disk long before its logical total trips a cap.
  if (maxDiskBytes != null) {
    await evictOldestUnreferenced(() => chargedTotal > maxDiskBytes);
  }
  // Object-count backstop: bounds inodes/entries directly, which a magic-prefix
  // flood abuses even when every file is tiny enough to stay under the byte cap.
  if (maxObjects != null) {
    await evictOldestUnreferenced(() => objectCount > maxObjects);
  }
  // Reap files that leak past the caps because ID_RE hides them - crash-orphaned temp
  // files (D6) and orphan .meta sidecars (ATTACH-002). Always runs, since a leaked file
  // is invisible to the caps above regardless of whether a TTL or disk cap is set.
  const orphans = await reapOrphanFiles(stateDir, now);
  deleted += orphans.deleted;
  freedBytes += orphans.freedBytes;
  await pruneEmptyDirs(path.join(stateDir, "attachments"));
  return { deleted, freedBytes };
}

// The TRUE committed allocation on disk: every file in the attachments tree - images,
// dims sidecars, and crash-orphaned temps/.meta debris the caps can't yet reclaim -
// charged the SAME allocated cost the disk cap measures. Admission reads this AFTER a
// reclaiming sweep so it bounds the post-write total against real bytes, counting the
// undeletable/in-grace debris the sweep left behind rather than a curated survivor set.
async function committedChargedBytes(stateDir) {
  const root = path.join(stateDir, "attachments");
  let total = 0;
  for (const dirent of await readdirSafe(root)) {
    if (!dirent.isDirectory() || !isValidAttachmentKey(dirent.name)) continue;
    const dir = path.join(root, dirent.name);
    for (const entry of await readdirSafe(dir)) {
      if (!entry.isFile()) continue;
      try {
        total += allocatedBytes((await stat(path.join(dir, entry.name))).size);
      } catch {
        // Raced with a delete; skip it.
      }
    }
  }
  return total;
}

// Scan each session dir for files that leak past the caps because ID_RE hides them:
// crash-orphaned temp files (D6, reaped once past the write grace) and orphan dims
// sidecars whose image is gone (ATTACH-002, reaped immediately - a live upload writes
// the image first, so a sidecar without one is debris). Best-effort: anything we can't
// stat or delete is left for the next sweep.
async function reapOrphanFiles(stateDir, now) {
  const root = path.join(stateDir, "attachments");
  let deleted = 0;
  let freedBytes = 0;
  for (const dirent of await readdirSafe(root)) {
    if (!dirent.isDirectory() || !isValidAttachmentKey(dirent.name)) continue;
    const dir = path.join(root, dirent.name);
    const entries = await readdirSafe(dir);
    const present = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const filePath = path.join(dir, entry.name);
      const sidecarMatch = SIDECAR_ORPHAN_RE.exec(entry.name);
      try {
        if (TEMP_FILE_RE.test(entry.name)) {
          const info = await stat(filePath);
          if (now - info.mtimeMs <= ATTACHMENT_TEMP_GRACE_MS) continue; // possibly a live write
          if (await removeFile(filePath)) {
            deleted += 1;
            freedBytes += info.size;
          }
        } else if (sidecarMatch && !present.has(sidecarMatch[1])) {
          // An `.meta` whose image id is not in this dir: its image is gone.
          const info = await stat(filePath);
          if (await removeFile(filePath)) {
            deleted += 1;
            freedBytes += info.size;
          }
        }
      } catch {
        // Raced with a rename/delete; skip it.
      }
    }
  }
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
  // Sidecar first (ATTACH-002): a failure after removing the image would otherwise
  // strand the uncounted `.meta`; removing the cache first leaves only the counted
  // image if we crash between the two.
  await rm(sidecarPath(file), { force: true }).catch(() => {});
  try {
    await rm(file, { force: true });
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
