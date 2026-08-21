import assert from "node:assert/strict";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { listAttachments, resolveAttachment, sweepAttachments, writeAttachment } from "../src/attachment-store.js";

const KEY = "0123456789abcdef";

// A minimal 2x1 PNG; `uniquePng` appends a fixed-length suffix so every seed writes
// to a distinct content-hash id while keeping the charged allocation identical.
const PNG_2x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR42mP8z8BQz0BkYGAAADAAA/8W1p0AAAAASUVORK5CYII=",
  "base64",
);

function uniquePng(seed) {
  return Buffer.concat([PNG_2x1, Buffer.from(String(seed).padEnd(8, "-"))]);
}

async function withTempDir(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-admit-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function committedBytes(dir) {
  return (await listAttachments(dir)).reduce((sum, f) => sum + f.chargedBytes, 0);
}

// ITEM 1 (root cause B): the disk cap is only a backstop if the WRITE path enforces
// it. Without admission, `writeAttachment` stores bytes unconditionally and the cap
// is only reconciled on the next periodic sweep, so several chrome pages can each
// write past the cap before that sweep runs. RED on 07d641d (writeAttachment ignores
// maxDiskBytes and resolves), GREEN once admission refuses the over-cap object.
test("writeAttachment refuses a new object that would push committed storage past the disk cap", async () => {
  await withTempDir(async (dir) => {
    // A first attachment that a queued prompt already references, so the sweep can
    // never evict it to make room.
    const pinned = await writeAttachment(dir, KEY, uniquePng("pinned"), {});
    const each = (await listAttachments(dir)).find((f) => f.id === pinned.id).chargedBytes;
    const referenced = new Set([`${KEY}/${pinned.id}`]);

    // The cap holds exactly the referenced file. A second, brand-new upload cannot fit
    // and nothing on disk is evictable, so admission must refuse it (507).
    await assert.rejects(
      () => writeAttachment(dir, KEY, uniquePng("overflow"), { maxDiskBytes: each, ttlMs: null, referenced }),
      /storage is full/,
      "a new object that cannot fit under the cap must be refused, not written",
    );

    // The invariant admission exists to hold: committed allocation never exceeds the
    // cap, even when concurrent pages each try to push another object in.
    const committed = await committedBytes(dir);
    assert.ok(committed <= each, `committed ${committed} must stay within cap ${each}`);
    assert.ok(await resolveAttachment(dir, KEY, pinned.id), "the referenced file is untouched");
  });
});

// ITEM 2 (attachment-store.js eviction filter): a "ready card" is an image the user
// dropped into the composer — uploaded to the server, shown as a card, but NOT yet on
// any queued prompt, so it is unreferenced. Cap eviction removes the oldest
// UNREFERENCED file with no minimum-age floor, so it can delete a freshly uploaded
// ready card out from under the imminent Send → unrecoverable not-found. This
// reproduces that data loss: RED on 07d641d (the fresh card is evicted), GREEN once a
// bounded upload grace protects recently written files from cap eviction.
test("a fresh unreferenced ready card survives disk-cap eviction so Send still finds it", async () => {
  await withTempDir(async (dir) => {
    const readyCard = await writeAttachment(dir, KEY, uniquePng("ready-card"), {});
    // A separate image already queued on a pending prompt keeps the cap under pressure
    // and can never be evicted.
    const queued = await writeAttachment(dir, KEY, uniquePng("queued"), {});
    const each = (await listAttachments(dir)).find((f) => f.id === readyCard.id).chargedBytes;

    const now = Date.now();
    // The ready card was just uploaded (well within the grace); the queued file is
    // older. mtimes are set explicitly so the reproduction is deterministic.
    await utimes(readyCard.path, new Date(now - 60_000), new Date(now - 60_000));
    await utimes(queued.path, new Date(now - 10 * 60_000), new Date(now - 10 * 60_000));

    // Disk pressure: the cap holds one file. The only unreferenced (evictable) file is
    // the fresh ready card. Without the grace the sweep deletes it; with the grace it
    // is protected and the store deliberately stays over cap rather than lose bytes a
    // live card still needs.
    const result = await sweepAttachments(dir, {
      ttlMs: null,
      maxDiskBytes: each,
      referenced: new Set([`${KEY}/${queued.id}`]),
      evictionGraceMs: 60 * 60 * 1000,
      now,
    });

    // The user now clicks Send: the prompt references the ready card's id, which must
    // still resolve.
    assert.ok(
      await resolveAttachment(dir, KEY, readyCard.id),
      "a freshly uploaded ready card must survive disk-cap eviction so Send does not hit not-found",
    );
    assert.equal(result.deleted, 0, "the grace left the fresh ready card in place");
  });
});
