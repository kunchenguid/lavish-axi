/* global document, Event, fetch, HTMLTextAreaElement, KeyboardEvent, location, window, WheelEvent */

// Mounts the real sketch layer as a top-level page and plays the chrome's side of the channel:
// the frame posts to `window.top`, which is this window. Select-all stands in for the reviewer
// selecting a sketch, so the run drives the same selection -> Comment -> Queue path a click does.
import "@excalidraw/excalidraw/index.css";
import "../../src/whiteboard-frame.css";

import { startSketchFrame } from "../../src/sketch-frame.js";

window.EXCALIDRAW_ASSET_PATH = `${location.origin}/whiteboard-assets/`;
window.__lavishWhiteboardChannelToken = "fixture-token";

const RECT = {
  id: "box",
  type: "rectangle",
  x: 120,
  y: 300,
  width: 200,
  height: 60,
  strokeColor: "#e03131",
  backgroundColor: "transparent",
};

const fromFrame = [];
let autoAckSaves = true;
window.addEventListener("message", (event) => {
  const type = String(event.data?.type || "");
  if (
    type === "lavish-sketch:ready" ||
    type === "lavish-sketch:comment" ||
    type === "lavish-sketch:scrollBy" ||
    type === "lavish-sketch:save" ||
    type === "lavish-sketch:draft" ||
    type === "lavish-sketch:toggleAnnotationMode"
  ) {
    fromFrame.push(event.data);
  }
  if (type === "lavish-sketch:save" && autoAckSaves) toChrome({ type: "lavish-sketch:saveResult", ok: true });
});

function count(type) {
  return fromFrame.filter((m) => m.type === type).length;
}

function lastDraft() {
  return fromFrame.filter((m) => m.type === "lavish-sketch:draft").at(-1)?.draft;
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

// Chrome runs this page under --virtual-time-budget, where timers skip ahead whenever the page is
// idle. Queue waits on Excalidraw's PNG export, which Chrome encodes in real time off the main
// thread, so a timer-only poll could spend its whole 5s budget in a few real milliseconds on a slow
// runner. Each attempt also waits on `/tick`, which answers after 25 real ms (a pending fetch pauses
// virtual time), so the deadline is at least 5s of real time as well.
async function until(read, what) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = read();
    if (value) return value;
    await sleep(25);
    await fetch("/tick", { cache: "no-store" });
  }
  throw new Error(`timed out waiting for ${what}`);
}

function toChrome(message) {
  window.postMessage({ ...message, channelId: "fixture-token" }, "*");
}

// Excalidraw's shortcuts take Cmd on macOS and Ctrl elsewhere.
const SHORTCUT_MODIFIER = /Mac|iPod|iPhone|iPad/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true };

function selectAll() {
  document
    .querySelector(".excalidraw")
    .dispatchEvent(new KeyboardEvent("keydown", { key: "a", code: "KeyA", ...SHORTCUT_MODIFIER, bubbles: true }));
}

async function run() {
  startSketchFrame();
  await until(() => fromFrame.find((m) => m.type === "lavish-sketch:ready"), "the ready message");
  // The artifact is scrolled 200px down when the layer boots.
  toChrome({
    type: "lavish-sketch:init",
    scene: { elements: [RECT], files: {} },
    active: true,
    scroll: { x: 0, y: 200 },
  });
  await until(() => document.querySelector(".excalidraw canvas"), "the editor");
  await sleep(300);

  // Excalidraw handles keys on its container unless handleKeyboardGlobally is set.
  selectAll();
  const button = await until(() => document.querySelector(".sk-comment"), "the Comment button");
  // Scene y 300..360 at scroll 200 is viewport y 100..160; the button sits just below it.
  const buttonTop = Math.round(button.getBoundingClientRect().top);

  toChrome({ type: "lavish-sketch:scroll", x: 0, y: 250 });
  await sleep(150);
  const scrolledTop = Math.round(document.querySelector(".sk-comment").getBoundingClientRect().top);

  document
    .querySelector(".excalidraw__canvas.interactive")
    .dispatchEvent(new WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true }));
  const scrollBy = await until(() => fromFrame.find((m) => m.type === "lavish-sketch:scrollBy"), "wheel relay");

  document.querySelector(".sk-comment").click();
  const textarea = await until(() => document.querySelector(".sk-card textarea"), "the comment card");
  // Typing past the comment limit stops at the limit, so Queue never cuts what the field shows.
  textarea.focus();
  document.execCommand("insertText", false, "x".repeat(4001));
  const typedLength = textarea.value.length;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(textarea, "Make this primary");
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(50);
  const draftWhileTyping = lastDraft();
  // A switch or hotkey the chrome refuses for this unsent comment moves focus back to it.
  textarea.blur();
  toChrome({ type: "lavish-sketch:focusComment" });
  await sleep(50);
  const commentRefocused = document.activeElement === textarea;
  const scrollBysBefore = count("lavish-sketch:scrollBy");
  const textareaWheel = new WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true });
  textarea.dispatchEvent(textareaWheel);
  await sleep(50);
  const textareaWheelRelayed = count("lavish-sketch:scrollBy") !== scrollBysBefore || textareaWheel.defaultPrevented;
  document.querySelector(".sk-card .sk-queue").click();
  const comment = await until(() => fromFrame.find((m) => m.type === "lavish-sketch:comment"), "the comment");
  toChrome({ type: "lavish-sketch:commentResult", attemptId: comment.attemptId, ok: true });
  await sleep(150);
  const draftAfterQueue = lastDraft();

  // Cancelling a busy card and opening a new one must survive the old attempt succeeding late.
  selectAll();
  const typeInto = async (value) => {
    document.querySelector(".sk-comment").click();
    const field = await until(() => document.querySelector(".sk-card textarea"), "a comment card");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(50);
  };
  await until(() => document.querySelector(".sk-comment"), "the Comment button after queueing");
  await typeInto("first note");
  document.querySelector(".sk-card .sk-queue").click();
  const firstNote = await until(() => fromFrame.find((m) => m.comment === "first note"), "the first note");
  const textareaReadOnlyWhileBusy = document.querySelector(".sk-card textarea").readOnly;
  document.querySelector(".sk-card .sk-cancel").click();
  await until(() => document.querySelector(".sk-comment"), "the Comment button after cancel");
  await typeInto("second note");
  toChrome({ type: "lavish-sketch:commentResult", attemptId: firstNote.attemptId, ok: true });
  await sleep(150);
  const newerCardText = document.querySelector(".sk-card textarea")?.value ?? null;
  document.querySelector(".sk-card .sk-cancel")?.click();

  // A failed save is retried, and the scene counts as a draft until a save lands.
  autoAckSaves = false;
  const savesBefore = count("lavish-sketch:save");
  selectAll();
  document
    .querySelector(".excalidraw")
    .dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", code: "Delete", bubbles: true }));
  await until(() => count("lavish-sketch:save") > savesBefore, "the save after a delete");
  const deletedSaved = fromFrame
    .filter((m) => m.type === "lavish-sketch:save")
    .at(-1)
    .scene.elements.every((element) => element.isDeleted);
  toChrome({ type: "lavish-sketch:saveResult", ok: false });
  await until(() => count("lavish-sketch:save") > savesBefore + 1, "the retried save");
  const draftWhileUnsaved = lastDraft();
  toChrome({ type: "lavish-sketch:saveResult", ok: true });
  await until(() => lastDraft() === false, "the saved scene clearing the draft");

  // The annotate hotkey toggles modes in the chrome and never reaches Excalidraw's container
  // listener, whose `I` arms the eyedropper and swallows the next wheel and drag. The headless
  // window is mobile-sized, where Excalidraw hides the eyedropper, so watch the delivery instead.
  const editor = document.querySelector(".excalidraw");
  let editorSawHotkey = 0;
  editor.addEventListener("keydown", (event) => {
    if (event.key === "i") editorSawHotkey += 1;
  });
  const togglesBefore = count("lavish-sketch:toggleAnnotationMode");
  editor.dispatchEvent(new KeyboardEvent("keydown", { key: "i", code: "KeyI", ctrlKey: true, bubbles: true }));
  await sleep(50);
  const hotkey = { toggled: count("lavish-sketch:toggleAnnotationMode") - togglesBefore, editorSawHotkey };

  // Undo the delete so a selection exists again.
  document
    .querySelector(".excalidraw")
    .dispatchEvent(new KeyboardEvent("keydown", { key: "z", code: "KeyZ", ...SHORTCUT_MODIFIER, bubbles: true }));
  await sleep(150);
  selectAll();
  await until(() => document.querySelector(".sk-comment"), "the Comment button before deselect");
  await typeInto("keep me");
  // Clicking empty canvas clears the selection, which must not erase the unsent comment.
  const canvas = document.querySelector(".excalidraw__canvas.interactive");
  const click = (type) =>
    canvas.dispatchEvent(
      new PointerEvent(type, {
        clientX: 20,
        clientY: 20,
        button: 0,
        buttons: type === "pointerdown" ? 1 : 0,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        bubbles: true,
      }),
    );
  click("pointerdown");
  await sleep(50);
  click("pointerup");
  await sleep(150);
  const textAfterDeselect = document.querySelector(".sk-card textarea")?.value ?? null;
  // Moving the sketch while the card is open must move the queued target with it.
  selectAll();
  await sleep(100);
  const nudge = () =>
    document
      .querySelector(".excalidraw")
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", code: "ArrowRight", shiftKey: true, bubbles: true }),
      );
  nudge();
  await sleep(100);
  const queuedBefore = count("lavish-sketch:comment");
  document.querySelector(".sk-card .sk-queue").click();
  const movedComment = await until(
    () => fromFrame.filter((m) => m.type === "lavish-sketch:comment").at(queuedBefore),
    "the comment after a move",
  );
  toChrome({ type: "lavish-sketch:commentResult", attemptId: movedComment.attemptId, ok: true });
  await sleep(100);

  const pngSignature = Array.from(comment.png.slice(0, 4)).join(",");
  return {
    pass: true,
    canvasBackground: window.getComputedStyle(document.body).backgroundColor,
    buttonTop,
    scrolledTop,
    wheelDeltaY: scrollBy.y,
    textareaWheelRelayed,
    drafts: { draftWhileTyping, draftAfterQueue, draftWhileUnsaved },
    deletedSaved,
    hotkey,
    comment: {
      text: comment.comment,
      ids: comment.ids,
      label: comment.label,
      bounds: comment.bounds,
      point: comment.point,
    },
    pngSignature,
    cardClosed: !document.querySelector(".sk-card"),
    newerCardText,
    textAfterDeselect,
    movedFromX: RECT.x,
    movedToX: movedComment.bounds.x,
    movedPointX: movedComment.point.x,
    textareaReadOnlyWhileBusy,
    typedLength,
    commentRefocused,
  };
}

function report(result) {
  location.replace(`/result?value=${encodeURIComponent(JSON.stringify(result))}`);
}

run().then(
  (result) => report(result),
  (error) => report({ pass: false, error: error?.stack || String(error) }),
);
