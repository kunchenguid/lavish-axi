// Shared fake-DOM harness for the chrome client. Both chrome-client test files boot the real
// src/chrome-client.js against this, so it must satisfy the WHOLE boot path, not just the
// surface a given test touches - a second, thinner harness silently rots the moment the
// client reaches for an API it does not implement.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

import { createChromeHtml } from "../../src/server.js";

const sourceUrl = new URL("../../src/chrome-client.js", import.meta.url);

// Deep-copies a value out of the vm realm so node:assert's deep-equality works across the sandbox
// boundary. `instanceof Map` is false across realms, so Maps are duck-typed on constructor.name.
function toHost(val) {
  if (val === null || val === undefined) return val;
  if (Array.isArray(val)) return Array.from(val, toHost);
  if (typeof val === "object") {
    if (val.constructor && val.constructor.name === "Map") {
      const m = new Map();
      for (const [k, v] of /** @type {Map<unknown, unknown>} */ (val)) m.set(toHost(k), toHost(v));
      return m;
    }
    const o = /** @type {Record<string, unknown>} */ ({});
    for (const k of Object.keys(val)) o[k] = toHost(val[k]);
    return o;
  }
  return val;
}

// The subset of selector syntax the chrome client actually queries with: comma-separated groups of
// one or more `.class` tokens, each optionally ending in a single `:not(.class)`. renderChat clears
// old bubbles with ".bubble.user,.bubble.agent:not(.agent-working)", so a matcher that understands
// only a lone `.class` silently matches nothing and the chat log accumulates every render.
function matchesClassSelector(node, selector) {
  if (typeof selector !== "string") return false;
  const classes = String(node.className || "")
    .split(/\s+/)
    .filter(Boolean);
  return selector.split(",").some((group) => {
    const trimmed = group.trim();
    if (!trimmed.startsWith(".")) return false;
    const not = /:not\(\.([A-Za-z0-9_-]+)\)$/.exec(trimmed);
    const excluded = not ? not[1] : null;
    const required = (not ? trimmed.slice(0, not.index) : trimmed).split(".").filter(Boolean);
    if (required.length === 0) return false;
    return required.every((name) => classes.includes(name)) && (!excluded || !classes.includes(excluded));
  });
}

/** @param {Function} fn */
function wrapVmFn(fn) {
  return /** @type {typeof fn} */ (
    function (...args) {
      return toHost(fn(...args));
    }
  );
}

// The ids the served chrome page actually declares. The client reaches for these by id, so a page
// that stopped declaring one would leave the corresponding feature silently dead behind an
// `if (element)` guard - a harness that invents an element for any id would never notice.
const servedChromeIds = new Set(
  [...createChromeHtml({ key: "abc", file: "/tmp/artifact.html" }).matchAll(/\sid="([^"]+)"/g)].map(
    (match) => match[1],
  ),
);

/** @typedef {{ key: string, file: string, layoutGateEnabled?: boolean, layoutGateMaxHoldMs?: number, modeToggleHotkeyKey?: string, initialLayoutWarnings?: any[], chromeLoadToken?: string, initialArtifactRevision?: number, initialArtifactLoadToken?: string, initialArtifactLoadSequence?: number, attachmentMaxBytes?: number, attachmentMaxCount?: number, attachmentAcceptedMime?: string[], initialEnded?: boolean, initialEndedBy?: string | null, initialChat?: any[] }} HarnessSessionData */
/** @type {HarnessSessionData} */
export const defaultSessionData = {
  key: "abc",
  file: "/tmp/artifact.html",
  modeToggleHotkeyKey: "i",
  attachmentAcceptedMime: ["image/png", "image/jpeg", "image/webp"],
};

export async function createChromeHarness({
  fetchImpl = /** @type {(url?: any, init?: any) => Promise<any>} */ (
    async () => ({ ok: true, json: async () => ({}) })
  ),
  sessionData = defaultSessionData,
  artifactSrc = "",
  storage = new Map(),
  beginLoadResponses = [],
  handoffResponses = [],
  storedQueue = null,
  // Opt-in frozen clock. `reloadChromeAfterServerRestart` waits on wall-clock deadlines, so a
  // test that needs one to expire has to own `Date.now()` rather than sleep through it.
  fakeClock = false,
  // Opt-in phone-width viewport: installs a `window.matchMedia` whose single query answers the
  // chrome's sheet breakpoint, with `setMobile` flipping it the way a resize would. Left off, the
  // window has no matchMedia at all, which is the desktop the other tests run against.
  mobile = false,
} = {}) {
  const source = await readFile(sourceUrl, "utf8");
  // Seed sessionStorage before the client boots, to model a tab whose queue was
  // already persisted by an earlier page load.
  if (storedQueue) storage.set(`lavish-axi:queued:${sessionData.key}`, JSON.stringify(storedQueue));
  const postedToFrame = [];
  const postedToWhiteboard = [];
  const inlineWhiteboards = [];
  const eventSources = [];
  const windowListeners = new Map();
  const documentListeners = new Map();
  const elements = new Map();
  const timers = new Map();
  const srcLoads = [];
  const beginRequests = [];
  const artifactBeginRequests = [];
  const focusLog = [];
  let activeElement = null;
  let nextTimerId = 1;
  let reloadCount = 0;
  let artifactRevision = 0;

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
  }

  function runTimers(ms) {
    for (const timer of [...timers.values()]) {
      if (ms !== undefined && timer.ms !== ms) continue;
      timers.delete(timer.id);
      timer.fn();
    }
  }

  function element(id) {
    if (elements.has(id)) return elements.get(id);
    const listeners = new Map();
    const classes = new Set();
    const el = {
      id,
      hidden: false,
      disabled: false,
      checked: false,
      indeterminate: false,
      type: "",
      className: "",
      value: "",
      // Assigning "" is how the client empties a container it then re-appends into, and a real DOM
      // drops the existing children with it. Modelling that is load-bearing: without it a stale
      // child survives every repaint here, so a pane that failed to repaint would still look right.
      _innerHTML: "",
      get innerHTML() {
        return this._innerHTML;
      },
      set innerHTML(value) {
        this._innerHTML = value;
        if (value === "") this.children.length = 0;
      },
      textContent: "",
      scrollTop: 0,
      scrollHeight: 0,
      scrolledIntoView: null,
      dataset: {},
      children: [],
      onclick: null,
      onchange: null,
      classList: {
        add(...names) {
          for (const name of names) classes.add(name);
        },
        remove(...names) {
          for (const name of names) classes.delete(name);
        },
        toggle(name, force) {
          const enabled = force === undefined ? !classes.has(name) : Boolean(force);
          if (enabled) classes.add(name);
          else classes.delete(name);
          return enabled;
        },
        contains(name) {
          return classes.has(name);
        },
        toString() {
          return [...classes].join(" ");
        },
      },
      style: {},
      setAttribute(name, value) {
        this[name] = String(value);
      },
      addEventListener(type, handler) {
        listeners.set(type, handler);
      },
      dispatch(type, event = {}) {
        const handler = listeners.get(type);
        if (handler) handler(event);
      },
      querySelectorAll(selector) {
        const matches = [];
        const walk = (node) => {
          for (const child of node.children || []) {
            if (matchesClassSelector(child, selector)) matches.push(child);
            walk(child);
          }
        };
        walk(this);
        return matches;
      },
      querySelector(selector) {
        if (selector !== "span") return this.querySelectorAll(selector)[0] || null;
        const childId = `${id}:span`;
        if (!elements.has(childId)) element(childId);
        return elements.get(childId);
      },
      contains(node) {
        let current = node;
        while (current) {
          if (current === this) return true;
          current = current.parentElement;
        }
        return false;
      },
      appendChild(child) {
        // Appending a node that is already in the tree moves it, as the real DOM does; a harness
        // that duplicated it would hide a re-append that reorders the panel.
        const existing = child.parentElement;
        if (existing) existing.children = existing.children.filter((node) => node !== child);
        child.parentElement = this;
        this.children.push(child);
        this.lastAppendedChild = child;
        return child;
      },
      replaceChildren(...next) {
        for (const child of this.children) child.parentElement = null;
        this.children = [];
        for (const child of next) this.appendChild(child);
      },
      click(event = {}) {
        this.clicked = true;
        if (typeof this.onclick === "function") return this.onclick(event);
        return undefined;
      },
      remove() {
        const parent = this.parentElement;
        if (!parent) return;
        parent.children = parent.children.filter((child) => child !== this);
        this.parentElement = null;
      },
      focus() {
        this.focused = true;
        activeElement = this;
        focusLog.push(this.id);
      },
      select() {},
      scrollIntoView(options) {
        this.scrolledIntoView = options;
      },
      listeners,
    };
    elements.set(id, el);
    return el;
  }

  element("lavish-session").textContent = JSON.stringify(sessionData);
  const frame = element("artifact");
  frame.dataset.artifactSrc = artifactSrc;
  Object.defineProperty(frame, "src", {
    get() {
      return this.currentSrc || "";
    },
    set(value) {
      this.currentSrc = String(value);
      srcLoads.push({ src: this.currentSrc, hadMessageListener: windowListeners.has("message") });
    },
  });
  frame.contentWindow = {
    postMessage(message) {
      postedToFrame.push(message);
    },
  };
  // The served chrome nests these inside the composer, and drag handling reads
  // that containment to decide whether a pointer actually left the drop target.
  for (const childId of ["chatInput", "chatAttachments", "chatAttachInput", "chatAttach"]) {
    element(childId).parentElement = element("chatComposer");
  }
  element("chatComposer").parentElement = element("panel");
  element("panelScroll").parentElement = element("panel");
  element("whiteboardOverlay").hidden = true;
  element("layoutGateBypass").hidden = true;
  element("shareDialog").hidden = true;
  element("moreMenu").hidden = true;
  element("warningsDrawer").hidden = true;
  const whiteboardFrame = element("whiteboardFrame");
  whiteboardFrame.contentWindow = {
    postMessage(message) {
      postedToWhiteboard.push(message);
    },
  };

  const harnessFetch = async (url, init) => {
    if (String(url).includes("/chrome-loads/begin")) {
      beginRequests.push({ url, init });
      if (handoffResponses.length > 0) return handoffResponses.shift();
      return {
        ok: true,
        json: async () => ({ chrome_load_token: "harness-chrome-refresh", artifact_revision: artifactRevision }),
      };
    }
    if (String(url).includes("/artifact-loads/begin")) {
      artifactBeginRequests.push({ url, init });
      if (beginLoadResponses.length > 0) return beginLoadResponses.shift();
      artifactRevision += 1;
      return {
        ok: true,
        json: async () => ({
          artifact_revision: artifactRevision,
          artifact_load_token: `harness-load-${artifactRevision}`,
        }),
      };
    }
    return fetchImpl(url, init);
  };

  let clockNow = Date.now();
  const context = {
    // Test seam: src/chrome-client.js fills this in so the pure threading helpers can be
    // exercised directly instead of only through rendered DOM.
    __lavishTest: { threading: {} },
    AbortController,
    clearTimeout: fakeClearTimeout,
    console,
    ...(fakeClock ? { Date: { now: () => clockNow, parse: Date.parse } } : {}),
    fetch: harnessFetch,
    location: {
      reload() {
        reloadCount += 1;
      },
    },
    navigator: {},
    setTimeout: fakeSetTimeout,
    URL: {
      createObjectURL() {
        return "blob:lavish-test";
      },
      revokeObjectURL() {},
    },
    EventSource: class FakeEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        eventSources.push(this);
      }

      addEventListener(type, handler) {
        this.listeners.set(type, handler);
      }
    },
    document: {
      body: element("body"),
      get activeElement() {
        return activeElement;
      },
      getElementById(id) {
        // Answer only for ids the served page declares, so an id the client and the page disagree
        // on fails here the way it would go dead in a browser.
        if (!servedChromeIds.has(id) && !elements.has(id)) return null;
        return element(id);
      },
      addEventListener(type, handler, capture) {
        if (!documentListeners.has(type)) documentListeners.set(type, []);
        documentListeners.get(type).push({ handler, capture: Boolean(capture) });
      },
      createElement(tag) {
        const el = element(`${tag}-${elements.size}`);
        el.tagName = tag.toUpperCase();
        return el;
      },
      execCommand() {
        return true;
      },
    },
    sessionStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      },
      removeItem(key) {
        storage.delete(key);
      },
    },
    window: {
      clearTimeout: fakeClearTimeout,
      setTimeout: fakeSetTimeout,
      addEventListener(type, handler) {
        if (!windowListeners.has(type)) windowListeners.set(type, []);
        windowListeners.get(type).push(handler);
      },
    },
  };
  const mediaQueries = [];
  if (mobile) {
    context.window.matchMedia = (query) => {
      const list = {
        media: query,
        matches: true,
        changeHandlers: [],
        addEventListener(type, handler) {
          if (type === "change") this.changeHandlers.push(handler);
        },
      };
      mediaQueries.push(list);
      return list;
    };
  }

  vm.runInNewContext(source, context, { filename: "chrome-client.js" });
  await flushPromises();
  if (artifactSrc) frame.dispatch("load");

  function frameLoadToken() {
    const match = String(frame.src).match(/[?&]artifact_load_token=([^&]+)/);
    return match ? decodeURIComponent(match[1]) : "";
  }

  return {
    element,
    threading() {
      const raw = context.__lavishTest.threading;
      const wrapped = /** @type {Record<string, Function>} */ ({});
      for (const k of Object.keys(raw)) {
        const v = raw[k];
        wrapped[k] = typeof v === "function" ? wrapVmFn(v) : v;
      }
      return wrapped;
    },
    threadingOpen(id) {
      return context.__lavishTest.openThread(id);
    },
    threadingReplyTo(id, text) {
      return context.__lavishTest.setThreadReplyTarget(id, text);
    },
    threadingBuildBubble(message, opts) {
      return context.__lavishTest.buildBubble(message, opts);
    },
    threadingOrdered() {
      return toHost(context.__lavishTest.orderedMessages());
    },
    threadingUnread(rootId) {
      return context.__lavishTest.threadUnreadCount(rootId);
    },
    // The pills are written with innerHTML, which this DOM does not parse into children, so the
    // close button's own click handler is unreachable here; call what that handler calls.
    removeQueuedPrompt(index) {
      return context.__lavishTest.removeQueuedPrompt(index);
    },
    // The joined innerHTML of every direct child of #chatLog.
    chatLogHtml() {
      return element("chatLog")
        .children.map((c) => c.innerHTML || "")
        .join("");
    },
    frame,
    postedToFrame,
    postedToWhiteboard,
    createInlineWhiteboard() {
      const posted = [];
      // A real inline whiteboard frame is created by the SDK inside the
      // artifact document, so its window's parent is the artifact window.
      const source = {
        parent: frame.contentWindow,
        postMessage(message) {
          posted.push(message);
        },
      };
      const whiteboard = { source, posted };
      inlineWhiteboards.push(whiteboard);
      return whiteboard;
    },
    // A window that is not a child of the artifact frame: an attacker page that
    // framed this chrome, or one holding a window.open handle to it. Such a
    // window is top-level, so its `parent` is itself.
    createForeignWindow() {
      const posted = [];
      /** @type {any} */
      const source = {
        postMessage(message) {
          posted.push(message);
        },
      };
      source.parent = source;
      return { source, posted };
    },
    eventSource() {
      assert.equal(eventSources.length, 1);
      return eventSources[0];
    },
    sendFrameMessage(data) {
      const handlers = windowListeners.get("message") || [];
      assert.ok(handlers.length > 0, "chrome-client registered a message handler");
      // Sent verbatim: what the test writes is what the chrome receives. Callers
      // modeling a genuine SDK message must stamp artifact_load_token themselves
      // (chrome.artifactLoadToken()) - the real SDK does on every postMessage, and
      // a harness that patches it in silently passes even when the real send omits
      // the token (that is exactly how the token-less attachment upload shipped).
      for (const handler of handlers) handler({ source: frame.contentWindow, data });
    },
    sendWhiteboardMessage(data) {
      const handlers = windowListeners.get("message") || [];
      assert.ok(handlers.length > 0, "chrome-client registered a message handler");
      for (const handler of handlers) handler({ source: whiteboardFrame.contentWindow, data });
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
    dispatchDocumentEvent(type, eventProps = {}) {
      const event = {
        defaultPrevented: false,
        ...eventProps,
        preventDefault() {
          this.defaultPrevented = true;
        },
      };
      for (const { handler } of documentListeners.get(type) || []) handler(event);
      return event;
    },
    queued() {
      return JSON.parse(storage.get("lavish-axi:queued:abc") || "[]");
    },
    reloadCount() {
      return reloadCount;
    },
    focusLog,
    storage,
    warningRows() {
      return element("warningsList").children.filter((child) => String(child.className).startsWith("warning-row"));
    },
    dispatchDocumentMousedown(target) {
      for (const { handler } of documentListeners.get("mousedown") || []) handler({ target });
    },
    runTimers,
    advanceClock(ms) {
      clockNow += ms;
    },
    srcLoads,
    beginRequests,
    artifactBeginRequests,
    artifactLoadToken: frameLoadToken,
    mediaQueries,
    setMobile(matches) {
      for (const list of mediaQueries) {
        list.matches = matches;
        for (const handler of list.changeHandlers) handler({ matches });
      }
    },
    // A pointer gesture on the conversation dock, as the browser would deliver it: one pointer
    // id from down to up, with the y travel the test names.
    dragDock(fromY, toY, { pointerId = 1 } = {}) {
      const head = element("panelHead");
      head.dispatch("pointerdown", { pointerId, clientY: fromY, button: 0 });
      head.dispatch("pointermove", { pointerId, clientY: fromY + (toY - fromY) / 2 });
      head.dispatch("pointermove", { pointerId, clientY: toY });
      head.dispatch("pointerup", { pointerId, clientY: toY });
      // A completed pointer sequence is followed by a click on the same target.
      head.dispatch("click", {});
    },
    cancelDock(fromY, moveY, cancelY, { pointerId = 1 } = {}) {
      const head = element("panelHead");
      head.dispatch("pointerdown", { pointerId, clientY: fromY, button: 0 });
      head.dispatch("pointermove", { pointerId, clientY: moveY });
      head.dispatch("pointercancel", { pointerId, clientY: cancelY });
    },
  };
}

// One whole begin-load attempt that fails: the request plus both in-call transport retries.
export async function exhaustOneBeginLoadAttempt(chrome) {
  await flushPromises();
  chrome.runTimers(100);
  await flushPromises();
  chrome.runTimers(300);
  await flushPromises();
}

export function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}
