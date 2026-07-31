import assert from "node:assert/strict";
import vm from "node:vm";
import { JSDOM } from "jsdom";

import { buildChromeClient } from "../../scripts/build-chrome-client.js";

/** @typedef {{ key: string, file: string, layoutGateEnabled?: boolean, layoutGateMaxHoldMs?: number, modeToggleHotkeyKey?: string, initialChat?: Array<{ role: string, text: string }> }} HarnessSessionData */
/** @type {HarnessSessionData} */
export const defaultSessionData = { key: "abc", file: "/tmp/artifact.html", modeToggleHotkeyKey: "i" };

let chromeClientSourcePromise;

async function chromeClientSource() {
  chromeClientSourcePromise ??= buildChromeClient({ write: false }).then((result) => {
    assert.equal(result.outputFiles?.length, 1, "expected one in-memory chrome client bundle");
    return result.outputFiles[0].text;
  });
  return chromeClientSourcePromise;
}

const CHROME_IDS = [
  "lavish-session",
  "artifact",
  "panelScroll",
  "annotationPills",
  "chatLog",
  "chatInput",
  "send",
  "sendAndEnd",
  "sendHint",
  "annotation",
  "moreWrap",
  "moreButton",
  "moreMenu",
  "reloadArtifact",
  "copySnapshot",
  "exportArtifact",
  "shareArtifact",
  "copyPath",
  "copyHint",
  "copyHintText",
  "end",
  "endedOverlay",
  "presenceBanner",
  "shareDialog",
  "shareForm",
  "sharePassword",
  "sharePublish",
  "shareStatus",
  "shareResult",
  "shareUrl",
  "shareUpdateKey",
  "shareClose",
  "shareCancel",
  "copyShareUrl",
  "copyUpdateKey",
  "layoutGateOverlay",
  "layoutGateTitle",
  "layoutGateCopy",
  "layoutGateAction",
  "layoutIssueBanner",
  "whiteboardOverlay",
  "whiteboardFrame",
  "whiteboardClose",
  "whiteboardError",
];

/**
 * Instrument a real DOM node so existing harness tests can still read
 * `.listeners`, `.onclick`, `lastAppendedChild`, and `scrolledIntoView`.
 * @param {Element} el
 * @returns {any}
 */
function instrumentElement(el) {
  const node = /** @type {any} */ (el);
  if (node.__lavishInstrumented) return node;
  node.__lavishInstrumented = true;
  const listeners = new Map();
  node.listeners = listeners;
  node.scrolledIntoView = null;
  node.lastAppendedChild = null;
  node.focused = false;
  node.clicked = false;

  const originalAdd = el.addEventListener.bind(el);
  node.addEventListener = (type, handler, options) => {
    listeners.set(type, handler);
    return originalAdd(type, handler, options);
  };

  const originalAppend = el.appendChild.bind(el);
  node.appendChild = (child) => {
    node.lastAppendedChild = child;
    return originalAppend(child);
  };

  node.scrollIntoView = (options) => {
    node.scrolledIntoView = options;
  };

  const originalFocus = typeof node.focus === "function" ? node.focus.bind(el) : null;
  node.focus = () => {
    node.focused = true;
    originalFocus?.();
  };

  let onclickHandler = null;
  Object.defineProperty(node, "onclick", {
    configurable: true,
    get() {
      return onclickHandler;
    },
    set(fn) {
      onclickHandler = typeof fn === "function" ? fn : null;
      listeners.set("click", onclickHandler);
    },
  });

  const originalClick = typeof node.click === "function" ? node.click.bind(el) : null;
  node.click = (event = {}) => {
    node.clicked = true;
    if (typeof onclickHandler === "function") return onclickHandler(event);
    return originalClick?.();
  };

  // Mirror the prior fake-DOM setAttribute behavior used by tests that read
  // `el["aria-pressed"]` as a data property rather than getAttribute().
  const originalSetAttribute = el.setAttribute.bind(el);
  node.setAttribute = (name, value) => {
    originalSetAttribute(name, value);
    try {
      node[name] = String(value);
    } catch {
      // Some IDL attributes reject direct assignment; attribute still set.
    }
  };

  return node;
}

export async function createChromeHarness({
  fetchImpl = async () => ({ ok: true }),
  sessionData = defaultSessionData,
  artifactSrc = "",
} = {}) {
  const source = await chromeClientSource();
  const storage = new Map();
  const postedToFrame = [];
  const postedToWhiteboard = [];
  const inlineWhiteboards = [];
  const eventSources = [];
  const windowListeners = new Map();
  const documentListeners = new Map();
  const timers = new Map();
  const srcLoads = [];
  let nextTimerId = 1;
  let reloadCount = 0;

  const idsHtml = CHROME_IDS.map((id) => {
    if (id === "lavish-session") {
      return `<script type="application/json" id="lavish-session">${JSON.stringify(sessionData).replace(/</g, "\\u003c")}</script>`;
    }
    if (id === "artifact") {
      return `<iframe id="artifact" data-artifact-src="${artifactSrc}"></iframe>`;
    }
    if (id === "whiteboardFrame") {
      return `<iframe id="whiteboardFrame"></iframe>`;
    }
    if (id === "exportArtifact") {
      return `<button id="exportArtifact" type="button"><span>Export</span></button>`;
    }
    if (id === "chatInput") {
      return `<textarea id="chatInput"></textarea>`;
    }
    if (id === "shareForm") {
      return `<form id="shareForm"></form>`;
    }
    if (id === "sharePassword" || id === "shareUrl" || id === "shareUpdateKey") {
      return `<input id="${id}" />`;
    }
    if (id === "annotationPills" || id === "chatLog" || id === "panelScroll" || id === "body") {
      return `<div id="${id}"></div>`;
    }
    return `<div id="${id}"></div>`;
  }).join("");

  const dom = new JSDOM(`<!doctype html><html><body id="body">${idsHtml}</body></html>`, {
    url: "http://127.0.0.1/",
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });
  const { window } = dom;
  const { document } = window;

  for (const id of CHROME_IDS) {
    const el = document.getElementById(id);
    if (el) instrumentElement(el);
  }
  instrumentElement(document.body);

  function fakeSetTimeout(fn, ms) {
    const timer = {
      id: nextTimerId++,
      ms,
      fn,
      unref() {},
    };
    timers.set(timer.id, timer);
    return timer;
  }

  function fakeClearTimeout(timer) {
    if (timer && typeof timer === "object") timers.delete(timer.id);
    else if (typeof timer === "number") timers.delete(timer);
  }

  function runTimers(ms) {
    for (const timer of [...timers.values()]) {
      if (ms !== undefined && timer.ms !== ms) continue;
      timers.delete(timer.id);
      timer.fn();
    }
  }

  function element(id) {
    if (id === "body") return /** @type {any} */ (document.body);
    const el = document.getElementById(id);
    assert.ok(el, `missing chrome element #${id}`);
    return instrumentElement(el);
  }

  const frame = element("artifact");
  let currentSrc = "";
  Object.defineProperty(frame, "src", {
    configurable: true,
    get() {
      return currentSrc;
    },
    set(value) {
      currentSrc = String(value);
      srcLoads.push({ src: currentSrc, hadMessageListener: windowListeners.has("message") });
    },
  });
  const frameContentWindow = {
    postMessage(message) {
      postedToFrame.push(message);
    },
  };
  Object.defineProperty(frame, "contentWindow", {
    configurable: true,
    get() {
      return frameContentWindow;
    },
  });

  const whiteboardFrame = element("whiteboardFrame");
  let whiteboardSrc = "";
  Object.defineProperty(whiteboardFrame, "src", {
    configurable: true,
    get() {
      return whiteboardSrc;
    },
    set(value) {
      whiteboardSrc = String(value);
    },
  });
  const whiteboardContentWindow = {
    postMessage(message) {
      postedToWhiteboard.push(message);
    },
  };
  Object.defineProperty(whiteboardFrame, "contentWindow", {
    configurable: true,
    get() {
      return whiteboardContentWindow;
    },
  });

  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      eventSources.push(this);
    }

    addEventListener(type, handler) {
      this.listeners.set(type, handler);
    }
  }

  const originalDocAdd = document.addEventListener.bind(document);
  document.addEventListener = (type, handler, capture) => {
    if (!documentListeners.has(type)) documentListeners.set(type, []);
    documentListeners.get(type).push({ handler, capture: Boolean(capture) });
    return originalDocAdd(type, handler, capture);
  };

  const originalWinAdd = window.addEventListener.bind(window);
  window.addEventListener = (type, handler, options) => {
    if (!windowListeners.has(type)) windowListeners.set(type, []);
    windowListeners.get(type).push(handler);
    return originalWinAdd(type, handler, options);
  };

  window.fetch = fetchImpl;
  window.EventSource = FakeEventSource;
  window.setTimeout = fakeSetTimeout;
  window.clearTimeout = fakeClearTimeout;
  window.console = console;
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
  window.URL.createObjectURL = () => "blob:lavish-test";
  window.URL.revokeObjectURL = () => {};
  const sessionStorageShim = {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      storage.set(key, String(value));
    },
    removeItem(key) {
      storage.delete(key);
    },
  };
  Object.defineProperty(window, "sessionStorage", {
    configurable: true,
    value: sessionStorageShim,
  });

  // Instrument createElement so dynamically created bubbles track scroll/append.
  const originalCreateElement = document.createElement.bind(document);
  document.createElement = (tagName, options) => instrumentElement(originalCreateElement(tagName, options));

  // jsdom's location.reload is non-writable; run the IIFE in a sandbox that
  // shares the jsdom window/document but supplies a controllable bare `location`.
  const locationShim = {
    href: "http://127.0.0.1/",
    origin: "http://127.0.0.1",
    reload() {
      reloadCount += 1;
    },
  };
  const sandbox = {
    window,
    self: window,
    globalThis: window,
    document,
    console,
    fetch: fetchImpl,
    EventSource: FakeEventSource,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    sessionStorage: sessionStorageShim,
    navigator: window.navigator,
    URL: window.URL,
    location: locationShim,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "chrome-client.js" });
  return {
    element,
    frame,
    postedToFrame,
    postedToWhiteboard,
    createInlineWhiteboard() {
      const posted = [];
      const sourceWindow = {
        postMessage(message) {
          posted.push(message);
        },
      };
      const whiteboard = { source: sourceWindow, posted };
      inlineWhiteboards.push(whiteboard);
      return whiteboard;
    },
    eventSource() {
      assert.equal(eventSources.length, 1);
      return eventSources[0];
    },
    sendFrameMessage(data) {
      const handlers = windowListeners.get("message") || [];
      assert.ok(handlers.length > 0, "chrome-client registered a message handler");
      for (const handler of handlers) handler({ source: frameContentWindow, data });
    },
    sendWhiteboardMessage(data) {
      const handlers = windowListeners.get("message") || [];
      assert.ok(handlers.length > 0, "chrome-client registered a message handler");
      for (const handler of handlers) handler({ source: whiteboardContentWindow, data });
    },
    sendInlineWhiteboardMessage(whiteboard, data) {
      const handlers = windowListeners.get("message") || [];
      assert.ok(handlers.length > 0, "chrome-client registered a message handler");
      for (const handler of handlers) handler({ source: whiteboard.source, data });
    },
    dispatchDocumentKeydown(eventProps) {
      const handlers = documentListeners.get("keydown") || [];
      assert.ok(handlers.length > 0, "chrome-client registered a document keydown handler");
      const event = {
        key: "",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        isComposing: false,
        defaultPrevented: false,
        ...eventProps,
        preventDefault() {
          this.defaultPrevented = true;
        },
      };
      for (const { handler } of handlers) handler(event);
      return event;
    },
    queued() {
      return JSON.parse(storage.get("lavish-axi:queued:abc") || "[]");
    },
    reloadCount() {
      return reloadCount;
    },
    runTimers,
    srcLoads,
  };
}
export function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}
