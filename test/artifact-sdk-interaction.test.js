import assert from "node:assert/strict";
import test from "node:test";

import { createArtifactSdk } from "../src/artifact-sdk.js";

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.ownerDocument = ownerDocument;
    this.nodeType = 1;
    this.tagName = String(tagName).toUpperCase();
    this.nodeName = this.tagName;
    this.parentElement = null;
    this.parentNode = null;
    this.children = [];
    this.childNodes = [];
    this.style = {};
    this.attributes = new Map();
    this.className = "";
    this.id = "";
    this.textContent = "";
    this.innerText = "";
    this.hidden = false;
    this.onclick = null;
    this.listeners = new Map();
    this._innerHTML = "";
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
    if (!this.className.includes("lavish-annotation-card")) return;
    const textarea = new FakeElement("textarea", this.ownerDocument);
    const cancel = new FakeElement("button", this.ownerDocument);
    cancel.className = "lavish-cancel";
    const send = new FakeElement("button", this.ownerDocument);
    send.className = "lavish-send";
    this.appendChild(textarea);
    this.appendChild(cancel);
    this.appendChild(send);
  }

  get innerHTML() {
    return this._innerHTML;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "id") this.id = String(value);
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  appendChild(child) {
    child.parentNode = this;
    if (child.nodeType === 1) {
      child.parentElement = this.nodeType === 1 ? this : null;
      this.children.push(child);
    }
    this.childNodes.push(child);
    return child;
  }

  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode.childNodes = this.parentNode.childNodes.filter((child) => child !== this);
    this.parentNode = null;
    this.parentElement = null;
  }

  attachShadow() {
    this.shadowRoot = new FakeShadowRoot(this.ownerDocument);
    return this.shadowRoot;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }

  click() {
    this.onclick?.({ target: this, preventDefault() {}, stopPropagation() {} });
  }

  focus() {
    this.ownerDocument.activeElement = this;
    if (this.tagName === "TEXTAREA") this.ownerDocument.selection.clear();
  }

  closest(selector) {
    const nativeTags = new Set(["button", "input", "select", "textarea", "option", "optgroup", "label", "summary"]);
    let node = this;
    while (node) {
      if (selector === "[data-lavish-ui]" && node.attributes?.has("data-lavish-ui")) return node;
      if (selector === "[data-lavish-action]" && node.attributes?.has("data-lavish-action")) return node;
      if (selector.includes("button,input,select,textarea") && nativeTags.has(node.tagName?.toLowerCase())) return node;
      node = node.parentElement;
    }
    return null;
  }

  contains(other) {
    if (other === this) return true;
    return this.children.some((child) => child.contains(other));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const selectors = selector.split(",").map((item) => item.trim());
    const matches = [];
    const visit = (node) => {
      for (const child of node.children || []) {
        if (
          selectors.some((candidate) => {
            if (candidate.startsWith(".")) return child.className.split(/\s+/).includes(candidate.slice(1));
            return child.tagName.toLowerCase() === candidate.toLowerCase();
          })
        ) {
          matches.push(child);
        }
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  getBoundingClientRect() {
    return { left: 20, top: 20, right: 220, bottom: 60, width: 200, height: 40 };
  }
}

class FakeShadowRoot extends FakeElement {
  constructor(ownerDocument) {
    super("shadow-root", ownerDocument);
    this.nodeType = 11;
  }
}

function fakeEvent(target, extra = {}) {
  return {
    target,
    clientX: 40,
    clientY: 40,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.propagationStopped = true;
    },
    ...extra,
  };
}

function createInteractionHarness({ selectedText = "Copy this exact review comment", execCommandResult = true } = {}) {
  let selectionText = selectedText;
  const listeners = new Map();
  const clipboardWrites = [];
  const execCommands = [];
  const postedMessages = [];

  const document = {
    readyState: "loading",
    activeElement: null,
    fonts: { ready: Promise.resolve() },
    addEventListener(type, listener) {
      const handlers = listeners.get(type) || [];
      handlers.push(listener);
      listeners.set(type, handlers);
    },
    dispatch(type, event) {
      for (const listener of listeners.get(type) || []) listener(event);
    },
    createElement(tagName) {
      return new FakeElement(tagName, document);
    },
    getElementById(id) {
      return document.documentElement.querySelectorAll("style").find((element) => element.id === id) || null;
    },
    querySelectorAll(selector) {
      return document.documentElement.querySelectorAll(selector);
    },
    getSelection() {
      return document.selection;
    },
    execCommand(command) {
      execCommands.push(command);
      return command === "copy" && execCommandResult;
    },
  };

  document.documentElement = new FakeElement("html", document);
  document.head = new FakeElement("head", document);
  document.body = new FakeElement("body", document);
  document.documentElement.appendChild(document.head);
  document.documentElement.appendChild(document.body);

  const paragraph = new FakeElement("p", document);
  paragraph.id = "review-finding";
  paragraph.textContent = selectedText;
  paragraph.innerText = selectedText;
  document.body.appendChild(paragraph);

  const range = {
    collapsed: false,
    commonAncestorContainer: paragraph,
    startContainer: paragraph,
    startOffset: 0,
    endContainer: paragraph,
    endOffset: selectedText.length,
    cloneRange() {
      return this;
    },
    intersectsNode(node) {
      return node === paragraph || paragraph.contains(node);
    },
    getClientRects() {
      return [paragraph.getBoundingClientRect()];
    },
    getBoundingClientRect() {
      return paragraph.getBoundingClientRect();
    },
  };
  document.selection = {
    rangeCount: selectedText ? 1 : 0,
    getRangeAt() {
      return range;
    },
    toString() {
      return selectionText;
    },
    clear() {
      selectionText = "";
    },
  };

  const windowListeners = new Map();
  const window = {
    innerWidth: 1280,
    innerHeight: 900,
    scrollX: 0,
    scrollY: 0,
    addEventListener(type, listener) {
      const handlers = windowListeners.get(type) || [];
      handlers.push(listener);
      windowListeners.set(type, handlers);
    },
    requestAnimationFrame(callback) {
      callback();
      return 1;
    },
    setTimeout,
    clearTimeout,
    scrollTo() {},
  };

  const globals = {
    CSS: globalThis.CSS,
    Element: globalThis.Element,
    MutationObserver: globalThis.MutationObserver,
    ResizeObserver: globalThis.ResizeObserver,
    document: globalThis.document,
    getComputedStyle: globalThis.getComputedStyle,
    navigator: globalThis.navigator,
    parent: globalThis.parent,
    window: globalThis.window,
  };

  Object.assign(globalThis, {
    CSS: { escape: (value) => String(value) },
    Element: FakeElement,
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    document,
    getComputedStyle: () => ({
      display: "block",
      visibility: "visible",
      opacity: "1",
      overflowX: "visible",
      overflowY: "visible",
      position: "static",
      borderLeftWidth: "0",
      borderRightWidth: "0",
      borderTopWidth: "0",
      borderBottomWidth: "0",
      paddingLeft: "0",
      paddingRight: "0",
      paddingTop: "0",
      paddingBottom: "0",
      textOverflow: "clip",
      webkitLineClamp: "0",
    }),
    parent: { postMessage: (message) => postedMessages.push(message) },
    window,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      platform: "MacIntel",
      clipboard: {
        async writeText(value) {
          clipboardWrites.push(value);
        },
      },
    },
  });

  createArtifactSdk(() => "");

  return {
    clipboardWrites,
    document,
    execCommands,
    paragraph,
    postedMessages,
    restore() {
      for (const [name, value] of Object.entries(globals)) {
        if (name === "navigator") {
          Object.defineProperty(globalThis, name, { configurable: true, value });
        } else if (value === undefined) {
          delete globalThis[name];
        } else {
          globalThis[name] = value;
        }
      }
    },
    selectionText: () => selectionText,
    shadowRoot: () => document.documentElement.querySelector(".lavish-annotation-root")?.shadowRoot || null,
  };
}

async function withHarness(options, callback) {
  const harness = createInteractionHarness(options);
  try {
    await callback(harness);
  } finally {
    harness.restore();
  }
}

test("ordinary left mouseup preserves selected text while annotation is enabled", async () => {
  await withHarness({}, async (harness) => {
    const event = fakeEvent(harness.paragraph);
    harness.document.dispatch("mouseup", event);
    await new Promise((resolve) => setTimeout(resolve, 5));

    assert.equal(event.defaultPrevented, false);
    assert.equal(harness.selectionText(), "Copy this exact review comment");
    assert.ok(!harness.shadowRoot()?.querySelector(".lavish-annotation-card"));
  });
});

test("ordinary left click and keyboard copy remain native", async () => {
  await withHarness({}, async (harness) => {
    const click = fakeEvent(harness.paragraph);
    const copy = fakeEvent(harness.paragraph, { key: "c", metaKey: true });

    harness.document.dispatch("click", click);
    harness.document.dispatch("keydown", copy);

    assert.equal(click.defaultPrevented, false);
    assert.equal(copy.defaultPrevented, false);
    assert.ok(!harness.shadowRoot()?.querySelector(".lavish-annotation-card"));
  });
});

test("right click on selected text offers Copy before explicit Annotate", async () => {
  const selectedText = "Copy  this exact review comment\nwithout normalizing it";
  await withHarness({ selectedText, execCommandResult: false }, async (harness) => {
    const event = fakeEvent(harness.paragraph);
    harness.document.dispatch("contextmenu", event);

    assert.equal(event.defaultPrevented, true);
    assert.equal(harness.selectionText(), selectedText);

    const menu = harness.shadowRoot()?.querySelector(".lavish-context-menu");
    assert.ok(menu);
    assert.deepEqual(
      menu.children.map((child) => child.textContent),
      ["Copy selection", "Annotate selection"],
    );

    menu.children[0].click();
    await Promise.resolve();
    assert.deepEqual(harness.execCommands, ["copy"]);
    assert.deepEqual(harness.clipboardWrites, [selectedText]);
    assert.equal(harness.selectionText(), selectedText);
    assert.ok(!harness.shadowRoot()?.querySelector(".lavish-annotation-card"));
  });
});

test("right click can explicitly annotate selected text", async () => {
  await withHarness({}, async (harness) => {
    harness.document.dispatch("contextmenu", fakeEvent(harness.paragraph));
    const menu = harness.shadowRoot()?.querySelector(".lavish-context-menu");
    assert.ok(menu);

    menu.children[1].click();
    await new Promise((resolve) => setTimeout(resolve, 5));

    assert.ok(harness.shadowRoot()?.querySelector(".lavish-annotation-card"));
  });
});

test("right click can explicitly annotate an element without selected text", async () => {
  await withHarness({ selectedText: "" }, async (harness) => {
    const event = fakeEvent(harness.paragraph);
    harness.document.dispatch("contextmenu", event);

    assert.equal(event.defaultPrevented, true);
    const menu = harness.shadowRoot()?.querySelector(".lavish-context-menu");
    assert.ok(menu);
    assert.deepEqual(
      menu.children.map((child) => child.textContent),
      ["Annotate element"],
    );
  });
});

test("disclosure summaries and data-lavish-action controls keep native behavior", async () => {
  await withHarness({}, async (harness) => {
    const summary = new FakeElement("summary", harness.document);
    const copyControl = new FakeElement("button", harness.document);
    copyControl.setAttribute("data-lavish-action", "copy-comment");
    harness.document.body.appendChild(summary);
    harness.document.body.appendChild(copyControl);

    for (const target of [summary, copyControl]) {
      const click = fakeEvent(target);
      const contextMenu = fakeEvent(target);
      const keyboard = fakeEvent(target, { key: "Enter" });
      harness.document.dispatch("click", click);
      harness.document.dispatch("contextmenu", contextMenu);
      harness.document.dispatch("keydown", keyboard);
      assert.equal(click.defaultPrevented, false);
      assert.equal(contextMenu.defaultPrevented, false);
      assert.equal(keyboard.defaultPrevented, false);
    }
  });
});
