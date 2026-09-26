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
          if (selector.startsWith("[")) return attributes.has(selector.slice(1, selector.indexOf("]")).split("=")[0]);
          return selector === element.tagName.toLowerCase();
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
  sdkOptions = undefined,
  origin = "http://127.0.0.1",
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
  const documentElement = createElement("html");
  const head = createElement("head");
  const body = createElement("body");
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
    URL: class extends URL {
      static createObjectURL() {
        return "blob:lavish-test";
      }
      static revokeObjectURL() {}
    },
    getComputedStyle: () => ({}),
    setTimeout: scheduleTimer,
    clearTimeout: cancelTimer,
    requestAnimationFrame: (fn) => (runAnimationFrames ? scheduleTimer(fn, 0) : 0),
    document: {
      readyState: "complete",
      currentScript: { src: "http://127.0.0.1/sdk.js?key=abc" },
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
      getSelection: () => null,
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
    location: {
      origin,
      pathname: "/artifact/abc/sub/page.html",
      search: "?view=full",
      hash: "#notes",
    },
    URL: sandbox.URL,
  };
  sandbox.top = sandbox.parent;
  sandbox.globalThis = sandbox;

  vm.runInNewContext(createSdkJs("abc", 3, "load-token", sdkOptions), sandbox);

  return {
    posted,
    body,
    api: sandbox.window.lavish,
    click(target) {
      const listener = documentListeners.find((entry) => entry.type === "click");
      assert.ok(listener, "the SDK registers a document click listener");
      listener.handler({ target, preventDefault() {}, stopPropagation() {} });
    },
    setDocumentQuery(query) {
      documentQuery = query;
    },
    setLocation(next) {
      Object.assign(sandbox.window.location, next);
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
    // The chrome is the only legitimate sender, so its messages arrive with `source: parent`
    // from the server origin the artifact URL also names.
    sendChromeMessage(data) {
      const listeners = windowListeners.filter((entry) => entry.type === "message");
      assert.ok(listeners.length > 0, "the SDK registers a window message listener");
      for (const listener of listeners) {
        listener.handler({ source: sandbox.parent, origin: sandbox.window.location.origin, data });
      }
    },
    dispatchWindowEvent(type, properties = {}) {
      for (const listener of windowListeners.filter((entry) => entry.type === type)) {
        listener.handler({ source: sandbox.parent, origin: sandbox.window.location.origin, ...properties });
      }
    },
    documentListenerCount(type) {
      return documentListeners.filter((entry) => entry.type === type).length;
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

const TEST_CHROME_NONCE = "nonce-AAAAAAAAAAAAAAAAAAAAAAAA";
const TEST_CHROME_AUTH = "server-issued-chrome-auth-mac";

// Bounded: resolves with whatever reached the port within the window, never waits forever.
function portMessagesWithin(port, ms = 150) {
  return new Promise((resolve) => {
    const seen = [];
    port.addEventListener("message", (event) => seen.push(event.data));
    port.start?.();
    setTimeout(() => resolve(seen), ms);
  });
}

function nextPortMessage(port, type = "") {
  return new Promise((resolve) => {
    const handler = (event) => {
      if (type && event.data?.type !== type) return;
      port.removeEventListener("message", handler);
      resolve(event.data);
    };
    port.addEventListener("message", handler);
    port.start?.();
  });
}

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

test("the protocol-1 SDK rebinds a BFCache document without reinstalling its DOM listeners", async () => {
  const sdk = bootSdk({
    sdkOptions: {
      pageProtocol: 1,
      page: "sub/page.html",
      pageProof: "proof-sub-page",
      servedRoute: "sub/page.html",
      chromeNonce: TEST_CHROME_NONCE,
      chromeAuth: TEST_CHROME_AUTH,
    },
  });
  const initialReady = sdk.posted.at(-1);
  assert.equal(initialReady.type, "lavish:ready");

  const first = new MessageChannel();
  /** @type {any} */ (first.port1).unref?.();
  /** @type {any} */ (first.port2).unref?.();
  const firstResponsePromise = nextPortMessage(first.port1);
  sdk.dispatchWindowEvent("message", {
    data: { type: "lavish:challenge", challenge: "first-challenge", chrome_auth: TEST_CHROME_AUTH },
    ports: [first.port2],
  });
  const firstResponse = await firstResponsePromise;
  const firstRevisionsPromise = nextPortMessage(first.port1, "lavish:revisions");
  first.port1.postMessage({
    ...firstResponse,
    type: "lavish:activate",
    document_sequence: 1,
    historical_destination_receipt: "receipt-before-bfcache",
  });
  const revisions = await firstRevisionsPromise;
  assert.equal(revisions.page, "sub/page.html");
  assert.equal(revisions.document_sequence, 1);
  const clickListeners = sdk.documentListenerCount("click");
  assert.ok(clickListeners > 0, "the accepted document installs the full SDK once");

  const departingPromise = nextPortMessage(first.port1, "lavish:documentDeparting");
  sdk.dispatchWindowEvent("pagehide");
  const departing = await departingPromise;
  assert.equal(departing.type, "lavish:documentDeparting");
  assert.equal(departing.document_sequence, 1);
  // Signed history is retained by trusted chrome under document-id/exact-URL,
  // not echoed back as authority by the untrusted artifact SDK.
  assert.equal(departing.historical_destination_receipt, undefined);
  assert.equal(departing.destination, firstResponse.destination);

  sdk.dispatchWindowEvent("pageshow", { persisted: true });
  const resumedReady = sdk.posted.at(-1);
  assert.equal(resumedReady.type, "lavish:ready");
  assert.equal(resumedReady.document_id, initialReady.document_id, "BFCache keeps the document identity");

  const second = new MessageChannel();
  /** @type {any} */ (second.port1).unref?.();
  /** @type {any} */ (second.port2).unref?.();
  const secondResponsePromise = nextPortMessage(second.port1);
  sdk.dispatchWindowEvent("message", {
    data: { type: "lavish:challenge", challenge: "second-challenge", chrome_auth: TEST_CHROME_AUTH },
    ports: [second.port2],
  });
  const secondResponse = await secondResponsePromise;
  assert.equal(secondResponse.historical_destination_receipt, undefined);
  assert.equal(secondResponse.document_id, firstResponse.document_id);
  assert.equal(secondResponse.destination, firstResponse.destination);
  second.port1.postMessage({ ...secondResponse, type: "lavish:activate", document_sequence: 2 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sdk.documentListenerCount("click"), clickListeners, "rebind does not duplicate the SDK");

  const snapshotPromise = nextPortMessage(second.port1, "lavish:snapshot");
  second.port1.postMessage({
    type: "lavish:requestSnapshot",
    snapshot_request_id: "after-bfcache",
    page: secondResponse.page,
    page_proof: secondResponse.page_proof,
    document_id: secondResponse.document_id,
    document_sequence: 2,
    artifact_load_token: secondResponse.artifact_load_token,
    artifact_revision: secondResponse.artifact_revision,
  });
  const snapshot = await snapshotPromise;
  assert.equal(snapshot.type, "lavish:snapshot");
  assert.equal(snapshot.document_sequence, 2);
  assert.equal(snapshot.snapshot_request_id, "after-bfcache");
  first.port1.close();
  second.port1.close();
});

test("the protocol-1 SDK sends scoped uploads and authored destinations over its accepted port", async (t) => {
  const sdk = bootSdk({
    sdkOptions: {
      pageProtocol: 1,
      page: "sub/page.html",
      pageProof: "proof-sub-page",
      servedRoute: "sub/page.html",
      chromeNonce: TEST_CHROME_NONCE,
      chromeAuth: TEST_CHROME_AUTH,
    },
  });
  const channel = new MessageChannel();
  /** @type {any} */ (channel.port1).unref?.();
  /** @type {any} */ (channel.port2).unref?.();
  t.after(() => {
    channel.port1.close();
    channel.port2.close();
  });
  const responsePromise = nextPortMessage(channel.port1);
  sdk.dispatchWindowEvent("message", {
    data: { type: "lavish:challenge", challenge: "scoped-upload", chrome_auth: TEST_CHROME_AUTH },
    ports: [channel.port2],
  });
  const response = await responsePromise;
  assert.equal(response.destination, "/artifact/abc/sub/page.html?view=full#notes");
  const revisionsPromise = nextPortMessage(channel.port1, "lavish:revisions");
  channel.port1.postMessage({
    ...response,
    type: "lavish:activate",
    document_sequence: 7,
    historical_destination_receipt: "receipt-initial",
  });
  const revisions = await revisionsPromise;
  assert.equal(revisions.page, "sub/page.html");
  assert.equal(revisions.document_sequence, 7);

  const destinationPromise = nextPortMessage(channel.port1, "lavish:documentDestination");
  sdk.dispatchWindowEvent("hashchange");
  const destination = await destinationPromise;
  assert.deepEqual(
    {
      type: destination.type,
      page: destination.page,
      page_proof: destination.page_proof,
      served_route: destination.served_route,
      destination: destination.destination,
      document_sequence: destination.document_sequence,
      historical_destination_receipt: destination.historical_destination_receipt,
    },
    {
      type: "lavish:documentDestination",
      page: "sub/page.html",
      page_proof: "proof-sub-page",
      served_route: "sub/page.html",
      destination: "/artifact/abc/sub/page.html?view=full#notes",
      document_sequence: 7,
      historical_destination_receipt: undefined,
    },
  );

  sdk.setLocation({ hash: "#other" });
  const unknownDestinationPromise = nextPortMessage(channel.port1, "lavish:documentDestination");
  sdk.dispatchWindowEvent("hashchange");
  const unknownDestination = await unknownDestinationPromise;
  assert.equal(unknownDestination.historical_destination_receipt, undefined);
  assert.equal(unknownDestination.destination, "/artifact/abc/sub/page.html?view=full#other");
  channel.port1.postMessage({
    ...response,
    type: "lavish:historicalDestinationReceipt",
    document_sequence: 7,
    historical_destination_receipt: "receipt-other",
    destination: "/artifact/abc/sub/page.html?view=full#other",
  });
  await new Promise((resolve) => setImmediate(resolve));
  sdk.setLocation({ hash: "#notes" });
  const restoredDestinationPromise = nextPortMessage(channel.port1, "lavish:documentDestination");
  sdk.dispatchWindowEvent("popstate");
  const restoredDestination = await restoredDestinationPromise;
  assert.equal(restoredDestination.historical_destination_receipt, undefined);
  assert.equal(restoredDestination.destination, "/artifact/abc/sub/page.html?view=full#notes");
  sdk.setLocation({ hash: "#other" });
  const otherDestinationPromise = nextPortMessage(channel.port1, "lavish:documentDestination");
  sdk.dispatchWindowEvent("popstate");
  const otherDestination = await otherDestinationPromise;
  assert.equal(otherDestination.historical_destination_receipt, undefined);
  assert.equal(otherDestination.destination, "/artifact/abc/sub/page.html?view=full#other");
  sdk.setLocation({ hash: "#notes" });

  const { evidence } = buildTable(sdk);
  sdk.click(evidence);
  const card = sdk.card();
  const input = card.querySelector(".lavish-attach-input");
  input.files = [
    {
      name: "evidence.png",
      type: "image/png",
      size: 3,
      arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
    },
  ];
  const change = input.listeners.find((listener) => listener.type === "change");
  assert.ok(change, "the emitted SDK wires the attachment picker");
  const uploadPromise = nextPortMessage(channel.port1, "lavish:uploadAttachment");
  change.handler();
  const upload = await uploadPromise;
  assert.equal(upload.type, "lavish:uploadAttachment");
  assert.equal(upload.page, "sub/page.html");
  assert.equal(upload.page_proof, "proof-sub-page");
  assert.equal(upload.served_route, "sub/page.html");
  assert.equal(upload.destination, "/artifact/abc/sub/page.html?view=full#notes");
  assert.equal(upload.document_sequence, 7);
  assert.equal(upload.artifact_load_token, "load-token");
  assert.equal(upload.localId, "att-1");
  assert.equal(upload.bytes.byteLength, 3);
  assert.ok(upload.nonce);

  channel.port1.postMessage({
    ...response,
    type: "lavish:attachmentResult",
    document_sequence: 7,
    nonce: upload.nonce,
    localId: upload.localId,
    ok: true,
    id: "stored-image",
  });
  await new Promise((resolve) => setImmediate(resolve));
  const queuedPromise = nextPortMessage(channel.port1, "lavish:queuePrompt");
  card.querySelector("textarea").value = "Review scoped upload";
  card.querySelector(".lavish-send").onclick();
  const queued = await queuedPromise;
  assert.equal(queued.type, "lavish:queuePrompt");
  assert.deepEqual(queued.prompt.attachments, [{ id: "stored-image", name: "evidence.png" }]);
});

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

test("the protocol-1 SDK reveals nothing to a parent that cannot present this document's chrome auth", async (t) => {
  const boot = (overrides = {}) =>
    bootSdk({
      sdkOptions: {
        pageProtocol: 1,
        page: "sub/page.html",
        pageProof: "proof-sub-page",
        servedRoute: "sub/page.html",
        chromeNonce: TEST_CHROME_NONCE,
        chromeAuth: TEST_CHROME_AUTH,
        ...overrides,
      },
    });
  const attempt = async (sdk, data) => {
    const channel = new MessageChannel();
    /** @type {any} */ (channel.port1).unref?.();
    /** @type {any} */ (channel.port2).unref?.();
    t.after(() => {
      channel.port1.close();
      channel.port2.close();
    });
    const seen = portMessagesWithin(channel.port1);
    sdk.dispatchWindowEvent("message", { data, ports: [channel.port2] });
    return { seen: await seen, port: channel.port1 };
  };

  const sdk = boot();
  const ready = sdk.posted.at(-1);
  assert.equal(ready.type, "lavish:ready");
  assert.equal(ready.document_nonce, TEST_CHROME_NONCE);
  // Readiness is broadcast to whatever parent frames the page, so it must carry no secret.
  const readyText = JSON.stringify(ready);
  assert.ok(!readyText.includes("proof-sub-page"));
  assert.ok(!readyText.includes(TEST_CHROME_AUTH));
  const clickListenersBefore = sdk.documentListenerCount("click");

  const hostileChallenges = [
    { type: "lavish:challenge", challenge: "missing" },
    { type: "lavish:challenge", challenge: "forged", chrome_auth: "forged-mac" },
    { type: "lavish:challenge", challenge: "empty", chrome_auth: "" },
    { type: "lavish:challenge", challenge: "nonce-as-auth", chrome_auth: TEST_CHROME_NONCE },
    { type: "lavish:challenge", challenge: "other-document", chrome_auth: "mac-for-another-document-nonce" },
    // The obsolete bind message must stay meaningless too.
    { type: "lavish:bind", challenge: "legacy", chrome_auth: TEST_CHROME_AUTH },
  ];
  for (const data of hostileChallenges) {
    const { seen, port } = await attempt(sdk, data);
    assert.deepEqual(seen, [], `no response for ${data.challenge}`);
    // Even a well-formed activation on that port cannot install the review SDK.
    port.postMessage({ type: "lavish:activate", document_id: ready.document_id, document_sequence: 1 });
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(sdk.documentListenerCount("click"), clickListenersBefore, "the review SDK never installed");

  // A document served without auth material can never be activated, even by an empty match.
  const bare = boot({ chromeNonce: "", chromeAuth: "" });
  for (const chrome_auth of [undefined, "", TEST_CHROME_AUTH]) {
    const { seen } = await attempt(bare, { type: "lavish:challenge", challenge: "bare", chrome_auth });
    assert.deepEqual(seen, []);
  }

  // Positive control: the same document answers the authenticated chrome.
  const { seen } = await attempt(sdk, {
    type: "lavish:challenge",
    challenge: "genuine",
    chrome_auth: TEST_CHROME_AUTH,
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, "lavish:challengeResponse");
  assert.equal(seen[0].page_proof, "proof-sub-page");
});

test("the protocol-1 SDK accepts the chrome origin in an opaque artifact and rejects relays", async (t) => {
  const boot = (origin = undefined) =>
    bootSdk({
      origin,
      sdkOptions: {
        pageProtocol: 1,
        page: "sub/page.html",
        pageProof: "proof-sub-page",
        servedRoute: "sub/page.html",
        chromeNonce: TEST_CHROME_NONCE,
        chromeAuth: TEST_CHROME_AUTH,
      },
    });
  const attempt = async (sdk, origin) => {
    const channel = new MessageChannel();
    /** @type {any} */ (channel.port1).unref?.();
    /** @type {any} */ (channel.port2).unref?.();
    t.after(() => {
      channel.port1.close();
      channel.port2.close();
    });
    const seen = portMessagesWithin(channel.port1);
    sdk.dispatchWindowEvent("message", {
      origin,
      data: { type: "lavish:challenge", challenge: "relayed", chrome_auth: TEST_CHROME_AUTH },
      ports: [channel.port2],
    });
    const messages = await seen;
    channel.port1.postMessage({
      type: "lavish:activate",
      document_id: sdk.posted.find((message) => message.type === "lavish:ready")?.document_id,
      document_sequence: 1,
    });
    return messages;
  };

  // An external page left in the chrome's artifact frame can obtain the MAC for any nonce it
  // announces, then frame this document top-level in a popup it controls and relay that MAC.
  const sdk = boot();
  const clickListenersBefore = sdk.documentListenerCount("click");
  for (const origin of ["http://evil.example", "http://127.0.0.1:4388", "null", "", undefined]) {
    assert.deepEqual(await attempt(sdk, origin), [], `no response for origin ${origin}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(sdk.documentListenerCount("click"), clickListenersBefore, "the review SDK never installed");

  // The sandbox gives the artifact an opaque origin, but its served SDK still names
  // the chrome's origin. An opaque sender remains untrusted.
  const opaque = boot("null");
  assert.deepEqual(await attempt(opaque, "null"), []);
  const opaqueAccepted = await attempt(opaque, "http://127.0.0.1");
  assert.equal(opaqueAccepted.length, 1);
  assert.equal(opaqueAccepted[0].type, "lavish:challengeResponse");

  // Positive control: the same MAC from the chrome's own origin completes the challenge.
  const seen = await attempt(sdk, "http://127.0.0.1");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, "lavish:challengeResponse");
});
