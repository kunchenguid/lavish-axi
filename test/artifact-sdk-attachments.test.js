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
