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

function bootSdk() {
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
    requestAnimationFrame: () => 0,
    document: {
      readyState: "complete",
      documentElement,
      head,
      body,
      activeElement: body,
      baseURI: "http://127.0.0.1/artifact/abc/index.html",
      addEventListener: (type, handler) => documentListeners.push({ type, handler }),
      removeEventListener() {},
      createElement,
      getElementById: () => null,
      querySelector: (selector) => documentQuery(selector),
      querySelectorAll: () => [],
      getSelection: () => null,
    },
  };
  const windowListeners = [];
  sandbox.window = {
    addEventListener: (type, handler) => windowListeners.push({ type, handler }),
    removeEventListener() {},
    setTimeout: scheduleTimer,
    clearTimeout: cancelTimer,
    requestAnimationFrame: () => 0,
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
    click(target) {
      const listener = documentListeners.find((entry) => entry.type === "click");
      assert.ok(listener, "the SDK registers a document click listener");
      listener.handler({ target, preventDefault() {}, stopPropagation() {} });
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
    // The chrome is the only legitimate sender, so its messages arrive with `source: parent`.
    sendChromeMessage(data) {
      const listeners = windowListeners.filter((entry) => entry.type === "message");
      assert.ok(listeners.length > 0, "the SDK registers a window message listener");
      for (const listener of listeners) listener.handler({ source: sandbox.parent, data });
    },
    card() {
      const card = documentElement.children
        .flatMap((child) => child.shadowRoot?.children || [])
        .findLast((child) => child.className === "lavish-annotation-card");
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
