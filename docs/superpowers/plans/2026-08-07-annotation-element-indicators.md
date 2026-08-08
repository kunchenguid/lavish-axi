# Annotation Element Indicators Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a small on-page indicator on every annotated element (queued or sent), and let a reviewer jump between that indicator and its entry in the review panel in either direction.

**Architecture:** A stable `id` is minted once per annotation in the injected artifact SDK and carried unchanged through the chat panel's queue, the server's storage, and back down to the panel on reload. The panel tells the iframe the current set of `{id, selector, target}` via a new `lavish:setAnnotationTargets` message; the iframe draws a badge per uniquely-resolved element and reports clicks back via `lavish:openAnnotation`. The panel reuses the existing `lavish:revealElement` message for the reverse direction. Sent annotations get a new durable `session.annotations` server-side record and a new "Annotations" panel section, since they previously vanished with no trace after sending (a corrected premise — see the design doc).

**Tech Stack:** Plain JS (ES modules), Express server, `node --test` for tests, no framework/bundler for the client files (`src/chrome-client.js`, `src/artifact-sdk.js` are injected as-is / built with esbuild).

**Reference:** Full design at `docs/superpowers/specs/2026-08-07-annotation-element-indicators-design.md`.

## Global Constraints

- Follow existing code style exactly: no framework, plain functions, JSDoc type casts only where the file already uses them (`/** @type {...} */`).
- `crypto` is a browser global inside `artifact-sdk.js`'s iframe context; add it to the file's top `/* global ... */` comment when used, matching the existing pattern for `CSS`, `document`, etc.
- Run `npx prettier --write <file>` and `npx eslint <file>` on every file touched before committing (matches `npm run lint` / `npm run format:check` in `package.json`).
- Every new exported pure function needs a `node --test` unit test using plain JS objects (no DOM), matching the style already in `test/artifact-sdk.test.js` and `test/session-store.test.js`.
- Preserve `assert.deepEqual` backward compatibility in `test/session-store.test.js`: new optional fields on a normalized prompt (`id`) must only be added to the object when present, never as an empty-string default, exactly like the existing `target` field is handled in `normalizePrompt`.
- Click-driven interaction tests only work in `test/chrome-client-queue.test.js`'s harness for DOM built with `document.createElement`/`appendChild` (see `createWarningRow`/`warningsList` for the working pattern) — the harness's `innerHTML` setter is a plain string, not parsed into a real tree, so anything rendered via `element.innerHTML = "<div>...</div>"` (like the existing queued-pill tray) cannot be click-tested there. Build the new sent-annotations list with `createElement`/`appendChild` specifically so its pin-icon clicks are unit-testable; the queued-pill tray's new pin icon follows the tray's existing `innerHTML` pattern and is verified manually only, exactly like the pill's pre-existing close button already is.

---

### Task 1: Server — durable annotation records

**Files:**

- Modify: `src/session-store.js:539-550` (`normalizePrompt`), `src/session-store.js:62-77` (`upsertSession`'s session object), `src/session-store.js:100-141` (`queuePrompts`)
- Modify: `src/server.js:1476` (panel HTML template's session JSON blob)
- Test: `test/session-store.test.js`

**Interfaces:**

- Produces: every session object now has `session.annotations: Array<{ id: string, selector: string, tag: string, text: string, prompt: string, at: string, target?: object }>`, durable (never cleared by `takeFeedback`, unlike `session.prompts`).
- Produces: `normalizePrompt` now preserves an optional `id` string on the normalized prompt (only when the incoming prompt had one), the same convention already used for `target`.
- Produces: the panel HTML template's embedded JSON (`#lavish-session` script tag, read by `chrome-client.js` as `sessionData`) now includes `initialAnnotations: session.annotations || []`, alongside the existing `initialChat`.
- Consumes: nothing new from other tasks — this task is server-only and independently testable.

- [ ] **Step 1: Write the failing test for `id` passthrough and the new `session.annotations` record**

Add to `test/session-store.test.js` (near the existing `"queued prompts are returned with DOM snapshot context and then cleared"` test):

```js
test("annotation-tagged prompts create a durable annotation record separate from chat and the outbox", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.queuePrompts(session.key, {
      prompts: [
        { id: "ann-1", uid: "1", prompt: "Make this warmer", selector: "h1", tag: "h1", text: "Hello" },
        { id: "", prompt: "Just a note", selector: "", tag: "message", text: "Freeform message" },
      ],
    });

    const stored = await store.findByKey(session.key);
    assert.deepEqual(stored.annotations, [
      {
        id: "ann-1",
        selector: "h1",
        tag: "h1",
        text: "Hello",
        prompt: "Make this warmer",
        at: stored.annotations[0].at,
      },
    ]);
    assert.deepEqual(stored.chat, [{ role: "user", text: "Just a note", at: stored.chat[0].at }]);

    // Draining the outbox must not touch the durable annotation log.
    await store.takeFeedback(session.key);
    const afterDrain = await store.findByKey(session.key);
    assert.equal(afterDrain.annotations.length, 1);
    assert.equal(afterDrain.prompts.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("annotation records preserve the target payload for text-range and Mermaid-node annotations", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<p id='intro'>Hello bright world</p>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const target = {
      type: "text-range",
      text: "bright",
      selector: "p#intro",
      start: { selector: "p#intro", path: [0], offset: 6 },
      end: { selector: "p#intro", path: [0], offset: 12 },
    };
    await store.queuePrompts(session.key, {
      prompts: [
        { id: "ann-2", uid: "", prompt: "Punch this up", selector: "p#intro", tag: "text", text: "bright", target },
      ],
    });

    const stored = await store.findByKey(session.key);
    assert.equal(stored.annotations.length, 1);
    assert.deepEqual(stored.annotations[0].target, target);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx node --test test/session-store.test.js`
Expected: FAIL — `stored.annotations` is `undefined` (property doesn't exist yet).

- [ ] **Step 3: Add `id` passthrough to `normalizePrompt`**

In `src/session-store.js`, change:

```js
function normalizePrompt(prompt) {
  const normalized = {
    uid: String(prompt.uid || ""),
    prompt: String(prompt.prompt || ""),
    selector: String(prompt.selector || ""),
    tag: String(prompt.tag || ""),
    text: String(prompt.text || ""),
  };
  const target = normalizeTarget(prompt.target);
  if (target) normalized.target = target;
  return normalized;
}
```

to:

```js
function normalizePrompt(prompt) {
  const normalized = {
    uid: String(prompt.uid || ""),
    prompt: String(prompt.prompt || ""),
    selector: String(prompt.selector || ""),
    tag: String(prompt.tag || ""),
    text: String(prompt.text || ""),
  };
  const id = String(prompt.id || "").trim();
  if (id) normalized.id = id;
  const target = normalizeTarget(prompt.target);
  if (target) normalized.target = target;
  return normalized;
}
```

- [ ] **Step 4: Initialize `annotations` on the session object**

In `src/session-store.js`'s `upsertSession`, change:

```js
        dom_snapshot: existing.dom_snapshot || "",
        chat: existing.chat || [],
        updated_at: new Date().toISOString(),
```

to:

```js
        dom_snapshot: existing.dom_snapshot || "",
        chat: existing.chat || [],
        annotations: existing.annotations || [],
        updated_at: new Date().toISOString(),
```

- [ ] **Step 5: Derive and append `session.annotations` in `queuePrompts`**

In `src/session-store.js`'s `queuePrompts`, change:

```js
const userMessages = acceptedPrompts
  .filter((prompt) => prompt.tag === "message" && prompt.prompt)
  .map((prompt) => ({ role: "user", text: prompt.prompt, at: new Date().toISOString() }));
session.prompts = [...(session.prompts || []), ...acceptedPrompts];
session.chat = [...(session.chat || []), ...userMessages];
```

to:

```js
const at = new Date().toISOString();
const userMessages = acceptedPrompts
  .filter((prompt) => prompt.tag === "message" && prompt.prompt)
  .map((prompt) => ({ role: "user", text: prompt.prompt, at }));
// Annotation-tagged prompts never reach session.chat (only tag === "message" does) and
// session.prompts is a write-only outbox drained by takeFeedback, so without this they
// leave no visible trace once sent. This is the durable, human-facing record of them.
const newAnnotations = acceptedPrompts
  .filter((prompt) => prompt.tag !== "message" && prompt.selector)
  .map((prompt) => ({
    id: prompt.id || "",
    selector: prompt.selector,
    tag: prompt.tag,
    text: prompt.text,
    prompt: prompt.prompt,
    at,
    ...(prompt.target ? { target: prompt.target } : {}),
  }));
session.prompts = [...(session.prompts || []), ...acceptedPrompts];
session.chat = [...(session.chat || []), ...userMessages];
session.annotations = [...(session.annotations || []), ...newAnnotations];
```

Note: this block already has a local `const at = new Date().toISOString();` a few lines above at the top of `queuePrompts` (used for `queueWarningRecords`) — check for a naming collision before pasting; if one already exists in scope, reuse it instead of redeclaring.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx node --test test/session-store.test.js`
Expected: PASS, and the full existing suite must still pass (checks the `id`-only-when-present convention didn't break older `deepEqual` assertions):

Run: `npx node --test test/session-store.test.js`
Expected: PASS (all tests, including the pre-existing ones with no `id` field in their expected `deepEqual` payloads).

- [ ] **Step 7: Wire `initialAnnotations` into the panel HTML template**

In `src/server.js`, find the `initialChat: session.chat || [],` line (around line 1476) and add a sibling field immediately after it:

```js
    initialChat: session.chat || [],
    initialAnnotations: session.annotations || [],
```

- [ ] **Step 8: Confirm the server test suite and typecheck still pass**

Run: `npx node --test test/server.test.js`
Expected: PASS (no existing assertion pins the exact session JSON shape in a way that would break from an added field; if one does, extend it to expect the new field rather than removing it).

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 9: Format, lint, and commit**

Run: `npx prettier --write src/session-store.js src/server.js test/session-store.test.js && npx eslint src/session-store.js src/server.js test/session-store.test.js`
Expected: no errors.

```bash
git add src/session-store.js src/server.js test/session-store.test.js
git commit -m "feat: persist sent annotations as a durable session record"
```

---

### Task 2: Injected SDK — annotation id, badge overlay, and reveal wiring

**Files:**

- Modify: `src/artifact-sdk.js` (top `/* global */` comment; `queuePrompt` around line 687-705; new exported `dedupeAnnotationTargets`; new badge-overlay state/functions inside `createArtifactSdk`; shadow-root CSS around line 1649; message handler around line 1756-1764)
- Test: `test/artifact-sdk.test.js`

**Interfaces:**

- Consumes: nothing from Task 1 directly (this task only needs to know the wire shape `{ id, selector, target }`, which the design doc already fixes).
- Produces: `queuePrompt` now includes a stable `id` (`crypto.randomUUID()`) on every `lavish:queuePrompt` message's `prompt` payload.
- Produces: a new exported pure function `dedupeAnnotationTargets(targets, resolve)` — `targets: Array<{id: string, selector: string}>`, `resolve: (selector: string) => object | null` — returns `Array<{id: string, el: object}>`, one entry per unique resolved element, keeping the first (earliest) `id` seen for that element and dropping entries with no `id`, no `selector`, or an unresolved `selector`.
- Produces: the SDK now handles an incoming `lavish:setAnnotationTargets` message (`{ targets: Array<{id, selector, target}> }`) by drawing/updating on-page badges, and emits `lavish:openAnnotation` (`{ id: string }`) via `postArtifactMessage` when a badge is clicked.
- Produces later tasks depend on: the exact message names `lavish:setAnnotationTargets` (incoming) and `lavish:openAnnotation` (outgoing), and that `queuePrompt`'s outgoing `lavish:queuePrompt` message's `prompt.id` is always a non-empty string.

- [ ] **Step 1: Write the failing test for `dedupeAnnotationTargets`**

Add to `test/artifact-sdk.test.js`:

```js
import {
  classifyMaterialRectEscape,
  classifySevereTextOverflow,
  dedupeAnnotationTargets,
  deriveLavishQueueKey,
  findStableLayoutFindings,
  isMaterialPageOverflow,
  isModeToggleHotkeyEvent,
  isNativeInteractiveControl,
  isNearTotalOcclusion,
} from "../src/artifact-sdk.js";
```

(add `dedupeAnnotationTargets` to the existing import list, alphabetically)

```js
test("dedupeAnnotationTargets keeps the earliest id per resolved element", () => {
  const elA = { name: "a" };
  const elB = { name: "b" };
  const resolve = (selector) => ({ "sel-a": elA, "sel-b": elB })[selector] || null;

  const result = dedupeAnnotationTargets(
    [
      { id: "1", selector: "sel-a" },
      { id: "2", selector: "sel-a" },
      { id: "3", selector: "sel-b" },
    ],
    resolve,
  );

  assert.deepEqual(result, [
    { id: "1", el: elA },
    { id: "3", el: elB },
  ]);
});

test("dedupeAnnotationTargets drops entries with no id, no selector, or an unresolved selector", () => {
  const elA = { name: "a" };
  const resolve = (selector) => (selector === "sel-a" ? elA : null);

  const result = dedupeAnnotationTargets(
    [
      { id: "", selector: "sel-a" },
      { id: "1", selector: "" },
      { id: "2", selector: "sel-missing" },
      { id: "3", selector: "sel-a" },
    ],
    resolve,
  );

  assert.deepEqual(result, [{ id: "3", el: elA }]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx node --test test/artifact-sdk.test.js`
Expected: FAIL — `dedupeAnnotationTargets` is not exported.

- [ ] **Step 3: Implement `dedupeAnnotationTargets`**

In `src/artifact-sdk.js`, add near the other pure exported functions (after `isNearTotalOcclusion`, before `createArtifactSdk`):

```js
// Multiple annotations can target the same element; the on-page badge collapses them to one dot
// keyed by resolved element identity, keeping the earliest (first-listed) id. `resolve` is
// injected so this stays DOM-shape-agnostic and unit-testable with plain objects.
export function dedupeAnnotationTargets(targets, resolve) {
  const seen = new Set();
  const result = [];
  for (const entry of Array.isArray(targets) ? targets : []) {
    const id = String(entry?.id || "");
    const selector = String(entry?.selector || "");
    if (!id || !selector) continue;
    const el = resolve(selector);
    if (!el || seen.has(el)) continue;
    seen.add(el);
    result.push({ id, el });
  }
  return result;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx node --test test/artifact-sdk.test.js`
Expected: PASS.

- [ ] **Step 5: Mint a stable `id` in `queuePrompt`**

In `src/artifact-sdk.js`, add `crypto` to the top `/* global ... */` comment (line 1):

```js
/* global CSS, Element, MutationObserver, ResizeObserver, crypto, document, getComputedStyle, parent, window */
```

Then in `queuePrompt` (around line 687-705), change:

```js
  function queuePrompt(prompt, options = {}) {
    const originElement = options.element || document.activeElement || document.body;
    /** @type {{ uid: string, prompt: string, selector: string, tag: string, text: string, target?: unknown, _lavishQueueKey?: string }} */
    const item = {
      ...context(originElement),
      prompt: String(prompt || ""),
    };
```

to:

```js
  function queuePrompt(prompt, options = {}) {
    const originElement = options.element || document.activeElement || document.body;
    /** @type {{ id: string, uid: string, prompt: string, selector: string, tag: string, text: string, target?: unknown, _lavishQueueKey?: string }} */
    const item = {
      ...context(originElement),
      id: crypto.randomUUID(),
      prompt: String(prompt || ""),
    };
```

(the existing `if (options.uid) item.uid = ...` block below is untouched — `id` is never overridable via `options`, unlike `uid`/`selector`/`tag`/`text`, since it must stay a fresh mint per queued annotation)

- [ ] **Step 6: Add badge-overlay state and rendering inside `createArtifactSdk`**

In `src/artifact-sdk.js`, inside `createArtifactSdk` (after the existing `let annotationMode = true;` block, around line 260-266), add:

```js
let annotationTargets = [];
/** @type {Array<{ id: string, el: Element, node: HTMLDivElement }>} */
let annotationBadges = [];
let annotationBadgeFrame = 0;

function setAnnotationTargets(targets) {
  annotationTargets = Array.isArray(targets) ? targets : [];
  renderAnnotationBadges();
}

function renderAnnotationBadges() {
  const root = ensureShadow();
  for (const badge of annotationBadges) badge.node.remove();
  annotationBadges = dedupeAnnotationTargets(annotationTargets, safeQuerySelector).map(({ id, el }) => {
    const node = document.createElement("div");
    node.className = "lavish-annotation-badge";
    node.addEventListener("click", (event) => {
      event.stopPropagation();
      postArtifactMessage("lavish:openAnnotation", { id });
    });
    root.appendChild(node);
    return { id, el, node };
  });
  positionAnnotationBadges();
  if (annotationBadges.length && !annotationBadgeFrame) {
    annotationBadgeFrame = window.requestAnimationFrame(annotationBadgeLoop);
  }
}

function positionAnnotationBadges() {
  for (const badge of annotationBadges) {
    const rect = badge.el.getBoundingClientRect();
    badge.node.style.left = rect.right - 6 + "px";
    badge.node.style.top = rect.top - 6 + "px";
  }
}

// Badges are persistent (unlike the one-shot reveal-marker pulse), so their position needs to
// track scroll/resize/layout changes. This loop self-terminates once there are no badges left
// rather than running unconditionally in the background.
function annotationBadgeLoop() {
  annotationBadgeFrame = 0;
  if (!annotationBadges.length) return;
  positionAnnotationBadges();
  annotationBadgeFrame = window.requestAnimationFrame(annotationBadgeLoop);
}

window.addEventListener("scroll", positionAnnotationBadges, true);
window.addEventListener("resize", positionAnnotationBadges);
```

Note: `dedupeAnnotationTargets` and `safeQuerySelector` must both be in scope here — `dedupeAnnotationTargets` is a top-level export in the same module (already in scope inside `createArtifactSdk`'s closure since it's a module-level function); `safeQuerySelector` is defined later in the file (around line 1540) but since this is all inside one function scope via `function` declarations (hoisted), forward reference is fine — confirm this matches the file's existing style (e.g. `ensureShadow`, `closeCard` are already called before their definitions elsewhere in the file).

- [ ] **Step 7: Add the badge CSS to the shadow root style block**

In `src/artifact-sdk.js`, find the shadow root's `style.textContent = ...` block (around line 1649, the large CSS string starting with `:host{all:initial;...`). Append, just before the closing backtick, right after the existing `.lavish-reveal-marker`/`@keyframes lavish-reveal-pulse` rules:

```
.lavish-annotation-badge{position:fixed;width:10px;height:10px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 2px var(--ink-900);cursor:pointer;pointer-events:auto;z-index:2147483647}
```

- [ ] **Step 8: Handle the incoming `setAnnotationTargets` message**

In `src/artifact-sdk.js`, in the `window.addEventListener("message", ...)` handler (around line 1756-1764), add alongside the existing `if (msg.type === "lavish:setAnnotationMode") ...` line:

```js
if (msg.type === "lavish:setAnnotationTargets") setAnnotationTargets(msg.targets);
```

- [ ] **Step 9: Typecheck and lint**

Run: `npx tsc --noEmit`
Expected: PASS.

Run: `npx eslint src/artifact-sdk.js test/artifact-sdk.test.js`
Expected: no errors (if `no-undef` flags `crypto`, confirm the global comment edit from Step 5 landed).

- [ ] **Step 10: Format and commit**

Run: `npx prettier --write src/artifact-sdk.js test/artifact-sdk.test.js`

```bash
git add src/artifact-sdk.js test/artifact-sdk.test.js
git commit -m "feat: draw on-page badges for annotated elements and report clicks"
```

Manual verification (no DOM test harness exercises `createArtifactSdk` today — see Global Constraints and the design doc's Testing section): open a real artifact in Lavish, annotate an element, confirm a small accent dot appears at its corner, scroll the page and confirm the dot tracks the element, and confirm clicking it doesn't throw (full click round-trip is verified end-to-end after Task 3).

---

### Task 3: Chat panel — registry, Annotations section, send-flow wiring

**Files:**

- Modify: `src/chrome-client.js` (top consts around line 3-23; `render()` around line 191-217; `submitQueuedOnce` around line 446-477; `frame.addEventListener("load", ...)` around line 1852-1862; message handler around line 1709-1769; bottom init block around line 1880-1883)
- Modify: `src/chrome.css` (near the existing `.pill*` rules, around line 1024-1117)
- Modify: `src/server.js` (panel HTML template body, around line 1503 — add the new section's container div)
- Test: `test/chrome-client-queue.test.js`

**Interfaces:**

- Consumes from Task 1: `sessionData.initialAnnotations` (array of `{ id, selector, tag, text, prompt, at, target? }`), and that a successful `POST /api/:key/prompts` durably records annotation-tagged prompts server-side (this task doesn't need the response to reflect that — see design doc's "no push channel" decision).
- Consumes from Task 2: the message names `lavish:setAnnotationTargets` (this task sends it) and `lavish:openAnnotation` (this task receives it), and that every annotation-tagged prompt arriving via `lavish:queuePrompt` already has a non-empty `prompt.id`.
- Produces: a new `#annotationsSent` panel section, built with `createElement`/`appendChild` (not `innerHTML`), one entry per sent annotation, each with a pin button.

- [ ] **Step 1: Add the new panel section to the server-rendered HTML**

In `src/server.js`, find the panel markup (around line 1503) containing:

```
<div class="panel-scroll" id="panelScroll"><div class="chat" id="chatLog"></div><div class="annotation-pills" id="annotationPills"></div></div>
```

Change to:

```
<div class="panel-scroll" id="panelScroll"><div class="chat" id="chatLog"></div><div class="annotations-sent" id="annotationsSent"></div><div class="annotation-pills" id="annotationPills"></div></div>
```

- [ ] **Step 2: Add CSS for the pin icon and the Annotations section**

In `src/chrome.css`, after the existing `.pill-wrap:hover .pill-tooltip, .pill-wrap:focus-within .pill-tooltip { display: block; }` rule (around line 1114-1117), add:

```css
.pill-pin {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: 0;
  border-radius: var(--radius-pill);
  padding: 0;
  background: transparent;
  color: var(--accent);
  cursor: pointer;
  flex: 0 0 auto;
}
.pill-pin svg {
  display: block;
}
.annotations-sent {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  padding: 0 16px 12px;
  flex: 0 0 auto;
}
.annotations-sent:empty {
  display: none;
}
.annotation-entry {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  background: transparent;
  color: var(--fg-muted);
  padding: 6px 8px;
  font-size: 12px;
}
.annotation-entry-text {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.annotation-highlight {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
```

- [ ] **Step 3: Write the failing test for send-flow moving an annotation into the sent-annotations section**

Add to `test/chrome-client-queue.test.js` (near the existing `"chrome client replaces queued prompts with the same internal key"` test):

```js
test("sending a queued annotation moves it into the sent-annotations section without a server round-trip", async () => {
  const chrome = await createChromeHarness();

  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { id: "ann-1", prompt: "Make this warmer", selector: "h1", tag: "h1", text: "Hello" },
  });
  assert.equal(chrome.queued().length, 1);

  chrome.element("send").click();
  await flushPromises();

  assert.equal(chrome.queued().length, 0);
  const entry = chrome.element("annotationsSent").children[0];
  assert.ok(entry, "a sent-annotation entry was appended");
  assert.equal(entry.dataset.annotationId, "ann-1");
});

test("a sent annotation's pin button asks the artifact iframe to reveal its element", async () => {
  const chrome = await createChromeHarness();

  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { id: "ann-1", prompt: "Make this warmer", selector: "h1", tag: "h1", text: "Hello" },
  });
  chrome.element("send").click();
  await flushPromises();

  const entry = chrome.element("annotationsSent").children[0];
  const pin = entry.children.find((child) => String(child.className).includes("pill-pin"));
  pin.dispatch("click");

  const revealMessage = chrome.postedToFrame.at(-1);
  assert.equal(revealMessage.type, "lavish:revealElement");
  assert.equal(revealMessage.selector, "h1");
});

test("an openAnnotation message from the artifact scrolls the matching sent-annotation entry into view", async () => {
  const chrome = await createChromeHarness();

  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { id: "ann-1", prompt: "Make this warmer", selector: "h1", tag: "h1", text: "Hello" },
  });
  chrome.element("send").click();
  await flushPromises();

  chrome.sendFrameMessage({ type: "lavish:openAnnotation", id: "ann-1" });

  const entry = chrome.element("annotationsSent").children[0];
  assert.ok(entry.scrolledIntoView, "the entry was scrolled into view");
});

test("chrome client posts the current annotation targets to the iframe after send and on load", async () => {
  const chrome = await createChromeHarness({ artifactSrc: "/artifact/abc/index.html" });

  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { id: "ann-1", prompt: "Make this warmer", selector: "h1", tag: "h1", text: "Hello" },
  });

  const queuedTargets = chrome.postedToFrame.filter((message) => message.type === "lavish:setAnnotationTargets");
  assert.ok(queuedTargets.length > 0, "targets were posted after queueing");
  assert.deepEqual(queuedTargets.at(-1).targets, [{ id: "ann-1", selector: "h1", target: undefined }]);

  chrome.element("send").click();
  await flushPromises();

  const afterSend = chrome.postedToFrame.filter((message) => message.type === "lavish:setAnnotationTargets").at(-1);
  assert.deepEqual(afterSend.targets, [{ id: "ann-1", selector: "h1", target: undefined }]);
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx node --test test/chrome-client-queue.test.js`
Expected: FAIL — `chrome.element("annotationsSent").children` is empty, `lavish:setAnnotationTargets` is never posted, `lavish:openAnnotation` isn't handled.

- [ ] **Step 5: Add state and DOM refs for the new section**

In `src/chrome-client.js`, near the other `const ... = document.getElementById(...)` declarations (after line 23's `annotationPills` const), add:

```js
const annotationsSent = /** @type {HTMLDivElement} */ (document.getElementById("annotationsSent"));
```

Near the existing `const initialChat = ...` (line 13), add:

```js
/** @type {Array<{ id: string, selector: string, tag: string, text: string, prompt: string, at: string, target?: unknown }>} */
let sentAnnotations = Array.isArray(sessionData.initialAnnotations) ? sessionData.initialAnnotations.slice() : [];
```

- [ ] **Step 6: Add the pin-button markup helper and the Annotations-section renderer**

In `src/chrome-client.js`, near `render()` (before it, around line 191), add:

```js
function pinButtonMarkup(selector) {
  if (!selector) return "";
  return (
    '<button class="pill-pin" type="button" aria-label="Show on artifact" data-selector="' +
    escapeHtml(selector) +
    '"><svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true" focusable="false">' +
    '<circle cx="5" cy="5" r="3.5" stroke="currentColor" stroke-width="1.4"/></svg></button>'
  );
}

function bindPinButtons(container) {
  for (const button of container.querySelectorAll(".pill-pin")) {
    const pinButton = /** @type {HTMLButtonElement} */ (button);
    pinButton.addEventListener("click", (event) => {
      event.stopPropagation();
      postToFrame({ type: "lavish:revealElement", selector: pinButton.dataset.selector || "" });
    });
  }
}

function annotationTargetsList() {
  const list = [];
  for (const prompt of queued) {
    if (prompt.id && prompt.selector) list.push({ id: prompt.id, selector: prompt.selector, target: prompt.target });
  }
  for (const item of sentAnnotations) {
    if (item.id && item.selector) list.push({ id: item.id, selector: item.selector, target: item.target });
  }
  return list;
}

function postAnnotationTargets() {
  postToFrame({ type: "lavish:setAnnotationTargets", targets: annotationTargetsList() });
}

function renderAnnotations() {
  annotationsSent.replaceChildren();
  for (const item of sentAnnotations) {
    const entry = document.createElement("div");
    entry.className = "annotation-entry";
    entry.dataset.annotationId = item.id || "";
    if (item.selector) {
      const pin = document.createElement("button");
      pin.className = "pill-pin";
      pin.type = "button";
      pin.setAttribute("aria-label", "Show on artifact");
      pin.dataset.selector = item.selector;
      pin.addEventListener("click", (event) => {
        event.stopPropagation();
        postToFrame({ type: "lavish:revealElement", selector: item.selector });
      });
      entry.appendChild(pin);
    }
    const text = document.createElement("span");
    text.className = "annotation-entry-text";
    text.textContent = item.prompt;
    entry.appendChild(text);
    annotationsSent.appendChild(entry);
  }
  postAnnotationTargets();
}

function openAnnotationEntry(id) {
  const target = String(id || "");
  if (!target) return;
  const entry = annotationsSent.children.find((child) => child.dataset?.annotationId === target);
  if (!entry) return;
  scrollElementIntoView(entry);
  entry.classList.add("annotation-highlight");
  setTimeout(() => entry.classList.remove("annotation-highlight"), 2400);
}
```

Note: `annotationsSent.children.find(...)` requires `children` to be a real array (or array-like with `.find`) — this matches the test harness's mock (`children: []`, a plain array) and real DOM's `HTMLCollection`... actually real `HTMLCollection` does **not** have `.find`. Use `[...annotationsSent.children].find(...)` instead for real-browser correctness; the mock's `children` being a plain array already supports spreading identically.

- [ ] **Step 7: Wire the pin button into the queued-pill markup and call `postAnnotationTargets` after queue changes**

In `src/chrome-client.js`'s `render()` (around line 191-217), change the pill template's opening to include the pin button, and add the registry post at the end:

```js
function render() {
  annotationPills.innerHTML = queued
    .map(
      (prompt, index) =>
        '<div class="pill-wrap"><div class="pill">' +
        pinButtonMarkup(prompt.selector) +
        '<span class="pill-preview">' +
        escapeHtml(prompt.prompt) +
        '</span><button class="pill-close" type="button" aria-label="Remove queued prompt" data-index="' +
        index +
        '"><svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true" focusable="false"><path d="M1 1L9 9M9 1L1 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></div><div class="pill-tooltip">' +
        (prompt.selector
          ? '<div class="tooltip-label">Target</div><div class="pill-tooltip-target">' +
            escapeHtml(prompt.selector) +
            "</div>"
          : "") +
        '<div class="tooltip-label">Prompt</div><div class="pill-tooltip-prompt">' +
        escapeHtml(prompt.prompt) +
        "</div></div></div>",
    )
    .join("");

  for (const button of annotationPills.querySelectorAll(".pill-close")) {
    const closeButton = /** @type {HTMLButtonElement} */ (button);
    closeButton.addEventListener("click", (event) => removeQueuedPrompt(Number(closeButton.dataset.index), event));
  }
  bindPinButtons(annotationPills);
  updateSendState();
  scrollPanelToBottom();
  postAnnotationTargets();
}
```

- [ ] **Step 8: Move sent annotation-tagged prompts into `sentAnnotations` after a successful send**

In `src/chrome-client.js`'s `submitQueuedOnce` (around line 446-477), change:

```js
for (const prompt of prompts) {
  const index = queued.indexOf(prompt);
  if (index !== -1) queued.splice(index, 1);
}
persistQueuedPrompts();
render();
```

to:

```js
const sentAt = new Date().toISOString();
for (const prompt of prompts) {
  const index = queued.indexOf(prompt);
  if (index !== -1) queued.splice(index, 1);
  if (prompt.tag !== "message" && prompt.selector) {
    sentAnnotations.push({
      id: prompt.id || "",
      selector: prompt.selector,
      target: prompt.target,
      tag: prompt.tag,
      text: prompt.text,
      prompt: prompt.prompt,
      at: sentAt,
    });
  }
}
persistQueuedPrompts();
render();
renderAnnotations();
```

- [ ] **Step 9: Handle the incoming `lavish:openAnnotation` message and send targets on iframe load**

In `src/chrome-client.js`'s `window.addEventListener("message", ...)` handler (around line 1709-1769), add alongside the other `if (msg.type === ...)` lines:

```js
if (msg.type === "lavish:openAnnotation") openAnnotationEntry(msg.id);
```

In the `frame.addEventListener("load", ...)` handler (around line 1852-1862), add:

```js
postAnnotationTargets();
```

right after the existing `postToFrame({ type: "lavish:setAnnotationMode", ... })` line inside that handler.

- [ ] **Step 10: Render the initial sent-annotations section on startup**

In `src/chrome-client.js`'s bottom init block (around line 1880-1883), change:

```js
render();
setWarningsDrawerOpen(false);
renderWarnings();
initialChat.forEach((item) => addChat(item.role, item.text));
```

to:

```js
render();
setWarningsDrawerOpen(false);
renderWarnings();
renderAnnotations();
initialChat.forEach((item) => addChat(item.role, item.text));
```

- [ ] **Step 11: Run the tests to verify they pass**

Run: `npx node --test test/chrome-client-queue.test.js`
Expected: PASS, including the four new tests from Step 3 and the full pre-existing suite (in particular the pill-tray test `"chrome client replaces queued prompts with the same internal key"`, since the pill markup changed).

- [ ] **Step 12: Typecheck and lint**

Run: `npx tsc --noEmit`
Expected: PASS.

Run: `npx eslint src/chrome-client.js src/server.js test/chrome-client-queue.test.js`
Expected: no errors.

- [ ] **Step 13: Format and commit**

Run: `npx prettier --write src/chrome-client.js src/chrome.css src/server.js test/chrome-client-queue.test.js`

```bash
git add src/chrome-client.js src/chrome.css src/server.js test/chrome-client-queue.test.js
git commit -m "feat: show sent annotations in the panel and wire badge/pin navigation"
```

- [ ] **Step 14: Full check and manual verification**

Run: `npm run check`
Expected: PASS (build, lint, format:check, typecheck, full test suite, skill/plugin build checks).

Manual verification in a real Chrome session (per the design doc's Testing section): start a Lavish review, queue an element annotation, a text-selection annotation, and a Mermaid-node annotation (confirm all three get pill pin icons and page-side badges); send one; confirm it moves into the Annotations section with a working pin; reload the artifact and confirm the sent annotation and its badge both survive; click the page-side badge and confirm the panel scrolls to and highlights the right entry; click a pin and confirm the page scrolls to and pulses the right element; remove an unsent element's target from the DOM (e.g. via devtools) and confirm its badge disappears while its pill/entry pin stays present but does nothing on click.

---

## Self-review notes

- **Spec coverage:** every Goal in the design doc maps to a task — on-page indicator (Task 2), bidirectional navigation (Task 2 + Task 3), all three annotation kinds (Task 1's `selector`-based filter and Task 2's `dedupeAnnotationTargets` are target-shape-agnostic, so element/text/Mermaid all flow through unchanged), reload survival (Task 1 Step 7 + Task 3 Step 10), dedupe-to-one-dot (Task 2 Step 3/6), stale-target degradation (Task 2's `dedupeAnnotationTargets` drop + Task 3's inert-pin via `revealElement`'s existing no-op).
- **Placeholder scan:** no TBD/TODO markers; every step has literal code.
- **Type consistency:** `{ id, selector, target }` is the wire shape used identically in Task 2 (SDK receiving `msg.targets`) and Task 3 (`annotationTargetsList()` producing it); `session.annotations` record shape (`{ id, selector, tag, text, prompt, at, target? }`) from Task 1 matches what Task 3's `submitQueuedOnce` constructs client-side for its optimistic `sentAnnotations` push and what `initialAnnotations` seeds on reload.
- **Scope check:** three tasks, each independently testable and revertible (server storage; SDK badge rendering; panel UI and wiring) — no task depends on uncommitted work from a sibling task's internals, only on the fixed message/data shapes documented in each task's Interfaces block.
