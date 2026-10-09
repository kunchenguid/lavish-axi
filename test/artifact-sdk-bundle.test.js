import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { createSdkJs } from "../src/server.js";

// The SDK the browser actually runs is a serialized bundle, not the module: `createSdkJs` has to
// declare every helper `createArtifactSdk` reaches for. A helper left out compiles fine and only
// ReferenceErrors on the first click, so these tests boot the served bundle and drive the real
// annotation path through a DOM stub instead of inspecting the module directly.

function createElement(tag) {
  const attributes = new Map();
  const queried = new Map();
  const element = {
    tagName: String(tag).toUpperCase(),
    nodeName: String(tag).toUpperCase(),
    nodeType: 1,
    parentElement: null,
    children: [],
    style: {},
    value: "",
    innerHTML: "",
    textContent: "",
    offsetWidth: 100,
    offsetHeight: 100,
    hidden: false,
    listeners: [],
    classList: {
      add() {},
      remove() {},
      contains() {
        return false;
      },
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    getAttribute(name) {
      return attributes.has(name) ? attributes.get(name) : null;
    },
    matches(selectorList) {
      return String(selectorList)
        .split(",")
        .some((part) => {
          const selector = part.trim();
          // `tag`, `[attr]`, or `tag[attr]` (e.g. `a[href]`): enough selector for what the SDK asks.
          const bracket = selector.indexOf("[");
          const tag = bracket >= 0 ? selector.slice(0, bracket) : selector;
          if (tag && tag !== element.tagName.toLowerCase()) return false;
          return bracket < 0 || attributes.has(selector.slice(bracket + 1, selector.indexOf("]")).split("=")[0]);
        });
    },
    closest(selectorList) {
      let current = element;
      while (current) {
        if (current.matches(selectorList)) return current;
        current = current.parentElement;
      }
      return null;
    },
    appendChild(child) {
      child.parentElement = element;
      element.children.push(child);
      return child;
    },
    remove() {
      const index = element.parentElement?.children.indexOf(element) ?? -1;
      if (index >= 0) element.parentElement.children.splice(index, 1);
    },
    // Card internals are looked up by class after innerHTML is assigned, so hand back a stable
    // stub per selector: the test drives the very buttons the SDK wired up.
    querySelector(selector) {
      if (!queried.has(selector)) queried.set(selector, createElement(selector.replace(/^[.#]/, "")));
      return queried.get(selector);
    },
    querySelectorAll() {
      return [];
    },
    getBoundingClientRect() {
      return { left: 10, top: 10, right: 110, bottom: 40, width: 100, height: 30 };
    },
    addEventListener(type, handler) {
      element.listeners.push({ type, handler });
    },
    removeEventListener() {},
    focus() {},
    click() {},
    scrollIntoView() {},
    attachShadow() {
      element.shadowRoot = createElement("shadow-root");
      return element.shadowRoot;
    },
  };
  return element;
}

function appendTo(parent, child) {
  child.parentElement = parent;
  parent.children.push(child);
  return child;
}

function cell(tag, text) {
  const element = createElement(tag);
  element.textContent = text;
  return element;
}

function bootSdk({
  runAnimationFrames = false,
  revisionsScript = null,
  revisionMarkElements = [],
  htmlAnnotate = null,
  bodyAnnotate = null,
  readyState = "complete",
} = {}) {
  const posted = [];
  const documentListeners = [];
  // Deferred work the SDK schedules, run only when a test asks for it: the draft-anchor settle
  // re-query is a real timer, and asserting on it means running it rather than assuming it.
  const timers = [];
  const scheduleTimer = (fn, ms) => timers.push({ fn, ms }) && timers.length;
  const cancelTimer = (id) => {
    if (timers[id - 1]) timers[id - 1].cancelled = true;
  };
  /** @type {(selector: string) => any} */
  let documentQuery = () => null;
  /** @type {any} */
  let selection = null;
  const documentElement = createElement("html");
  const head = createElement("head");
  const body = createElement("body");
  if (htmlAnnotate !== null) documentElement.setAttribute("data-lavish-annotate", htmlAnnotate);
  if (bodyAnnotate !== null) body.setAttribute("data-lavish-annotate", bodyAnnotate);
  appendTo(documentElement, head);
  appendTo(documentElement, body);
  for (const element of revisionMarkElements) appendTo(body, element);

  const sandbox = {
    parent: { postMessage: (message) => posted.push(message) },
    navigator: { platform: "Linux" },
    CSS: { escape: (value) => String(value) },
    Element: class Element {},
    MutationObserver: class MutationObserver {
      observe() {}
      disconnect() {}
    },
    ResizeObserver: class ResizeObserver {
      observe() {}
      disconnect() {}
    },
    URL: {
      createObjectURL() {
        return "blob:lavish-test";
      },
      revokeObjectURL() {},
    },
    getComputedStyle: () => ({}),
    setTimeout: scheduleTimer,
    clearTimeout: cancelTimer,
    requestAnimationFrame: (fn) => (runAnimationFrames ? scheduleTimer(fn, 0) : 0),
    document: {
      readyState,
      documentElement,
      head,
      body,
      activeElement: body,
      baseURI: "http://127.0.0.1/artifact/abc/index.html",
      addEventListener: (type, handler) => documentListeners.push({ type, handler }),
      removeEventListener() {},
      createElement,
      getElementById: () => null,
      querySelector: (selector) =>
        selector === "script[data-lavish-revisions]" ? revisionsScript : documentQuery(selector),
      querySelectorAll: (selector) => (selector === "[data-lavish-revision]" ? revisionMarkElements : []),
      getSelection: () => selection,
    },
  };
  const windowListeners = [];
  sandbox.window = {
    addEventListener: (type, handler) => windowListeners.push({ type, handler }),
    removeEventListener() {},
    setTimeout: scheduleTimer,
    clearTimeout: cancelTimer,
    requestAnimationFrame: (fn) => (runAnimationFrames ? scheduleTimer(fn, 0) : 0),
    innerWidth: 1280,
    innerHeight: 800,
    scrollX: 0,
    scrollY: 0,
    location: { origin: "http://127.0.0.1" },
    URL: sandbox.URL,
  };
  sandbox.globalThis = sandbox;

  vm.runInNewContext(createSdkJs("abc", 3, "load-token"), sandbox);

  return {
    posted,
    body,
    api: sandbox.window.lavish,
    domContentLoaded() {
      for (const listener of documentListeners.filter((entry) => entry.type === "DOMContentLoaded")) {
        listener.handler();
      }
    },
    // Returns the dispatched event so a test can tell whether the SDK swallowed the click.
    click(target, modifiers = {}) {
      const listener = documentListeners.find((entry) => entry.type === "click");
      assert.ok(listener, "the SDK registers a document click listener");
      const event = {
        target,
        ctrlKey: false,
        metaKey: false,
        ...modifiers,
        defaultPrevented: false,
        preventDefault() {
          event.defaultPrevented = true;
        },
        stopPropagation() {},
      };
      listener.handler(event);
      return event;
    },
    // Releases the mouse over `target` with `text` selected inside it, as a drag-select would.
    selectText(target, text) {
      const textNode = { nodeType: 3, parentElement: target, parentNode: { childNodes: [] } };
      textNode.parentNode.childNodes.push(textNode);
      const range = {
        collapsed: false,
        commonAncestorContainer: textNode,
        startContainer: textNode,
        startOffset: 0,
        endContainer: textNode,
        endOffset: text.length,
        cloneRange: () => range,
        getClientRects: () => [],
        getBoundingClientRect: () => target.getBoundingClientRect(),
      };
      selection = { rangeCount: 1, getRangeAt: () => range, toString: () => text };
      const listener = documentListeners.find((entry) => entry.type === "mouseup");
      assert.ok(listener, "the SDK registers a document mouseup listener");
      listener.handler({ target });
      selection = null;
    },
    setDocumentQuery(query) {
      documentQuery = query;
    },
    runTimers() {
      const pending = timers.splice(0, timers.length);
      for (const timer of pending) {
        if (!timer.cancelled) timer.fn();
      }
    },
    async runAllTimers() {
      for (let round = 0; round < 100; round += 1) {
        await Promise.resolve();
        await Promise.resolve();
        const pending = timers.splice(0, timers.length);
        if (pending.length === 0) {
          await Promise.resolve();
          if (timers.length === 0) return;
          continue;
        }
        for (const timer of pending) {
          if (!timer.cancelled) timer.fn();
        }
      }
      assert.fail("the SDK timer queue did not settle");
    },
    // The chrome is the only legitimate sender, so its messages arrive with `source: parent`.
    sendChromeMessage(data) {
      const listeners = windowListeners.filter((entry) => entry.type === "message");
      assert.ok(listeners.length > 0, "the SDK registers a window message listener");
      for (const listener of listeners) listener.handler({ source: sandbox.parent, data });
    },
    cards() {
      return documentElement.children
        .flatMap((child) => child.shadowRoot?.children || [])
        .filter((child) => child.className === "lavish-annotation-card");
    },
    card() {
      const card = this.cards().at(-1);
      assert.ok(card, "clicking an element opens an annotation card");
      return card;
    },
    queue(text) {
      const card = this.card();
      card.querySelector("textarea").value = text;
      card.querySelector(".lavish-send").onclick();
      return posted.at(-1);
    },
  };
}

for (const { label, attributes, enabled } of [
  { label: "default", attributes: {}, enabled: true },
  { label: "html off", attributes: { htmlAnnotate: "off" }, enabled: false },
  { label: "body off", attributes: { bodyAnnotate: "off" }, enabled: false },
  { label: "html on", attributes: { htmlAnnotate: "on" }, enabled: true },
  { label: "body on", attributes: { bodyAnnotate: "on" }, enabled: true },
  { label: "unknown html value", attributes: { htmlAnnotate: "no" }, enabled: true },
  { label: "unknown body value", attributes: { bodyAnnotate: "no" }, enabled: true },
  { label: "body overrides html", attributes: { htmlAnnotate: "off", bodyAnnotate: "on" }, enabled: true },
]) {
  test(`annotation declaration honours ${label} and reports its initial mode`, () => {
    const sdk = bootSdk(attributes);
    const target = appendTo(sdk.body, cell("p", "Decision board"));
    assert.equal(sdk.click(target).defaultPrevented, enabled);
    assert.equal(sdk.cards().length, enabled ? 1 : 0);
    const mode = sdk.posted.find((message) => message.type === "lavish:annotationMode");
    assert.ok(mode, "the SDK reports the initial mode to the chrome");
    assert.equal(mode.enabled, enabled);
    assert.equal(mode.artifact_load_token, "load-token");
  });
}

test("the chrome can turn annotation on and off after a page declares off", () => {
  const sdk = bootSdk({ bodyAnnotate: "off" });
  const target = appendTo(sdk.body, cell("p", "Decision board"));
  assert.equal(sdk.click(target).defaultPrevented, false);
  sdk.sendChromeMessage({ type: "lavish:setAnnotationMode", enabled: true });
  assert.equal(sdk.click(target).defaultPrevented, true);
  assert.equal(sdk.cards().length, 1);
  sdk.sendChromeMessage({ type: "lavish:setAnnotationMode", enabled: false });
  assert.equal(sdk.click(target).defaultPrevented, false);
  // This harness retains closed cards; no new card should appear while disabled.
  assert.equal(sdk.cards().length, 1);
  sdk.runTimers();
  const state = sdk.posted.filter((message) => message.type === "lavish:reviewState").at(-1);
  assert.equal(state.state.card, null, "turning annotation off closes the active card");
});

test("the initial declaration report waits for DOMContentLoaded without resetting a chrome override", () => {
  const sdk = bootSdk({ bodyAnnotate: "off", readyState: "loading" });
  assert.equal(
    sdk.posted.some((message) => message.type === "lavish:annotationMode"),
    false,
  );
  sdk.sendChromeMessage({ type: "lavish:setAnnotationMode", enabled: true });
  sdk.domContentLoaded();
  const mode = sdk.posted.find((message) => message.type === "lavish:annotationMode");
  assert.equal(mode?.enabled, false, "the report carries the declared default, not the chrome override");
  const target = appendTo(sdk.body, cell("p", "Decision board"));
  assert.equal(sdk.click(target).defaultPrevented, true, "DOMContentLoaded does not undo the toolbar");
});

function buildTable(sdk) {
  const table = appendTo(sdk.body, createElement("table"));
  const thead = appendTo(table, createElement("thead"));
  const headerRow = appendTo(thead, createElement("tr"));
  for (const label of ["Permission / setting", "Visible state", "Database evidence"]) {
    appendTo(headerRow, cell("th", label));
  }
  const tbody = appendTo(table, createElement("tbody"));
  const dataRow = appendTo(tbody, createElement("tr"));
  appendTo(dataRow, cell("td", "Media & Apple Music"));
  appendTo(dataRow, cell("td", "4 apps"));
  const evidence = appendTo(dataRow, cell("td", "Drive, Neovide, Cursor"));
  const badge = appendTo(evidence, cell("code", "Drive"));
  return { evidence, badge };
}

test("a requested layout diagnostic publishes even when the result is unchanged", async () => {
  const sdk = bootSdk({ runAnimationFrames: true });

  await sdk.runAllTimers();
  const first = sdk.posted.filter((message) => message.type === "lavish:layoutDiagnostics");
  assert.equal(first.length, 1);

  sdk.sendChromeMessage({ type: "lavish:requestLayoutDiagnostics" });
  await sdk.runAllTimers();
  const diagnostics = sdk.posted.filter((message) => message.type === "lavish:layoutDiagnostics");
  assert.equal(diagnostics.length, 2);
  assert.equal(diagnostics[1].artifact_pass_sequence, diagnostics[0].artifact_pass_sequence + 1);
  assert.deepEqual(diagnostics[1].findings, diagnostics[0].findings);
});

test("the served SDK echoes the snapshot request id", () => {
  const sdk = bootSdk();

  sdk.sendChromeMessage({ type: "lavish:requestSnapshot", snapshot_request_id: "snapshot-17" });

  const response = sdk.posted.at(-1);
  assert.equal(response.type, "lavish:snapshot");
  assert.equal(response.snapshot_request_id, "snapshot-17");
  assert.equal(response.artifact_load_token, "load-token");
});

// readArtifactRevisions calls parseRevisionRegistry and collectRevisionMarks, which in turn call
// the rest of the revision helper chain; a helper left out of the bundle only ReferenceErrors on
// this real read, which a source-grep over the bundle text cannot catch.
test("the served SDK bundle reports the artifact's own revision registry and marks", () => {
  const revisionsScript = createElement("script");
  revisionsScript.textContent = JSON.stringify([
    { id: "r1", label: "Tightened header copy", summary: "Shortened the hero headline" },
  ]);
  const marked = createElement("h1");
  marked.setAttribute("data-lavish-revision", "r1");
  marked.textContent = "Ship faster";

  const sdk = bootSdk({ revisionsScript, revisionMarkElements: [marked] });

  const message = sdk.posted.find((entry) => entry.type === "lavish:revisions");
  assert.ok(message, "the SDK reports the revision registry on load");
  assert.equal(message.revisions.length, 1);
  assert.equal(message.revisions[0].id, "r1");
  assert.equal(message.revisions[0].label, "Tightened header copy");
  assert.equal(message.revisions[0].mark_count, 1);
  assert.equal(message.marks.length, 1);
  assert.equal(message.marks[0].revision_id, "r1");
  assert.equal(message.marks[0].selector, "html > body > h1");
  assert.equal(message.marks[0].excerpt, "Ship faster");
});

test("the served SDK bundle queues a table-cell annotation without a missing-helper ReferenceError", () => {
  const sdk = bootSdk();
  const { evidence } = buildTable(sdk);

  sdk.click(evidence);
  const message = sdk.queue("Check this permission");

  assert.equal(message.type, "lavish:queuePrompt");
  assert.equal(message.prompt.prompt, "Check this permission");
  assert.deepEqual(
    { ...message.prompt.target },
    {
      type: "table-cell",
      selector: "body > table > tbody > tr > td:nth-of-type(3)",
      rowLabel: "Media & Apple Music",
      columnLabel: "Database evidence",
      text: "Drive, Neovide, Cursor",
    },
  );
});

test("the served SDK bundle keeps the clicked element's own identity inside a table cell", () => {
  const sdk = bootSdk();
  const { badge } = buildTable(sdk);

  sdk.click(badge);
  const message = sdk.queue("Rename this app");

  assert.equal(message.prompt.tag, "code");
  assert.equal(message.prompt.selector, "table > tbody > tr > td:nth-of-type(3) > code");
  assert.equal(message.prompt.text, "Drive");
  assert.equal(message.prompt.target.selector, "body > table > tbody > tr > td:nth-of-type(3)");
  assert.equal(message.prompt.target.columnLabel, "Database evidence");
});

test("the annotation card names the cell it annotates when the cell itself is clicked", () => {
  const sdk = bootSdk();
  const { evidence } = buildTable(sdk);

  sdk.click(evidence);

  assert.match(sdk.card().innerHTML, /Annotate cell: Media &amp; Apple Music → Database evidence/);
  assert.match(sdk.card().innerHTML, /about this table cell/);
});

test("the annotation card names the clicked element, not the cell, for a nested click", () => {
  const sdk = bootSdk();
  const { badge } = buildTable(sdk);

  sdk.click(badge);

  assert.match(sdk.card().innerHTML, /Annotate &lt;code&gt; in Media &amp; Apple Music → Database evidence/);
  assert.doesNotMatch(sdk.card().innerHTML, /about this table cell/);
});

test("the served SDK bundle resolves table coordinates only for annotation clicks", () => {
  const sdk = bootSdk();
  const { evidence } = buildTable(sdk);

  sdk.api.queuePrompt("Programmatic note", { element: evidence });

  assert.equal(sdk.posted.at(-1).prompt.target, undefined);
});

test("the served SDK bundle annotates elements outside tables with no table target", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));

  sdk.click(paragraph);
  const message = sdk.queue("Reword this");

  assert.equal(message.prompt.tag, "p");
  assert.equal(message.prompt.target, undefined);
});

// closeCard() clears the element highlight, so that highlight standing or gone is the observable proof of close.
function pressEscape(textarea) {
  const listener = textarea.listeners.find((entry) => entry.type === "keydown");
  assert.ok(listener, "the annotation textarea registers a keydown listener");
  listener.handler({ key: "Escape", preventDefault() {} });
}

test("Escape closes an annotation card with no text and no attachment", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));

  sdk.click(paragraph);
  const textarea = sdk.card().querySelector("textarea");
  textarea.value = "   "; // whitespace-only counts as empty
  pressEscape(textarea);

  assert.equal(paragraph.style.outline, "", "the highlight is cleared, proving the card closed");
});

test("Escape during IME composition leaves an empty annotation card open", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));

  sdk.click(paragraph);
  const textarea = sdk.card().querySelector("textarea");
  const listener = textarea.listeners.find((entry) => entry.type === "keydown");
  listener.handler({ key: "Escape", isComposing: true, preventDefault() {} });

  assert.notEqual(paragraph.style.outline, "", "a composing Escape belongs to the IME, not the card");
});

test("Escape leaves an annotation card with typed text open and untouched", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));

  sdk.click(paragraph);
  const textarea = sdk.card().querySelector("textarea");
  textarea.value = "keep this note";
  pressEscape(textarea);

  assert.notEqual(paragraph.style.outline, "", "the card is still open, so the highlight remains");
  assert.equal(textarea.value, "keep this note", "Escape never discards the typed text");
});

test("Escape leaves an annotation card with an in-flight attachment open, even with no text", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));

  sdk.click(paragraph);
  const card = sdk.card();
  const attachInput = card.querySelector(".lavish-attach-input");
  // Never resolves - only the synchronous "uploading" status addFiles sets is needed here.
  attachInput.files = [{ name: "shot.png", type: "image/png", size: 10, arrayBuffer: () => new Promise(() => {}) }];
  const changeListener = attachInput.listeners.find((entry) => entry.type === "change");
  assert.ok(changeListener, "the attach input registers a change listener");
  changeListener.handler();

  pressEscape(card.querySelector("textarea"));

  assert.notEqual(
    paragraph.style.outline,
    "",
    "an attachment mid-upload is unsent content, so Escape must not close the card",
  );
});

// The chrome cannot see into this document, so a draft whose anchor is gone is only ever retired
// if the SDK says so. Silence left it to be retried against every later load.
test("the served SDK bundle reports a draft whose anchor the artifact no longer has", () => {
  const sdk = bootSdk();

  sdk.sendChromeMessage({
    type: "lavish:restoreReviewState",
    state: { card: { selector: "#hero", text: "needs a shorter headline" }, fields: [] },
  });

  // The load event proves the document parsed, not that it finished rendering, so nothing is
  // reported until the anchor has had time to appear.
  assert.equal(
    sdk.posted.some((message) => message.type === "lavish:reviewDraftUnrestorable"),
    false,
  );

  sdk.runTimers();
  const report = sdk.posted.at(-1);
  assert.equal(report.type, "lavish:reviewDraftUnrestorable");
  assert.equal(report.selector, "#hero");
  assert.equal(report.artifact_load_token, "load-token");
});

// A section this page builds in script, or a Mermaid diagram, is not in the document when it
// loads. Reporting that as a missing anchor is how a live draft gets thrown away.
test("the served SDK bundle restores a draft whose anchor arrives after the load", () => {
  const sdk = bootSdk();
  let late = null;
  sdk.setDocumentQuery((selector) => (selector === "#hero" ? late : null));

  sdk.sendChromeMessage({
    type: "lavish:restoreReviewState",
    state: { card: { selector: "#hero", text: "needs a shorter headline" }, fields: [] },
  });
  late = appendTo(sdk.body, cell("h1", "Headline"));
  sdk.runTimers();

  assert.equal(
    sdk.posted.some((message) => message.type === "lavish:reviewDraftUnrestorable"),
    false,
    "an anchor that arrived late is restored, not reported gone",
  );
  assert.equal(sdk.card().querySelector("textarea").value, "needs a shorter headline");
});

test("the served SDK bundle reports nothing when there is no draft to restore", () => {
  const sdk = bootSdk();
  const before = sdk.posted.length;

  sdk.sendChromeMessage({ type: "lavish:restoreReviewState", state: { card: null, fields: [] } });
  sdk.sendChromeMessage({ type: "lavish:restoreReviewState", state: { card: { selector: "#hero", text: "  " } } });
  sdk.runTimers();

  assert.equal(sdk.posted.length, before);
});

// `showAnnotationCard` closes whatever card is open before it draws, so a late restore landing on
// a card the user opened inside the settle window would delete text they are still typing - text
// no report has carried to the chrome yet.
test("the served SDK bundle leaves a card the user opened alone when the anchor arrives late", () => {
  const sdk = bootSdk();
  let late = null;
  sdk.setDocumentQuery((selector) => (selector === "#hero" ? late : null));

  sdk.sendChromeMessage({
    type: "lavish:restoreReviewState",
    state: { card: { selector: "#hero", text: "needs a shorter headline" }, fields: [] },
  });

  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));
  sdk.click(paragraph);
  sdk.card().querySelector("textarea").value = "typing something new";
  late = appendTo(sdk.body, cell("h1", "Headline"));
  sdk.runTimers();

  assert.equal(sdk.card().querySelector("textarea").value, "typing something new");
  // The draft is still stored on the chrome side, so a later load can try again; nothing here
  // claims the anchor is gone either.
  assert.equal(
    sdk.posted.some((message) => message.type === "lavish:reviewDraftUnrestorable"),
    false,
  );
});

// Cancelling a card reports `card: null`, which is what retires the stored draft on the chrome
// side. A late restore firing after that cancel would draw text the chrome no longer holds and
// report it back as a live draft, so the card the user dismissed reappears with someone else's
// text in it.
test("the served SDK bundle drops a late restore once the user has opened a card of their own", () => {
  const sdk = bootSdk();
  let late = null;
  sdk.setDocumentQuery((selector) => (selector === "#hero" ? late : null));

  sdk.sendChromeMessage({
    type: "lavish:restoreReviewState",
    state: { card: { selector: "#hero", text: "needs a shorter headline" }, fields: [] },
  });

  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));
  sdk.click(paragraph);
  sdk.card().querySelector(".lavish-cancel").onclick();
  const cardsAfterCancel = sdk.cards().length;

  late = appendTo(sdk.body, cell("h1", "Headline"));
  sdk.runTimers();

  assert.equal(sdk.cards().length, cardsAfterCancel, "the cancelled card is not replaced by a restored one");
  assert.notEqual(sdk.card().querySelector("textarea").value, "needs a shorter headline");
  assert.equal(
    sdk.posted.some((message) => message.type === "lavish:reviewDraftUnrestorable"),
    false,
  );
});

test("clicking an element with a queued note asks the chrome to edit it instead of opening a card", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));
  sdk.click(paragraph);
  const queued = sdk.queue("Reword this");
  sdk.sendChromeMessage({ type: "lavish:queuedAnchors", selectors: [queued.prompt.selector] });
  // The stub shadow root keeps closed cards, so a new card shows as a higher count.
  const cardsBefore = sdk.cards().length;

  sdk.click(paragraph);

  assert.equal(sdk.cards().length, cardsBefore);
  const message = sdk.posted.at(-1);
  assert.equal(message.type, "lavish:editQueuedAnchor");
  assert.equal(message.selector, queued.prompt.selector);
  assert.equal(message.artifact_load_token, "load-token");
});

test("an element whose queued note left the queue opens a fresh card again", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));
  sdk.click(paragraph);
  const queued = sdk.queue("Reword this");
  sdk.sendChromeMessage({ type: "lavish:queuedAnchors", selectors: [queued.prompt.selector] });
  sdk.sendChromeMessage({ type: "lavish:queuedAnchors", selectors: [] });
  const cardsBefore = sdk.cards().length;

  sdk.click(paragraph);

  assert.equal(sdk.cards().length, cardsBefore + 1);
});

test("the chrome can hand an element click back for a fresh card", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));
  sdk.setDocumentQuery((selector) => (selector === "body > p" ? paragraph : null));

  sdk.sendChromeMessage({ type: "lavish:annotateElement", selector: "body > p" });

  assert.match(sdk.card().innerHTML, /Annotate &lt;p&gt;/);
});

// A Mermaid node as the SDK sees one: a `<g class="node">` inside an SVG Mermaid rendered.
function buildMermaidNode(sdk) {
  const svg = appendTo(sdk.body, createElement("svg"));
  svg.id = "mermaid-1";
  const node = appendTo(svg, createElement("g"));
  node.id = "flowchart-A-0";
  const matchesTag = node.matches;
  node.matches = (selectorList) =>
    String(selectorList)
      .split(",")
      .some((part) => part.trim() === "g.node") || matchesTag(selectorList);
  const label = appendTo(node, cell("span", "Start"));
  const shape = appendTo(node, createElement("rect"));
  return { label, shape };
}

test("a note queued from a diagram node's label opens again from the node's shape", () => {
  const sdk = bootSdk();
  const { label, shape } = buildMermaidNode(sdk);
  sdk.click(label);
  const queued = sdk.queue("Rename this step");
  sdk.sendChromeMessage({
    type: "lavish:queuedAnchors",
    selectors: [queued.prompt.selector, queued.prompt.target.selector],
  });
  const cardsBefore = sdk.cards().length;

  sdk.click(shape);

  assert.equal(sdk.cards().length, cardsBefore);
  const message = sdk.posted.at(-1);
  assert.equal(message.type, "lavish:editQueuedAnchor");
  assert.equal(message.selector, queued.prompt.target.selector);
});

test("a click inside a table cell opens only the note on the exact element clicked", () => {
  const sdk = bootSdk();
  const { evidence } = buildTable(sdk);
  const strong = appendTo(evidence, cell("strong", "Drive"));
  const em = appendTo(evidence, cell("em", "Cursor"));
  sdk.click(evidence);
  const cellNote = sdk.queue("Explain this cell");
  sdk.click(strong);
  const strongNote = sdk.queue("Explain this app");
  sdk.sendChromeMessage({
    type: "lavish:queuedAnchors",
    selectors: [cellNote.prompt.selector, strongNote.prompt.selector],
  });
  const cardsBefore = sdk.cards().length;

  sdk.click(em);

  assert.equal(sdk.cards().length, cardsBefore + 1);
  assert.notEqual(sdk.posted.at(-1)?.type, "lavish:editQueuedAnchor");
});

// In annotate mode a plain click on a link annotates it, so Ctrl-click (Cmd-click on macOS) is the
// way to follow the link without leaving annotate mode: the SDK steps aside and the browser opens it.
function buildLink(sdk) {
  const link = appendTo(sdk.body, cell("a", "Read the spec"));
  link.setAttribute("href", "https://example.com/spec");
  const inner = appendTo(link, cell("span", "spec"));
  return { link, inner };
}

for (const modifier of ["ctrlKey", "metaKey"]) {
  test(`${modifier}-click on a link in annotate mode follows the link instead of annotating`, () => {
    const sdk = bootSdk();
    const { link, inner } = buildLink(sdk);

    for (const target of [link, inner]) {
      const event = sdk.click(target, { [modifier]: true });
      assert.equal(event.defaultPrevented, false, "the browser's own link handling runs");
    }
    assert.equal(sdk.cards().length, 0);
  });
}

test("a plain click on a link in annotate mode still opens an annotation card", () => {
  const sdk = bootSdk();
  const { link } = buildLink(sdk);

  const event = sdk.click(link);

  assert.equal(event.defaultPrevented, true);
  assert.match(sdk.card().innerHTML, /Annotate &lt;a&gt;/);
});

test("a modified click on something that is not a link still annotates", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));

  const event = sdk.click(paragraph, { ctrlKey: true });

  assert.equal(event.defaultPrevented, true);
  assert.match(sdk.card().innerHTML, /Annotate &lt;p&gt;/);
});

test("Ctrl-click follows a link even when the link already has a queued note", () => {
  const sdk = bootSdk();
  const { link } = buildLink(sdk);
  sdk.click(link);
  const queued = sdk.queue("Is this the right spec?");
  sdk.sendChromeMessage({ type: "lavish:queuedAnchors", selectors: [queued.prompt.selector] });
  const postedBefore = sdk.posted.length;

  const event = sdk.click(link, { ctrlKey: true });

  assert.equal(event.defaultPrevented, false);
  assert.equal(
    sdk.posted.slice(postedBefore).some((message) => message.type === "lavish:editQueuedAnchor"),
    false,
  );
});

test("Ctrl-click on a link after a text selection does not eat the next plain click", () => {
  const sdk = bootSdk();
  const { link } = buildLink(sdk);
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));
  sdk.selectText(paragraph, "prose");
  assert.match(sdk.card().innerHTML, /Annotate text/, "the selection opens a text annotation card");

  const followed = sdk.click(link, { ctrlKey: true });
  assert.equal(followed.defaultPrevented, false);

  sdk.click(paragraph);

  assert.match(sdk.card().innerHTML, /Annotate &lt;p&gt;/);
});
