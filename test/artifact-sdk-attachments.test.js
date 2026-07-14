import assert from "node:assert/strict";
import test from "node:test";

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
  assert.match(sdk, /type: "lavish:removeAttachment", id: item\.id/);
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

test("the SDK bundle only deletes a removed chip's file when no sibling shares its id", () => {
  assert.match(sdk, /!items\.some\(\(other\) => other\.id === item\.id\)/);
});
