import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ATTACHMENT_ALLOC_BLOCK_BYTES,
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
  // The object bound is DERIVED from the disk budget (budget / min per-object charge),
  // never a separate env var, so it can only agree with the byte cap.
  assert.equal(defaults.maxObjects, Math.floor((512 * 1024 * 1024) / (2 * ATTACHMENT_ALLOC_BLOCK_BYTES)));
  // Disabling the disk cap disables the derived object bound too.
  assert.equal(resolveAttachmentConfig({ LAVISH_AXI_MAX_ATTACHMENT_DISK_MB: "off" }).maxObjects, null);

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

    // Cap measured in CHARGED (allocated) cost, since that is what the sweep now
    // enforces; all three payloads are the same length so each charges the same.
    const each = (await listAttachments(dir)).find((f) => f.id === oldest.id).chargedBytes;
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
      // The cap fits either file alone but not both, expressed in CHARGED cost.
      // Dropping the undeletable file from survivors would hide its allocation, leave
      // the total apparently under cap, and evict nothing - so the cap stays exceeded.
      const charged = new Map((await listAttachments(dir)).map((f) => [f.id, f.chargedBytes]));
      const result = await sweepAttachments(dir, {
        ttlMs: 7 * 24 * 60 * 60 * 1000,
        maxDiskBytes: charged.get(stuck.id) + charged.get(fresh.id) - 1,
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

test("disk accounting charges real allocation, not just logical image bytes (round7-b)", async () => {
  await withTempDir(async (dir) => {
    // A 12-byte image (the smallest detectImageType accepts) plus its ~40-byte
    // sidecar occupies two filesystem blocks on disk, not 52 logical bytes. The cap
    // must see the allocated cost, or thousands of tiny uploads sit far under the
    // reported total while consuming real disk (the measured 683x undercount).
    const stored = await writeAttachment(dir, KEY, uniquePng("tiny"), {});
    const listed = await listAttachments(dir);
    assert.equal(listed.length, 1);
    const entry = listed[0];
    assert.equal(entry.bytes, uniquePng("tiny").length, "logical size stays reported as bytes");
    assert.ok(
      entry.chargedBytes >= ATTACHMENT_ALLOC_BLOCK_BYTES,
      `charged cost floors at one block, got ${entry.chargedBytes}`,
    );
    // Charge must include the sidecar's own allocation, not just the image's.
    assert.ok(
      entry.chargedBytes >= 2 * ATTACHMENT_ALLOC_BLOCK_BYTES,
      `charge includes the sidecar block, got ${entry.chargedBytes}`,
    );
    void stored;
  });
});

test("the disk cap evicts tiny files whose real allocation exceeds it (round7-b, the 683x)", async () => {
  await withTempDir(async (dir) => {
    const uploads = [];
    for (let i = 0; i < 12; i += 1) uploads.push(await writeAttachment(dir, KEY, uniquePng("t" + i), {}));
    const base = Date.now();
    for (let i = 0; i < uploads.length; i += 1) {
      await utimes(
        uploads[i].path,
        new Date(base - (uploads.length - i) * 1000),
        new Date(base - (uploads.length - i) * 1000),
      );
    }

    // Logical bytes total ~ a couple hundred; a 12 KiB cap would NEVER fire on that.
    // Against real allocation (~2 blocks each = ~8 KiB/upload) the cap is far
    // exceeded, so the sweep must evict oldest-first down to it. TTL off so only the
    // disk-cap backstop acts.
    const logicalTotal = uploads.reduce((s, u) => s + u.bytes, 0);
    const cap = 12 * 1024;
    assert.ok(logicalTotal < cap, "logical bytes alone would never trip the cap");

    const result = await sweepAttachments(dir, { ttlMs: null, maxDiskBytes: cap });
    assert.ok(result.deleted > 0, "the cap fires on real allocation, not logical bytes");

    // What survives must actually be under the cap by charged cost.
    const survivors = await listAttachments(dir);
    const chargedTotal = survivors.reduce((s, f) => s + f.chargedBytes, 0);
    assert.ok(chargedTotal <= cap, `survivors fit the cap by charged cost, got ${chargedTotal} > ${cap}`);
    // Oldest-first: the newest upload must be among the survivors.
    assert.ok(await resolveAttachment(dir, KEY, uploads[uploads.length - 1].id), "newest survives");
  });
});

test("sweepAttachments enforces an object-count bound on unreferenced files (round7-b)", async () => {
  await withTempDir(async (dir) => {
    const uploads = [];
    for (let i = 0; i < 10; i += 1) uploads.push(await writeAttachment(dir, KEY, uniquePng("o" + i), {}));
    const base = Date.now();
    for (let i = 0; i < uploads.length; i += 1) {
      await utimes(
        uploads[i].path,
        new Date(base - (uploads.length - i) * 1000),
        new Date(base - (uploads.length - i) * 1000),
      );
    }
    // Bytes are trivially under any cap; the inode/object dimension is what a
    // magic-prefix flood abuses. Bound the object count directly, oldest-first.
    const result = await sweepAttachments(dir, { ttlMs: null, maxObjects: 4 });
    assert.equal(result.deleted, 6, "evicts down to the object-count bound");
    const survivors = await listAttachments(dir);
    assert.equal(survivors.length, 4);
    assert.ok(await resolveAttachment(dir, KEY, uploads[9].id), "newest object survives the count bound");
  });
});

test("the object-count bound never evicts a referenced file (round7-b)", async () => {
  await withTempDir(async (dir) => {
    const uploads = [];
    for (let i = 0; i < 6; i += 1) uploads.push(await writeAttachment(dir, KEY, uniquePng("r" + i), {}));
    const base = Date.now();
    for (let i = 0; i < uploads.length; i += 1) {
      await utimes(
        uploads[i].path,
        new Date(base - (uploads.length - i) * 1000),
        new Date(base - (uploads.length - i) * 1000),
      );
    }
    // The OLDEST is referenced, so a count bound of 2 must still keep it and evict
    // the next-oldest unreferenced ones instead.
    const referenced = new Set([`${KEY}/${uploads[0].id}`]);
    const result = await sweepAttachments(dir, { ttlMs: null, maxObjects: 2, referenced });
    assert.ok(await resolveAttachment(dir, KEY, uploads[0].id), "referenced oldest is never evicted");
    void result;
  });
});

test("the disk cap evicts the exact minimum with running totals, oldest-first (round7-b perf)", async () => {
  await withTempDir(async (dir) => {
    // Eight equal-size files; the sweep decrements a running charged total rather
    // than recomputing over all survivors per candidate (O(n log n), not O(n^2)
    // under the global mutex). Correctness must be identical: evict oldest-first
    // only until the running total fits the cap, and never one file more.
    const uploads = [];
    for (let i = 0; i < 8; i += 1) uploads.push(await writeAttachment(dir, KEY, uniquePng("p" + i), {}));
    const base = Date.now();
    for (let i = 0; i < uploads.length; i += 1) {
      await utimes(
        uploads[i].path,
        new Date(base - (uploads.length - i) * 1000),
        new Date(base - (uploads.length - i) * 1000),
      );
    }
    const each = (await listAttachments(dir)).find((f) => f.id === uploads[0].id).chargedBytes;
    // Cap fits exactly 3 files.
    const result = await sweepAttachments(dir, { ttlMs: null, maxDiskBytes: each * 3 });

    assert.equal(result.deleted, 5, "evicts exactly down to the cap, no more");
    const survivors = await listAttachments(dir);
    assert.equal(survivors.length, 3);
    assert.ok(survivors.reduce((s, f) => s + f.chargedBytes, 0) <= each * 3, "survivors fit the cap");
    // The three NEWEST survive; the five oldest are gone.
    for (let i = 0; i < 5; i += 1) assert.equal(await resolveAttachment(dir, KEY, uploads[i].id), null);
    for (let i = 5; i < 8; i += 1) assert.ok(await resolveAttachment(dir, KEY, uploads[i].id), `newest ${i} survives`);
  });
});

async function fileExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

test("sweepAttachments reaps an orphaned .tmp left by a crash (D6)", async () => {
  await withTempDir(async (dir) => {
    const stored = await writeAttachment(dir, KEY, uniquePng("keep"), {});
    // A crash between writeFile(temp) and rename leaves a temp file matching the
    // store's own `<name>.<pid>.<n>.tmp` pattern. ID_RE excludes it, so no TTL/disk/
    // object cap ever counts or removes it - the bytes leak forever.
    const orphanImg = path.join(attachmentsDir(dir, KEY), stored.id + ".12345.7.tmp");
    const orphanMeta = path.join(attachmentsDir(dir, KEY), stored.id + ".meta.12345.8.tmp");
    await writeFile(orphanImg, Buffer.alloc(4096));
    await writeFile(orphanMeta, Buffer.alloc(64));
    const old = Date.now() - 60 * 60 * 1000; // an hour old: long past any live write
    await utimes(orphanImg, new Date(old), new Date(old));
    await utimes(orphanMeta, new Date(old), new Date(old));

    const result = await sweepAttachments(dir, { ttlMs: null });
    assert.equal(await fileExists(orphanImg), false, "the stale temp image is reaped");
    assert.equal(await fileExists(orphanMeta), false, "the stale temp sidecar is reaped");
    assert.ok(await resolveAttachment(dir, KEY, stored.id), "the real attachment is untouched");
    void result;
  });
});

test("sweepAttachments leaves a FRESH .tmp alone - it may be a live write (D6)", async () => {
  await withTempDir(async (dir) => {
    await writeAttachment(dir, KEY, uniquePng("live"), {});
    // A just-created temp file (recent mtime) could be an in-progress atomic write in
    // another process; reaping it would corrupt that write. Only stale ones are debris.
    const fresh = path.join(attachmentsDir(dir, KEY), "a".repeat(64) + ".png.999.1.tmp");
    await writeFile(fresh, Buffer.alloc(16));
    await sweepAttachments(dir, { ttlMs: null });
    assert.equal(await fileExists(fresh), true, "a fresh temp file survives the sweep");
  });
});

test("sweepAttachments reaps an orphan sidecar whose image is gone (ATTACH-002)", async () => {
  await withTempDir(async (dir) => {
    const stored = await writeAttachment(dir, KEY, uniquePng("orphan-meta"), {});
    // Simulate a failed/partial delete: the image is removed but its `.meta` sidecar
    // is left behind. ID_RE excludes `.meta`, so no TTL/disk/object cap ever sees it -
    // a permanent leak unless the sweep reaps orphan sidecars.
    const sidecar = stored.path + ".meta";
    await rm(stored.path);
    assert.equal(await fileExists(sidecar), true, "the orphan sidecar is present before the sweep");

    await sweepAttachments(dir, { ttlMs: null });
    assert.equal(await fileExists(sidecar), false, "the orphan sidecar is reaped");
  });
});

test("sweepAttachments keeps a sidecar whose image still exists (ATTACH-002)", async () => {
  await withTempDir(async (dir) => {
    const stored = await writeAttachment(dir, KEY, uniquePng("live-meta"), {});
    await sweepAttachments(dir, { ttlMs: null });
    // A live attachment's sidecar must survive - it is not an orphan.
    assert.equal(await fileExists(stored.path + ".meta"), true, "a referenced image's sidecar is untouched");
    assert.ok(await resolveAttachment(dir, KEY, stored.id));
  });
});

test("removeAttachment removes the sidecar before the image (ATTACH-002)", async () => {
  await withTempDir(async (dir) => {
    // The sidecar (uncounted display cache) is removed first, so a crash after the
    // first removal leaves the counted image - reclaimable by TTL/disk caps - rather
    // than an orphan .meta they can never see. Order is observed via a stat sequence.
    const stored = await writeAttachment(dir, KEY, uniquePng("order"), {});
    assert.equal(await removeAttachment(dir, KEY, stored.id), true);
    assert.equal(await fileExists(stored.path), false);
    assert.equal(await fileExists(stored.path + ".meta"), false);
  });
});
