import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { createSdkJs } from "../src/server.js";
import { reviewShortcutAction } from "../src/artifact-sdk.js";

test("review shortcuts reject modified keys and editable controls", () => {
  assert.equal(reviewShortcutAction({ key: "m" }), "mark");
  assert.equal(reviewShortcutAction({ key: "c" }), "comment");
  assert.equal(reviewShortcutAction({ key: "d" }), "done");
  assert.equal(reviewShortcutAction({ key: "D", shiftKey: true }), "done-parent");
  for (const event of [
    { key: "M", shiftKey: true },
    { key: "c", ctrlKey: true },
    { key: "d", metaKey: true },
    { key: "m", altKey: true },
    { key: "d", repeat: true },
    { key: "m", target: { closest: () => ({}) } },
  ]) {
    assert.equal(reviewShortcutAction(event), "");
  }
});

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
      toggle(name, force) {
        const names = new Set(
          String(element.className || "")
            .split(/\s+/)
            .filter(Boolean),
        );
        const on = force ?? !names.has(name);
        if (on) names.add(name);
        else names.delete(name);
        element.className = [...names].join(" ");
        return on;
      },
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    getAttribute(name) {
      return attributes.has(name) ? attributes.get(name) : null;
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
    className: "",
    matches(selectorList) {
      return String(selectorList)
        .split(",")
        .some((part) => {
          const selector = part.trim();
          if (!selector) return false;
          if (selector.startsWith("[")) return attributes.has(selector.slice(1, selector.indexOf("]")).split("=")[0]);
          if (selector.startsWith(".")) {
            return String(element.className || "")
              .split(/\s+/)
              .includes(selector.slice(1));
          }
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
    focus(options) {
      element.focusedWith = options || {};
    },
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
  initialAnnotate = true,
  revisionsScript = null,
  revisionMarkElements = [],
} = {}) {
  const posted = [];
  const windowScrolls = [];
  const clipboardWrites = [];
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
  /** @type {(selector: string) => any[]} */
  let documentQueryAll = () => [];
  let selection = null;
  const elementsById = new Map();
  const documentElement = createElement("html");
  const head = createElement("head");
  const body = createElement("body");
  appendTo(documentElement, head);
  appendTo(documentElement, body);
  for (const element of revisionMarkElements) appendTo(body, element);

  const sandbox = {
    parent: { postMessage: (message) => posted.push(message) },
    navigator: { platform: "Linux", clipboard: { writeText: async (value) => clipboardWrites.push(value) } },
    CSS: { escape: (value) => String(value) },
    Element: class Element {},
    NodeFilter: { SHOW_TEXT: 4 },
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
    getComputedStyle: (element) => element?.computedStyle || {},
    setTimeout: scheduleTimer,
    clearTimeout: cancelTimer,
    requestAnimationFrame: (fn) => (runAnimationFrames ? scheduleTimer(fn, 0) : 0),
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
      createRange: () => null,
      createTreeWalker: () => ({ nextNode: () => null }),
      getElementById: (id) =>
        elementsById.get(id) ||
        head.children.find((el) => el.id === id) ||
        body.children.find((el) => el.id === id) ||
        null,
      querySelector: (selector) =>
        selector === "script[data-lavish-revisions]" ? revisionsScript : documentQuery(selector),
      querySelectorAll: (selector) =>
        selector === "[data-lavish-revision]" ? revisionMarkElements : documentQueryAll(selector),
      getSelection: () => selection,
    },
  };
  // The browser's `instanceof Element` check is meaningful for the contextmenu path. The DOM
  // stub uses plain objects, so mirror that check through the nodeType contract used by real
  // elements instead of making the left-click test accidentally cover only the old mode.
  Object.defineProperty(sandbox.Element, Symbol.hasInstance, {
    value(instance) {
      return Boolean(instance && instance.nodeType === 1);
    },
  });
  const windowListeners = [];
  sandbox.window = {
    addEventListener: (type, handler) => windowListeners.push({ type, handler }),
    removeEventListener() {},
    setTimeout: scheduleTimer,
    clearTimeout: cancelTimer,
    requestAnimationFrame: (fn) => (runAnimationFrames ? scheduleTimer(fn, 0) : 0),
    innerWidth: 1280,
    innerHeight: 800,
    scrollTo: (options) => windowScrolls.push(options),
    scrollX: 0,
    scrollY: 0,
    location: { origin: "http://127.0.0.1" },
    URL: sandbox.URL,
  };
  sandbox.globalThis = sandbox;

  vm.runInNewContext(createSdkJs("abc", 3, "load-token", { initialAnnotate }), sandbox);

  return {
    posted,
    windowScrolls,
    documentElement,
    body,
    head,
    api: sandbox.window.lavish,
    click(target) {
      const listeners = documentListeners.filter((entry) => entry.type === "click");
      assert.ok(listeners.length, "the SDK registers a document click listener");
      const event = { target, preventDefault() {}, stopPropagation() {} };
      for (const listener of listeners) listener.handler(event);
    },
    rightClick(target) {
      const listener = documentListeners.find((entry) => entry.type === "contextmenu");
      assert.ok(listener, "the SDK registers a document contextmenu listener");
      listener.handler({ target, clientX: 10, clientY: 10, preventDefault() {}, stopPropagation() {} });
    },
    setDocumentQuery(query) {
      documentQuery = query;
    },
    setSelection(value) {
      selection = value;
    },
    setCreateRange(factory) {
      sandbox.document.createRange = factory;
    },
    overlayElements() {
      return documentElement.children.flatMap((child) => child.shadowRoot?.children || []);
    },
    setDocumentQueryAll(query) {
      documentQueryAll = query;
    },
    setElementById(id, element) {
      elementsById.set(id, element);
    },
    trigger(type, event) {
      const listeners = documentListeners.filter((entry) => entry.type === type);
      assert.ok(listeners.length, `the SDK registers a document ${type} listener`);
      for (const listener of listeners) listener.handler(event);
    },
    clipboardWrites,
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
    scroll() {
      const listeners = windowListeners.filter((entry) => entry.type === "scroll");
      assert.ok(listeners.length > 0, "the SDK registers a window scroll listener");
      for (const listener of listeners) listener.handler();
    },
    copyButton() {
      return documentElement.children
        .flatMap((child) => child.shadowRoot?.children || [])
        .find((child) => child.className === "lavish-copy-markdown");
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

function selectText(sdk, element, text) {
  const node = { nodeType: 3, parentElement: element, parentNode: element, nodeValue: text };
  element.childNodes = [node];
  const range = {
    collapsed: false,
    commonAncestorContainer: node,
    startContainer: node,
    endContainer: node,
    startOffset: 0,
    endOffset: text.length,
    cloneRange() {
      return this;
    },
    getClientRects() {
      return [];
    },
    getBoundingClientRect() {
      return element.getBoundingClientRect();
    },
  };
  const selection = {
    rangeCount: 1,
    getRangeAt: () => range,
    toString: () => text,
    removeAllRanges() {
      this.rangeCount = 0;
    },
  };
  sdk.setSelection(selection);
  return selection;
}

test("selection shortcuts preserve mouse selection and mark or comment the selected text", () => {
  const sdk = bootSdk();
  const p = appendTo(sdk.body, cell("p", "Selected words"));
  const selection = selectText(sdk, p, "Selected words");
  sdk.trigger("mouseup", { target: p });
  assert.equal(sdk.cards().length, 0);
  let prevented = false;
  sdk.trigger("keydown", {
    key: "m",
    target: p,
    preventDefault() {
      prevented = true;
    },
  });
  const prompt = sdk.posted.find((entry) => entry.type === "lavish:queuePrompt").prompt;
  assert.equal(prevented, true);
  assert.equal(selection.rangeCount, 0);
  assert.equal(prompt.prompt, "");
  assert.equal(prompt.target.type, "text-range");
  assert.equal(prompt.target.text, "Selected words");

  selectText(sdk, p, "Selected words");
  prevented = false;
  sdk.trigger("keydown", {
    key: "c",
    target: p,
    preventDefault() {
      prevented = true;
    },
  });
  assert.equal(prevented, true);
  assert.equal(sdk.cards().length, 1);
});

test("the SDK restyles the frame scrollbar so the thumb separates from warm backgrounds", () => {
  const sdk = bootSdk();
  sdk.documentElement.computedStyle = { backgroundColor: "rgb(227, 203, 182)" };
  sdk.sendChromeMessage({ type: "lavish:setAnnotationMode", enabled: true });
  const style = sdk.head.children.find((el) => el.id === "lavish-scrollbar-style");
  assert.ok(style, "the SDK installs a scrollbar style element");
  assert.match(style.textContent, /::-webkit-scrollbar-thumb\{background:#f3f3f4/);
  // A fine dark outline keeps the light thumb visible on borderline-light surfaces too.
  assert.match(style.textContent, /border:1px solid rgba\(0,0,0,\.28\)/);
  assert.match(style.textContent, /scrollbar-color:#f3f3f4 transparent/);
});

test("on a bright artifact surface the scrollbar thumb switches to dark grey", () => {
  const sdk = bootSdk();
  sdk.documentElement.computedStyle = { backgroundColor: "rgb(255, 255, 255)" };
  sdk.sendChromeMessage({ type: "lavish:setAnnotationMode", enabled: true });
  const style = sdk.head.children.find((el) => el.id === "lavish-scrollbar-style");
  assert.match(style.textContent, /::-webkit-scrollbar-thumb\{background:#4b4b52/);
  assert.doesNotMatch(style.textContent, /rgba\(0,0,0,\.28\)/, "a dark thumb needs no outline");
  assert.match(style.textContent, /scrollbar-color:#4b4b52 transparent/);
});

test("done shortcut toggles a paragraph and excludes a styled heading", () => {
  const sdk = bootSdk();
  const section = appendTo(sdk.body, createElement("section"));
  section.getBoundingClientRect = () => ({ left: 0, top: 0, right: 300, bottom: 100, width: 300, height: 100 });
  const heading = appendTo(section, cell("h2", "Heading"));
  const p = appendTo(section, cell("p", "Paragraph"));
  section.querySelectorAll = (query) =>
    query === '[data-lavish-done="true"]' && p.getAttribute("data-lavish-done") === "true" ? [p] : [];
  section.contains = (element) => element === p || element === heading;
  sdk.setDocumentQueryAll((query) =>
    query === '[data-lavish-done="true"]'
      ? [section, p].filter((el) => el.getAttribute("data-lavish-done") === "true")
      : [],
  );
  const key = (key, shiftKey = false) =>
    sdk.trigger("keydown", { key, shiftKey, target: sdk.body, preventDefault() {} });
  sdk.trigger("mousemove", { target: p, clientX: 12, clientY: 12 });
  key("d");
  assert.equal(p.getAttribute("data-lavish-done"), "true");
  key("D", true);
  assert.equal(p.getAttribute("data-lavish-done"), null);
  assert.equal(section.getAttribute("data-lavish-done"), "true");
  key("D", true);
  assert.equal(section.getAttribute("data-lavish-done"), null);
  key("D", true);
  assert.equal(section.getAttribute("data-lavish-done"), "true");
  key("d");
  sdk.trigger("mousemove", { target: heading, clientX: 12, clientY: 12 });
  key("d");
  assert.equal(heading.getAttribute("data-lavish-done"), null);
  assert.equal(section.getAttribute("data-lavish-done"), "true");
});

test("done-parent marks an intro header so its heading greys out with the lead", () => {
  const sdk = bootSdk();
  const hero = appendTo(sdk.body, createElement("header"));
  hero.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1018, bottom: 1538, width: 1018, height: 1538 });
  hero.computedStyle = {
    display: "block",
    backgroundColor: "#101623",
    boxShadow: "none",
    borderStyle: "none",
    borderTopWidth: "0px",
    borderRightWidth: "0px",
    borderBottomWidth: "0px",
    borderLeftWidth: "0px",
    borderRadius: "0px",
    paddingTop: "28px",
    paddingRight: "20px",
    paddingBottom: "28px",
    paddingLeft: "20px",
  };
  const heading = appendTo(hero, cell("h1", "Monetarisierungs-Architektur"));
  const lead = appendTo(hero, cell("p", "Dieses Dokument bündelt"));
  hero.querySelectorAll = (query) =>
    query === '[data-lavish-done="true"]'
      ? [heading, lead].filter((el) => el.getAttribute("data-lavish-done") === "true")
      : [];
  sdk.setDocumentQueryAll((query) =>
    query === '[data-lavish-done="true"]' ? [hero].filter((el) => el.getAttribute("data-lavish-done") === "true") : [],
  );
  const key = (keyName, shiftKey = false) =>
    sdk.trigger("keydown", { key: keyName, shiftKey, target: sdk.body, preventDefault() {} });
  sdk.trigger("mousemove", { target: lead, clientX: 12, clientY: 12 });
  key("d");
  assert.equal(lead.getAttribute("data-lavish-done"), "true");
  key("D", true);
  assert.equal(lead.getAttribute("data-lavish-done"), null);
  assert.equal(hero.getAttribute("data-lavish-done"), "true");
  assert.equal(heading.getAttribute("data-lavish-done"), null);
  key("D", true);
  assert.equal(hero.getAttribute("data-lavish-done"), null);
});

test("done still skips a header that carries no heading-and-prose pairing", () => {
  const sdk = bootSdk();
  const banner = appendTo(sdk.body, createElement("header"));
  banner.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1018, bottom: 120, width: 1018, height: 120 });
  banner.querySelector = () => null;
  const lead = appendTo(banner, cell("p", "Nur ein Banner-Hinweis"));
  banner.querySelectorAll = (query) =>
    query === '[data-lavish-done="true"]' ? [lead].filter((el) => el.getAttribute("data-lavish-done") === "true") : [];
  sdk.setDocumentQueryAll((query) =>
    query === '[data-lavish-done="true"]' ? [lead].filter((el) => el.getAttribute("data-lavish-done") === "true") : [],
  );
  const key = (keyName, shiftKey = false) =>
    sdk.trigger("keydown", { key: keyName, shiftKey, target: sdk.body, preventDefault() {} });
  sdk.trigger("mousemove", { target: lead, clientX: 12, clientY: 12 });
  key("D", true);
  assert.equal(banner.getAttribute("data-lavish-done"), null);
  assert.equal(lead.getAttribute("data-lavish-done"), "true");
});

test("done shortcut records the selected range and clears the native selection", () => {
  const sdk = bootSdk();
  const p = appendTo(sdk.body, cell("p", "Review this passage"));
  const selection = selectText(sdk, p, "this passage");
  let prevented = false;
  sdk.trigger("keydown", {
    key: "d",
    target: p,
    preventDefault() {
      prevented = true;
    },
  });
  const message = sdk.posted.find((entry) => entry.type === "lavish:doneBoxes");
  assert.equal(prevented, true);
  assert.equal(selection.rangeCount, 0);
  assert.equal(message.items.length, 1);
  assert.equal(message.items[0].kind, "text-range");
  assert.equal(message.items[0].target.text, "this passage");
  assert.equal(typeof message.items[0].ancestorSignature, "string");
});

test("done restore rejects a changed paragraph even when its selector still resolves", () => {
  const sdk = bootSdk();
  const p = appendTo(sdk.body, cell("p", "Original wording"));
  sdk.setDocumentQueryAll((query) => {
    if (query === '[data-lavish-done="true"]') return p.getAttribute("data-lavish-done") === "true" ? [p] : [];
    return query === "html > body > p" ? [p] : [];
  });
  sdk.trigger("mousemove", { target: p, clientX: 12, clientY: 12 });
  sdk.trigger("keydown", { key: "d", target: p, preventDefault() {} });
  const item = sdk.posted.find((entry) => entry.type === "lavish:doneBoxes").items[0];
  assert.ok(item.textSignature);
  p.textContent = "Changed wording!";
  sdk.sendChromeMessage({ type: "lavish:restoreDoneBoxes", items: [item] });
  assert.equal(p.getAttribute("data-lavish-done"), null);
});

test("done restore rejects identical paragraphs after their parent sections swap", () => {
  const sdk = bootSdk();
  const first = appendTo(sdk.body, cell("section", "First section: identical"));
  const second = appendTo(sdk.body, cell("section", "Second section: identical"));
  const p1 = appendTo(first, cell("p", "identical"));
  const p2 = appendTo(second, cell("p", "identical"));
  sdk.setDocumentQueryAll((query) => {
    if (query === '[data-lavish-done="true"]')
      return [p1, p2].filter((p) => p.getAttribute("data-lavish-done") === "true");
    if (query === "P") return [p1, p2];
    if (query === "html > body > section:nth-of-type(1) > p") return [sdk.body.children[0].children[0]];
    return [];
  });
  sdk.trigger("mousemove", { target: p1, clientX: 12, clientY: 12 });
  sdk.trigger("keydown", { key: "d", target: p1, preventDefault() {} });
  const item = sdk.posted.find((entry) => entry.type === "lavish:doneBoxes").items[0];
  assert.match(item.selector, /nth-of-type/);
  sdk.body.children.reverse();
  sdk.sendChromeMessage({ type: "lavish:restoreDoneBoxes", items: [item] });
  assert.equal(p1.getAttribute("data-lavish-done"), null);
  assert.equal(p2.getAttribute("data-lavish-done"), null);
});

test("persistent marks open comments and take priority over element annotations", () => {
  const sdk = bootSdk({ runAnimationFrames: true });
  const p = appendTo(sdk.body, cell("p", "Marked text"));
  const node = { nodeType: 3, parentElement: p, parentNode: p, nodeValue: "Marked text" };
  p.childNodes = [node];
  sdk.setDocumentQueryAll((query) => (query === "#paragraph" ? [p] : []));
  sdk.setCreateRange(() => ({
    setStart() {},
    setEnd() {},
    toString: () => "Marked text",
    collapsed: false,
    getClientRects: () => [{ left: 10, top: 10, right: 90, bottom: 30, width: 80, height: 20 }],
    getBoundingClientRect: () => p.getBoundingClientRect(),
  }));
  const target = {
    type: "text-range",
    text: "Marked text",
    selector: "#paragraph",
    commonAncestorSelector: "#paragraph",
    start: { selector: "#paragraph", path: [0], offset: 0 },
    end: { selector: "#paragraph", path: [0], offset: 11 },
  };
  sdk.sendChromeMessage({
    type: "lavish:annotationMarks",
    items: [
      { id: "one", selector: "#paragraph", state: "sent", hasComment: false, target },
      { id: "two", selector: "#paragraph", state: "queued", hasComment: true, badgeNumber: 1, target },
    ],
  });
  sdk.runTimers();
  assert.ok(sdk.overlayElements().some((el) => el.className.includes("is-marker-only")));
  assert.ok(sdk.overlayElements().some((el) => el.className.includes("is-commented")));
  sdk.trigger("click", { target: p, clientX: 20, clientY: 15, preventDefault() {}, stopPropagation() {} });
  assert.equal(sdk.posted.at(-1).type, "lavish:activateAnnotationMark");
  assert.equal(sdk.posted.at(-1).id, "two");
  assert.equal(sdk.posted.at(-1).selectOnly, true);
  assert.equal(sdk.cards().length, 0);
  sdk.sendChromeMessage({ type: "lavish:openCommentForMark", id: "one" });
  assert.equal(sdk.cards().length, 1);
});

test("mark arrows step through commented and bare marks in page order and the chrome can reveal one", () => {
  const sdk = bootSdk({ runAnimationFrames: true });
  const upper = appendTo(sdk.body, cell("p", "Upper words"));
  const middle = appendTo(sdk.body, cell("p", "Middle words"));
  const lower = appendTo(sdk.body, cell("p", "Lower words"));
  for (const [p, top] of [
    [upper, 100],
    [middle, 350],
    [lower, 600],
  ]) {
    p.childNodes = [{ nodeType: 3, parentElement: p, parentNode: p, nodeValue: p.textContent }];
    p.rectTop = top;
  }
  const bySelector = { "#upper": upper, "#middle": middle, "#lower": lower };
  sdk.setDocumentQueryAll((query) => (bySelector[query] ? [bySelector[query]] : []));
  sdk.setCreateRange(() => {
    let owner = null;
    return {
      setStart(node) {
        owner = node.parentElement;
      },
      setEnd() {},
      get commonAncestorContainer() {
        return owner;
      },
      toString: () => owner.textContent,
      collapsed: false,
      getClientRects: () => [
        { left: 10, top: owner.rectTop, right: 90, bottom: owner.rectTop + 20, width: 80, height: 20 },
      ],
      getBoundingClientRect: () => ({
        left: 10,
        top: owner.rectTop,
        right: 90,
        bottom: owner.rectTop + 20,
        width: 80,
        height: 20,
      }),
    };
  });
  const textTarget = (selector, text) => ({
    type: "text-range",
    text,
    selector,
    commonAncestorSelector: selector,
    start: { selector, path: [0], offset: 0 },
    end: { selector, path: [0], offset: text.length },
  });
  // The chat lists the lower passage first: the arrows follow the page, not the badge numbers.
  sdk.sendChromeMessage({
    type: "lavish:annotationMarks",
    items: [
      {
        id: "low",
        selector: "#lower",
        state: "sent",
        hasComment: true,
        badgeNumber: 1,
        target: textTarget("#lower", "Lower words"),
      },
      {
        id: "up",
        selector: "#upper",
        state: "queued",
        hasComment: true,
        badgeNumber: 2,
        target: textTarget("#upper", "Upper words"),
      },
      {
        id: "mid",
        selector: "#middle",
        state: "queued",
        hasComment: false,
        badgeNumber: 0,
        target: textTarget("#middle", "Middle words"),
      },
    ],
  });
  sdk.runTimers();
  const navs = () => sdk.overlayElements().filter((el) => el.className.startsWith("lavish-mark-nav"));
  assert.equal(navs().length, 3);
  const [lowNav, upNav, midNav] = navs();
  // The arrows sit just right of their badge (badge at 88px, stub width 100px).
  assert.equal(upNav.style.left, "191px");
  assert.equal(upNav.children[0].disabled, true, "the topmost mark has nothing above it");
  assert.equal(lowNav.children[1].disabled, true, "the bottom mark has nothing below it");
  // A bare marker's arrows hide with its + comment button until it is hovered or selected.
  assert.equal(midNav.className, "lavish-mark-nav is-marker-only");

  const fire = (button, type, extra) =>
    button.listeners.find((l) => l.type === type).handler({ preventDefault() {}, stopPropagation() {}, ...extra });
  // A release that began elsewhere, such as the end of a text selection dragged onto the arrow,
  // does not activate it.
  fire(upNav.children[1], "pointerup", { button: 0, pointerId: 1, clientX: 20, clientY: 20 });
  assert.equal(sdk.windowScrolls.length, 0);
  // A touch dragged off the arrow is released elsewhere; implicit pointer capture still delivers
  // that release to the arrow, which must not activate.
  fire(upNav.children[1], "pointerdown", { button: 0, pointerId: 1 });
  fire(upNav.children[1], "pointerup", { button: 0, pointerId: 1, clientX: 600, clientY: 400 });
  assert.equal(sdk.windowScrolls.length, 0);
  // An artifact that mutates on mousedown rebuilds the overlay mid-press, so the browser never fires
  // `click` on the arrow it pressed. The release over the rebuilt copy of the same arrow activates,
  // and the trailing mouse click is a no-op.
  fire(upNav.children[1], "pointerdown", { button: 0, pointerId: 2 });
  sdk.scroll();
  sdk.runTimers();
  const rebuiltUpNav = navs()[1];
  assert.notEqual(rebuiltUpNav, upNav, "the overlay was rebuilt between press and release");
  fire(rebuiltUpNav.children[1], "pointerup", { button: 0, pointerId: 2, clientX: 20, clientY: 20 });
  fire(rebuiltUpNav.children[1], "click", { detail: 1 });
  assert.equal(sdk.windowScrolls.length, 1);
  // Explicit instant offsets: some artifacts stall scrollIntoView. The bare marker's middle (360)
  // lands in the middle of the 800px view.
  assert.deepEqual({ ...sdk.windowScrolls.at(-1) }, { top: -40, left: 0, behavior: "instant" });
  assert.equal(sdk.posted.at(-1).id, "mid");
  const selectedMidNav = navs().find((nav) => nav.className.includes("is-marker-only"));
  assert.equal(selectedMidNav.className, "lavish-mark-nav is-marker-only is-visible");
  fire(selectedMidNav.children[1], "pointerdown", { button: 0, pointerId: 3 });
  fire(selectedMidNav.children[1], "pointerup", { button: 0, pointerId: 3, clientX: 20, clientY: 20 });
  assert.equal(sdk.windowScrolls.at(-1).top, 210);
  assert.deepEqual(
    { type: sdk.posted.at(-1).type, id: sdk.posted.at(-1).id, selectOnly: sdk.posted.at(-1).selectOnly },
    { type: "lavish:activateAnnotationMark", id: "low", selectOnly: true },
  );
  assert.ok(sdk.overlayElements().some((el) => el.className.includes("is-selected")));

  // A click in the conversation reveals the exact words without echoing back to the chrome.
  const postedBefore = sdk.posted.length;
  sdk.sendChromeMessage({ type: "lavish:revealAnnotationMark", id: "up", selector: "#upper" });
  assert.equal(sdk.windowScrolls.length, 3);
  assert.equal(sdk.windowScrolls.at(-1).top, -290);
  assert.equal(sdk.posted.length, postedBefore);

  // A keyboard user presses Enter on a focused arrow (a click without a pointer). The overlay is
  // rebuilt by the jump, so the focus moves to the same arrow beside the mark it reached.
  const shadowRoot = navs()[0].parentElement;
  const keyboardNext = navs()[1].children[1];
  shadowRoot.activeElement = keyboardNext;
  fire(keyboardNext, "click", { detail: 0 });
  assert.equal(sdk.posted.at(-1).id, "mid");
  assert.deepEqual({ ...navs()[2].children[1].focusedWith }, { preventScroll: true });
  // Beside the last mark in that direction the same arrow is disabled, so the focus takes the
  // opposite one and stepping back stays possible.
  shadowRoot.activeElement = navs()[2].children[1];
  fire(navs()[2].children[1], "click", { detail: 0 });
  assert.equal(sdk.posted.at(-1).id, "low");
  assert.deepEqual({ ...navs()[0].children[0].focusedWith }, { preventScroll: true });
  assert.equal(navs()[0].children[1].focusedWith, undefined);
});

test("an element mark from a right-click annotation gets a badge and joins the arrow order", () => {
  const sdk = bootSdk({ runAnimationFrames: true });
  const upper = appendTo(sdk.body, cell("p", "Upper words"));
  const card = appendTo(sdk.body, cell("div", "Card words"));
  for (const [el, top] of [
    [upper, 100],
    [card, 350],
  ]) {
    el.childNodes = [{ nodeType: 3, parentElement: el, parentNode: el, nodeValue: el.textContent }];
    el.rectTop = top;
  }
  const bySelector = { "#upper": upper, "#card": card };
  sdk.setDocumentQueryAll((query) => (bySelector[query] ? [bySelector[query]] : []));
  sdk.setCreateRange(() => {
    let owner = null;
    return {
      setStart(node) {
        owner = node.parentElement;
      },
      setEnd() {},
      selectNodeContents(element) {
        owner = element;
      },
      get commonAncestorContainer() {
        return owner;
      },
      toString: () => owner.textContent,
      collapsed: false,
      getClientRects: () => [
        { left: 10, top: owner.rectTop, right: 90, bottom: owner.rectTop + 20, width: 80, height: 20 },
      ],
      getBoundingClientRect: () => ({
        left: 10,
        top: owner.rectTop,
        right: 90,
        bottom: owner.rectTop + 20,
        width: 80,
        height: 20,
      }),
    };
  });
  sdk.sendChromeMessage({
    type: "lavish:annotationMarks",
    items: [
      {
        id: "card-mark",
        selector: "#card",
        kind: "element",
        state: "sent",
        hasComment: true,
        badgeNumber: 1,
      },
      {
        id: "text-mark",
        selector: "#upper",
        kind: "text-range",
        state: "sent",
        hasComment: false,
        badgeNumber: 0,
        target: {
          type: "text-range",
          text: "Upper words",
          selector: "#upper",
          commonAncestorSelector: "#upper",
          start: { selector: "#upper", path: [0], offset: 0 },
          end: { selector: "#upper", path: [0], offset: 11 },
        },
      },
    ],
  });
  sdk.runTimers();
  // The right-click annotation renders a commented badge over its element instead of nothing.
  assert.ok(sdk.overlayElements().some((el) => el.className.includes("is-commented")));
  assert.ok(sdk.overlayElements().some((el) => el.className.startsWith("lavish-mark-badge")));
  // Both marks are in the reading order, so the arrows exist for each of them.
  const navs = sdk.overlayElements().filter((el) => el.className.startsWith("lavish-mark-nav"));
  assert.equal(navs.length, 2);
  assert.equal(
    navs.every((nav) => nav.children.length === 2),
    true,
  );
});

test("the arrow activates and scrolls to an element mark with no matching text", () => {
  const sdk = bootSdk({ runAnimationFrames: true });
  const upper = appendTo(sdk.body, cell("p", "Upper words"));
  const card = appendTo(sdk.body, cell("div", "Card words"));
  for (const [el, top] of [
    [upper, 100],
    [card, 600],
  ]) {
    el.childNodes = [{ nodeType: 3, parentElement: el, parentNode: el, nodeValue: el.textContent }];
    el.rectTop = top;
  }
  const bySelector = { "#upper": upper, "#card": card };
  sdk.setDocumentQueryAll((query) => (bySelector[query] ? [bySelector[query]] : []));
  sdk.setCreateRange(() => {
    let owner = null;
    return {
      setStart(node) {
        owner = node.parentElement;
      },
      setEnd() {},
      selectNodeContents(element) {
        owner = element;
      },
      get commonAncestorContainer() {
        return owner;
      },
      toString: () => owner.textContent,
      collapsed: false,
      getClientRects: () => [
        { left: 10, top: owner.rectTop, right: 90, bottom: owner.rectTop + 20, width: 80, height: 20 },
      ],
      getBoundingClientRect: () => ({
        left: 10,
        top: owner.rectTop,
        right: 90,
        bottom: owner.rectTop + 20,
        width: 80,
        height: 20,
      }),
    };
  });
  // The element mark carries no text that resolveTextTarget could match: without the
  // element path in the focus resolver, its arrow would do nothing at all.
  sdk.sendChromeMessage({
    type: "lavish:annotationMarks",
    items: [
      {
        id: "text-mark",
        selector: "#upper",
        kind: "text-range",
        state: "sent",
        hasComment: false,
        badgeNumber: 0,
        target: {
          type: "text-range",
          text: "Upper words",
          selector: "#upper",
          commonAncestorSelector: "#upper",
          start: { selector: "#upper", path: [0], offset: 0 },
          end: { selector: "#upper", path: [0], offset: 11 },
        },
      },
      {
        id: "card-mark",
        selector: "#card",
        kind: "element",
        state: "sent",
        hasComment: true,
        badgeNumber: 1,
        text: "",
      },
    ],
  });
  sdk.runTimers();
  const navs = sdk.overlayElements().filter((el) => el.className.startsWith("lavish-mark-nav"));
  assert.equal(navs.length, 2, "both marks are navigable");
  const fire = (button, type, extra) =>
    button.listeners.find((l) => l.type === type).handler({ preventDefault() {}, stopPropagation() {}, ...extra });
  // Step from the text mark down to the element mark.
  fire(navs[0].children[1], "pointerdown", { button: 0, pointerId: 1, clientX: 20, clientY: 20 });
  fire(navs[0].children[1], "pointerup", { button: 0, pointerId: 1, clientX: 20, clientY: 20 });
  fire(navs[0].children[1], "click", { detail: 1 });
  assert.equal(sdk.windowScrolls.length, 1, "the arrow scrolled the element mark into view");
  assert.equal(sdk.posted.at(-1).type, "lavish:activateAnnotationMark");
  assert.equal(sdk.posted.at(-1).id, "card-mark");
});

test("an element mark on an empty container still gets a badge and arrow order", () => {
  const sdk = bootSdk({ runAnimationFrames: true });
  const empty = appendTo(sdk.body, cell("div", ""));
  empty.childNodes = [];
  empty.rectTop = 200;
  const bySelector = { "#empty": empty };
  sdk.setDocumentQueryAll((query) => (bySelector[query] ? [bySelector[query]] : []));
  sdk.setCreateRange(() => ({
    setStart() {},
    setEnd() {},
    selectNodeContents() {},
    getClientRects: () => [], // an empty container's range has no rectangles
    getBoundingClientRect: () => null,
  }));
  sdk.sendChromeMessage({
    type: "lavish:annotationMarks",
    items: [
      {
        id: "empty-mark",
        selector: "#empty",
        kind: "element",
        state: "sent",
        hasComment: true,
        badgeNumber: 1,
        text: "",
      },
    ],
  });
  const badge = sdk.overlayElements().find((el) => String(el.className || "").includes("lavish-mark-badge"));
  assert.ok(badge, "an empty container element mark still renders its badge from the element box");
});

test("overlapping text selection ignores element marks when placing a new text mark", () => {
  const sdk = bootSdk({ runAnimationFrames: true });
  const p = appendTo(sdk.body, cell("p", "Card words"));
  p.childNodes = [{ nodeType: 3, parentElement: p, parentNode: p, nodeValue: "Card words" }];
  const bySelector = { "#card": p };
  sdk.setDocumentQueryAll((query) => (bySelector[query] ? [bySelector[query]] : []));
  sdk.setCreateRange(() => {
    let owner = null;
    return {
      setStart() {},
      setEnd() {},
      selectNodeContents(element) {
        owner = element;
      },
      getClientRects: () => (owner ? [{ left: 10, top: 10, right: 90, bottom: 30, width: 80, height: 20 }] : []),
      getBoundingClientRect: () => ({ left: 10, top: 10, right: 90, bottom: 30, width: 80, height: 20 }),
    };
  });
  sdk.sendChromeMessage({
    type: "lavish:annotationMarks",
    items: [
      {
        id: "card-mark",
        selector: "#card",
        kind: "element",
        state: "sent",
        hasComment: true,
        badgeNumber: 1,
        text: "Card words",
      },
    ],
  });
  // A new selection inside that element must not merge with or select the element mark:
  // findOverlappingMarks skips element kinds entirely.
  selectText(sdk, p, "Card");
  sdk.trigger("keydown", { key: "m", target: p, preventDefault() {} });
  const prompt = sdk.posted.find((entry) => entry.type === "lavish:queuePrompt").prompt;
  assert.equal(prompt.replace_mark_ids, undefined, "an element mark never replaces a fresh text selection");
});

test("a text mark never falls back to its container selector alone", () => {
  const sdk = bootSdk({ runAnimationFrames: true });
  const p = appendTo(sdk.body, cell("p", "Reworded since the mark"));
  p.childNodes = [{ nodeType: 3, parentElement: p, parentNode: p, nodeValue: p.textContent }];
  p.rectTop = 100;
  sdk.setDocumentQueryAll((query) => (query === "#gone" ? [p] : []));
  sdk.setCreateRange(() => {
    let owner = null;
    return {
      setStart(node) {
        owner = node.parentElement;
      },
      setEnd() {},
      selectNodeContents(element) {
        owner = element;
      },
      get commonAncestorContainer() {
        return owner;
      },
      toString: () => owner.textContent,
      collapsed: false,
      getClientRects: () => [
        { left: 10, top: owner.rectTop, right: 90, bottom: owner.rectTop + 20, width: 80, height: 20 },
      ],
    };
  });
  // The marked wording no longer exists, so the text mark must stay unresolved rather than
  // silently anchoring to whatever the selector resolves to now.
  sdk.sendChromeMessage({
    type: "lavish:annotationMarks",
    items: [
      {
        id: "stale",
        selector: "#gone",
        kind: "text-range",
        state: "sent",
        hasComment: true,
        badgeNumber: 1,
        target: {
          type: "text-range",
          text: "original wording",
          selector: "#gone",
          commonAncestorSelector: "#gone",
          start: { selector: "#gone", path: [0], offset: 0 },
          end: { selector: "#gone", path: [0], offset: 8 },
        },
      },
    ],
  });
  sdk.runTimers();
  assert.equal(sdk.overlayElements().filter((el) => el.className.startsWith("lavish-persistent-mark")).length, 0);
  assert.equal(sdk.overlayElements().filter((el) => el.className.startsWith("lavish-mark-badge")).length, 0);
});

test("a selected mark later in the list does not steal the hover from the bare marker under the pointer", () => {
  const sdk = bootSdk({ runAnimationFrames: true });
  const first = appendTo(sdk.body, cell("p", "First words"));
  const second = appendTo(sdk.body, cell("p", "Second words"));
  for (const [p, top] of [
    [first, 100],
    [second, 350],
  ]) {
    p.childNodes = [{ nodeType: 3, parentElement: p, parentNode: p, nodeValue: p.textContent }];
    p.rectTop = top;
  }
  const bySelector = { "#first": first, "#second": second };
  sdk.setDocumentQueryAll((query) => (bySelector[query] ? [bySelector[query]] : []));
  sdk.setCreateRange(() => {
    let owner = null;
    const rect = () => ({ left: 10, top: owner.rectTop, right: 90, bottom: owner.rectTop + 20, width: 80, height: 20 });
    return {
      setStart(node) {
        owner = node.parentElement;
      },
      setEnd() {},
      get commonAncestorContainer() {
        return owner;
      },
      toString: () => owner.textContent,
      collapsed: false,
      getClientRects: () => [rect()],
      getBoundingClientRect: rect,
    };
  });
  const bareMark = (id, selector, text) => ({
    id,
    selector,
    state: "queued",
    hasComment: false,
    badgeNumber: 0,
    target: {
      type: "text-range",
      text,
      selector,
      commonAncestorSelector: selector,
      start: { selector, path: [0], offset: 0 },
      end: { selector, path: [0], offset: text.length },
    },
  });
  sdk.sendChromeMessage({
    type: "lavish:annotationMarks",
    items: [bareMark("first", "#first", "First words"), bareMark("second", "#second", "Second words")],
  });
  sdk.runTimers();
  sdk.sendChromeMessage({ type: "lavish:revealAnnotationMark", id: "second", selector: "#second" });
  // The pointer rests on the first marker while the second one stays selected.
  sdk.trigger("mousemove", { target: first, clientX: 20, clientY: 110 });
  // An artifact that mutates on mousedown rebuilds the overlay before the release.
  sdk.scroll();
  sdk.runTimers();
  const addButtons = sdk.overlayElements().filter((el) => el.className.startsWith("lavish-mark-add-comment"));
  assert.deepEqual(
    addButtons.map((el) => el.className.includes("is-visible")),
    [true, true],
    "the hovered first marker and the selected second marker both keep their + comment control",
  );
});

test("a jump scrolls a scrollable anchor itself and brings a mark beyond the right edge into view", () => {
  const sdk = bootSdk({ runAnimationFrames: true });
  // Words inside a <pre> that scrolls on its own, sitting right of the 1280px wide view.
  const pre = appendTo(sdk.body, cell("pre", "Wide words"));
  pre.childNodes = [{ nodeType: 3, parentElement: pre, parentNode: pre, nodeValue: "Wide words" }];
  Object.assign(pre, { computedStyle: { overflowY: "auto", overflowX: "visible" } });
  Object.assign(pre, { scrollHeight: 500, clientHeight: 100, scrollTop: 0, scrollWidth: 100, clientWidth: 100 });
  sdk.setDocumentQueryAll((query) => (query === "#wide" ? [pre] : []));
  const rect = { left: 1500, top: 600, right: 1580, bottom: 620, width: 80, height: 20 };
  sdk.setCreateRange(() => {
    let owner = null;
    return {
      setStart(node) {
        owner = node.parentElement;
      },
      setEnd() {},
      get commonAncestorContainer() {
        return owner;
      },
      toString: () => owner.textContent,
      collapsed: false,
      getClientRects: () => [rect],
      getBoundingClientRect: () => rect,
    };
  });
  const target = {
    type: "text-range",
    text: "Wide words",
    selector: "#wide",
    commonAncestorSelector: "#wide",
    start: { selector: "#wide", path: [0], offset: 0 },
    end: { selector: "#wide", path: [0], offset: 10 },
  };
  sdk.sendChromeMessage({
    type: "lavish:annotationMarks",
    items: [{ id: "wide", selector: "#wide", state: "queued", hasComment: true, badgeNumber: 1, target }],
  });
  sdk.runTimers();
  sdk.sendChromeMessage({ type: "lavish:revealAnnotationMark", id: "wide", selector: "#wide" });
  // The <pre> box is 10..110 tall, so the words' middle (610) moves to its middle (60).
  assert.equal(pre.scrollTop, 550);
  // The window centers the words sideways because they lie beyond the right edge.
  assert.deepEqual({ ...sdk.windowScrolls.at(-1) }, { top: 210, left: 900, behavior: "instant" });
});

test("a jump scrolls the body when an app-shell layout makes it the scroll container", () => {
  const sdk = bootSdk({ runAnimationFrames: true });
  // html{overflow:hidden} with body{overflow:auto}: only the body scrolls, the window never moves.
  Object.assign(sdk.body, { computedStyle: { overflowY: "auto", overflowX: "hidden" } });
  Object.assign(sdk.body, { scrollHeight: 3000, clientHeight: 800, scrollTop: 0, scrollWidth: 100, clientWidth: 100 });
  sdk.body.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1280, bottom: 800, width: 1280, height: 800 });
  // A smooth scroll-behavior would only start an animation, leaving the marker drawn at the old place.
  const bodyScrolls = [];
  sdk.body.scrollTo = (options) => {
    bodyScrolls.push({ ...options });
    sdk.body.scrollTop = options.top;
    sdk.body.scrollLeft = options.left;
  };
  const p = appendTo(sdk.body, cell("p", "Deep words"));
  p.childNodes = [{ nodeType: 3, parentElement: p, parentNode: p, nodeValue: "Deep words" }];
  sdk.setDocumentQueryAll((query) => (query === "#deep" ? [p] : []));
  const rect = { left: 10, top: 1500, right: 90, bottom: 1520, width: 80, height: 20 };
  sdk.setCreateRange(() => {
    let owner = null;
    return {
      setStart(node) {
        owner = node.parentElement;
      },
      setEnd() {},
      get commonAncestorContainer() {
        return owner;
      },
      toString: () => owner.textContent,
      collapsed: false,
      getClientRects: () => [rect],
      getBoundingClientRect: () => rect,
    };
  });
  const target = {
    type: "text-range",
    text: "Deep words",
    selector: "#deep",
    commonAncestorSelector: "#deep",
    start: { selector: "#deep", path: [0], offset: 0 },
    end: { selector: "#deep", path: [0], offset: 10 },
  };
  sdk.sendChromeMessage({
    type: "lavish:annotationMarks",
    items: [{ id: "deep", selector: "#deep", state: "queued", hasComment: true, badgeNumber: 1, target }],
  });
  sdk.runTimers();
  sdk.sendChromeMessage({ type: "lavish:revealAnnotationMark", id: "deep", selector: "#deep" });
  // The words' middle (1510) moves to the middle of the 800px tall body (400).
  assert.equal(sdk.body.scrollTop, 1110);
  assert.deepEqual(bodyScrolls, [{ top: 1110, left: 0, behavior: "instant" }]);
});

test("clicking a mark or pressing M then C or Delete comments or deletes without stacking duplicates", () => {
  const sdk = bootSdk({ runAnimationFrames: true });
  const p = appendTo(sdk.body, cell("p", "Marked text"));
  const node = { nodeType: 3, parentElement: p, parentNode: p, nodeValue: "Marked text" };
  p.childNodes = [node];
  sdk.setDocumentQueryAll((query) => (query === "#paragraph" || query === "html > body > p" ? [p] : []));
  const rangeObj = {
    startContainer: node,
    endContainer: node,
    startOffset: 0,
    endOffset: 11,
    setStart() {},
    setEnd() {},
    cloneRange() {
      return this;
    },
    compareBoundaryPoints() {
      return 0;
    },
    toString: () => "Marked text",
    collapsed: false,
    getClientRects: () => [{ left: 10, top: 10, right: 90, bottom: 30, width: 80, height: 20 }],
    getBoundingClientRect: () => p.getBoundingClientRect(),
  };
  sdk.setCreateRange(() => rangeObj);
  const target = {
    type: "text-range",
    text: "Marked text",
    selector: "#paragraph",
    commonAncestorSelector: "#paragraph",
    start: { selector: "#paragraph", path: [0], offset: 0 },
    end: { selector: "#paragraph", path: [0], offset: 11 },
  };
  sdk.sendChromeMessage({
    type: "lavish:annotationMarks",
    items: [{ id: "m1", selector: "#paragraph", state: "queued", hasComment: false, comment: "", target }],
  });
  sdk.runTimers();

  // Clicking the mark selects it; pressing C without a blue selection opens the comment card on it.
  sdk.trigger("click", { target: p, clientX: 20, clientY: 15, preventDefault() {}, stopPropagation() {} });
  sdk.setSelection({ rangeCount: 0, toString: () => "" });
  sdk.trigger("keydown", { key: "c", target: p, preventDefault() {} });
  assert.equal(sdk.cards().length, 1);
  sdk.cards()[0].querySelector(".lavish-cancel").onclick();

  // Clicking the + comment overlay button also opens the comment card directly on the page.
  const addCommentBtn = sdk.overlayElements().find((el) => el.className.includes("lavish-mark-add-comment"));
  assert.ok(addCommentBtn);
  addCommentBtn.listeners.find((l) => l.type === "click").handler({ preventDefault() {}, stopPropagation() {} });
  assert.equal(sdk.cards().length, 2);
  sdk.cards()[1].querySelector(".lavish-cancel").onclick();

  // Pressing Delete removes the selected mark and posts lavish:deleteAnnotationMark.
  sdk.trigger("keydown", { key: "Delete", target: p, preventDefault() {} });
  assert.equal(sdk.posted.at(-1).type, "lavish:deleteAnnotationMark");
  assert.equal(sdk.posted.at(-1).id, "m1");
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

test("explore mode keeps left clicks native while the SDK annotates on right click", () => {
  const sdk = bootSdk({ initialAnnotate: false });
  const { evidence } = buildTable(sdk);

  sdk.click(evidence);
  assert.equal(sdk.cards().length, 0);

  sdk.rightClick(evidence);
  const message = sdk.queue("Check this permission");
  assert.equal(message.type, "lavish:queuePrompt");
  assert.equal(message.prompt.prompt, "Check this permission");
});

test("a marked link remains navigable on left click and annotatable on right click", () => {
  const sdk = bootSdk({ initialAnnotate: false });
  const link = appendTo(sdk.body, cell("a", "Historische Modellantwort"));
  link.setAttribute("data-lavish-action", "link");
  link.setAttribute("href", "\\\\wsl.localhost\\Ubuntu\\home\\simon\\example.json");

  sdk.click(link);
  assert.equal(sdk.cards().length, 0);

  sdk.rightClick(link);
  const message = sdk.queue("Dieser Link soll anders heißen.");
  assert.equal(message.type, "lavish:queuePrompt");
  assert.equal(message.prompt.tag, "a");
  assert.equal(message.prompt.text, "Historische Modellantwort");
});

test("hovering a report card offers a Markdown copy control without opening an annotation", async () => {
  const sdk = bootSdk({ initialAnnotate: false });
  const reportCard = appendTo(sdk.body, cell("article", "Nur mit Freigabe"));

  sdk.trigger("mouseover", { target: reportCard });
  const copyButton = sdk.copyButton();
  assert.ok(copyButton, "a compact copy control is placed over the hovered card");
  assert.equal(copyButton.hidden, false);
  assert.equal(copyButton.style.top, "12px");
  assert.equal(copyButton.style.left, "118px");
  assert.ok(
    Number.parseInt(copyButton.style.left, 10) >= reportCard.getBoundingClientRect().right,
    "the copy control sits outside the text block, not over the text",
  );

  const click = copyButton.listeners.find((entry) => entry.type === "click");
  assert.ok(click, "the control handles its own click");
  await click.handler({ preventDefault() {}, stopPropagation() {} });

  assert.deepEqual(sdk.clipboardWrites, ["Nur mit Freigabe"]);
  assert.equal(sdk.cards().length, 0, "copying is a native card action, never an annotation");
});

test("the copy control attaches to the nearest hovered block, not a coarser ancestor", async () => {
  const sdk = bootSdk({ initialAnnotate: false });
  const sourceCard = appendTo(sdk.body, cell("div", ""));
  sourceCard.className = "src-card";
  const meta = appendTo(sourceCard, cell("div", "Strategic content execution architecture"));
  meta.className = "meta-block meta-topic";
  meta.getBoundingClientRect = () => ({ left: 40, top: 120, right: 400, bottom: 180, width: 360, height: 60 });
  sourceCard.getBoundingClientRect = () => ({ left: 20, top: -80, right: 500, bottom: 900, width: 480, height: 980 });

  sdk.trigger("mouseover", { target: meta });
  const copyButton = sdk.copyButton();
  assert.ok(copyButton, "the copy control appears for the hovered meta block");
  assert.equal(copyButton.style.top, "122px", "the control sits beside the meta block, not the scrolled card");
  assert.equal(copyButton.style.left, "408px");
  assert.ok(
    Number.parseInt(copyButton.style.left, 10) >= meta.getBoundingClientRect().right,
    "the control sits outside the text area",
  );

  const click = copyButton.listeners.find((entry) => entry.type === "click");
  await click.handler({ preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(sdk.clipboardWrites, ["Strategic content execution architecture"]);
});

test("scrolling a hovered block off-screen hides the copy control instead of pinning it to the viewport", () => {
  const sdk = bootSdk({ initialAnnotate: false });
  const notice = appendTo(sdk.body, cell("aside", "Diese Fläche projiziert die Wissensinsel"));
  notice.className = "notice";
  notice.getBoundingClientRect = () => ({ left: 400, top: 40, right: 1012, bottom: 120, width: 612, height: 80 });

  sdk.trigger("mouseover", { target: notice });
  const copyButton = sdk.copyButton();
  assert.ok(copyButton);
  assert.equal(copyButton.hidden, false);
  assert.equal(copyButton.style.top, "42px");
  assert.equal(copyButton.style.left, "1020px");
  assert.ok(
    Number.parseInt(copyButton.style.left, 10) >= notice.getBoundingClientRect().right,
    "the control sits outside the text block",
  );

  notice.getBoundingClientRect = () => ({ left: 400, top: -220, right: 1012, bottom: -140, width: 612, height: 80 });
  sdk.scroll();
  assert.equal(copyButton.hidden, true, "the control must not stick to the viewport corner");
  assert.equal(sdk.copyButton() && sdk.copyButton().hidden, true);
});

test("the copy control falls back outside to the left or above when the right margin has no room", () => {
  const sdk = bootSdk({ initialAnnotate: false });
  const rightBlocked = appendTo(sdk.body, cell("aside", "Kein Platz rechts"));
  rightBlocked.className = "notice";
  rightBlocked.getBoundingClientRect = () => ({ left: 800, top: 40, right: 1270, bottom: 120, width: 470, height: 80 });

  sdk.trigger("mouseover", { target: rightBlocked });
  const copyButton = sdk.copyButton();
  assert.ok(copyButton);
  assert.equal(copyButton.hidden, false);
  assert.equal(copyButton.style.left, "768px");
  assert.ok(
    Number.parseInt(copyButton.style.left, 10) + 24 <= rightBlocked.getBoundingClientRect().left,
    "sits outside on the left",
  );

  const fullWidth = appendTo(sdk.body, cell("aside", "Volle Breite"));
  fullWidth.className = "notice";
  fullWidth.getBoundingClientRect = () => ({ left: 10, top: 60, right: 1270, bottom: 160, width: 1260, height: 100 });

  sdk.trigger("mouseover", { target: fullWidth });
  assert.equal(copyButton.hidden, false);
  assert.equal(copyButton.style.top, "32px");
  assert.ok(
    Number.parseInt(copyButton.style.top, 10) + 24 <= fullWidth.getBoundingClientRect().top,
    "sits outside above the text",
  );
});

test("scroll position marks the current sidebar section, including the final sources section", () => {
  const sdk = bootSdk({ runAnimationFrames: true, initialAnnotate: false });
  const firstLink = cell("a", "Start");
  firstLink.setAttribute("href", "#start");
  const sourceLink = cell("a", "Quellen");
  sourceLink.setAttribute("href", "#sources");
  const start = cell("section", "Start");
  start.getBoundingClientRect = () => ({ left: 0, top: -900, right: 100, bottom: -800, width: 100, height: 100 });
  const sources = cell("section", "Quellen");
  sources.getBoundingClientRect = () => ({ left: 0, top: 120, right: 100, bottom: 220, width: 100, height: 100 });
  sdk.setElementById("start", start);
  sdk.setElementById("sources", sources);
  sdk.setDocumentQueryAll((selector) => (selector.includes("href^='#'") ? [firstLink, sourceLink] : []));

  sdk.runTimers();

  assert.equal(firstLink.getAttribute("data-lavish-active-nav"), "false");
  assert.equal(sourceLink.getAttribute("data-lavish-active-nav"), "true");
  assert.equal(sourceLink.getAttribute("aria-current"), "location");
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

test("review capture reports a native answer before the debounce and refuses changed question restoration", () => {
  const sdk = bootSdk();
  const scope = createElement("form");
  scope.setAttribute("data-lavish-question", "decision");
  scope.textContent = "Which approach?";
  const input = createElement("input");
  input.setAttribute("name", "note");
  input.defaultValue = "";
  input.value = "My unfinished answer";
  scope.querySelectorAll = () => [input];
  sdk.setDocumentQueryAll((selector) => (selector === "[data-lavish-question]" ? [scope] : []));
  sdk.sendChromeMessage({ type: "lavish:requestReviewState", request_id: "before-switch" });
  const captured = sdk.posted.find((item) => item.type === "lavish:reviewState" && item.request_id === "before-switch");
  assert.ok(captured);
  assert.equal(captured.state.fields[0].dirty, true);
  assert.equal(captured.state.fields[0].value, "My unfinished answer");
  scope.textContent = "A materially different question";
  input.value = "";
  sdk.sendChromeMessage({ type: "lavish:restoreReviewState", state: captured.state });
  assert.equal(input.value, "", "changed context must not receive the old answer");
  assert.ok(
    sdk.posted.some(
      (item) => item.type === "lavish:reviewDraftRecovered" && item.text.includes("My unfinished answer"),
    ),
  );
});

test("only acknowledged native answers become clean and later edits remain drafts", () => {
  const sdk = bootSdk();
  const scope = createElement("form");
  scope.setAttribute("data-lavish-question", "decision");
  scope.closest = () => scope;
  const input = createElement("input");
  input.value = "answer";
  input.defaultValue = "";
  scope.querySelectorAll = () => [input];
  sdk.setDocumentQueryAll((selector) => (selector === "[data-lavish-question]" ? [scope] : []));
  const capture = () => {
    sdk.sendChromeMessage({ type: "lavish:requestReviewState", request_id: "answer" });
    return sdk.posted.filter((item) => item.request_id === "answer").at(-1).state.fields[0];
  };
  sdk.api.queuePrompt("answer", { element: scope });
  const request = sdk.posted.find((item) => item.type === "lavish:queuePrompt");
  assert.equal(capture().dirty, true);
  sdk.sendChromeMessage({
    type: "lavish:questionQueued",
    review_request_id: request.review_request_id,
    accepted: true,
  });
  assert.equal(capture().dirty, false);
  input.value = "new answer";
  assert.equal(capture().dirty, true);
  sdk.api.queuePrompt("new answer", { element: scope });
  const rejected = sdk.posted.filter((item) => item.type === "lavish:queuePrompt").at(-1);
  sdk.sendChromeMessage({
    type: "lavish:questionQueued",
    review_request_id: rejected.review_request_id,
    accepted: false,
  });
  assert.equal(capture().dirty, true);
});

test("native select defaults are clean and changes preserve every selected value", () => {
  const sdk = bootSdk();
  const scope = createElement("form");
  scope.setAttribute("data-lavish-question", "selection");
  const select = createElement("select");
  select.type = "select-multiple";
  select.multiple = true;
  select.options = [
    { value: "one", defaultSelected: true, selected: true },
    { value: "two", defaultSelected: false, selected: false },
  ];
  select.value = "one";
  scope.querySelectorAll = () => [select];
  sdk.setDocumentQueryAll((selector) => (selector === "[data-lavish-question]" ? [scope] : []));
  const capture = () => {
    sdk.sendChromeMessage({ type: "lavish:requestReviewState", request_id: "select" });
    return sdk.posted.filter((item) => item.request_id === "select").at(-1).state;
  };
  assert.equal(capture().fields[0].dirty, false);
  select.options[1].selected = true;
  const changed = capture();
  assert.equal(changed.fields[0].dirty, true);
  assert.deepEqual(Array.from(changed.fields[0].selectedValues), ["one", "two"]);
  select.options[1].selected = false;
  sdk.sendChromeMessage({ type: "lavish:restoreReviewState", state: changed });
  assert.equal(select.options[1].selected, true);
});

test("changed explicit decision context recovers an answer even with identical form text", () => {
  const sdk = bootSdk();
  const scope = createElement("form");
  scope.setAttribute("data-lavish-question", "decision");
  scope.setAttribute("data-lavish-question-context", "original subject");
  const input = createElement("input");
  input.value = "unfinished";
  input.defaultValue = "";
  scope.querySelectorAll = () => [input];
  sdk.setDocumentQueryAll((selector) => (selector === "[data-lavish-question]" ? [scope] : []));
  sdk.sendChromeMessage({ type: "lavish:requestReviewState", request_id: "context" });
  const state = sdk.posted.find((item) => item.request_id === "context").state;
  scope.setAttribute("data-lavish-question-context", "different subject");
  input.value = "";
  sdk.sendChromeMessage({ type: "lavish:restoreReviewState", state });
  assert.equal(input.value, "");
  assert.ok(sdk.posted.some((item) => item.type === "lavish:reviewDraftRecovered"));
});

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

test("the served SDK bundle restores an anchored draft across an artifactRevision increment", () => {
  const sdk = bootSdk();
  const hero = appendTo(sdk.body, cell("h1", "Headline"));
  hero.id = "hero";
  sdk.setDocumentQuery((selector) => (selector === "#hero" ? hero : null));

  sdk.sendChromeMessage({
    type: "lavish:restoreReviewState",
    state: {
      card: { selector: "#hero", text: "keep anchored across reload", revision: 1 },
      fields: [],
    },
  });
  sdk.runTimers();

  assert.equal(
    sdk.posted.some((message) => message.type === "lavish:reviewDraftRecovered"),
    false,
    "a revision increment on reload must re-anchor the draft instead of detaching it",
  );
  assert.equal(sdk.card().querySelector("textarea").value, "keep anchored across reload");
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
