import assert from "node:assert/strict";
import test from "node:test";

import { createWhiteboardEndSessionHotkeyHandler } from "../src/whiteboard-hotkeys.js";

function keyEvent(overrides = {}) {
  return {
    key: "e",
    metaKey: true,
    shiftKey: true,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopImmediatePropagation() {
      this.propagationStopped = true;
    },
    ...overrides,
  };
}

test("fullscreen whiteboard consumes and relays the end-session shortcut", () => {
  let mode = "inline";
  const messages = [];
  const handler = createWhiteboardEndSessionHotkeyHandler(
    () => mode,
    (message) => messages.push(message),
  );

  const inlineEvent = keyEvent();
  handler(inlineEvent);
  assert.equal(inlineEvent.defaultPrevented, false);
  assert.equal(inlineEvent.propagationStopped, false);
  assert.deepEqual(messages, []);

  mode = "overlay";
  const overlayEvent = keyEvent();
  handler(overlayEvent);
  assert.equal(overlayEvent.defaultPrevented, true);
  assert.equal(overlayEvent.propagationStopped, true);
  assert.deepEqual(messages, [{ type: "lavish-whiteboard:endSession" }]);
});

test("whiteboard end-session relay preserves Escape and IME composition", () => {
  const messages = [];
  const handler = createWhiteboardEndSessionHotkeyHandler(
    () => "overlay",
    (message) => messages.push(message),
  );

  const escapeEvent = keyEvent({ key: "Escape", metaKey: false, shiftKey: false });
  handler(escapeEvent);
  const composingEvent = keyEvent({ isComposing: true });
  handler(composingEvent);

  assert.equal(escapeEvent.defaultPrevented, false);
  assert.equal(escapeEvent.propagationStopped, false);
  assert.equal(composingEvent.defaultPrevented, false);
  assert.equal(composingEvent.propagationStopped, false);
  assert.deepEqual(messages, []);
});
