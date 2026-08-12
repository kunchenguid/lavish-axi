import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const sourceUrl = new URL("../src/chrome-client.js", import.meta.url);

import { UI_CLIENTE } from "../src/i18n-ptbr.js";

/** @typedef {{ key: string, file: string, layoutGateEnabled?: boolean, layoutGateMaxHoldMs?: number, modeToggleHotkeyKey?: string, initialLayoutWarnings?: any[], initialChat?: Array<{ role: string, text: string }>, chromeLoadToken?: string, initialArtifactRevision?: number, initialArtifactLoadToken?: string, initialArtifactLoadSequence?: number, i18n?: Record<string, string> }} HarnessSessionData */
// dealernet: o servidor sempre injeta os textos de interface no bootstrap da sessao, e o cliente
// os le como `t`. O harness precisa injetar os MESMOS textos reais (nao um dublê), senao os testes
// exercitam um cliente sem idioma — e uma chamada como `t.revelarNoArtefato.replace(...)` estoura.
/** @type {HarnessSessionData} */
const defaultSessionData = {
  key: "abc",
  file: "/tmp/artifact.html",
  modeToggleHotkeyKey: "i",
  i18n: UI_CLIENTE,
};

async function createChromeHarness({
  fetchImpl = /** @type {(url?: any, init?: any) => Promise<any>} */ (
    async () => ({ ok: true, json: async () => ({}) })
  ),
  sessionData = defaultSessionData,
  artifactSrc = "",
  storage = new Map(),
  beginLoadResponses = [],
  handoffResponses = [],
  compactViewport = false,
} = {}) {
  const source = await readFile(sourceUrl, "utf8");
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
      innerHTML: "",
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
      style: {
        setProperty(name, value) {
          this[name] = String(value);
        },
        getPropertyValue(name) {
          return this[name] || "";
        },
      },
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
            if (typeof selector === "string" && selector.startsWith(".")) {
              if (
                String(child.className || "")
                  .split(/\s+/)
                  .includes(selector.slice(1))
              )
                matches.push(child);
            }
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

  // dealernet: o servidor SEMPRE injeta os textos de interface; o harness faz o mesmo por baixo,
  // para que um teste que sobrescreva sessionData nao perca o idioma sem querer.
  element("lavish-session").textContent = JSON.stringify({ i18n: UI_CLIENTE, ...sessionData });
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
  element("whiteboardOverlay").hidden = true;
  element("shareDialog").hidden = true;
  element("actionPanel").hidden = true;
  element("endedOverlay").hidden = true;
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

  const context = {
    clearTimeout: fakeClearTimeout,
    console,
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
      getElementById(id) {
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
      matchMedia() {
        return { matches: compactViewport };
      },
      addEventListener(type, handler) {
        if (!windowListeners.has(type)) windowListeners.set(type, []);
        windowListeners.get(type).push(handler);
      },
    },
  };

  vm.runInNewContext(source, context, { filename: "chrome-client.js" });
  await flushPromises();
  if (artifactSrc) frame.dispatch("load");

  function frameLoadToken() {
    const match = String(frame.src).match(/[?&]artifact_load_token=([^&]+)/);
    return match ? decodeURIComponent(match[1]) : "";
  }

  return {
    element,
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
      const message =
        artifactSrc && !Object.hasOwn(data || {}, "artifact_load_token")
          ? { ...data, artifact_load_token: frameLoadToken() }
          : data;
      for (const handler of handlers) handler({ source: frame.contentWindow, data: message });
    },
    sendForeignMessage(source, data) {
      const handlers = windowListeners.get("message") || [];
      assert.ok(handlers.length > 0, "chrome-client registered a message handler");
      for (const handler of handlers) handler({ source, data });
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
    srcLoads,
    beginRequests,
    artifactBeginRequests,
    artifactLoadToken: frameLoadToken,
  };
}

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

function descendants(root) {
  const result = [];
  const visit = (node) => {
    for (const child of node.children || []) {
      result.push(child);
      visit(child);
    }
  };
  visit(root);
  return result;
}

test("chrome client re-handshakes once after a missing reviewer handoff", async () => {
  const chrome = await createChromeHarness({
    artifactSrc: "/artifact/abc/index.html",
    sessionData: {
      ...defaultSessionData,
      chromeLoadToken: "expired-handoff",
      initialArtifactRevision: 1,
      initialArtifactLoadToken: "old-load",
    },
    beginLoadResponses: [{ ok: false, status: 409, json: async () => ({ status: "no-handoff" }) }],
    handoffResponses: [
      {
        ok: true,
        json: async () => ({
          chrome_load_token: "fresh-handoff",
          artifact_revision: 1,
          artifact_load_token: "",
          artifact_load_sequence: 0,
        }),
      },
    ],
  });
  await flushPromises();
  await flushPromises();

  assert.equal(chrome.beginRequests.length, 1);
  assert.equal(chrome.artifactBeginRequests.length, 2);
  assert.match(chrome.artifactBeginRequests[0].init.body, /expired-handoff/);
  assert.match(chrome.artifactBeginRequests[1].init.body, /fresh-handoff/);
  assert.equal(chrome.element("handoffBanner").hidden, true);
});

test("chrome client surfaces a superseded reviewer without re-handshaking", async () => {
  const chrome = await createChromeHarness({
    artifactSrc: "/artifact/abc/index.html",
    sessionData: { ...defaultSessionData, chromeLoadToken: "old-handoff" },
    beginLoadResponses: [{ ok: false, status: 409, json: async () => ({ status: "superseded" }) }],
  });
  await flushPromises();
  await flushPromises();

  assert.equal(chrome.beginRequests.length, 0);
  assert.equal(chrome.artifactBeginRequests.length, 1);
  assert.equal(chrome.element("handoffBanner").hidden, false);
  chrome.element("handoffTakeover").click();
  assert.equal(chrome.reloadCount(), 1);
});

test("stale re-handshake responses cannot overwrite a newer load", async () => {
  /** @type {((value: any) => void) | undefined} */
  let resolveOldHandoff;
  const oldHandoffJson = new Promise((resolve) => {
    resolveOldHandoff = resolve;
  });
  const chrome = await createChromeHarness({
    artifactSrc: "/artifact/abc/index.html",
    sessionData: {
      ...defaultSessionData,
      chromeLoadToken: "old-handoff",
      initialArtifactRevision: 1,
      initialArtifactLoadToken: "old-load",
    },
    beginLoadResponses: [
      { ok: false, status: 409, json: async () => ({ status: "no-handoff" }) },
      { ok: false, status: 409, json: async () => ({ status: "no-handoff" }) },
    ],
    handoffResponses: [
      { ok: true, json: async () => oldHandoffJson },
      {
        ok: true,
        json: async () => ({
          chrome_load_token: "new-handoff",
          artifact_revision: 1,
          artifact_load_token: "",
          artifact_load_sequence: 0,
        }),
      },
    ],
  });

  await flushPromises();
  chrome.eventSource().listeners.get("reload")();
  await flushPromises();
  await flushPromises();

  assert.ok(resolveOldHandoff);
  resolveOldHandoff({
    chrome_load_token: "old-recovery",
    artifact_revision: 1,
    artifact_load_token: "",
    artifact_load_sequence: 0,
  });
  await flushPromises();
  await flushPromises();

  chrome.element("reloadArtifact").click();
  await flushPromises();
  await flushPromises();

  const lastRequest = chrome.artifactBeginRequests.at(-1);
  assert.match(lastRequest.init.body, /new-handoff/);
  assert.doesNotMatch(lastRequest.init.body, /old-recovery/);
  assert.equal(chrome.element("handoffBanner").hidden, true);
});

test("chrome client replaces queued prompts with the same internal key", async () => {
  const chrome = await createChromeHarness();

  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "Use plan A", selector: "input#plan-a", tag: "choice", text: "Plan A", _lavishQueueKey: "plan" },
  });
  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "Use plan B", selector: "input#plan-b", tag: "choice", text: "Plan B", _lavishQueueKey: "plan" },
  });
  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "Apply dark mode", selector: "button#dark", tag: "choice", text: "Dark" },
  });

  assert.deepEqual(
    chrome.queued().map((prompt) => prompt.prompt),
    ["Use plan B", "Apply dark mode"],
  );
  assert.match(chrome.element("annotationPills").innerHTML, /Use plan B/);
  assert.doesNotMatch(chrome.element("annotationPills").innerHTML, /Use plan A/);
  assert.match(chrome.element("annotationPills").innerHTML, />Alvo</);
  assert.match(chrome.element("annotationPills").innerHTML, />Instrução</);
  assert.doesNotMatch(chrome.element("annotationPills").innerHTML, />Target|>Prompt/);
});

test("chrome client scrolls new chat bubbles into view above queued prompts", async () => {
  const chrome = await createChromeHarness();
  const panelScroll = chrome.element("panelScroll");
  panelScroll.scrollHeight = 1800;

  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "Review the title", selector: "h1", tag: "annotation", text: "Title" },
  });
  assert.equal(panelScroll.scrollTop, 1800);

  panelScroll.scrollTop = 640;
  chrome.eventSource().listeners.get("agent-reply")({
    data: JSON.stringify({ text: "I updated the title." }),
  });

  const bubble = chrome.element("chatLog").lastAppendedChild;
  assert.match(bubble.innerHTML, /<small>Agente<\/small>/);
  assert.doesNotMatch(bubble.innerHTML, /<small>Agent<\/small>/);
  assert.equal(bubble.scrolledIntoView.block, "nearest");
  assert.equal(bubble.scrolledIntoView.inline, "nearest");
  assert.equal(panelScroll.scrollTop, 640);
});

test("chrome client renders chat roles and working state in pt-BR", async () => {
  const chrome = await createChromeHarness({
    sessionData: {
      ...defaultSessionData,
      initialChat: [
        { role: "user", text: "Revise o título" },
        { role: "agent", text: "Vou revisar" },
      ],
    },
  });

  assert.match(chrome.element("chatLog").children[0].innerHTML, /<small>Você<\/small>/);
  assert.match(chrome.element("chatLog").children[1].innerHTML, /<small>Agente<\/small>/);
  chrome.eventSource().listeners.get("agent-presence")({ data: JSON.stringify({ state: "working" }) });
  assert.match(chrome.element("chatLog").lastAppendedChild.innerHTML, /Trabalhando\.\.\./);
});

function warningPayload(overrides = {}) {
  return {
    id: "w1",
    fingerprint: "w1",
    rule: "page-horizontal-overflow",
    severity: "error",
    status: "open",
    status_label: "Aberto",
    title: "A pagina rola para o lado",
    explanation: "The page is 18px wider than the 720px viewport, so content sits off-screen.",
    selector: "html",
    component: "html",
    axis: "horizontal",
    overflow_px: 18,
    viewport_class: "compact",
    viewport_label: "Tablet / compacto",
    viewport_width: 720,
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    last_seen_revision: 1,
    queued_at: "",
    queue_attempts: 0,
    active: true,
    selectable: true,
    outstanding: false,
    history: [],
    ...overrides,
  };
}

function diagnosticsHarness(warningsByCall) {
  const posts = [];
  let call = 0;
  return {
    posts,
    fetchImpl: async (url, init) => {
      const body = init && init.body ? JSON.parse(init.body) : null;
      posts.push({ url, body, method: init?.method || "GET" });
      const warnings = warningsByCall[Math.min(call, warningsByCall.length - 1)] || [];
      call += 1;
      return { ok: true, json: async () => ({ warnings, prompt: null }) };
    },
  };
}

test("chrome client posts a completed diagnostic pass and never queues feedback from it", async () => {
  const { posts, fetchImpl } = diagnosticsHarness([[warningPayload()]]);
  const chrome = await createChromeHarness({ fetchImpl });

  chrome.sendFrameMessage({
    type: "lavish:layoutDiagnostics",
    artifact_revision: 7,
    complete: true,
    target_presence_complete: true,
    viewport_width: 720,
    findings: [{ selector: "html", kind: "page-horizontal-overflow", overflowPx: 18, severity: "error" }],
  });
  await flushPromises();

  const diagnostics = posts.filter((post) => post.url === "/api/abc/layout-diagnostics");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].body.artifact_revision, 7);
  assert.equal(diagnostics[0].body.complete, true);
  assert.equal(diagnostics[0].body.target_presence_complete, true);
  assert.equal(diagnostics[0].body.viewport_width, 720);
  assert.equal(diagnostics[0].body.findings.length, 1);
  // Detection must never touch the prompt queue.
  assert.equal(
    posts.some((post) => post.url === "/api/abc/prompts"),
    false,
  );
  assert.deepEqual(chrome.queued(), []);
});

test("a failed diagnostic pass reports its incompleteness rather than an empty result", async () => {
  const { posts, fetchImpl } = diagnosticsHarness([[warningPayload({ status: "unverified" })]]);
  const chrome = await createChromeHarness({ fetchImpl });

  chrome.sendFrameMessage({ type: "lavish:layoutDiagnostics", complete: false, viewport_width: 720, findings: [] });
  await flushPromises();

  assert.equal(posts[0].body.complete, false);
  assert.equal(chrome.element("warningsWrap").hidden, false);
  assert.equal(chrome.element("layoutGateOverlay").hidden, false);
});

test("warning-only observations are discarded before they reach the server", async () => {
  const { posts, fetchImpl } = diagnosticsHarness([[]]);
  await createChromeHarness({ fetchImpl });

  const chrome = await createChromeHarness({ fetchImpl });
  chrome.sendFrameMessage({
    type: "lavish:layoutDiagnostics",
    complete: true,
    viewport_width: 720,
    findings: [
      { selector: ".card", kind: "clipped-text", overflowPx: 2, severity: "warning" },
      { selector: ".unproven", kind: "clipped-text", overflowPx: 200 },
    ],
  });
  await flushPromises();

  assert.deepEqual(posts.at(-1).body.findings, []);
});

test("the warning button hides at zero and shows a deduplicated unresolved count", async () => {
  const chrome = await createChromeHarness();

  assert.equal(chrome.element("warningsWrap").hidden, true, "no button without unresolved work");

  chrome.eventSource().listeners.get("layout-warnings")({
    data: JSON.stringify({ warnings: [warningPayload(), warningPayload({ id: "w2", selector: "p" })] }),
  });

  assert.equal(chrome.element("warningsWrap").hidden, false);
  assert.equal(chrome.element("warningsCount").textContent, "2");
  assert.equal(chrome.element("warningsButton")["aria-label"], "2 problemas de layout em aberto");
  assert.equal(chrome.warningRows().length, 2);

  // The same warnings arriving again must not inflate anything.
  chrome.eventSource().listeners.get("layout-warnings")({
    data: JSON.stringify({ warnings: [warningPayload(), warningPayload({ id: "w2", selector: "p" })] }),
  });
  assert.equal(chrome.element("warningsCount").textContent, "2");
  assert.equal(chrome.warningRows().length, 2);
});

test("resolved warnings drop out of the active count and hide the button", async () => {
  const chrome = await createChromeHarness();
  const source = chrome.eventSource().listeners.get("layout-warnings");

  source({ data: JSON.stringify({ warnings: [warningPayload()] }) });
  assert.equal(chrome.element("warningsWrap").hidden, false);

  source({
    data: JSON.stringify({ warnings: [warningPayload({ status: "resolved", active: false, selectable: false })] }),
  });
  assert.equal(chrome.element("warningsWrap").hidden, true);
  assert.equal(chrome.element("warningsCount").textContent, "0");
});

test("nothing is selected by default and Select all is an explicit action", async () => {
  const chrome = await createChromeHarness();
  chrome.eventSource().listeners.get("layout-warnings")({
    data: JSON.stringify({ warnings: [warningPayload(), warningPayload({ id: "w2" })] }),
  });

  assert.equal(chrome.element("warningsSelectAll").checked, false);
  assert.equal(chrome.element("warningsSelected").textContent, "Nenhum selecionado");
  assert.equal(chrome.element("warningsQueueButton").disabled, true);
  for (const row of chrome.warningRows()) {
    assert.equal(row.children[0].checked, false);
  }

  chrome.element("warningsSelectAll").checked = true;
  chrome.element("warningsSelectAll").onchange();
  assert.equal(chrome.element("warningsSelected").textContent, "2 selecionado(s)");
  assert.equal(chrome.element("warningsQueueButton").disabled, false);
});

test("layout warning metadata shown to the user is entirely in pt-BR", async () => {
  const chrome = await createChromeHarness();
  const now = Date.now();
  chrome.eventSource().listeners.get("layout-warnings")({
    data: JSON.stringify({
      warnings: [
        warningPayload(),
        warningPayload({ id: "w2", last_seen_at: new Date(now - 2 * 60_000).toISOString() }),
        warningPayload({ id: "w3", last_seen_at: new Date(now - 2 * 60 * 60_000).toISOString() }),
        warningPayload({ id: "w4", last_seen_at: new Date(now - 2 * 24 * 60 * 60_000).toISOString() }),
      ],
    }),
  });

  assert.deepEqual(
    chrome.warningRows().map((row) => row.children[1].children[2].children.map((chip) => chip.textContent)),
    [
      ["Grave", "Aberto", "Tablet / compacto · 720px", "Visto agora"],
      ["Grave", "Aberto", "Tablet / compacto · 720px", "Visto há 2 min"],
      ["Grave", "Aberto", "Tablet / compacto · 720px", "Visto há 2 h"],
      ["Grave", "Aberto", "Tablet / compacto · 720px", "Visto há 2 d"],
    ],
  );
});

test("layout warning target fallback is shown in pt-BR", async () => {
  const chrome = await createChromeHarness();
  chrome.eventSource().listeners.get("layout-warnings")({
    data: JSON.stringify({ warnings: [warningPayload({ selector: "" })] }),
  });

  const [row] = chrome.warningRows();
  assert.equal(row.children[1].children[3].textContent, "(página inteira)");
});

test("queueing a selected subset produces exactly one ordinary prompt with only those warnings", async () => {
  const posts = [];
  const queuedWarnings = [
    warningPayload({ status: "queued", status_label: "Correcao pedida", selectable: false, outstanding: true }),
    warningPayload({ id: "w2", selector: "p" }),
  ];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init) => {
      posts.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
      return {
        ok: true,
        json: async () => ({
          status: "queued",
          queued_count: 1,
          warnings: queuedWarnings,
          prompt: {
            prompt: "Fix this layout issue the browser detected in this artifact:\n1. [w1] ...",
            text: "Layout issue: 1 selected",
            target: { type: "layout-warnings", warnings: [{ id: "w1", rule: "page-horizontal-overflow" }] },
          },
        }),
      };
    },
  });
  chrome.eventSource().listeners.get("layout-warnings")({
    data: JSON.stringify({ warnings: [warningPayload(), warningPayload({ id: "w2", selector: "p" })] }),
  });

  const [first] = chrome.warningRows();
  first.children[0].checked = true;
  first.children[0].dispatch("change");
  assert.equal(chrome.element("warningsSelected").textContent, "1 selecionado(s)");

  await chrome.element("warningsQueueButton").onclick();
  await flushPromises();

  const queueCall = posts.find((post) => post.url === "/api/abc/layout-warnings/queue");
  assert.deepEqual(queueCall.body, { ids: ["w1"] });

  const queued = chrome.queued();
  assert.equal(queued.length, 1, "one ordinary queued prompt");
  assert.equal(queued[0].tag, "layout-warnings");
  assert.equal(queued[0].target.warnings.length, 1);
  assert.equal(queued[0].target.warnings[0].id, "w1");

  // Queueing does not clear the warning; it stays counted and becomes unselectable.
  assert.equal(chrome.element("warningsCount").textContent, "2");
  assert.equal(chrome.warningRows()[0].children[0].disabled, true);
  assert.equal(chrome.warningRows()[0].children[1].children.at(-1).children.at(-1).disabled, true);
  assert.equal(chrome.warningRows()[0].children[1].children[2].children[1].textContent, "Na fila para envio");
  assert.equal(chrome.element("warningsSelected").textContent, "Nenhum selecionado");
});

test("a stale queued layout prompt remains available for user re-decision", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init = {}) => {
      posts.push({ url, body: init.body ? JSON.parse(init.body) : null });
      if (url.endsWith("/layout-warnings/queue")) {
        return {
          ok: true,
          json: async () => ({
            queued_count: 1,
            warnings: [warningPayload()],
            prompt: {
              prompt: "Fix this layout issue",
              text: "Layout issue: 1 selected",
              target: { type: "layout-warnings", artifact_revision: 1, warnings: [{ id: "w1" }] },
            },
          }),
        };
      }
      if (url.endsWith("/prompts")) {
        return {
          ok: false,
          status: 409,
          json: async () => ({ warnings: [warningPayload({ status: "recurring", status_label: "Ainda presente" })] }),
        };
      }
      return { ok: true, json: async () => ({}) };
    },
  });
  chrome.eventSource().listeners.get("layout-warnings")({
    data: JSON.stringify({ warnings: [warningPayload()] }),
  });

  const [row] = chrome.warningRows();
  row.children[0].checked = true;
  row.children[0].dispatch("change");
  await chrome.element("warningsQueueButton").onclick();
  chrome.sendFrameMessage({ type: "lavish:snapshot", snapshot: "" });
  await flushPromises();

  assert.ok(posts.some((post) => post.url === "/api/abc/prompts"));
  assert.equal(chrome.queued().length, 1);
  assert.equal(chrome.warningRows()[0].children[1].children[2].children[1].textContent, "Na fila para envio");
});

test("dismissing a warning asks the server and never clears it locally on failure", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init) => {
      posts.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
      return { ok: false, json: async () => ({}) };
    },
  });
  chrome.eventSource().listeners.get("layout-warnings")({
    data: JSON.stringify({ warnings: [warningPayload()] }),
  });

  const [row] = chrome.warningRows();
  const dismiss = row.children[1].children.at(-1).children.at(-1);
  dismiss.dispatch("click");
  await flushPromises();

  assert.ok(posts.some((post) => post.url === "/api/abc/layout-warnings/dismiss" && post.body.id === "w1"));
  assert.equal(chrome.element("warningsCount").textContent, "1", "a failed dismissal must not look like a resolution");
});

test("Reveal asks the artifact iframe to highlight the affected element", async () => {
  const chrome = await createChromeHarness();
  chrome.eventSource().listeners.get("layout-warnings")({
    data: JSON.stringify({ warnings: [warningPayload({ selector: "p#copy" })] }),
  });

  const [row] = chrome.warningRows();
  const reveal = row.children[1].children.at(-1).children[0];
  reveal.dispatch("click");

  const revealMessage = chrome.postedToFrame.at(-1);
  assert.equal(revealMessage.type, "lavish:revealElement");
  assert.equal(revealMessage.selector, "p#copy");
});

test("the drawer manages focus and closes on Escape", async () => {
  const chrome = await createChromeHarness();
  chrome.eventSource().listeners.get("layout-warnings")({
    data: JSON.stringify({ warnings: [warningPayload()] }),
  });

  assert.equal(chrome.element("warningsDrawer").hidden, true);
  chrome.element("warningsButton").click();
  assert.equal(chrome.element("warningsDrawer").hidden, false);
  assert.equal(chrome.element("warningsButton")["aria-expanded"], "true");
  assert.equal(chrome.focusLog.at(-1), "warningsSelectAll", "focus moves into the drawer");

  chrome.dispatchDocumentKeydown({ key: "Escape" });
  assert.equal(chrome.element("warningsDrawer").hidden, true);
  assert.equal(chrome.element("warningsButton")["aria-expanded"], "false");
  assert.equal(chrome.focusLog.at(-1), "warningsButton", "focus returns to the trigger");
});

test("a click outside the drawer closes it", async () => {
  const chrome = await createChromeHarness();
  chrome.eventSource().listeners.get("layout-warnings")({
    data: JSON.stringify({ warnings: [warningPayload()] }),
  });
  chrome.element("warningsButton").click();
  assert.equal(chrome.element("warningsDrawer").hidden, false);

  chrome.dispatchDocumentMousedown(chrome.element("chatInput"));
  assert.equal(chrome.element("warningsDrawer").hidden, true);
});

test("warning state and selection survive a chrome reload of the same session", async () => {
  const first = await createChromeHarness();
  first.eventSource().listeners.get("layout-warnings")({
    data: JSON.stringify({ warnings: [warningPayload(), warningPayload({ id: "w2" })] }),
  });
  const [row] = first.warningRows();
  row.children[0].checked = true;
  row.children[0].dispatch("change");
  assert.equal(first.element("warningsSelected").textContent, "1 selecionado(s)");

  // A browser refresh re-bootstraps from the server, and the chrome's own selection is restored
  // from per-session storage.
  const reloaded = await createChromeHarness({
    storage: first.storage,
    sessionData: {
      key: "abc",
      file: "/tmp/artifact.html",
      modeToggleHotkeyKey: "i",
      initialLayoutWarnings: [warningPayload(), warningPayload({ id: "w2" })],
    },
  });
  assert.equal(reloaded.element("warningsCount").textContent, "2");
  assert.equal(reloaded.element("warningsSelected").textContent, "1 selecionado(s)");
});

test("warning state does not leak across review sessions", async () => {
  const first = await createChromeHarness();
  first.eventSource().listeners.get("layout-warnings")({
    data: JSON.stringify({ warnings: [warningPayload()] }),
  });
  const [row] = first.warningRows();
  row.children[0].checked = true;
  row.children[0].dispatch("change");

  const other = await createChromeHarness({
    storage: first.storage,
    sessionData: { key: "zzz", file: "/tmp/other.html", modeToggleHotkeyKey: "i" },
  });
  assert.equal(other.element("warningsWrap").hidden, true);
  assert.equal(other.element("warningsSelected").textContent, "Nenhum selecionado");
});

test("chrome client surfaces export warnings from the server response", async () => {
  const chrome = await createChromeHarness({
    fetchImpl: async () => ({
      ok: true,
      headers: {
        get(name) {
          if (name.toLowerCase() === "x-lavish-export-warning-count") return "1";
          return null;
        },
      },
      blob: async () => ({}),
    }),
  });

  await chrome.element("exportArtifact").onclick();
  await flushPromises();

  assert.equal(
    chrome.element("exportArtifact").querySelector("span").textContent,
    "Exportado com 1 recurso não resolvido",
  );
});

test("chrome client narrates export progress in pt-BR", async () => {
  /** @type {(value: any) => void} */
  let finishExport;
  const response = new Promise((resolve) => {
    finishExport = resolve;
  });
  const chrome = await createChromeHarness({ fetchImpl: async () => response });

  const exporting = chrome.element("exportArtifact").onclick();
  assert.equal(chrome.element("exportArtifact").querySelector("span").textContent, "Exportando...");

  finishExport({
    ok: true,
    headers: { get: () => "0" },
    blob: async () => ({}),
  });
  await exporting;
});

test("chrome client surfaces export notices from the server response", async () => {
  const chrome = await createChromeHarness({
    fetchImpl: async () => ({
      ok: true,
      headers: {
        get(name) {
          if (name.toLowerCase() === "x-lavish-export-warning-count") return "0";
          if (name.toLowerCase() === "x-lavish-export-notice-count") return "1";
          return null;
        },
      },
      blob: async () => ({}),
    }),
  });

  await chrome.element("exportArtifact").onclick();
  await flushPromises();

  assert.equal(chrome.element("exportArtifact").querySelector("span").textContent, "Exportado com 1 aviso");
});

test("chrome client includes export notices alongside unresolved assets", async () => {
  const chrome = await createChromeHarness({
    fetchImpl: async () => ({
      ok: true,
      headers: {
        get(name) {
          if (name.toLowerCase() === "x-lavish-export-warning-count") return "2";
          if (name.toLowerCase() === "x-lavish-export-notice-count") return "1";
          return null;
        },
      },
      blob: async () => ({}),
    }),
  });

  await chrome.element("exportArtifact").onclick();
  await flushPromises();

  assert.equal(
    chrome.element("exportArtifact").querySelector("span").textContent,
    "Exportado com 2 recursos não resolvidos e 1 aviso",
  );
});

test("chrome client registers message listener before loading the artifact iframe", async () => {
  const chrome = await createChromeHarness({ artifactSrc: "/artifact/abc/index.html" });

  assert.equal(chrome.srcLoads.length, 1);
  assert.match(chrome.srcLoads[0].src, /^\/artifact\/abc\/index\.html\?artifact_revision=\d+&artifact_load_token=/);
  assert.equal(chrome.srcLoads[0].hadMessageListener, true);
});

test("the layout gate reveals after a completed pass with no findings", async () => {
  const { posts, fetchImpl } = diagnosticsHarness([[]]);
  const chrome = await createChromeHarness({ fetchImpl });

  assert.equal(chrome.element("layoutGateOverlay").hidden, false);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), true);

  chrome.sendFrameMessage({ type: "lavish:layoutDiagnostics", complete: true, viewport_width: 720, findings: [] });
  await flushPromises();

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), false);
  assert.equal(posts[0].url, "/api/abc/layout-diagnostics");
  assert.deepEqual(posts[0].body.findings, []);
});

// The gate used to hold the artifact hostage until an agent repaired the finding. Triage is the
// user's now, so a completed pass always reveals and hands the result to the inbox.
test("the layout gate reveals on severe findings and points at the inbox instead of holding", async () => {
  const { fetchImpl } = diagnosticsHarness([[warningPayload()]]);
  const chrome = await createChromeHarness({ fetchImpl });

  chrome.sendFrameMessage({
    type: "lavish:layoutDiagnostics",
    complete: true,
    viewport_width: 720,
    findings: [{ selector: "html", kind: "page-horizontal-overflow", overflowPx: 18, severity: "error" }],
  });
  await flushPromises();

  assert.equal(chrome.element("layoutGateOverlay").hidden, true, "the user sees the artifact");
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), false);
  assert.equal(chrome.element("warningsWrap").hidden, false);
});

test("layout gate timeout fails open when no result arrives", async () => {
  const chrome = await createChromeHarness({
    sessionData: { key: "abc", file: "/tmp/artifact.html", layoutGateMaxHoldMs: 25 },
  });

  chrome.runTimers(25);

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), false);
});

test("layout gate re-arms on reload and still reveals on the next completed pass", async () => {
  const { fetchImpl } = diagnosticsHarness([[], [warningPayload()]]);
  const chrome = await createChromeHarness({
    fetchImpl,
    sessionData: { key: "abc", file: "/tmp/artifact.html", layoutGateMaxHoldMs: 25 },
  });

  chrome.runTimers(25);
  assert.equal(chrome.element("layoutGateOverlay").hidden, true);

  chrome.eventSource().listeners.get("reload")();
  assert.equal(chrome.element("layoutGateOverlay").hidden, false);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), true);

  chrome.sendFrameMessage({
    type: "lavish:layoutDiagnostics",
    complete: true,
    viewport_width: 720,
    findings: [{ selector: "html", kind: "page-horizontal-overflow", overflowPx: 18, severity: "error" }],
  });
  await flushPromises();

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
});

test("a stale prior-document diagnostic cannot reveal the new gate or clear its probe", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init = {}) => {
      posts.push({ url, body: init.body ? JSON.parse(init.body) : null });
      if (url === "/api/abc/layout-diagnostics") {
        return { ok: true, json: async () => ({ status: "stale", warnings: [] }) };
      }
      return { ok: true, json: async () => ({}) };
    },
    sessionData: { key: "abc", file: "/tmp/artifact.html", layoutGateMaxHoldMs: 25 },
    artifactSrc: "/artifact/abc/index.html",
  });

  const oldToken = chrome.artifactLoadToken();
  chrome.runTimers(25);
  chrome.eventSource().listeners.get("reload")();
  await flushPromises();
  chrome.sendFrameMessage({
    artifact_load_token: oldToken,
    type: "lavish:layoutDiagnostics",
    artifact_revision: 1,
    complete: true,
    viewport_width: 720,
    findings: [],
  });
  await flushPromises();

  assert.equal(
    posts.some((post) => post.url === "/api/abc/layout-diagnostics"),
    false,
  );
  assert.equal(chrome.element("layoutGateOverlay").hidden, false);
  chrome.frame.dispatch("load");
  chrome.sendFrameMessage({
    artifact_load_token: oldToken,
    type: "lavish:layoutDiagnostics",
    artifact_revision: 1,
    complete: true,
    viewport_width: 720,
    findings: [],
  });
  await flushPromises();
  chrome.runTimers(8000);
  await flushPromises();
  assert.ok(posts.some((post) => post.url.includes("/artifact/abc/index.html?") && post.url.includes("probe=1")));
});

test("a failed begin-load keeps the previous frame until a retry succeeds", async () => {
  const beginLoadResponses = [];
  const posts = [];
  const chrome = await createChromeHarness({
    artifactSrc: "/artifact/abc/index.html",
    beginLoadResponses,
    fetchImpl: async (url, init = {}) => {
      posts.push({ url, body: init.body ? JSON.parse(init.body) : null });
      return { ok: true, json: async () => ({}) };
    },
  });

  const previousSrc = chrome.frame.src;
  beginLoadResponses.push(
    { ok: false, status: 503 },
    { ok: true, json: async () => ({ artifact_revision: 2, artifact_load_token: "retry-load" }) },
  );
  chrome.eventSource().listeners.get("reload")();
  await flushPromises();
  assert.equal(chrome.frame.src, previousSrc);

  chrome.runTimers(100);
  await flushPromises();
  assert.match(chrome.frame.src, /artifact_load_token=retry-load/);
  assert.equal(
    posts.some((post) => post.url === "/api/abc/artifact-failures"),
    false,
  );
});

test("exhausted begin-load retries preserve the previous frame without waking the agent", async () => {
  const beginLoadResponses = [];
  const posts = [];
  const chrome = await createChromeHarness({
    artifactSrc: "/artifact/abc/index.html",
    beginLoadResponses,
    fetchImpl: async (url, init = {}) => {
      posts.push({ url, body: init.body ? JSON.parse(init.body) : null });
      return { ok: true, json: async () => ({}) };
    },
  });

  const previousSrc = chrome.frame.src;
  const previousToken = chrome.artifactLoadToken();
  beginLoadResponses.push({ ok: false, status: 503 }, { ok: false, status: 503 }, { ok: false, status: 503 });
  chrome.eventSource().listeners.get("reload")();
  await flushPromises();
  chrome.runTimers(100);
  await flushPromises();
  chrome.runTimers(300);
  await flushPromises();

  assert.equal(chrome.frame.src, previousSrc);
  assert.equal(chrome.artifactLoadToken(), previousToken);
  assert.equal(
    posts.some((post) => post.url === "/api/abc/artifact-failures"),
    false,
  );
});

test("a current load token accepts artifact messages before the frame load event", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    artifactSrc: "/artifact/abc/index.html",
    fetchImpl: async (url, init = {}) => {
      posts.push({ url, body: init.body ? JSON.parse(init.body) : null });
      return { ok: true, json: async () => ({}) };
    },
  });

  chrome.eventSource().listeners.get("reload")();
  await flushPromises();
  const currentToken = chrome.artifactLoadToken();
  chrome.sendFrameMessage({
    artifact_load_token: currentToken,
    type: "lavish:artifactAssetFailure",
    detail: "current asset before load",
  });
  await flushPromises();

  assert.equal(posts.filter((post) => post.url === "/api/abc/artifact-failures").length, 1);
  chrome.frame.dispatch("load");
});

test("a pre-load diagnostic silences the probe even while its response is delayed", async () => {
  const posts = [];
  /** @type {(() => void) | undefined} */
  let releaseDiagnostic;
  const chrome = await createChromeHarness({
    artifactSrc: "/artifact/abc/index.html",
    fetchImpl: (url, init = {}) => {
      posts.push({ url, body: init.body ? JSON.parse(init.body) : null });
      if (url === "/api/abc/layout-diagnostics") {
        return new Promise((resolve) => {
          releaseDiagnostic = () => resolve({ ok: true, json: async () => ({ warnings: [] }) });
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    },
  });

  chrome.eventSource().listeners.get("reload")();
  await flushPromises();
  chrome.sendFrameMessage({ type: "lavish:layoutDiagnostics", complete: true, findings: [] });
  await flushPromises();
  chrome.frame.dispatch("load");
  chrome.runTimers(8000);

  assert.equal(
    posts.some((post) => post.url.includes("/artifact/abc/index.html?") && post.url.includes("probe=1")),
    false,
  );
  assert.ok(releaseDiagnostic);
  releaseDiagnostic();
  await flushPromises();
});

test("stale artifact messages are ignored until the current frame load", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    artifactSrc: "/artifact/abc/index.html",
    fetchImpl: async (url, init = {}) => {
      posts.push({ url, body: init.body ? JSON.parse(init.body) : null });
      return { ok: true, json: async () => ({}) };
    },
  });

  const oldToken = chrome.artifactLoadToken();
  chrome.eventSource().listeners.get("reload")();
  await flushPromises();
  chrome.sendFrameMessage({
    artifact_load_token: oldToken,
    type: "lavish:reviewState",
    state: { card: { selector: "h1", text: "stale" } },
  });
  chrome.sendFrameMessage({ artifact_load_token: oldToken, type: "lavish:scroll", x: 8, y: 44 });
  chrome.sendFrameMessage({
    artifact_load_token: oldToken,
    type: "lavish:artifactAssetFailure",
    detail: "stale asset",
  });
  await flushPromises();

  assert.equal(
    posts.some((post) => post.url === "/api/abc/artifact-failures"),
    false,
  );
  chrome.frame.dispatch("load");
  assert.equal(
    chrome.postedToFrame.some((message) => message.type === "lavish:restoreReviewState"),
    false,
  );
  const restoredScroll = chrome.postedToFrame.filter((message) => message.type === "lavish:restoreScroll").at(-1);
  assert.equal(restoredScroll.x, 0);
  assert.equal(restoredScroll.y, 0);

  chrome.sendFrameMessage({ type: "lavish:artifactAssetFailure", detail: "current asset" });
  await flushPromises();
  assert.equal(posts.filter((post) => post.url === "/api/abc/artifact-failures").length, 1);
});

test("a delayed diagnostic response does not delay silencing the artifact probe", async () => {
  const posts = [];
  /** @type {(() => void) | undefined} */
  let releaseDiagnostic;
  const chrome = await createChromeHarness({
    artifactSrc: "/artifact/abc/index.html",
    fetchImpl: (url, init = {}) => {
      posts.push({ url, body: init.body ? JSON.parse(init.body) : null });
      if (url === "/api/abc/layout-diagnostics") {
        return new Promise((resolve) => {
          releaseDiagnostic = () => resolve({ ok: true, json: async () => ({ warnings: [] }) });
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    },
  });

  chrome.sendFrameMessage({ type: "lavish:layoutDiagnostics", complete: true, viewport_width: 1440, findings: [] });
  await flushPromises();
  chrome.runTimers(8000);
  await flushPromises();

  assert.equal(
    posts.some((post) => post.url.includes("/artifact/abc/index.html?") && post.url.includes("probe=1")),
    false,
  );
  assert.ok(releaseDiagnostic);
  releaseDiagnostic();
  await flushPromises();
  assert.equal(
    posts.some((post) => post.url.includes("/artifact/abc/index.html?") && post.url.includes("probe=1")),
    false,
  );
});

test("a stale artifact probe cannot report failure after a reload", async () => {
  const posts = [];
  /** @type {(() => void) | undefined} */
  let releaseProbe;
  const chrome = await createChromeHarness({
    artifactSrc: "/artifact/abc/index.html",
    fetchImpl: (url, init = {}) => {
      posts.push({ url, body: init.body ? JSON.parse(init.body) : null });
      if (String(url).includes("/artifact/abc/index.html?") && String(url).includes("probe=1")) {
        return new Promise((resolve) => {
          releaseProbe = () => resolve({ ok: false, status: 503 });
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    },
  });

  chrome.runTimers(8000);
  await flushPromises();
  assert.equal(
    posts.filter((post) => post.url.includes("/artifact/abc/index.html?") && post.url.includes("probe=1")).length,
    1,
  );

  chrome.eventSource().listeners.get("reload")();
  await flushPromises();
  assert.ok(releaseProbe);
  releaseProbe();
  await flushPromises();

  assert.equal(
    posts.some((post) => post.url === "/api/abc/artifact-failures"),
    false,
  );
});

test("a delayed older diagnostic response cannot repaint the inbox", async () => {
  const posts = [];
  const releases = [];
  const chrome = await createChromeHarness({
    fetchImpl: (url, init = {}) => {
      posts.push({ url, body: init.body ? JSON.parse(init.body) : null });
      if (url !== "/api/abc/layout-diagnostics") return Promise.resolve({ ok: true, json: async () => ({}) });
      const requestIndex = releases.length;
      return new Promise((resolve) => {
        releases.push(() =>
          resolve({
            ok: true,
            json: async () => ({ warnings: [warningPayload({ id: requestIndex === 0 ? "old" : "new" })] }),
          }),
        );
      });
    },
  });

  chrome.sendFrameMessage({ type: "lavish:layoutDiagnostics", complete: true, findings: [] });
  chrome.sendFrameMessage({ type: "lavish:layoutDiagnostics", complete: true, findings: [] });
  releases[1]();
  await flushPromises();
  assert.deepEqual(
    chrome.warningRows().map((row) => row.dataset.warningId),
    ["new"],
  );

  releases[0]();
  await flushPromises();
  assert.deepEqual(
    chrome.warningRows().map((row) => row.dataset.warningId),
    ["new"],
  );
  assert.equal(posts.filter((post) => post.url === "/api/abc/layout-diagnostics").length, 2);
});

test("layout gate manual override reveals immediately", async () => {
  const chrome = await createChromeHarness();

  chrome.element("layoutGateAction").onclick();

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), false);
});

test("layout gate manual override stays bypassed on reload", async () => {
  const chrome = await createChromeHarness();

  chrome.element("layoutGateAction").onclick();
  chrome.eventSource().listeners.get("reload")();

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), false);
});

test("layout gate stays skipped when the session disables it", async () => {
  const { fetchImpl } = diagnosticsHarness([[warningPayload()]]);
  const chrome = await createChromeHarness({
    fetchImpl,
    sessionData: { key: "abc", file: "/tmp/artifact.html", layoutGateEnabled: false },
  });

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), false);

  chrome.sendFrameMessage({
    type: "lavish:layoutDiagnostics",
    complete: true,
    viewport_width: 720,
    findings: [{ selector: "html", kind: "page-horizontal-overflow", overflowPx: 18, severity: "error" }],
  });
  await flushPromises();

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("warningsWrap").hidden, false, "the inbox still surfaces the finding");
});

test("a zero-warning review keeps the top bar unchanged", async () => {
  const { posts, fetchImpl } = diagnosticsHarness([[]]);
  const chrome = await createChromeHarness({ fetchImpl });

  chrome.sendFrameMessage({ type: "lavish:layoutDiagnostics", complete: true, viewport_width: 1440, findings: [] });
  await flushPromises();

  assert.equal(chrome.element("warningsWrap").hidden, true);
  assert.equal(
    posts.some((post) => post.url === "/api/abc/prompts"),
    false,
  );
});

test("chrome client strips the internal queue key before posting prompts", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return { ok: true };
    },
  });

  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "Use plan B", selector: "input#plan-b", tag: "choice", text: "Plan B", _lavishQueueKey: "plan" },
  });
  chrome.element("send").onclick();
  assert.equal(chrome.postedToFrame.at(-1).type, "lavish:requestSnapshot");

  chrome.sendFrameMessage({ type: "lavish:snapshot", snapshot: "uid=1 body" });
  await flushPromises();

  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, "/api/abc/prompts");
  assert.deepEqual(posts[0].body, {
    prompts: [{ prompt: "Use plan B", selector: "input#plan-b", tag: "choice", text: "Plan B" }],
    domSnapshot: "uid=1 body",
  });
  assert.equal(chrome.queued().length, 0);
});

test("artifact action panel renders one safe sidebar surface and returns field values once", async () => {
  const chrome = await createChromeHarness();

  chrome.sendFrameMessage({
    type: "lavish:registerActionPanel",
    panel: {
      schema: "lavish-action-panel-v1",
      id: "dealernet-gate1",
      title: '<img src=x onerror="window.compromised=true">Decisão do Gate 1',
      description: "Escolha o destino desta revisão.",
      hideGenericSendAndEnd: true,
      fields: [
        {
          id: "adjustment_text",
          type: "textarea",
          label: "Ajustes solicitados",
          help: "Obrigatório para Solicitar ajustes.",
          placeholder: "Descreva os ajustes necessários",
          maxLength: 4000,
        },
      ],
      actions: [
        { id: "approve", label: "Aprovar", tone: "primary" },
        { id: "adjust", label: "Solicitar ajustes", tone: "neutral", requires: ["adjustment_text"] },
        { id: "abort", label: "Abortar demanda", tone: "danger" },
      ],
    },
  });

  const panel = chrome.element("actionPanel");
  assert.equal(panel.hidden, false);
  assert.equal(chrome.element("sendAndEnd").hidden, true);
  const nodes = descendants(panel);
  assert.equal(nodes.find((node) => node.tagName === "H2").textContent.includes("<img"), true);
  assert.equal(
    nodes.some((node) => node.innerHTML.includes("<img")),
    false,
    "artifact strings are never parsed as HTML",
  );
  assert.deepEqual(
    nodes.filter((node) => node.tagName === "BUTTON").map((node) => node.textContent),
    ["Aprovar", "Solicitar ajustes", "Abortar demanda"],
  );
  const textarea = nodes.find((node) => node.tagName === "TEXTAREA");
  assert.ok(textarea);
  assert.equal(textarea.maxLength, 4000);
  assert.equal(textarea.placeholder, "Descreva os ajustes necessários");
  assert.equal(textarea["aria-invalid"], "true");
  const fieldError = nodes.find((node) => node.className === "action-panel-error");
  assert.equal(fieldError.hidden, false);
  assert.equal(fieldError.textContent, "Preencha o campo obrigatório.");
  textarea.value = "Detalhar a concorrência";
  textarea.dispatch("input");
  assert.equal(textarea["aria-invalid"], "false");
  assert.equal(fieldError.hidden, true);

  const approve = nodes.find((node) => node.dataset.actionPanelAction === "approve");
  approve.click();
  approve.click();

  const invocations = chrome.postedToFrame.filter((message) => message.type === "lavish:actionPanelInvoke");
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].panelId, "dealernet-gate1");
  assert.equal(invocations[0].actionId, "approve");
  assert.deepEqual(JSON.parse(JSON.stringify(invocations[0].values)), {
    adjustment_text: "Detalhar a concorrência",
  });
  assert.equal(
    nodes.filter((node) => node.tagName === "BUTTON").every((node) => node.disabled),
    true,
  );
});

test("compact Gate keeps the same sidebar DOM with Gate and conversation open", async () => {
  const chrome = await createChromeHarness({ compactViewport: true });
  chrome.element("conversationSection").open = true;
  chrome.sendFrameMessage({
    type: "lavish:registerActionPanel",
    panel: {
      schema: "lavish-action-panel-v1",
      id: "dealernet-gate1",
      title: "Decisão do Gate 1",
      actions: [{ id: "approve", label: "Aprovar", tone: "primary" }],
    },
  });

  assert.equal(chrome.element("conversationSection").open, true);
  assert.equal(chrome.element("actionPanel").hidden, false);

  chrome.element("conversationSection").open = true;
  chrome.sendFrameMessage({
    type: "lavish:registerActionPanel",
    panel: {
      schema: "lavish-action-panel-v1",
      id: "dealernet-gate1",
      title: "Decisão do Gate 1 atualizada",
      actions: [{ id: "approve", label: "Aprovar", tone: "primary" }],
    },
  });
  assert.equal(chrome.element("conversationSection").open, true, "hot reload preserves the user's section choice");
});

test("only current artifact metrics can size the compact document frame", async () => {
  const chrome = await createChromeHarness({ artifactSrc: "/artifact/abc/index.html", compactViewport: true });
  const token = chrome.artifactLoadToken();

  chrome.sendFrameMessage({ type: "lavish:artifactMetrics", height: 2468 });
  assert.equal(chrome.frame.style.getPropertyValue("--lavish-artifact-height"), "2468px");

  const foreign = chrome.createForeignWindow();
  chrome.sendForeignMessage(foreign.source, {
    type: "lavish:artifactMetrics",
    height: 9999,
    artifact_load_token: token,
  });
  assert.equal(chrome.frame.style.getPropertyValue("--lavish-artifact-height"), "2468px");

  chrome.sendFrameMessage({ type: "lavish:artifactMetrics", height: Number.POSITIVE_INFINITY });
  assert.equal(chrome.frame.style.getPropertyValue("--lavish-artifact-height"), "2468px");

  chrome.sendFrameMessage({ type: "lavish:artifactMetrics", height: 2_000_000 });
  assert.equal(chrome.frame.style.getPropertyValue("--lavish-artifact-height"), "1000000px");
});

test("accepted hot reload removes stale Gate actions and restores its fields only after re-registration", async () => {
  const chrome = await createChromeHarness({ artifactSrc: "/artifact/abc/index.html", compactViewport: true });
  const panel = {
    schema: "lavish-action-panel-v1",
    id: "dealernet-gate1",
    title: "Decisão do Gate 1",
    hideGenericSendAndEnd: true,
    fields: [{ id: "adjustment_text", type: "textarea", label: "Ajustes", maxLength: 4000 }],
    actions: [{ id: "adjust", label: "Solicitar ajustes", tone: "neutral", requires: ["adjustment_text"] }],
  };
  chrome.sendFrameMessage({ type: "lavish:registerActionPanel", panel });
  const firstTextarea = descendants(chrome.element("actionPanel")).find((node) => node.tagName === "TEXTAREA");
  firstTextarea.value = "Preservar entre versões válidas.";
  firstTextarea.dispatch("input");
  chrome.element("conversationSection").open = true;

  chrome.eventSource().listeners.get("reload")();
  await flushPromises();
  await flushPromises();

  assert.equal(chrome.element("actionPanel").hidden, true);
  assert.equal(descendants(chrome.element("actionPanel")).length, 0);
  assert.equal(chrome.element("sendAndEnd").hidden, false);

  chrome.sendFrameMessage({ type: "lavish:registerActionPanel", panel });
  const restored = descendants(chrome.element("actionPanel")).find((node) => node.tagName === "TEXTAREA");
  assert.equal(restored.value, "Preservar entre versões válidas.");
  assert.equal(chrome.element("conversationSection").open, true, "reload does not override the user's section choice");
});

test("malformed persisted action-panel values cannot break registration", async () => {
  const storage = new Map([["lavish-axi:action-panel:abc:dealernet-gate1", "null"]]);
  const chrome = await createChromeHarness({ storage });

  chrome.sendFrameMessage({
    type: "lavish:registerActionPanel",
    panel: {
      schema: "lavish-action-panel-v1",
      id: "dealernet-gate1",
      title: "Decisão do Gate 1",
      fields: [{ id: "adjustment_text", type: "textarea", label: "Ajustes", maxLength: 4000 }],
      actions: [{ id: "approve", label: "Aprovar", tone: "primary" }],
    },
  });

  const textarea = descendants(chrome.element("actionPanel")).find((node) => node.tagName === "TEXTAREA");
  assert.equal(textarea.value, "");
  assert.equal(chrome.element("actionPanel").hidden, false);
});

test("artifact action panel applies declarative state and recovers only the matching invocation", async () => {
  const chrome = await createChromeHarness();
  chrome.sendFrameMessage({
    type: "lavish:registerActionPanel",
    panel: {
      schema: "lavish-action-panel-v1",
      id: "dealernet-gate1",
      title: "Decisão do Gate 1",
      hideGenericSendAndEnd: true,
      fields: [{ id: "adjustment_text", type: "textarea", label: "Ajustes", maxLength: 4000 }],
      actions: [
        { id: "approve", label: "Aprovar", tone: "primary" },
        { id: "adjust", label: "Solicitar ajustes", tone: "neutral", requires: ["adjustment_text"] },
        { id: "abort", label: "Abortar demanda", tone: "danger" },
      ],
    },
  });
  chrome.sendFrameMessage({
    type: "lavish:updateActionPanel",
    panelId: "dealernet-gate1",
    state: {
      summary: "Falta responder: D2.",
      status: "Revise as escolhas antes de enviar.",
      actions: { approve: { disabled: true, reason: "Responda D2." } },
    },
  });

  const nodes = descendants(chrome.element("actionPanel"));
  const summary = nodes.find((node) => node.className === "action-panel-summary");
  const status = nodes.find((node) => node.className === "action-panel-status");
  const approve = nodes.find((node) => node.dataset.actionPanelAction === "approve");
  const adjust = nodes.find((node) => node.dataset.actionPanelAction === "adjust");
  const abort = nodes.find((node) => node.dataset.actionPanelAction === "abort");
  const textarea = nodes.find((node) => node.tagName === "TEXTAREA");
  assert.equal(summary.textContent, "Falta responder: D2.");
  assert.equal(status.textContent, "Revise as escolhas antes de enviar.");
  assert.equal(approve.disabled, true);
  assert.equal(approve.title, "Responda D2.");
  assert.equal(adjust.disabled, true);
  assert.equal(abort.disabled, false);

  textarea.value = "Acrescentar evidência concorrente.";
  textarea.dispatch("input");
  assert.equal(adjust.disabled, false);

  chrome.eventSource().listeners.get("agent-presence")({ data: JSON.stringify({ state: "working" }) });
  assert.equal(
    [approve, adjust, abort].every((button) => button.disabled),
    true,
  );
  chrome.eventSource().listeners.get("agent-presence")({ data: JSON.stringify({ state: "listening" }) });
  assert.equal(approve.disabled, true, "the artifact-owned disable remains after the agent becomes available");
  assert.equal(adjust.disabled, false);
  assert.equal(abort.disabled, false);

  abort.click();
  const invocation = chrome.postedToFrame.find((message) => message.type === "lavish:actionPanelInvoke");
  assert.ok(invocation);
  chrome.sendFrameMessage({
    type: "lavish:actionPanelResult",
    panelId: "dealernet-gate1",
    invocationId: "stale-invocation",
    ok: false,
    error: "Resposta antiga.",
  });
  assert.equal(abort.disabled, true, "a stale result cannot unlock a newer action");

  chrome.sendFrameMessage({
    type: "lavish:actionPanelResult",
    panelId: "dealernet-gate1",
    invocationId: invocation.invocationId,
    ok: false,
    error: "Falha de rede; tente novamente.",
  });
  assert.equal(status.textContent, "Falha de rede; tente novamente.");
  assert.equal(approve.disabled, true);
  assert.equal(adjust.disabled, false);
  assert.equal(abort.disabled, false);
  assert.equal(textarea.value, "Acrescentar evidência concorrente.");
});

test("chrome send and end carries the end intent with queued prompts", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init = {}) => {
      posts.push({ url, body: init.body ? JSON.parse(init.body) : null });
      return { ok: true };
    },
  });

  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "Ship this", selector: "button#ship", tag: "choice", text: "Ship" },
  });
  chrome.element("sendAndEnd").onclick();
  assert.equal(chrome.postedToFrame.at(-1).type, "lavish:requestSnapshot");

  chrome.sendFrameMessage({ type: "lavish:snapshot", snapshot: "uid=1 body" });
  await flushPromises();
  await flushPromises();

  assert.deepEqual(
    posts.map((post) => post.url),
    ["/api/abc/prompts"],
  );
  assert.deepEqual(posts[0].body, {
    prompts: [{ prompt: "Ship this", selector: "button#ship", tag: "choice", text: "Ship" }],
    domSnapshot: "uid=1 body",
    endSession: true,
  });
  assert.equal(chrome.queued().length, 0);
  assert.equal(chrome.element("chatInput").disabled, true);
});

test("artifact terminal send ends atomically instead of leaving the chrome working", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init = {}) => {
      posts.push({ url, body: init.body ? JSON.parse(init.body) : null });
      return { ok: true };
    },
  });

  chrome.sendFrameMessage({
    type: "lavish:registerActionPanel",
    panel: {
      schema: "lavish-action-panel-v1",
      id: "dealernet-gate1",
      title: "Decisão do Gate 1",
      fields: [{ id: "adjustment_text", type: "textarea", label: "Ajustes", maxLength: 4000 }],
      actions: [
        {
          id: "approve",
          label: "Aprovar",
          tone: "primary",
          successMessage: "Decisão de aprovação enviada. A revisão foi encerrada.",
        },
      ],
    },
  });
  const panelNodes = descendants(chrome.element("actionPanel"));
  const textarea = panelNodes.find((node) => node.tagName === "TEXTAREA");
  textarea.value = "Texto transitório";
  textarea.dispatch("input");
  panelNodes.find((node) => node.dataset.actionPanelAction === "approve").click();

  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "Approve this contract", selector: "", tag: "dealernet-gate1", text: "Gate 1" },
  });
  chrome.sendFrameMessage({ type: "lavish:sendQueuedPrompts", endSession: true, requestId: "gate-1" });
  assert.equal(chrome.postedToFrame.at(-1).type, "lavish:requestSnapshot");

  chrome.sendFrameMessage({ type: "lavish:snapshot", snapshot: "uid=1 body" });
  await flushPromises();
  await flushPromises();

  assert.deepEqual(posts, [
    {
      url: "/api/abc/prompts",
      body: {
        prompts: [{ prompt: "Approve this contract", selector: "", tag: "dealernet-gate1", text: "Gate 1" }],
        domSnapshot: "uid=1 body",
        endSession: true,
      },
    },
  ]);
  assert.equal(chrome.element("endedOverlay").hidden, false);
  assert.equal(chrome.element("endedTitle").textContent, "Decisão de aprovação enviada. A revisão foi encerrada.");
  assert.equal(chrome.element("workingBubble").parentElement, undefined);
  assert.equal(chrome.storage.has("lavish-axi:action-panel:abc:dealernet-gate1"), false);
  assert.deepEqual(JSON.parse(JSON.stringify(chrome.postedToFrame.at(-1))), {
    type: "lavish:sendQueuedPromptsResult",
    requestId: "gate-1",
    ok: true,
  });
});

test("failed terminal send preserves Gate input and re-enables actions after the SDK reports the error", async () => {
  const chrome = await createChromeHarness({
    fetchImpl: async () => {
      throw new Error("network unavailable");
    },
  });
  chrome.sendFrameMessage({
    type: "lavish:registerActionPanel",
    panel: {
      schema: "lavish-action-panel-v1",
      id: "dealernet-gate1",
      title: "Decisão do Gate 1",
      fields: [{ id: "adjustment_text", type: "textarea", label: "Ajustes", maxLength: 4000 }],
      actions: [{ id: "adjust", label: "Solicitar ajustes", tone: "neutral", requires: ["adjustment_text"] }],
    },
  });
  const nodes = descendants(chrome.element("actionPanel"));
  const textarea = nodes.find((node) => node.tagName === "TEXTAREA");
  const adjust = nodes.find((node) => node.dataset.actionPanelAction === "adjust");
  textarea.value = "Preservar esta justificativa.";
  textarea.dispatch("input");
  adjust.click();
  const invocation = chrome.postedToFrame.find((message) => message.type === "lavish:actionPanelInvoke");

  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "typed payload", selector: "", tag: "dealernet-gate1", text: "Gate 1" },
  });
  chrome.sendFrameMessage({ type: "lavish:sendQueuedPrompts", endSession: true, requestId: "gate-error" });
  chrome.sendFrameMessage({ type: "lavish:snapshot", snapshot: "uid=1 body" });
  await flushPromises();
  await flushPromises();

  assert.equal(chrome.element("endedOverlay").hidden, true);
  assert.equal(chrome.queued().length, 1);
  assert.equal(textarea.value, "Preservar esta justificativa.");
  assert.equal(chrome.storage.has("lavish-axi:action-panel:abc:dealernet-gate1"), true);
  assert.deepEqual(JSON.parse(JSON.stringify(chrome.postedToFrame.at(-1))), {
    type: "lavish:sendQueuedPromptsResult",
    requestId: "gate-error",
    ok: false,
    error: "submit-failed",
  });

  chrome.sendFrameMessage({
    type: "lavish:actionPanelResult",
    panelId: "dealernet-gate1",
    invocationId: invocation.invocationId,
    ok: false,
    error: "Falha de rede; tente novamente.",
  });
  assert.equal(adjust.disabled, false);
  assert.equal(textarea.value, "Preservar esta justificativa.");
});

test("chrome send and end with an empty composer nudges instead of ending", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init = {}) => {
      posts.push({ url, body: init.body ? JSON.parse(init.body) : null });
      return { ok: true };
    },
  });
  chrome.element("sendHint").hidden = true;

  chrome.element("sendAndEnd").onclick();
  await flushPromises();

  assert.equal(posts.length, 0);
  assert.equal(chrome.postedToFrame.length, 0);
  assert.equal(chrome.element("sendHint").hidden, false);
  assert.equal(chrome.element("chatInput").focused, true);
  assert.equal(chrome.element("chatInput").disabled, false);
});

test("chrome send and end during an in-flight submit still ends after the submit drains the queue", async () => {
  const posts = [];
  let resolveFirstPost = () => {};
  const firstPost = new Promise((resolve) => {
    resolveFirstPost = () => resolve();
  });
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init = {}) => {
      posts.push({ url, body: init.body ? JSON.parse(init.body) : null });
      if (posts.length === 1) await firstPost;
      return { ok: true };
    },
  });

  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "Ship this", selector: "button#ship", tag: "choice", text: "Ship" },
  });
  chrome.element("send").onclick();
  chrome.sendFrameMessage({ type: "lavish:snapshot", snapshot: "uid=1 body" });
  await flushPromises();
  assert.equal(posts.length, 1);

  chrome.element("sendAndEnd").onclick();
  chrome.sendFrameMessage({ type: "lavish:snapshot", snapshot: "uid=1 body" });
  await flushPromises();
  assert.equal(posts.length, 1);

  resolveFirstPost();
  await flushPromises();
  await flushPromises();

  assert.deepEqual(
    posts.map((post) => post.url),
    ["/api/abc/prompts", "/api/abc/end"],
  );
  assert.deepEqual(posts[0].body, {
    prompts: [{ prompt: "Ship this", selector: "button#ship", tag: "choice", text: "Ship" }],
    domSnapshot: "uid=1 body",
  });
  assert.equal(posts[1].body, null);
  assert.equal(chrome.queued().length, 0);
  assert.equal(chrome.element("chatInput").disabled, true);
});

test("artifact terminal acknowledgement stays attached to its own queued batch during an in-flight submit", async () => {
  const posts = [];
  let resolveFirstPost = () => {};
  let resolveSecondPost = () => {};
  const firstPost = new Promise((resolve) => {
    resolveFirstPost = () => resolve();
  });
  const secondPost = new Promise((resolve) => {
    resolveSecondPost = () => resolve();
  });
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init = {}) => {
      posts.push({ url, body: init.body ? JSON.parse(init.body) : null });
      if (posts.length === 1) await firstPost;
      if (posts.length === 2) await secondPost;
      return { ok: true };
    },
  });

  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "Mensagem comum", selector: "", tag: "message", text: "Mensagem" },
  });
  chrome.element("send").onclick();
  chrome.sendFrameMessage({ type: "lavish:snapshot", snapshot: "uid=1 body" });
  await flushPromises();
  assert.equal(posts.length, 1);

  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "Payload terminal", selector: "", tag: "dealernet-gate1", text: "Gate 1" },
  });
  chrome.sendFrameMessage({ type: "lavish:sendQueuedPrompts", endSession: true, requestId: "gate-overlap" });
  chrome.sendFrameMessage({ type: "lavish:snapshot", snapshot: "uid=1 body" });
  await flushPromises();
  assert.equal(
    chrome.postedToFrame.some(
      (message) => message.type === "lavish:sendQueuedPromptsResult" && message.requestId === "gate-overlap",
    ),
    false,
    "the terminal handler cannot complete from the earlier ordinary POST",
  );

  resolveFirstPost();
  await flushPromises();
  await flushPromises();
  assert.equal(posts.length, 2);
  assert.equal(
    chrome.postedToFrame.some(
      (message) => message.type === "lavish:sendQueuedPromptsResult" && message.requestId === "gate-overlap",
    ),
    false,
    "the acknowledgement waits for the terminal POST itself",
  );
  assert.equal(chrome.element("endedOverlay").hidden, true);

  resolveSecondPost();
  await flushPromises();
  await flushPromises();

  assert.deepEqual(posts, [
    {
      url: "/api/abc/prompts",
      body: {
        prompts: [{ prompt: "Mensagem comum", selector: "", tag: "message", text: "Mensagem" }],
        domSnapshot: "uid=1 body",
      },
    },
    {
      url: "/api/abc/prompts",
      body: {
        prompts: [{ prompt: "Payload terminal", selector: "", tag: "dealernet-gate1", text: "Gate 1" }],
        domSnapshot: "uid=1 body",
        endSession: true,
      },
    },
  ]);
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        chrome.postedToFrame.find(
          (message) => message.type === "lavish:sendQueuedPromptsResult" && message.requestId === "gate-overlap",
        ),
      ),
    ),
    { type: "lavish:sendQueuedPromptsResult", requestId: "gate-overlap", ok: true },
  );
  assert.equal(chrome.element("endedOverlay").hidden, false);
});

test("Cmd/Ctrl+I toggles annotation mode from the chrome document, regardless of focus", async () => {
  const chrome = await createChromeHarness();

  const metaEvent = chrome.dispatchDocumentKeydown({ key: "i", metaKey: true });
  assert.equal(metaEvent.defaultPrevented, true);
  assert.equal(chrome.element("annotation")["aria-pressed"], "true");
  assert.equal(chrome.postedToFrame.at(-1).type, "lavish:setAnnotationMode");
  assert.equal(chrome.postedToFrame.at(-1).enabled, true);

  const ctrlEvent = chrome.dispatchDocumentKeydown({ key: "I", ctrlKey: true });
  assert.equal(ctrlEvent.defaultPrevented, true);
  assert.equal(chrome.element("annotation")["aria-pressed"], "false");
  assert.equal(chrome.postedToFrame.at(-1).type, "lavish:setAnnotationMode");
  assert.equal(chrome.postedToFrame.at(-1).enabled, false);
});

test("plain 'i' and other modifier combos do not toggle annotation mode", async () => {
  const chrome = await createChromeHarness();
  const framePostCount = () => chrome.postedToFrame.length;
  const before = framePostCount();

  const bareEvent = chrome.dispatchDocumentKeydown({ key: "i" });
  assert.equal(bareEvent.defaultPrevented, false);
  assert.equal(chrome.element("annotation")["aria-pressed"], undefined);

  const shiftEvent = chrome.dispatchDocumentKeydown({ key: "i", shiftKey: true });
  assert.equal(shiftEvent.defaultPrevented, false);

  const ctrlShiftEvent = chrome.dispatchDocumentKeydown({ key: "i", ctrlKey: true, shiftKey: true });
  assert.equal(ctrlShiftEvent.defaultPrevented, false);

  const metaAltEvent = chrome.dispatchDocumentKeydown({ key: "i", metaKey: true, altKey: true });
  assert.equal(metaAltEvent.defaultPrevented, false);

  const otherKeyEvent = chrome.dispatchDocumentKeydown({ key: "s", metaKey: true });
  assert.equal(otherKeyEvent.defaultPrevented, false);

  assert.equal(framePostCount(), before);
});

test("chrome client reads the mode toggle hotkey from the session bootstrap", async () => {
  const chrome = await createChromeHarness({
    sessionData: { key: "abc", file: "/tmp/artifact.html", modeToggleHotkeyKey: "k" },
  });

  const oldHotkeyEvent = chrome.dispatchDocumentKeydown({ key: "i", metaKey: true });
  assert.equal(oldHotkeyEvent.defaultPrevented, false);
  assert.equal(chrome.element("annotation")["aria-pressed"], undefined);

  const bootstrapHotkeyEvent = chrome.dispatchDocumentKeydown({ key: "K", metaKey: true });
  assert.equal(bootstrapHotkeyEvent.defaultPrevented, true);
  assert.equal(chrome.element("annotation")["aria-pressed"], "true");
  assert.equal(chrome.postedToFrame.at(-1).type, "lavish:setAnnotationMode");
  assert.equal(chrome.postedToFrame.at(-1).enabled, true);
});

test("chrome client toggles annotation mode when the artifact SDK requests it via postMessage", async () => {
  const chrome = await createChromeHarness();

  chrome.sendFrameMessage({ type: "lavish:toggleAnnotationMode" });

  assert.equal(chrome.element("annotation")["aria-pressed"], "true");
  assert.equal(chrome.postedToFrame.at(-1).type, "lavish:setAnnotationMode");
  assert.equal(chrome.postedToFrame.at(-1).enabled, true);

  chrome.sendFrameMessage({ type: "lavish:toggleAnnotationMode" });
  assert.equal(chrome.element("annotation")["aria-pressed"], "false");
  assert.equal(chrome.postedToFrame.at(-1).type, "lavish:setAnnotationMode");
  assert.equal(chrome.postedToFrame.at(-1).enabled, false);
});

test("chrome client ignores annotation mode toggles after the session ends", async () => {
  const chrome = await createChromeHarness();

  chrome.dispatchDocumentKeydown({ key: "i", metaKey: true });
  assert.equal(chrome.element("annotation")["aria-pressed"], "true");

  chrome.sendFrameMessage({ type: "lavish:endSession" });
  await flushPromises();
  const afterEndPostCount = chrome.postedToFrame.length;

  chrome.dispatchDocumentKeydown({ key: "i", metaKey: true });
  chrome.sendFrameMessage({ type: "lavish:toggleAnnotationMode" });

  assert.equal(chrome.element("annotation")["aria-pressed"], "true");
  assert.equal(chrome.postedToFrame.length, afterEndPostCount);
});

test("a silent artifact is probed for a fatal failure, and a talking one is not", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    artifactSrc: "/artifact/abc/index.html",
    fetchImpl: async (url, init) => {
      posts.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
      if (String(url).includes("/artifact/abc/index.html?") && String(url).includes("probe=1"))
        return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, json: async () => ({}) };
    },
  });

  chrome.element("artifact").dispatch("load");
  chrome.runTimers(8000);
  await flushPromises();
  await flushPromises();

  const failure = posts.find((post) => post.url === "/api/abc/artifact-failures");
  assert.equal(failure.body.failures[0].kind, "artifact-unavailable");
  assert.match(failure.body.failures[0].detail, /HTTP 404/);
});

test("an artifact that reports diagnostics is never probed as unavailable", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    artifactSrc: "/artifact/abc/index.html",
    fetchImpl: async (url, init) => {
      posts.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
      return { ok: true, json: async () => ({ warnings: [] }) };
    },
  });

  chrome.element("artifact").dispatch("load");
  chrome.sendFrameMessage({ type: "lavish:layoutDiagnostics", complete: true, viewport_width: 1440, findings: [] });
  await flushPromises();
  chrome.runTimers(8000);
  await flushPromises();

  assert.equal(
    posts.some((post) => post.url.includes("/artifact/abc/index.html?") && post.url.includes("probe=1")),
    false,
    "a healthy artifact costs exactly one document request",
  );
  assert.equal(
    posts.some((post) => post.url === "/api/abc/artifact-failures"),
    false,
  );
});

test("a local asset failure inside the artifact is reported as a fatal artifact failure", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init) => {
      posts.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
      return { ok: true, json: async () => ({}) };
    },
  });

  chrome.sendFrameMessage({
    type: "lavish:artifactAssetFailure",
    detail: "<img> could not load /artifact/abc/logo.png",
  });
  await flushPromises();

  const failure = posts.find((post) => post.url === "/api/abc/artifact-failures");
  assert.equal(failure.body.failures[0].kind, "artifact-asset-unavailable");
  assert.match(failure.body.failures[0].detail, /logo\.png/);
});
