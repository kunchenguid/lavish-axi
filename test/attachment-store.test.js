import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  attachmentPath,
  attachmentsDir,
  detectImageType,
  imageDimensions,
  isValidAttachmentId,
  isValidAttachmentKey,
  listAttachments,
  removeAttachment,
  resolveAttachment,
  resolveAttachmentConfig,
  statAttachmentForServe,
  sweepAttachments,
  writeAttachment,
} from "../src/attachment-store.js";

const KEY = "0123456789abcdef";

// A 2x1 PNG, a minimal JPEG (baseline SOF0 with 3x2 dims), and a 1x1 lossy WebP.
const PNG_2x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR42mP8z8BQz0BkYGAAADAAA/8W1p0AAAAASUVORK5CYII=",
  "base64",
);
// A VP8L (lossless) WebP header with the given dimensions packed exactly as the
// spec lays them out, so the parser round-trips against a known width/height.
function makeWebpVP8L(width, height) {
  const packed = (width - 1) | ((height - 1) << 14);
  const stream = Buffer.from([0x2f, packed & 0xff, (packed >> 8) & 0xff, (packed >> 16) & 0xff, (packed >> 24) & 0xff]);
  const riff = Buffer.alloc(12);
  riff.write("RIFF", 0, "ascii");
  riff.writeUInt32LE(4 + 8 + stream.length, 4);
  riff.write("WEBP", 8, "ascii");
  const chunkHeader = Buffer.alloc(8);
  chunkHeader.write("VP8L", 0, "ascii");
  chunkHeader.writeUInt32LE(stream.length, 4);
  return Buffer.concat([riff, chunkHeader, stream]);
}

const WEBP_1x1 = makeWebpVP8L(1, 1);

function makeJpeg(width, height) {
  // SOI + a SOF0 frame header carrying width/height, enough for the parser.
  const sof = Buffer.from([
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x22,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01,
  ]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])]);
}

async function withTempDir(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-attach-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("detectImageType recognizes PNG, JPEG, and WebP by magic bytes", () => {
  assert.deepEqual(detectImageType(PNG_2x1), { mime: "image/png", ext: "png" });
  assert.deepEqual(detectImageType(makeJpeg(3, 2)), { mime: "image/jpeg", ext: "jpg" });
  assert.deepEqual(detectImageType(WEBP_1x1), { mime: "image/webp", ext: "webp" });
  assert.equal(detectImageType(Buffer.from("<svg></svg>")), null);
  assert.equal(detectImageType(Buffer.from("GIF89a......", "ascii")), null);
  assert.equal(detectImageType(Buffer.alloc(4)), null);
});

test("imageDimensions parses each supported format's header", () => {
  assert.deepEqual(imageDimensions(PNG_2x1, "image/png"), { width: 2, height: 1 });
  assert.deepEqual(imageDimensions(makeJpeg(640, 480), "image/jpeg"), { width: 640, height: 480 });
  const jpeg = makeJpeg(320, 240);
  const jpegWithTem = Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0x01]), jpeg.subarray(2)]);
  assert.deepEqual(imageDimensions(jpegWithTem, "image/jpeg"), { width: 320, height: 240 });
  assert.deepEqual(imageDimensions(WEBP_1x1, "image/webp"), { width: 1, height: 1 });
  assert.deepEqual(imageDimensions(makeWebpVP8L(320, 200), "image/webp"), { width: 320, height: 200 });
});

test("writeAttachment stores content-addressed bytes and returns server-vetted metadata", async () => {
  await withTempDir(async (dir) => {
    const meta = await writeAttachment(dir, KEY, PNG_2x1, {});
    assert.ok(isValidAttachmentId(meta.id));
    assert.match(meta.id, /\.png$/);
    assert.equal(meta.type, "image");
    assert.equal(meta.mime, "image/png");
    assert.equal(meta.bytes, PNG_2x1.length);
    assert.deepEqual({ width: meta.width, height: meta.height }, { width: 2, height: 1 });
    assert.equal(meta.path, path.join(attachmentsDir(dir, KEY), meta.id));
    assert.deepEqual(await readFile(meta.path), PNG_2x1);
  });
});

test("writeAttachment dedupes identical content to one file and id", async () => {
  await withTempDir(async (dir) => {
    const first = await writeAttachment(dir, KEY, PNG_2x1, {});
    const second = await writeAttachment(dir, KEY, PNG_2x1, {});
    assert.equal(first.id, second.id);
    assert.equal(first.path, second.path);
  });
});

test("writeAttachment refreshes the mtime when deduping identical content (B3)", async () => {
  await withTempDir(async (dir) => {
    const first = await writeAttachment(dir, KEY, PNG_2x1, {});
    // Age the stored file far past any TTL, as a long-lived server would see it.
    const old = Date.now() - 30 * 24 * 60 * 60 * 1000;
    await utimes(first.path, new Date(old), new Date(old));

    await writeAttachment(dir, KEY, PNG_2x1, {});
    // A sweep with a 1-day TTL must now keep the file: the dedup refreshed its mtime,
    // so the fresh reference restarts the clock (otherwise it would be reaped).
    const swept = await sweepAttachments(dir, { ttlMs: 24 * 60 * 60 * 1000 });
    assert.equal(swept.deleted, 0);
    assert.ok(await resolveAttachment(dir, KEY, first.id), "re-referenced file survives its old age");
  });
});

test("writeAttachment persists a dims sidecar that resolveAttachment reads without the image (D6)", async () => {
  await withTempDir(async (dir) => {
    const { id, path: file } = await writeAttachment(dir, KEY, PNG_2x1, {});
    // The sidecar sits beside the image and is ignored by the id-shaped listing.
    const sidecar = await readFile(`${file}.meta`, "utf8");
    assert.deepEqual(JSON.parse(sidecar), { v: 1, mime: "image/png", bytes: PNG_2x1.length, width: 2, height: 1 });
    const listed = await listAttachments(dir);
    assert.equal(listed.length, 1, "the .meta sidecar is not enumerated as an attachment");

    // Overwrite the image bytes with non-image garbage: a re-parse would now yield
    // no dims, but the sidecar still carries them, proving resolveAttachment reads
    // the sidecar rather than the whole image.
    await writeFile(file, Buffer.from("not a real image"));
    const resolved = await resolveAttachment(dir, KEY, id);
    assert.deepEqual({ width: resolved.width, height: resolved.height }, { width: 2, height: 1 });
  });
});

test("statAttachmentForServe returns file + mime without reading the image, and 404-safe otherwise", async () => {
  await withTempDir(async (dir) => {
    const { id, path: file } = await writeAttachment(dir, KEY, PNG_2x1, {});
    assert.deepEqual(await statAttachmentForServe(dir, KEY, id), { file, mime: "image/png" });
    assert.equal(await statAttachmentForServe(dir, KEY, "f".repeat(64) + ".png"), null);
    assert.equal(await statAttachmentForServe(dir, KEY, "not-a-valid-id"), null);
    assert.equal(await statAttachmentForServe(dir, "../etc", id), null);
  });
});

test("removeAttachment also cleans up the dims sidecar", async () => {
  await withTempDir(async (dir) => {
    const { id, path: file } = await writeAttachment(dir, KEY, PNG_2x1, {});
    assert.equal(await removeAttachment(dir, KEY, id), true);
    await assert.rejects(() => readFile(`${file}.meta`, "utf8"), /ENOENT/);
  });
});

test("writeAttachment rejects oversized, empty, and non-image uploads", async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(() => writeAttachment(dir, KEY, PNG_2x1, { maxBytes: 4 }), /exceeds/);
    await assert.rejects(() => writeAttachment(dir, KEY, Buffer.alloc(0), {}), /empty/);
    await assert.rejects(() => writeAttachment(dir, KEY, Buffer.from("<svg/>"), {}), /unsupported/);
    await assert.rejects(() => writeAttachment(dir, "../etc", PNG_2x1, {}), /invalid/);
  });
});

test("resolveAttachment re-derives metadata from disk and ignores unknown ids", async () => {
  await withTempDir(async (dir) => {
    const { id } = await writeAttachment(dir, KEY, PNG_2x1, {});
    const resolved = await resolveAttachment(dir, KEY, id);
    assert.equal(resolved.path, path.join(attachmentsDir(dir, KEY), id));
    assert.equal(resolved.bytes, PNG_2x1.length);
    assert.equal(resolved.width, 2);
    assert.equal(await resolveAttachment(dir, KEY, "f".repeat(64) + ".png"), null);
    assert.equal(await resolveAttachment(dir, KEY, "../../etc/passwd"), null);
    assert.equal(await resolveAttachment(dir, "../etc", id), null);
  });
});

test("id validation rejects traversal and wrong extensions", () => {
  assert.equal(isValidAttachmentKey(KEY), true);
  assert.equal(isValidAttachmentKey("ZZZ"), false);
  assert.equal(isValidAttachmentId("a".repeat(64) + ".png"), true);
  assert.equal(isValidAttachmentId("a".repeat(64) + ".gif"), false);
  assert.equal(isValidAttachmentId("../" + "a".repeat(62) + ".png"), false);
  assert.equal(isValidAttachmentId("a".repeat(63) + ".png"), false);
  assert.equal(attachmentPath("bad key", "a".repeat(64) + ".png"), null);
});

test("removeAttachment deletes a stored file and reports absence", async () => {
  await withTempDir(async (dir) => {
    const { id } = await writeAttachment(dir, KEY, PNG_2x1, {});
    assert.equal(await removeAttachment(dir, KEY, id), true);
    assert.equal(await resolveAttachment(dir, KEY, id), null);
    assert.equal(await removeAttachment(dir, KEY, id), false);
    assert.equal(await removeAttachment(dir, KEY, "../../secret"), false);
  });
});

test("resolveAttachmentConfig reads LAVISH_AXI_* limits with sane fallbacks", () => {
  const defaults = resolveAttachmentConfig({});
  assert.equal(defaults.maxBytes, 10 * 1024 * 1024);
  assert.equal(defaults.maxPerPrompt, 4);
  assert.equal(defaults.maxPromptBytes, 25 * 1024 * 1024);
  assert.equal(defaults.ttlMs, 7 * 24 * 60 * 60 * 1000);
  // Bounded default disk quota so the sweeper caps unreferenced growth out of the box.
  assert.equal(defaults.maxDiskBytes, 512 * 1024 * 1024);

  const custom = resolveAttachmentConfig({
    LAVISH_AXI_MAX_ATTACHMENT_BYTES: "2048",
    LAVISH_AXI_MAX_ATTACHMENTS_PER_PROMPT: "2",
    LAVISH_AXI_ATTACHMENT_TTL_MS: "off",
    LAVISH_AXI_MAX_ATTACHMENT_DISK_MB: "50",
  });
  assert.equal(custom.maxBytes, 2048);
  assert.equal(custom.maxPerPrompt, 2);
  assert.equal(custom.ttlMs, null);
  assert.equal(custom.maxDiskBytes, 50 * 1024 * 1024);

  // The disk quota is explicitly disable-able with off/0.
  assert.equal(resolveAttachmentConfig({ LAVISH_AXI_MAX_ATTACHMENT_DISK_MB: "off" }).maxDiskBytes, null);
  assert.equal(resolveAttachmentConfig({ LAVISH_AXI_MAX_ATTACHMENT_DISK_MB: "0" }).maxDiskBytes, null);

  // Non-positive / unparseable values fall back rather than throwing.
  assert.equal(resolveAttachmentConfig({ LAVISH_AXI_MAX_ATTACHMENT_BYTES: "-1" }).maxBytes, 10 * 1024 * 1024);
  assert.equal(resolveAttachmentConfig({ LAVISH_AXI_ATTACHMENT_TTL_MS: "0" }).ttlMs, null);
  assert.equal(resolveAttachmentConfig({ LAVISH_AXI_MAX_ATTACHMENT_DISK_MB: "-5" }).maxDiskBytes, 512 * 1024 * 1024);
});

test("a fractional limit that floors below 1 falls back instead of disabling the cap (W5)", () => {
  // `0.5` is > 0, so a bounds-check-then-floor order accepts it and then floors it
  // to 0: uploads are disabled server-side while the SDK still advertises its own
  // default, so the client and server disagree about the cap.
  assert.equal(resolveAttachmentConfig({ LAVISH_AXI_MAX_ATTACHMENTS_PER_PROMPT: "0.5" }).maxPerPrompt, 4);
  assert.equal(resolveAttachmentConfig({ LAVISH_AXI_MAX_ATTACHMENT_BYTES: "0.9" }).maxBytes, 10 * 1024 * 1024);
  assert.equal(
    resolveAttachmentConfig({ LAVISH_AXI_MAX_PROMPT_ATTACHMENT_BYTES: "0.25" }).maxPromptBytes,
    25 * 1024 * 1024,
  );
  // A fractional value that still floors to >= 1 is honored, floored.
  assert.equal(resolveAttachmentConfig({ LAVISH_AXI_MAX_ATTACHMENTS_PER_PROMPT: "2.7" }).maxPerPrompt, 2);
  // Same discipline for the MB-scaled disk cap: a value that rounds down to zero
  // bytes must not masquerade as a 0-byte quota that evicts everything.
  assert.equal(
    resolveAttachmentConfig({ LAVISH_AXI_MAX_ATTACHMENT_DISK_MB: "0.0000001" }).maxDiskBytes,
    512 * 1024 * 1024,
  );
  assert.equal(resolveAttachmentConfig({ LAVISH_AXI_MAX_ATTACHMENT_DISK_MB: "0.5" }).maxDiskBytes, 512 * 1024);
});

test("writeAttachment leaves no stray temp files behind", async () => {
  await withTempDir(async (dir) => {
    await writeAttachment(dir, KEY, PNG_2x1, {});
    const entries = await readdir(attachmentsDir(dir, KEY));
    assert.ok(
      entries.every((name) => !name.endsWith(".tmp")),
      `unexpected temp file in ${entries}`,
    );
  });
});

const KEY_B = "fedcba9876543210";

// Distinct byte payloads that still carry the PNG magic signature, so each writes
// to a unique content-hash id (dimensions are irrelevant to sweeping).
function uniquePng(seed) {
  return Buffer.concat([PNG_2x1, Buffer.from(String(seed).padEnd(8, "-"))]);
}

test("listAttachments enumerates well-formed files across session dirs", async () => {
  await withTempDir(async (dir) => {
    const a = await writeAttachment(dir, KEY, uniquePng("a"), {});
    const b = await writeAttachment(dir, KEY_B, uniquePng("b"), {});
    const listed = await listAttachments(dir);
    const byPath = new Map(listed.map((f) => [f.path, f]));
    assert.equal(listed.length, 2);
    assert.ok(byPath.has(a.path));
    assert.ok(byPath.has(b.path));
    assert.equal(byPath.get(a.path).key, KEY);
    assert.equal(byPath.get(a.path).bytes, uniquePng("a").length);
  });
});

test("sweepAttachments reaps expired unreferenced files but keeps referenced and fresh ones", async () => {
  await withTempDir(async (dir) => {
    const expiredOrphan = await writeAttachment(dir, KEY, uniquePng("orphan"), {});
    const expiredReferenced = await writeAttachment(dir, KEY, uniquePng("kept"), {});
    const fresh = await writeAttachment(dir, KEY, uniquePng("fresh"), {});

    // Age the two "expired" files well past the TTL; leave `fresh` recent.
    const old = Date.now() - 10 * 24 * 60 * 60 * 1000;
    await utimes(expiredOrphan.path, new Date(old), new Date(old));
    await utimes(expiredReferenced.path, new Date(old), new Date(old));

    const result = await sweepAttachments(dir, {
      ttlMs: 7 * 24 * 60 * 60 * 1000,
      referenced: new Set([`${KEY}/${expiredReferenced.id}`]),
    });

    assert.equal(result.deleted, 1);
    assert.equal(await resolveAttachment(dir, KEY, expiredOrphan.id), null);
    assert.ok(await resolveAttachment(dir, KEY, expiredReferenced.id), "referenced file must survive its TTL");
    assert.ok(await resolveAttachment(dir, KEY, fresh.id), "fresh file must survive");
  });
});

test("sweepAttachments never reaps when the TTL is disabled", async () => {
  await withTempDir(async (dir) => {
    const stored = await writeAttachment(dir, KEY, uniquePng("x"), {});
    const old = Date.now() - 365 * 24 * 60 * 60 * 1000;
    await utimes(stored.path, new Date(old), new Date(old));
    const result = await sweepAttachments(dir, { ttlMs: null });
    assert.equal(result.deleted, 0);
    assert.ok(await resolveAttachment(dir, KEY, stored.id));
  });
});

test("disk cap evicts oldest unreferenced files first and never referenced ones", async () => {
  await withTempDir(async (dir) => {
    const oldest = await writeAttachment(dir, KEY, uniquePng("oldest"), {});
    const middle = await writeAttachment(dir, KEY, uniquePng("middle"), {});
    const newest = await writeAttachment(dir, KEY, uniquePng("newest"), {});
    const base = Date.now();
    await utimes(oldest.path, new Date(base - 3000), new Date(base - 3000));
    await utimes(middle.path, new Date(base - 2000), new Date(base - 2000));
    await utimes(newest.path, new Date(base - 1000), new Date(base - 1000));

    const each = oldest.bytes; // all three payloads are the same length
    // Cap fits ~2 files; the oldest unreferenced one is evicted. TTL off so only
    // the disk-cap backstop acts.
    const result = await sweepAttachments(dir, {
      ttlMs: null,
      maxDiskBytes: each * 2 + 1,
      referenced: new Set([`${KEY}/${oldest.id}`]),
    });

    assert.equal(result.deleted, 1);
    // The oldest is referenced, so eviction must skip it and take the next oldest.
    assert.ok(await resolveAttachment(dir, KEY, oldest.id), "referenced file is never evicted");
    assert.equal(await resolveAttachment(dir, KEY, middle.id), null);
    assert.ok(await resolveAttachment(dir, KEY, newest.id));
  });
});

// POSIX file modes and permission-based failures have no Windows equivalent
// (chmod there only toggles a read-only flag and does not gate unlink).
const posixOnly = { skip: process.platform === "win32" ? "POSIX file modes" : false };

// Run `body` with `dir` made unwritable, restoring the mode afterwards so the
// temp-dir cleanup can still remove it. An unwritable parent is the portable way
// to make an unlink inside it fail (EACCES) without root.
async function withUnwritableDir(dir, body) {
  const original = (await stat(dir)).mode & 0o777;
  await chmod(dir, 0o500);
  try {
    await body();
  } finally {
    await chmod(dir, original);
  }
}

test("attachment files and dirs are created private to the owner (E4)", posixOnly, async () => {
  await withTempDir(async (dir) => {
    const meta = await writeAttachment(dir, KEY, PNG_2x1, {});
    // Images can be screenshots of anything on the user's screen. In a traversable
    // state dir under the usual 0022 umask these would otherwise land 0644/0755 and
    // be readable by every other local user.
    assert.equal((await stat(meta.path)).mode & 0o777, 0o600, "image bytes are owner-only");
    assert.equal((await stat(`${meta.path}.meta`)).mode & 0o777, 0o600, "dims sidecar is owner-only");
    assert.equal((await stat(attachmentsDir(dir, KEY))).mode & 0o777, 0o700, "session dir is owner-only");
    assert.equal((await stat(path.join(dir, "attachments"))).mode & 0o777, 0o700, "attachments root is owner-only");
  });
});

test("writeAttachment tightens the modes of a pre-hardening world-readable dir (E4)", posixOnly, async () => {
  await withTempDir(async (dir) => {
    // An install that uploaded before this hardening already has 0755 dirs on disk;
    // creating with a mode alone would leave those old screenshots exposed.
    const first = await writeAttachment(dir, KEY, PNG_2x1, {});
    await chmod(path.join(dir, "attachments"), 0o755);
    await chmod(attachmentsDir(dir, KEY), 0o755);

    await writeAttachment(dir, KEY, uniquePng("second"), {});
    assert.equal((await stat(attachmentsDir(dir, KEY))).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(dir, "attachments"))).mode & 0o777, 0o700);
    assert.ok(await resolveAttachment(dir, KEY, first.id), "repairing modes leaves stored bytes intact");
  });
});

test("writeAttachment rewrites identical bytes when the dedup mtime refresh fails (W2)", async () => {
  await withTempDir(async (dir) => {
    const first = await writeAttachment(dir, KEY, PNG_2x1, {});
    const old = Date.now() - 30 * 24 * 60 * 60 * 1000;
    await utimes(first.path, new Date(old), new Date(old));

    // A swallowed utimes failure would report success while leaving the file
    // TTL-expired, so the sweeper reaps it out from under the fresh prompt.
    const second = await writeAttachment(dir, KEY, PNG_2x1, {
      touchFile: async () => {
        throw Object.assign(new Error("utimes not permitted"), { code: "EPERM" });
      },
    });
    assert.equal(second.id, first.id, "dedup still resolves to the same content-addressed id");
    assert.deepEqual(await readFile(first.path), PNG_2x1, "the rewrite preserves the identical bytes");

    const swept = await sweepAttachments(dir, { ttlMs: 24 * 60 * 60 * 1000 });
    assert.equal(swept.deleted, 0, "the rewrite restarted the TTL clock");
    assert.ok(await resolveAttachment(dir, KEY, first.id));
  });
});

test("a failed expired-orphan delete still counts toward the disk cap (W3)", posixOnly, async () => {
  await withTempDir(async (dir) => {
    // `stuck` is expired and unreferenced but sits in a dir we make unwritable, so
    // its delete fails and its bytes stay on disk. `fresh` lives in another session
    // dir that stays writable.
    const stuck = await writeAttachment(dir, KEY, uniquePng("stuck"), {});
    const fresh = await writeAttachment(dir, KEY_B, uniquePng("fresh"), {});
    const old = Date.now() - 10 * 24 * 60 * 60 * 1000;
    await utimes(stuck.path, new Date(old), new Date(old));

    await withUnwritableDir(attachmentsDir(dir, KEY), async () => {
      // The cap fits either file alone but not both. Dropping the undeletable file
      // from survivors would hide its bytes, leave the total apparently under cap,
      // and evict nothing - so the cap stays exceeded on disk.
      const result = await sweepAttachments(dir, {
        ttlMs: 7 * 24 * 60 * 60 * 1000,
        maxDiskBytes: stuck.bytes + fresh.bytes - 1,
      });

      assert.ok(await resolveAttachment(dir, KEY, stuck.id), "the undeletable file is still on disk");
      assert.equal(result.deleted, 1, "the cap evicted a file it could actually delete");
      assert.equal(await resolveAttachment(dir, KEY_B, fresh.id), null, "disk-cap accounting saw the stuck bytes");
    });
  });
});

test("sweepAttachments prunes empty session dirs and tolerates a missing root", async () => {
  await withTempDir(async (dir) => {
    const stored = await writeAttachment(dir, KEY, uniquePng("solo"), {});
    const old = Date.now() - 30 * 24 * 60 * 60 * 1000;
    await utimes(stored.path, new Date(old), new Date(old));
    await sweepAttachments(dir, { ttlMs: 7 * 24 * 60 * 60 * 1000 });
    const remaining = await readdir(attachmentsDir(dir, KEY)).catch((e) => e.code);
    assert.equal(remaining, "ENOENT");
    // No attachments root at all: a no-op, not a throw.
    await withTempDir(async (empty) => {
      assert.deepEqual(await sweepAttachments(empty, {}), { deleted: 0, freedBytes: 0 });
    });
  });
});
