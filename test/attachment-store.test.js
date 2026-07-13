import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
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
  removeAttachment,
  resolveAttachment,
  resolveAttachmentConfig,
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
  assert.equal(defaults.maxDiskBytes, null);

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

  // Non-positive / unparseable values fall back rather than throwing.
  assert.equal(resolveAttachmentConfig({ LAVISH_AXI_MAX_ATTACHMENT_BYTES: "-1" }).maxBytes, 10 * 1024 * 1024);
  assert.equal(resolveAttachmentConfig({ LAVISH_AXI_ATTACHMENT_TTL_MS: "0" }).ttlMs, null);
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
