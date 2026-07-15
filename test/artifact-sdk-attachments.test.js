import assert from "node:assert/strict";
import test from "node:test";

import { classifyAttachmentDelete, deriveAttachmentNoticeState } from "../src/artifact-sdk.js";
import { createSdkJs } from "../src/server.js";

// The annotation card lives inside the sandboxed artifact iframe, so its image
// attachment behavior can only be exercised in a real browser. These assertions
// pin the SDK <-> chrome message contract in the serialized bundle so a refactor
// can't silently break the paste/drop -> upload -> queue handshake.
const sdk = createSdkJs("0123456789abcdef");

test("the SDK bundle uploads captured images through the chrome", () => {
  assert.match(sdk, /type: "lavish:uploadAttachment", localId: item\.localId/);
  assert.match(sdk, /item\.file\s*\n?\s*\.arrayBuffer\(\)/);
});

test("the SDK bundle applies upload results and removes/retries attachments", () => {
  assert.match(sdk, /lavish:attachmentResult/);
  assert.match(sdk, /activeAttachments\?\.handleResult\(msg\.localId, msg\.ok, msg\.id, msg\.error\)/);
  assert.match(sdk, /type: "lavish:removeAttachment", id \}/);
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
  assert.match(sdk, /attachments\.rejectUnsupported\(unsupportedDropName\(event\.dataTransfer\)\)/);
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
  const transient = "Waiting for an image to finish uploading…";
  let state = deriveAttachmentNoticeState(undefined, cap, "cap");
  assert.deepEqual(state, { cap, transient: "", visible: cap });

  state = deriveAttachmentNoticeState(state, transient, "transient");
  assert.deepEqual(state, { cap, transient, visible: transient });

  state = deriveAttachmentNoticeState(state, "", "transient");
  assert.deepEqual(state, { cap, transient: "", visible: cap });
  assert.match(sdk, /if \(noticeState\.visible\)/);
  assert.match(sdk, /attachNotice\.classList\.add\("lavish-hint-alert"\)/);

  state = deriveAttachmentNoticeState(state, "", "cap");
  assert.deepEqual(state, { cap: "", transient: "", visible: "" });
  assert.match(sdk, /if \(items\.length < ATTACHMENT_MAX_COUNT\) notify\("", "cap"\)/);
});

test("a removed chip's file is deleted only when nothing else can reference it", () => {
  // Nothing else holds the id and no upload is in flight: the file is provably
  // unreferenced, so the eager delete is safe.
  assert.equal(classifyAttachmentDelete([], "img-1"), "delete");
  assert.equal(classifyAttachmentDelete([{ status: "ready", id: "img-2" }], "img-1"), "delete");
  // A settled sibling already shows the same content-addressed file.
  assert.equal(classifyAttachmentDelete([{ status: "ready", id: "img-1" }], "img-1"), "skip");
  // A chip with no id (an unsupported-type error chip) never deletes anything.
  assert.equal(classifyAttachmentDelete([], ""), "skip");
});

test("a removed chip's file survives while an identical twin is still uploading (W-B)", () => {
  // The twin dedups to the SAME content-addressed id but has no id yet, so an id
  // check alone misses it. Deleting now would strand the twin's upload on a file
  // that no longer exists and the send would fail as not-found.
  const items = [{ status: "uploading", id: "" }];
  assert.equal(classifyAttachmentDelete(items, "img-1"), "defer");
  // Once that upload settles onto the same id, the surviving twin owns the file.
  assert.equal(classifyAttachmentDelete([{ status: "ready", id: "img-1" }], "img-1"), "skip");
  // Settling onto a different id (or failing) leaves the parked id unreferenced.
  assert.equal(classifyAttachmentDelete([{ status: "ready", id: "img-9" }], "img-1"), "delete");
  assert.equal(classifyAttachmentDelete([{ status: "error", id: "" }], "img-1"), "delete");
});

test("the SDK bundle parks an undecidable delete until every upload settles (W-B)", () => {
  assert.match(sdk, /const classifyAttachmentDelete=/);
  // removeAt routes through the classifier instead of posting the delete eagerly.
  assert.match(sdk, /function releaseAttachmentId\(id\)/);
  assert.match(sdk, /const decision = classifyAttachmentDelete\(items, id\)/);
  assert.match(sdk, /pendingDeletes\.add\(id\)/);
  // Every settling upload re-decides the parked ids.
  assert.match(sdk, /function flushPendingDeletes\(\)/);
  assert.match(sdk, /flushPendingDeletes\(\);/);
  assert.match(sdk, /type: "lavish:removeAttachment", id/);
});
