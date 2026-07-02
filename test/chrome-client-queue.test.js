import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const sourceUrl = new URL("../src/chrome-client.js", import.meta.url);

/** @typedef {{ key: string, file: string, layoutGateEnabled?: boolean, layoutGateMaxHoldMs?: number }} HarnessSessionData */
/** @type {HarnessSessionData} */
const defaultSessionData = { key: "abc", file: "/tmp/artifact.html" };

async function createChromeHarness({
  fetchImpl = async () => ({ ok: true }),
  sessionData = defaultSessionData,
  artifactSrc = "",
} = {}) {
  const source = await readFile(sourceUrl, "utf8");
  const storage = new Map();
  const postedToFrame = [];
  const eventSources = [];
  const windowListeners = new Map();
  const elements = new Map();
  const timers = new Map();
  const srcLoads = [];
  let nextTimerId = 1;

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
      value: "",
      innerHTML: "",
      textContent: "",
      scrollTop: 0,
      scrollHeight: 0,
      dataset: {},
      onclick: null,
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
      querySelectorAll() {
        return [];
      },
      querySelector(selector) {
        if (selector !== "span") return null;
        const childId = `${id}:span`;
        if (!elements.has(childId)) element(childId);
        return elements.get(childId);
      },
      appendChild(child) {
        child.parentElement = this;
        return child;
      },
      click(event = {}) {
        this.clicked = true;
        if (typeof this.onclick === "function") return this.onclick(event);
        return undefined;
      },
      remove() {},
      focus() {
        this.focused = true;
      },
      select() {},
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

  const context = {
    clearTimeout: fakeClearTimeout,
    console,
    fetch: fetchImpl,
    location: { reload() {} },
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
      addEventListener() {},
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
      addEventListener(type, handler) {
        windowListeners.set(type, handler);
      },
    },
  };

  vm.runInNewContext(source, context, { filename: "chrome-client.js" });

  return {
    element,
    frame,
    postedToFrame,
    eventSource() {
      assert.equal(eventSources.length, 1);
      return eventSources[0];
    },
    sendFrameMessage(data) {
      const handler = windowListeners.get("message");
      assert.ok(handler, "chrome-client registered a message handler");
      handler({ source: frame.contentWindow, data });
    },
    queued() {
      return JSON.parse(storage.get("lavish-axi:queued:abc") || "[]");
    },
    runTimers,
    srcLoads,
  };
}

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

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
});

test("chrome client posts layout warnings from the artifact iframe", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return { ok: true };
    },
  });

  chrome.sendFrameMessage({
    type: "lavish:layoutWarnings",
    layout_warnings: [
      {
        selector: "html",
        kind: "page-horizontal-overflow",
        overflowPx: 18,
        viewportWidth: 720,
        severity: "error",
      },
    ],
  });
  await flushPromises();

  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, "/api/abc/layout-warnings");
  assert.deepEqual(posts[0].body, {
    layout_warnings: [
      {
        selector: "html",
        kind: "page-horizontal-overflow",
        overflowPx: 18,
        viewportWidth: 720,
        severity: "error",
      },
    ],
  });
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

  assert.equal(chrome.element("exportArtifact").querySelector("span").textContent, "Exported with 1 unresolved asset");
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

  assert.equal(chrome.element("exportArtifact").querySelector("span").textContent, "Exported with 1 notice");
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
    "Exported with 2 unresolved assets and 1 notice",
  );
});

test("chrome client surfaces share warnings from the server response", async () => {
  const chrome = await createChromeHarness({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        url: "https://abc123.ht-ml.app/",
        update_key: "uk_secret",
        warnings: [
          { kind: "load-failed", ref: "missing.png" },
          { kind: "csp-meta", ref: "script-src 'self'" },
        ],
        unresolved_local_assets: [{ kind: "load-failed", ref: "missing.png" }],
        notices: [{ kind: "csp-meta", ref: "script-src 'self'" }],
      }),
    }),
  });
  const submit = chrome.element("shareForm").listeners.get("submit");
  assert.equal(typeof submit, "function");

  await submit({ preventDefault() {} });
  await flushPromises();

  assert.equal(chrome.element("shareStatus").textContent, "Published with 1 unresolved local asset and 1 notice.");
  assert.equal(chrome.element("shareResult").hidden, false);
});

test("chrome client does not count share notices as unresolved assets", async () => {
  const chrome = await createChromeHarness({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        url: "https://abc123.ht-ml.app/",
        update_key: "uk_secret",
        warnings: [{ kind: "csp-meta", ref: "script-src 'self'" }],
        notices: [{ kind: "csp-meta", ref: "script-src 'self'" }],
      }),
    }),
  });
  const submit = chrome.element("shareForm").listeners.get("submit");
  assert.equal(typeof submit, "function");

  await submit({ preventDefault() {} });
  await flushPromises();

  assert.equal(chrome.element("shareStatus").textContent, "Published with 1 notice.");
  assert.equal(chrome.element("shareResult").hidden, false);
});

test("chrome client clears stale share passwords when opening a fresh dialog", async () => {
  const chrome = await createChromeHarness();

  chrome.element("sharePassword").value = "old-password";
  chrome.element("shareArtifact").onclick();

  assert.equal(chrome.element("sharePassword").value, "");
});

test("chrome client preserves share passwords during an in-dialog retry", async () => {
  const chrome = await createChromeHarness({
    fetchImpl: async () => ({
      ok: false,
      json: async () => ({ error: "publish failed" }),
    }),
  });

  chrome.element("shareArtifact").onclick();
  chrome.element("sharePassword").value = "pw";
  const submit = chrome.element("shareForm").listeners.get("submit");
  assert.equal(typeof submit, "function");

  await submit({ preventDefault() {} });
  await flushPromises();

  assert.equal(chrome.element("sharePassword").value, "pw");
  assert.equal(chrome.element("shareStatus").textContent, "publish failed");
});

test("chrome client says password-protected shares also require the password", async () => {
  const chrome = await createChromeHarness({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        url: "https://abc123.ht-ml.app/",
        update_key: "uk_secret",
      }),
    }),
  });
  chrome.element("sharePassword").value = "pw";
  const submit = chrome.element("shareForm").listeners.get("submit");
  assert.equal(typeof submit, "function");

  await submit({ preventDefault() {} });
  await flushPromises();

  assert.equal(
    chrome.element("shareStatus").textContent,
    "Published. This page is PASSWORD-PROTECTED; viewers also need the password.",
  );
});

test("chrome client treats a whitespace-only share password as public", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (_url, init) => {
      posts.push(JSON.parse(init.body));
      return {
        ok: true,
        json: async () => ({
          url: "https://abc123.ht-ml.app/",
          update_key: "uk_secret",
        }),
      };
    },
  });
  chrome.element("sharePassword").value = "   ";
  const submit = chrome.element("shareForm").listeners.get("submit");
  assert.equal(typeof submit, "function");

  await submit({ preventDefault() {} });
  await flushPromises();

  assert.deepEqual(posts, [{}]);
  assert.equal(chrome.element("shareStatus").textContent, "Published. Anyone with the link can view this page.");
});

test("chrome client registers message listener before loading the artifact iframe", async () => {
  const chrome = await createChromeHarness({ artifactSrc: "/artifact/abc/index.html" });

  assert.deepEqual(chrome.srcLoads, [{ src: "/artifact/abc/index.html", hadMessageListener: true }]);
});

test("layout gate reveals after a clean audit result", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return { ok: true };
    },
  });

  assert.equal(chrome.element("layoutGateOverlay").hidden, false);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), true);

  chrome.sendFrameMessage({ type: "lavish:layoutWarnings", layout_warnings: [] });
  await flushPromises();

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), false);
  assert.equal(chrome.element("layoutIssueBanner").hidden, true);
  assert.deepEqual(posts[0], { url: "/api/abc/layout-warnings", body: { layout_warnings: [] } });
});

test("layout gate holds on error severity audit findings and still posts them", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return { ok: true };
    },
  });

  chrome.sendFrameMessage({
    type: "lavish:layoutWarnings",
    layout_warnings: [
      {
        selector: "html",
        kind: "page-horizontal-overflow",
        overflowPx: 18,
        viewportWidth: 720,
        severity: "error",
      },
    ],
  });
  await flushPromises();

  assert.equal(chrome.element("layoutGateOverlay").hidden, false);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), true);
  assert.match(chrome.element("layoutGateTitle").innerHTML, /Fixing a layout issue/);
  assert.deepEqual(posts[0].body.layout_warnings[0].severity, "error");
});

test("layout gate does not hold on warning severity audit findings", async () => {
  const chrome = await createChromeHarness();

  chrome.sendFrameMessage({
    type: "lavish:layoutWarnings",
    layout_warnings: [
      {
        selector: ".card",
        kind: "text-clipped",
        overflowPx: 2,
        viewportWidth: 720,
        severity: "warning",
      },
    ],
  });
  await flushPromises();

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), false);
  assert.equal(chrome.element("layoutIssueBanner").hidden, true);
});

test("layout gate timeout reveals with a persistent layout issue banner", async () => {
  const chrome = await createChromeHarness({
    sessionData: { key: "abc", file: "/tmp/artifact.html", layoutGateMaxHoldMs: 25 },
  });

  chrome.sendFrameMessage({
    type: "lavish:layoutWarnings",
    layout_warnings: [{ selector: "html", kind: "content-overlap", severity: "error" }],
  });
  assert.equal(chrome.element("layoutGateOverlay").hidden, false);

  chrome.runTimers(25);

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), false);
  assert.equal(chrome.element("layoutIssueBanner").hidden, false);
  assert.match(chrome.element("layoutIssueBanner").textContent, /may have layout issues/);
});

test("layout gate timeout re-arms on reload", async () => {
  const chrome = await createChromeHarness({
    sessionData: { key: "abc", file: "/tmp/artifact.html", layoutGateMaxHoldMs: 25 },
  });

  chrome.sendFrameMessage({
    type: "lavish:layoutWarnings",
    layout_warnings: [{ selector: "html", kind: "content-overlap", severity: "error" }],
  });
  chrome.runTimers(25);
  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("layoutIssueBanner").hidden, false);

  chrome.eventSource().listeners.get("reload")();

  assert.equal(chrome.element("layoutGateOverlay").hidden, false);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), true);
  assert.equal(chrome.element("layoutIssueBanner").hidden, true);

  chrome.sendFrameMessage({
    type: "lavish:layoutWarnings",
    layout_warnings: [{ selector: "html", kind: "content-overlap", severity: "error" }],
  });

  assert.equal(chrome.element("layoutGateOverlay").hidden, false);
  assert.match(chrome.element("layoutGateTitle").innerHTML, /Fixing a layout issue/);
});

test("layout gate manual override reveals immediately", async () => {
  const chrome = await createChromeHarness();

  chrome.sendFrameMessage({
    type: "lavish:layoutWarnings",
    layout_warnings: [{ selector: "html", kind: "content-overlap", severity: "error" }],
  });
  chrome.element("layoutGateAction").onclick();

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), false);
  assert.equal(chrome.element("layoutIssueBanner").hidden, false);
});

test("layout gate manual override stays bypassed on reload", async () => {
  const chrome = await createChromeHarness();

  chrome.sendFrameMessage({
    type: "lavish:layoutWarnings",
    layout_warnings: [{ selector: "html", kind: "content-overlap", severity: "error" }],
  });
  chrome.element("layoutGateAction").onclick();
  chrome.eventSource().listeners.get("reload")();

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), false);

  chrome.sendFrameMessage({
    type: "lavish:layoutWarnings",
    layout_warnings: [{ selector: "html", kind: "content-overlap", severity: "error" }],
  });

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("layoutIssueBanner").hidden, false);
});

test("layout gate stays skipped when the session disables it", async () => {
  const chrome = await createChromeHarness({
    sessionData: { key: "abc", file: "/tmp/artifact.html", layoutGateEnabled: false },
  });

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), false);

  chrome.sendFrameMessage({
    type: "lavish:layoutWarnings",
    layout_warnings: [{ selector: "html", kind: "content-overlap", severity: "error" }],
  });
  await flushPromises();

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("layoutIssueBanner").hidden, true);
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
