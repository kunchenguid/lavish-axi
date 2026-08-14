import assert from "node:assert/strict";
import test from "node:test";

import {
  attachmentSizeError,
  classifyAttachmentBatch,
  deriveAttachmentNoticeState,
  isTrustedAttachmentResult,
  partitionDroppedFiles,
} from "../src/artifact-sdk.js";
import { createSdkJs } from "../src/server.js";

// The annotation card lives inside the sandboxed artifact iframe, so its image
// attachment behavior can only be exercised in a real browser. These assertions
// pin the SDK <-> chrome message contract in the serialized bundle so a refactor
// can't silently break the paste/drop -> upload -> queue handshake.
const sdk = createSdkJs("0123456789abcdef");

test("the SDK bundle uploads captured images through the chrome", () => {
  // The send must go through postArtifactMessage: that helper stamps the current
  // artifact_load_token, and the chrome drops EVERY artifact message without it
  // before the upload handler runs - so a raw parent.postMessage here (which this
  // regression once shipped as) silently kills every real upload while mocked
  // harnesses stay green.
  assert.match(sdk, /postArtifactMessage\("lavish:uploadAttachment", \{/);
  assert.doesNotMatch(sdk, /parent\.postMessage\(\s*\{\s*type: "lavish:uploadAttachment"/);
  assert.match(sdk, /localId: item\.localId/);
  assert.match(sdk, /item\.file\s*\n?\s*\.arrayBuffer\(\)/);
});

test("the SDK bundle scopes every upload and result to this document (E1)", () => {
  // The nonce is minted per document, sent with each upload, and required on the
  // way back; the listener also drops anything that did not come from the chrome.
  assert.match(sdk, /const ATTACHMENT_NONCE\s*=/);
  assert.match(sdk, /nonce: ATTACHMENT_NONCE/);
  assert.match(sdk, /const isTrustedAttachmentResult=/);
  assert.match(sdk, /if \(event\.source !== parent\) return;/);
  assert.match(sdk, /isTrustedAttachmentResult\(event, \{ parentWindow: parent, nonce: ATTACHMENT_NONCE \}\)/);
});

test("the SDK bundle applies upload results and offers a retry", () => {
  assert.match(sdk, /lavish:attachmentResult/);
  assert.match(sdk, /activeAttachments\?\.handleResult\(msg\.localId, msg\.ok, msg\.id, msg\.error\)/);
  assert.match(sdk, /data-attachment-retry/);
});

test("the SDK bundle carries ready attachment refs on the queued prompt", () => {
  assert.match(sdk, /options\.attachments/);
  assert.match(sdk, /item\.attachments = attachments/);
  assert.match(sdk, /queuePrompt\(prompt, \{ \.\.\.c, queueKey: "", attachments: readyAttachments \}\)/);
});

test("the SDK bundle only accepts PNG, JPEG, and WebP images", () => {
  assert.match(sdk, /ATTACHMENT_ACCEPTED_MIME = \{ "image\/png": true, "image\/jpeg": true, "image\/webp": true \}/);
  assert.match(sdk, /accept="image\/png,image\/jpeg,image\/webp"/);
});

test("the SDK bundle renders chips with a thumbnail, name, and status", () => {
  assert.match(sdk, /lavish-attachment-thumb/);
  assert.match(sdk, /lavish-attachment-name/);
  assert.match(sdk, /Uploading…/);
  assert.match(sdk, /revokeObjectURL/);
});

test("the SDK bundle intercepts every drop so a non-image can't navigate the frame", () => {
  // The drop handler calls preventDefault() unconditionally, then classifies.
  assert.match(
    sdk,
    /"drop",\s*\(event\)\s*=>\s*\{\s*[\s\S]*?event\.preventDefault\(\);\s*card\.classList\.remove\("is-dropping"\)/,
  );
  assert.match(sdk, /dataTransferHasFiles/);
  assert.match(sdk, /attachments\.rejectUnsupportedBatch\(unsupported\)/);
  assert.match(sdk, /error: "UNSUPPORTED_TYPE"/);
});

test("the SDK bundle renders a visible, titled remove control on each chip", () => {
  assert.match(sdk, /aria-label="Remove image" title="Remove"/);
  assert.match(sdk, /lavish-attachment-remove/);
});

test("the SDK bundle gates queuing until in-flight uploads settle (R2.4)", () => {
  // hasPending flags any still-uploading chip, and the queue path bails on it so an
  // in-flight image is never silently dropped by collectReady/closeCard.
  assert.match(sdk, /function hasPending\(\)\s*\{\s*return items\.some\(\(item\) => item\.status === "uploading"\)/);
  assert.match(sdk, /if \(attachments\.hasPending\(\)\)/);
  assert.match(sdk, /Waiting for an image to finish uploading/);
  // "Send now" only fires when the queue actually happened.
  assert.match(sdk, /const queued = tryQueue\(\);\s*\n?\s*[\s\S]*?if \(queued && sendNow\) sendQueuedPrompts\(\)/);
});

test("the count-cap notice reads as an error, not as the passive keyboard hint", () => {
  // The cap notice replaces the card's gray hint line, so without its own error
  // styling it reads as passive help text and a rejected drop goes unnoticed.
  assert.match(sdk, /lavish-hint-alert/);
  assert.match(sdk, /\.lavish-hint-alert\{[^}]*color:#ff9d7a/);
  assert.match(sdk, /attachNotice\.classList\.add\("lavish-hint-alert"\)/);
  // Clearing the notice restores the neutral hint instead of leaving stale red text.
  assert.match(sdk, /attachNotice\.classList\.remove\("lavish-hint-alert"\)/);
});

test("the count-cap notice persists until attachment capacity is created", () => {
  const cap = "You can attach up to 4 images.";
  const waiting = "Waiting for an image to finish uploading…";
  const failed = "An image couldn't be attached. Retry or remove it before queuing.";
  const state = { itemCount: 4, maxCount: 4, capRejected: true, queueBlocked: false };

  assert.equal(deriveAttachmentNoticeState(state), cap);
  assert.equal(deriveAttachmentNoticeState({ ...state, queueBlocked: true, hasPending: true }), waiting);
  assert.equal(deriveAttachmentNoticeState({ ...state, queueBlocked: true, hasErrors: true }), failed);
  assert.equal(deriveAttachmentNoticeState({ ...state, queueBlocked: true, hasPending: true }), waiting);
  assert.equal(deriveAttachmentNoticeState({ ...state, queueBlocked: true }), cap);
  assert.equal(deriveAttachmentNoticeState({ ...state, itemCount: 3 }), "");

  assert.match(sdk, /notify\(\s*deriveAttachmentNoticeState\(/);
  assert.match(sdk, /attachNotice\.classList\.add\("lavish-hint-alert"\)/);
  assert.match(sdk, /if \(items\.length < ATTACHMENT_MAX_COUNT\) capRejected = false/);
  assert.match(sdk, /if \(!hasPending\(\) && !hasErrors\(\)\) queueBlocked = false/);
});

// The three tests that pinned the eager-delete classifier (`classifyAttachmentDelete`,
// its W-B "defer" parking, and the bundle's removeAttachment posting) are gone with
// it: E2 removed iframe-driven deletes outright, so the chrome never honors one and
// the reference-aware sweeper owns reclamation. See chrome-client-queue.test.js.

test("an upload result is only applied to the document that asked for it (E1)", () => {
  const parentWindow = { name: "chrome" };
  const nonce = "doc-nonce-1";
  const trusted = (data, source = parentWindow) => isTrustedAttachmentResult({ source, data }, { parentWindow, nonce });

  // The chrome's own result for this document's upload.
  assert.equal(trusted({ nonce, localId: "att-1", ok: true }), true);

  // A stale result from BEFORE an iframe reload. Local ids restart at "att-1" on
  // every load, so without a per-document nonce this marks a brand-new chip ready
  // with the previous document's image.
  assert.equal(trusted({ nonce: "doc-nonce-0", localId: "att-1", ok: true }), false);
  assert.equal(trusted({ localId: "att-1", ok: true }), false, "a result with no nonce is not ours");

  // A forged same-window message: the artifact posting to itself must never be
  // able to hand its own chips a server id it did not upload.
  assert.equal(trusted({ nonce, localId: "att-1", ok: true }, { name: "self" }), false);
  assert.equal(
    trusted({ nonce, localId: "att-1", ok: true }, null),
    false,
    "a sourceless message is not from the chrome",
  );
});

test("attachment result trust survives a hostile nonce shape (E1)", () => {
  const parentWindow = { name: "chrome" };
  const nonce = "doc-nonce-1";
  const trusted = (data) => isTrustedAttachmentResult({ source: parentWindow, data }, { parentWindow, nonce });

  // Exact string equality only: no coercion, no prefix/truthiness games.
  for (const hostile of [{}, { nonce: null }, { nonce: 0 }, { nonce: true }, { nonce: ["doc-nonce-1"] }]) {
    assert.equal(trusted(hostile), false, `nonce ${JSON.stringify(hostile)} must not pass`);
  }
  // A document with no nonce of its own never accepts results either.
  assert.equal(isTrustedAttachmentResult({ source: parentWindow, data: {} }, { parentWindow, nonce: "" }), false);
});

const ACCEPTED = { "image/png": true, "image/jpeg": true, "image/webp": true };
const file = (name, type) => ({ name, type });

test("a mixed drop attaches the images AND reports every unsupported file (W4-a)", () => {
  // The ruled behavior: partial-accept. Keep the images the user dropped, and
  // surface one visible error chip per unsupported companion. Reporting the
  // unsupported files only when there were NO images is what made a mixed drop
  // swallow them silently.
  const { images, unsupported } = partitionDroppedFiles(
    { files: [file("shot.png", "image/png"), file("report.pdf", "application/pdf"), file("notes.txt", "text/plain")] },
    ACCEPTED,
  );

  assert.deepEqual(
    images.map((image) => image.name),
    ["shot.png"],
  );
  assert.deepEqual(unsupported, ["report.pdf", "notes.txt"]);
});

test("an all-image drop reports nothing unsupported (W4-a)", () => {
  const { images, unsupported } = partitionDroppedFiles(
    { files: [file("a.png", "image/png"), file("b.webp", "image/webp")] },
    ACCEPTED,
  );
  assert.equal(images.length, 2);
  assert.deepEqual(unsupported, []);
});

test("an all-unsupported drop reports each file and attaches none (W4-a)", () => {
  const { images, unsupported } = partitionDroppedFiles(
    { files: [file("report.pdf", "application/pdf"), file("archive.zip", "application/zip")] },
    ACCEPTED,
  );
  assert.deepEqual(images, []);
  assert.deepEqual(unsupported, ["report.pdf", "archive.zip"]);
});

test("a nameless unsupported file still gets a chip label (W4-a)", () => {
  const { unsupported } = partitionDroppedFiles({ files: [file("", "application/pdf")] }, ACCEPTED);
  assert.deepEqual(unsupported, ["file"]);
});

test("a pasted item list partitions the same way (W4-a)", () => {
  const png = file("pasted.png", "image/png");
  const { images, unsupported } = partitionDroppedFiles(
    {
      items: [
        { kind: "file", type: "image/png", getAsFile: () => png },
        { kind: "file", type: "application/pdf", getAsFile: () => file("x.pdf", "application/pdf") },
        { kind: "string", type: "text/plain", getAsFile: () => null },
      ],
    },
    ACCEPTED,
  );
  assert.deepEqual(images, [png]);
  assert.deepEqual(unsupported, ["file"]);
});

test("an empty drop partitions to nothing (W4-a)", () => {
  assert.deepEqual(partitionDroppedFiles(null, ACCEPTED), { images: [], unsupported: [] });
  assert.deepEqual(partitionDroppedFiles({}, ACCEPTED), { images: [], unsupported: [] });
});

test("the SDK bundle wires the drop handler to partial-accept (W4-a)", () => {
  assert.match(sdk, /const partitionDroppedFiles=/);
  assert.match(sdk, /partitionDroppedFiles\(event\.dataTransfer, ATTACHMENT_ACCEPTED_MIME\)/);
  // Unsupported files are rejected as a single batch (D7), not one render per file.
  assert.match(sdk, /attachments\.rejectUnsupportedBatch\(unsupported\)/);
});

test("attachmentSizeError rejects an over-limit file before it is read (round7-a)", () => {
  const cap = 10 * 1024 * 1024; // 10 MiB
  // Within the limit (and the boundary) is accepted.
  assert.equal(attachmentSizeError(1024, cap), "");
  assert.equal(attachmentSizeError(cap, cap), "");
  // Over the limit is rejected with a message that names the cap.
  const over = attachmentSizeError(cap + 1, cap);
  assert.notEqual(over, "");
  assert.match(over, /larger than/i);
  assert.match(over, /MB/);
  // A huge drop - the case that would otherwise be allocated + structured-cloned
  // into the chrome before any check - is refused.
  assert.notEqual(attachmentSizeError(2 * 1024 * 1024 * 1024, cap), "");
  // An unwired/disabled limit imposes no client-side gate (the server still caps).
  assert.equal(attachmentSizeError(cap + 1, 0), "");
  assert.equal(attachmentSizeError(cap + 1, undefined), "");
  assert.equal(attachmentSizeError(cap + 1, -1), "");
  // A non-finite size never throws and never falsely rejects.
  assert.equal(attachmentSizeError(NaN, cap), "");
});

test("the SDK bundle checks the size limit before reading or cloning the file (round7-a)", () => {
  // The limit is threaded in, and the size decision runs in classifyAttachmentBatch
  // (called by addFiles with ATTACHMENT_MAX_BYTES) BEFORE any createObjectURL /
  // arrayBuffer, so an oversized file is decided "error" and never materializes a
  // buffer or a second clone. Post-D7 the gate lives in the classifier, not inline.
  assert.match(sdk, /const ATTACHMENT_MAX_BYTES\s*=/);
  assert.match(sdk, /const attachmentSizeError=/);
  assert.match(sdk, /const classifyAttachmentBatch=/);
  // The classifier is the size gate, and it does its check on file.size.
  assert.match(sdk, /attachmentSizeError\(file\.size, maxBytes\)/);
  // addFiles runs the classifier with the real limit, and createObjectURL only ever
  // runs afterwards (for an "accept" decision), so nothing is read before the gate.
  const gateAt = sdk.indexOf("classifyAttachmentBatch(files, {");
  const threadsLimit = /classifyAttachmentBatch\(files, \{[\s\S]*?maxBytes: ATTACHMENT_MAX_BYTES/.test(sdk);
  const createObjectUrlAt = sdk.indexOf("URL.createObjectURL");
  assert.ok(gateAt !== -1, "addFiles routes the batch through the classifier");
  assert.ok(threadsLimit, "the classifier is called with ATTACHMENT_MAX_BYTES");
  assert.equal(sdk.match(/URL\.createObjectURL/g).length, 1, "createObjectURL only appears once, in the accept path");
  assert.ok(
    gateAt < createObjectUrlAt,
    "the size gate (classifier) precedes createObjectURL, so nothing is read first",
  );
});

test("classifyAttachmentBatch decides a whole drop in one pass (D7)", () => {
  const accepted = { "image/png": true };
  const cap = 10 * 1024 * 1024;
  const files = [
    { type: "image/png", size: 1 }, // accept (count 2 -> 3)
    { type: "application/pdf", size: 1 }, // skip: wrong mime
    { type: "image/png", size: 20 * 1024 * 1024 }, // error: over size
    { type: "image/png", size: 1 }, // accept (count 3 -> 4)
    { type: "image/png", size: 1 }, // cap: count already at max 4
  ];
  const decisions = classifyAttachmentBatch(files, {
    currentCount: 2,
    maxCount: 4,
    maxBytes: cap,
    accepted,
  });
  assert.deepEqual(
    decisions.map((d) => d.kind),
    ["accept", "skip", "error", "accept", "cap"],
  );
  // Only accepts carry the file forward for upload; the size error carries its message.
  assert.equal(decisions.filter((d) => d.kind === "accept").length, 2);
  assert.match(decisions.find((d) => d.kind === "error").error, /larger than/i);
  // Count cap is honored ACROSS the batch, not reset per file.
  const allImages = classifyAttachmentBatch(
    [
      { type: "image/png", size: 1 },
      { type: "image/png", size: 1 },
      { type: "image/png", size: 1 },
    ],
    {
      currentCount: 0,
      maxCount: 2,
      maxBytes: 0,
      accepted,
    },
  );
  assert.deepEqual(
    allImages.map((d) => d.kind),
    ["accept", "accept", "cap"],
  );
});

test("the SDK bundle renders once per multi-file batch (D7)", () => {
  assert.match(sdk, /const classifyAttachmentBatch=/);
  // addFiles routes the whole list through the classifier instead of per-file add().
  assert.match(sdk, /classifyAttachmentBatch\(/);
  // A batched unsupported-rejection path exists and the drop handler uses it...
  assert.match(sdk, /function rejectUnsupportedBatch\(/);
  assert.match(sdk, /attachments\.rejectUnsupportedBatch\(unsupported\)/);
  // ...instead of the old per-file loop that rendered N times.
  assert.doesNotMatch(sdk, /for \(const name of unsupported\) attachments\.rejectUnsupported\(name\)/);
});
