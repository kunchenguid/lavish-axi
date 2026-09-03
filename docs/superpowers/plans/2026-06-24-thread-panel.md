# Thread Panel (Slack-style slide-out) Implementation Plan

> **Status: SHIPPED.** This plan was implemented and merged on branch `merge/main-into-sse`; it is kept as a historical record of how the work was scoped, not as outstanding work. The unchecked `- [ ]` boxes below are the original task list as written before implementation - do not re-execute this plan. The current behavior contract lives in README.md (user-facing), the `lavish-axi` CLI guidance strings (agent-facing), and AGENTS.md (architecture invariants).

> **For agentic workers (historical):** this plan was executed with superpowers:subagent-driven-development. Steps used checkbox (`- [ ]`) syntax for tracking while it was in flight.

**Goal:** Turn the flat lavish chat into Slack-style threads — roots stay in the chat list, replies collapse into a slide-out thread view that reuses the right-hand panel without shrinking or covering the artifact.

**Architecture:** Threading is derived entirely on the client from the existing `reply_to` field; the server is untouched. Pure, DOM-free helpers (root resolution, grouping, chip label, badge decision) live at the top of `chrome-client.js` and are unit-tested through the existing `vm` harness via a guarded `globalThis.__lavishTest` seam. The panel gains a `.chat-pane` (roots + chips + main composer that now starts new top-level messages) and a `.thread-pane` (Back button + pinned root + replies + reply composer) that is `display:none` when closed and animates in on open.

**Tech Stack:** Vanilla browser JS (classic script, copied to `dist/` — no bundler, no imports), plain CSS with design tokens, `node:test` + `node:vm` harness for unit tests, Playwright (out-of-repo) for the E2E gate.

## Global Constraints

- `npm run check` must be green before any commit: `build` → `lint` (eslint) → `format:check` (prettier) → `typecheck` (`tsc --noEmit`, checkJs is on — annotate with JSDoc) → `test` (`node --test`) → `build-skill --check`.
- `chrome-client.js` is a **classic script** copied verbatim to `dist/` by `scripts/build.js`. Do NOT add ESM `import`/`export` to it and do NOT change `scripts/build.js`. Share code only via top-level functions in the file.
- Server (`src/server.js` request handlers, session store, SSE) is **not** modified except the `createChromeHtml` HTML template string.
- Threading is **one level**: a reply-to-a-reply resolves up the `reply_to` chain to its root and displays flat under that root. Keep the precise `reply_to` on the wire.
- The eslint header in `chrome-client.js` is `/* global EventSource, document, location, window */`; `globalThis` is already an allowed ES2020 global.
- After editing `src/`, rebuild with `node scripts/build.js` so the globally linked `lavish-axi` serves the change (the user reloads the tab; the chrome does not hot-reload).
- Branch is `feat/realtime-sse-threading`; commit there. Do NOT push until the convergence + Playwright gates pass (Tasks 7–8).

---

### Task 1: Pure threading helpers + unit tests

Establish the tested, DOM-free core. No rendering yet.

**Files:**

- Modify: `src/chrome-client.js` (add helpers after `renderInlineMarkdown`, ~line 101; add a test seam at the end, ~line 689)
- Create: `test/helpers/chrome-harness.js` (extract the existing harness so two test files can share it)
- Modify: `test/chrome-client-queue.test.js` (import the shared harness instead of defining it inline)
- Create: `test/chrome-client-threading.test.js`

**Interfaces:**

- Produces (all pure, defined in `chrome-client.js`):
  - `resolveRootId(id: string, byId: Map<string, Msg>): string`
  - `groupThreads(messages: Msg[]): { roots: Msg[], repliesByRoot: Map<string, Msg[]> }`
  - `formatRelativeTime(at: number, now: number): string`
  - `threadChipLabel(count: number, lastAt: number, now: number): string`
  - `shouldFlagBackBadge(openRootId: string, message: Msg, byId: Map<string, Msg>): boolean`
  - where `Msg = { id?: string, role: string, text: string, reply_to?: string, at?: number }`
- The harness exposes these via `globalThis.__lavishTest.threading` when `globalThis.__lavishTest` is pre-seeded by a test.

- [ ] **Step 1: Extract the existing harness into a shared module**

Move the `createChromeHarness` function and its `flushPromises` helper out of `test/chrome-client-queue.test.js` into a new file `test/helpers/chrome-harness.js`, exporting both. Add one line to the `context` object so tests can read exposed helpers, and return it from the harness.

Create `test/helpers/chrome-harness.js` with the full current harness (copy `createChromeHarness` and `flushPromises` from `test/chrome-client-queue.test.js` verbatim), then make exactly these two edits inside it:

In the `context` object (alongside `clearTimeout`, `console`, …), add:

```js
    __lavishTest: { threading: {} },
```

In the returned object (alongside `element`, `frame`, …), add:

```js
    threading() {
      return context.__lavishTest.threading;
    },
```

And add `export` to both declarations:

```js
export async function createChromeHarness({
  /* …unchanged… */
} = {}) {
  /* … */
}
export function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}
```

- [ ] **Step 2: Point the existing queue test at the shared harness**

In `test/chrome-client-queue.test.js`, delete the inline `createChromeHarness` and `flushPromises` definitions (and the now-unused `readFile`/`vm`/`sourceUrl`/`defaultSessionData` plumbing they owned) and replace the top of the file with:

```js
import assert from "node:assert/strict";
import test from "node:test";

import { createChromeHarness, flushPromises } from "./helpers/chrome-harness.js";
```

Leave every `test(...)` block unchanged.

- [ ] **Step 3: Run the existing suite to verify the refactor is behavior-neutral**

Run: `cd /Users/ezeng/Coding/lavish-axi-fork && node --test test/chrome-client-queue.test.js`
Expected: PASS — all existing chrome-client tests still green (proves the harness extraction changed nothing).

- [ ] **Step 4: Write the failing threading unit tests**

Create `test/chrome-client-threading.test.js`:

```js
import assert from "node:assert/strict";
import test from "node:test";

import { createChromeHarness } from "./helpers/chrome-harness.js";

async function threading() {
  const chrome = await createChromeHarness();
  return chrome.threading();
}

function msg(id, text, replyTo, at) {
  const m = { id, role: "agent", text, at: at ?? 0 };
  if (replyTo) m.reply_to = replyTo;
  return m;
}

test("resolveRootId returns the message id when it has no reply_to", async () => {
  const { resolveRootId } = await threading();
  const byId = new Map([["a", msg("a", "root")]]);
  assert.equal(resolveRootId("a", byId), "a");
});

test("resolveRootId walks a reply chain up to the root", async () => {
  const { resolveRootId } = await threading();
  const byId = new Map([
    ["a", msg("a", "root")],
    ["b", msg("b", "reply", "a")],
    ["c", msg("c", "reply to reply", "b")],
  ]);
  assert.equal(resolveRootId("c", byId), "a");
});

test("resolveRootId is cycle-safe", async () => {
  const { resolveRootId } = await threading();
  const byId = new Map([
    ["a", msg("a", "x", "b")],
    ["b", msg("b", "y", "a")],
  ]);
  // Returns one of the two ids without infinite looping.
  assert.ok(["a", "b"].includes(resolveRootId("a", byId)));
});

test("resolveRootId treats a dangling reply_to as a root", async () => {
  const { resolveRootId } = await threading();
  const byId = new Map([["b", msg("b", "orphan reply", "missing")]]);
  assert.equal(resolveRootId("b", byId), "b");
});

test("groupThreads separates roots from replies and flattens nesting", async () => {
  const { groupThreads } = await threading();
  const messages = [
    msg("a", "root A"),
    msg("b", "reply to A", "a"),
    msg("c", "root C"),
    msg("d", "reply to reply", "b"),
  ];
  const { roots, repliesByRoot } = groupThreads(messages);
  assert.deepEqual(
    roots.map((m) => m.id),
    ["a", "c"],
  );
  assert.deepEqual(
    (repliesByRoot.get("a") || []).map((m) => m.id),
    ["b", "d"],
  );
  assert.equal((repliesByRoot.get("c") || []).length, 0);
});

test("groupThreads keeps id-less optimistic messages as roots", async () => {
  const { groupThreads } = await threading();
  const messages = [{ role: "user", text: "pending", at: 1 }];
  const { roots } = groupThreads(messages);
  assert.equal(roots.length, 1);
});

test("formatRelativeTime renders coarse buckets", async () => {
  const { formatRelativeTime } = await threading();
  assert.equal(formatRelativeTime(1000, 1000), "just now");
  assert.equal(formatRelativeTime(0, 30_000), "30s");
  assert.equal(formatRelativeTime(0, 5 * 60_000), "5m");
  assert.equal(formatRelativeTime(0, 3 * 3_600_000), "3h");
  assert.equal(formatRelativeTime(0, 2 * 86_400_000), "2d");
  assert.equal(formatRelativeTime(undefined, 1000), "");
});

test("threadChipLabel pluralizes and appends the last-reply time", async () => {
  const { threadChipLabel } = await threading();
  assert.equal(threadChipLabel(1, 0, 30_000), "1 reply · 30s");
  assert.equal(threadChipLabel(3, 0, 5 * 60_000), "3 replies · 5m");
  assert.equal(threadChipLabel(2, undefined, 0), "2 replies");
});

test("shouldFlagBackBadge is true only for activity outside the open thread", async () => {
  const { shouldFlagBackBadge } = await threading();
  const byId = new Map([
    ["a", msg("a", "root A")],
    ["b", msg("b", "reply to A", "a")],
    ["c", msg("c", "root C")],
  ]);
  assert.equal(shouldFlagBackBadge("a", byId.get("b"), byId), false); // same thread
  assert.equal(shouldFlagBackBadge("a", byId.get("c"), byId), true); // different root
  assert.equal(shouldFlagBackBadge("", byId.get("c"), byId), false); // no thread open
});
```

- [ ] **Step 5: Run the threading tests to verify they fail**

Run: `cd /Users/ezeng/Coding/lavish-axi-fork && node --test test/chrome-client-threading.test.js`
Expected: FAIL — `chrome.threading()` returns `{}` (helpers not defined/exposed yet), so destructured functions are `undefined`.

- [ ] **Step 6: Add the pure helpers to `chrome-client.js`**

Insert immediately after `renderInlineMarkdown` (after the closing `}` at ~line 101):

```js
/**
 * @typedef {{ id?: string, role: string, text: string, reply_to?: string, at?: number }} ChatMsg
 */

// Walk reply_to up to the thread root id. Cycle- and dangling-safe: returns the topmost id with no
// reply_to, or the current id if the chain loops or points at a missing message.
/** @param {string} id @param {Map<string, ChatMsg>} byId @returns {string} */
function resolveRootId(id, byId) {
  const seen = new Set();
  let curId = String(id);
  for (;;) {
    if (seen.has(curId)) return curId;
    seen.add(curId);
    const current = byId.get(curId);
    if (!current || !current.reply_to) return curId;
    const parentId = String(current.reply_to);
    if (!byId.has(parentId)) return curId;
    curId = parentId;
  }
}

// Split a flat, chronological transcript into roots (no reply_to) and replies grouped under their
// resolved root. One level deep: nested replies land flat under the same root.
/** @param {ChatMsg[]} messages @returns {{ roots: ChatMsg[], repliesByRoot: Map<string, ChatMsg[]> }} */
function groupThreads(messages) {
  const byId = new Map();
  for (const m of messages) {
    if (m && m.id != null && m.id !== "") byId.set(String(m.id), m);
  }
  const roots = [];
  const repliesByRoot = new Map();
  for (const m of messages) {
    if (!m) continue;
    const id = m.id != null ? String(m.id) : "";
    const rootId = id ? resolveRootId(id, byId) : "";
    if (!id || !m.reply_to || rootId === id) {
      roots.push(m);
      if (id && !repliesByRoot.has(id)) repliesByRoot.set(id, []);
      continue;
    }
    if (!repliesByRoot.has(rootId)) repliesByRoot.set(rootId, []);
    (repliesByRoot.get(rootId) || []).push(m);
  }
  return { roots, repliesByRoot };
}

// Coarse relative time for thread chips ("just now", "30s", "5m", "3h", "2d").
/** @param {number} at @param {number} now @returns {string} */
function formatRelativeTime(at, now) {
  const t = Number(at);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** @param {number} count @param {number} lastAt @param {number} now @returns {string} */
function threadChipLabel(count, lastAt, now) {
  const noun = count === 1 ? "reply" : "replies";
  const rel = formatRelativeTime(lastAt, now);
  return rel ? `${count} ${noun} · ${rel}` : `${count} ${noun}`;
}

// True when a thread is open and an incoming message belongs to a different thread/root, so the
// Back button should show an unread badge.
/** @param {string} openRootId @param {ChatMsg} message @param {Map<string, ChatMsg>} byId @returns {boolean} */
function shouldFlagBackBadge(openRootId, message, byId) {
  if (!openRootId) return false;
  const id = message && message.id != null ? String(message.id) : "";
  if (!id) return false;
  return resolveRootId(id, byId) !== String(openRootId);
}
```

- [ ] **Step 7: Add the test seam at the end of `chrome-client.js`**

Append at the very end of the file (after `setAgentPresence("waiting");`):

```js
// Test seam: a harness pre-seeds globalThis.__lavishTest, letting the pure threading helpers be
// unit-tested without a DOM. No-op in the browser, where the key is never set.
if (globalThis.__lavishTest) {
  globalThis.__lavishTest.threading = {
    resolveRootId,
    groupThreads,
    formatRelativeTime,
    threadChipLabel,
    shouldFlagBackBadge,
  };
}
```

- [ ] **Step 8: Run the threading tests to verify they pass**

Run: `cd /Users/ezeng/Coding/lavish-axi-fork && node --test test/chrome-client-threading.test.js`
Expected: PASS — all nine threading tests green.

- [ ] **Step 9: Run the full check and commit**

Run: `cd /Users/ezeng/Coding/lavish-axi-fork && npm run check`
Expected: PASS (build, lint, format, typecheck, all tests, skill check).

```bash
cd /Users/ezeng/Coding/lavish-axi-fork
git add src/chrome-client.js test/helpers/chrome-harness.js test/chrome-client-queue.test.js test/chrome-client-threading.test.js
git commit -m "feat(ui): pure threading helpers (root resolve, grouping, chip, badge) + tests"
```

---

### Task 2: Thread-pane HTML scaffold in `createChromeHtml`

Add the markup the client will drive. Behavior comes later; this task just makes the structure (and its element ids) exist.

**Files:**

- Modify: `src/server.js` (`createChromeHtml`, the `<aside class="panel">…</aside>` block on line 941)
- Modify: `test/server.test.js` (add a scaffold assertion)

**Interfaces:**

- Produces these element ids for later tasks: `chatPane`, `threadPane`, `threadBack`, `backBadge`, `threadTitle`, `threadChat`, `threadInput`, `threadSend`, `threadReplyIndicator`, `threadReplyIndicatorText`, `threadReplyIndicatorClear`. Keeps existing ids: `chatLog`, `chatInput`, `send`, `sendActions`, `sendMenu`, `presenceBanner`, `annotationPills`.

- [ ] **Step 1: Write the failing scaffold test**

In `test/server.test.js`, add (near the other `createChromeHtml` assertions; if none exist, add a new `test(...)` that imports `createChromeHtml` from `../src/server.js`):

```js
test("createChromeHtml includes the thread-pane scaffold", () => {
  const html = createChromeHtml({ key: "k", file: "/tmp/a.html", chat: [] });
  assert.match(html, /id="chatPane"/);
  assert.match(html, /id="threadPane"/);
  assert.match(html, /id="threadBack"/);
  assert.match(html, /id="backBadge"/);
  assert.match(html, /id="threadChat"/);
  assert.match(html, /id="threadInput"/);
  assert.match(html, /id="threadSend"/);
});
```

(If `createChromeHtml` is not yet imported in `test/server.test.js`, add it to the existing import from `../src/server.js`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/ezeng/Coding/lavish-axi-fork && node --test test/server.test.js`
Expected: FAIL — the new ids are not in the HTML.

- [ ] **Step 3: Restructure the panel markup**

In `src/server.js`, replace the entire `<aside class="panel">…</aside>` substring on line 941 with the following (it wraps the existing chat + composer in `<div class="chat-pane" id="chatPane">`, removes the old `reply-indicator` from the main composer, and appends the `thread-pane`):

```html
<aside class="panel">
  <div class="chat-pane" id="chatPane">
    <h2>Conversation</h2>
    <div class="chat" id="chatLog"></div>
    <div class="composer">
      <div class="presence-banner" id="presenceBanner" hidden>
        Your agent is not listening. If this persists, ask your agent to poll for updates from Lavish.
      </div>
      <div class="annotation-pills" id="annotationPills"></div>
      <textarea id="chatInput" placeholder="Write a message for the agent..."></textarea>
      <div class="actions" id="sendActions">
        <span class="send-hint" id="sendHint" hidden>Write a message or annotate an element first.</span>
        <div class="split">
          <button class="button send-main" id="send">Send to Agent</button
          ><button
            class="button send-caret"
            id="sendCaret"
            type="button"
            title="Send options"
            aria-haspopup="menu"
            aria-expanded="false"
          >
            ${chromeIcons.caret}
          </button>
        </div>
        <div class="menu send-menu" id="sendMenu" hidden>
          <button class="menu-item" id="sendFromMenu" type="button">
            ${chromeIcons.send}<span>Send to Agent</span></button
          ><button class="menu-item danger" id="sendAndEnd" type="button">
            ${chromeIcons.exit}<span>Send &amp; end session</span>
          </button>
        </div>
      </div>
    </div>
  </div>
  <div class="thread-pane" id="threadPane">
    <div class="thread-head">
      <button class="thread-back" id="threadBack" type="button">
        &lsaquo; Back<span class="back-badge" id="backBadge" hidden></span></button
      ><span class="thread-title" id="threadTitle">Thread</span>
    </div>
    <div class="chat thread-chat" id="threadChat"></div>
    <div class="composer">
      <div class="reply-indicator" id="threadReplyIndicator" hidden>
        <span class="reply-indicator-label">Replying to:</span
        ><span class="reply-indicator-text" id="threadReplyIndicatorText"></span
        ><button
          class="reply-indicator-clear"
          id="threadReplyIndicatorClear"
          type="button"
          title="Reply to the whole thread"
        >
          &times;
        </button>
      </div>
      <textarea id="threadInput" placeholder="Reply in thread..."></textarea>
      <div class="actions">
        <div class="split"><button class="button send-main" id="threadSend">Reply</button></div>
      </div>
    </div>
  </div>
</aside>
```

Note: the old `replyIndicator`/`replyIndicatorText`/`replyIndicatorClear` ids are intentionally gone from the main composer (replies now happen in the thread). Task 5 removes their now-dead references in `chrome-client.js`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/ezeng/Coding/lavish-axi-fork && node --test test/server.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/ezeng/Coding/lavish-axi-fork
git add src/server.js test/server.test.js
git commit -m "feat(ui): thread-pane scaffold in chrome HTML (chat-pane + thread-pane)"
```

---

### Task 3: Thread-panel CSS

Style the two panes, the slide-out, the thread chip, the Back button + badge. CSS is verified visually (Task 8), so this task has no unit test; keep it self-contained and commit.

**Files:**

- Modify: `src/chrome.css` (the `.panel` block ~line 440 and the threading block ~line 515)

- [ ] **Step 1: Make the panel a positioning context for the slide-out**

Replace the `.panel` rule (lines 440–448) with:

```css
.panel {
  width: var(--panel-w);
  border-left: var(--hairline-subtle);
  background: var(--bg-panel);
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  position: relative;
  overflow: hidden;
}
.chat-pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}
```

- [ ] **Step 2: Add the thread-pane, chip, Back button, and badge styles**

Append to `src/chrome.css`:

```css
/* Thread panel (slide-out): roots stay in .chat-pane, a thread drills in over the panel. */
.thread-pane {
  position: absolute;
  inset: 0;
  z-index: 3;
  display: none;
  flex-direction: column;
  min-height: 0;
  background: var(--bg-panel);
  box-shadow: -18px 0 40px rgba(0, 0, 0, 0.28);
}
.panel.thread-open .thread-pane {
  display: flex;
  animation: thread-slide-in var(--dur-slow) var(--ease);
}
@keyframes thread-slide-in {
  from {
    transform: translateX(100%);
  }
  to {
    transform: translateX(0);
  }
}
.thread-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: var(--hairline-subtle);
  flex-shrink: 0;
}
.thread-back {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  border: var(--hairline-subtle);
  background: var(--bg);
  color: var(--fg-muted);
  font: inherit;
  font-size: 12px;
  font-weight: var(--w-semi);
  padding: 6px 12px 6px 9px;
  border-radius: var(--radius-pill);
  cursor: pointer;
}
.thread-back:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.back-badge {
  background: var(--danger);
  color: #fff;
  border-radius: var(--radius-pill);
  font-size: 10px;
  font-weight: var(--w-bold);
  padding: 0 6px;
  line-height: 16px;
  min-width: 16px;
  text-align: center;
}
.back-badge[hidden] {
  display: none;
}
.thread-title {
  font-size: 13px;
  font-weight: var(--w-semi);
  color: var(--fg-muted);
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.thread-chat .bubble {
  max-width: 100%;
}
.thread-chat .thread-root {
  border-bottom: var(--hairline-subtle);
  padding-bottom: 12px;
}
/* Reply-count chip under a root that has a thread. */
.thread-chip {
  margin-top: 8px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  font-size: 11px;
  font-weight: var(--w-bold);
  color: var(--accent);
  background: rgba(244, 201, 93, 0.1);
  border: 1px solid rgba(244, 201, 93, 0.35);
  border-radius: var(--radius-pill);
  cursor: pointer;
}
.thread-chip:hover {
  background: rgba(244, 201, 93, 0.18);
}
```

- [ ] **Step 3: Build and sanity-check the CSS compiles into dist**

Run: `cd /Users/ezeng/Coding/lavish-axi-fork && node scripts/build.js && node -e "const c=require('node:fs').readFileSync('dist/chrome.css','utf8'); if(!c.includes('thread-slide-in')) throw new Error('css not copied'); console.log('css ok')"`
Expected: prints `css ok`.

- [ ] **Step 4: Commit**

```bash
cd /Users/ezeng/Coding/lavish-axi-fork
git add src/chrome.css
git commit -m "feat(ui): thread-panel styles (slide-out pane, chip, Back button + badge)"
```

---

### Task 4: Render roots + chips in the list; render the thread; open/close

Replace the flat renderer with the threaded model and wire the slide-out.

> **Coupling note:** Tasks 4 and 5 jointly rewrite `chrome-client.js`'s chat/compose logic and are executed by a single implementer dispatch. Task 4 in isolation would not lint-clean, because removing the `replyToId`/`clearReplyTarget` declarations (Step 1/2) leaves the old `sendQueued` referencing them until Task 5's `sendQueued` rewrite. When implementing, apply Task 4 then Task 5 and ensure each commit passes `npm run check` — in practice the `sendQueued` rewrite (Task 5, Step 4) and the dead `replyIndicatorClear` wiring removal (Task 5, Step 5) must land in the SAME commit as the Task 4 state-block/render changes that orphan those symbols.

**Files:**

- Modify: `src/chrome-client.js` (state block ~lines 46–52; `addChat`/`syncChat` ~lines 210–272; new render/open/close functions; element refs)

**Interfaces:**

- Consumes from Task 1: `groupThreads`, `resolveRootId`, `threadChipLabel`.
- Produces: a client model `messagesById: Map<string, ChatMsg>` + `messageOrder: string[]`; `renderChat()`, `renderThread(rootId)`, `openThread(rootId)`, `closeThread()`; state `openThreadRootId: string`. Used by Tasks 5–6.

- [ ] **Step 1: Replace the threading state block**

Replace lines 46–52 (the `replyToId` / `chatMessages` / `replyIndicator*` block) with:

```js
// Threading: full client model rebuilt from the authoritative transcript, plus the id of the root
// whose thread is currently open ("" = none).
/** @type {Map<string, ChatMsg>} */
const messagesById = new Map();
/** @type {string[]} */
const messageOrder = [];
let openThreadRootId = "";
const chatPane = /** @type {HTMLDivElement} */ (document.getElementById("chatPane"));
const panel = chatPane?.parentElement || null;
const threadChat = /** @type {HTMLDivElement} */ (document.getElementById("threadChat"));
const threadTitle = /** @type {HTMLSpanElement} */ (document.getElementById("threadTitle"));
const threadBack = /** @type {HTMLButtonElement} */ (document.getElementById("threadBack"));
const backBadge = /** @type {HTMLSpanElement} */ (document.getElementById("backBadge"));
const threadInput = /** @type {HTMLTextAreaElement} */ (document.getElementById("threadInput"));
const threadSend = /** @type {HTMLButtonElement} */ (document.getElementById("threadSend"));
const threadReplyIndicator = /** @type {HTMLDivElement} */ (document.getElementById("threadReplyIndicator"));
const threadReplyIndicatorText = /** @type {HTMLSpanElement} */ (document.getElementById("threadReplyIndicatorText"));
const threadReplyIndicatorClear = /** @type {HTMLButtonElement} */ (
  document.getElementById("threadReplyIndicatorClear")
);
let threadReplyToId = "";
```

- [ ] **Step 2: Add a bubble builder and replace `addChat`/`truncateQuote`/`setReplyTarget`/`clearReplyTarget`/`syncChat`**

Replace the block from `function addChat(` (line 210) through the end of `syncChat` (line 272) with:

```js
// Build one chat bubble element. `withChip` adds a thread chip to a root that has replies; `inThread`
// renders without a Reply affordance (the thread composer is the reply path) and pins the root.
function buildBubble(message, { chip = null, isRoot = false } = {}) {
  const el = document.createElement("div");
  el.className = "bubble " + message.role + (isRoot ? " thread-root" : "");
  if (message.id) el.dataset.messageId = String(message.id);
  const body = message.role === "agent" ? renderInlineMarkdown(message.text) : escapeHtml(message.text);
  let html = "<small>" + (message.role === "agent" ? "Agent" : "You") + "</small><div>" + body + "</div>";
  if (chip) {
    html +=
      '<button class="thread-chip" type="button" data-root-id="' +
      escapeHtml(String(message.id)) +
      '">' +
      escapeHtml(chip) +
      "</button>";
  }
  el.innerHTML = html;
  const chipButton = el.querySelector(".thread-chip");
  if (chipButton) chipButton.addEventListener("click", () => openThread(String(message.id)));
  return el;
}

// Append a message to the in-memory model (used for optimistic local sends and incoming events).
function rememberMessage(message) {
  if (!message) return;
  const id = message.id != null ? String(message.id) : "";
  if (id) {
    if (!messagesById.has(id)) messageOrder.push(id);
    messagesById.set(id, message);
  } else {
    messageOrder.push("");
  }
}

// Rebuild the whole model from the authoritative transcript.
function setMessages(chat) {
  messagesById.clear();
  messageOrder.length = 0;
  for (const item of chat) {
    rememberMessage({
      id: item.id,
      role: item.role,
      text: item.text,
      reply_to: item.reply_to,
      at: item.at,
    });
  }
}

function orderedMessages() {
  const seen = new Set();
  const list = [];
  for (const id of messageOrder) {
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
      const m = messagesById.get(id);
      if (m) list.push(m);
    }
  }
  return list;
}

// Render only roots into the main list, each with a thread chip when it has replies.
function renderChat() {
  for (const el of [...chatLog.querySelectorAll(".bubble.user,.bubble.agent:not(.agent-working)")]) {
    el.remove();
  }
  const { roots, repliesByRoot } = groupThreads(orderedMessages());
  const now = Date.now();
  const reference = workingBubble && workingBubble.parentElement === chatLog ? workingBubble : null;
  for (const root of roots) {
    const id = root.id != null ? String(root.id) : "";
    const replies = id ? repliesByRoot.get(id) || [] : [];
    let chip = null;
    if (replies.length) {
      const lastAt = replies[replies.length - 1].at;
      chip = threadChipLabel(replies.length, lastAt, now);
    }
    chatLog.insertBefore(buildBubble(root, { chip }), reference);
  }
  chatLog.scrollTop = chatLog.scrollHeight;
}

// Render the open thread: pinned root, a count rule, then replies in time order.
function renderThread(rootId) {
  threadChat.innerHTML = "";
  const root = messagesById.get(String(rootId));
  if (!root) return;
  const { repliesByRoot } = groupThreads(orderedMessages());
  const replies = repliesByRoot.get(String(rootId)) || [];
  threadTitle.textContent = replies.length
    ? threadChipLabel(replies.length, replies[replies.length - 1].at, Date.now())
    : "Thread";
  threadChat.appendChild(buildBubble(root, { isRoot: true }));
  for (const reply of replies) threadChat.appendChild(buildBubble(reply));
  threadChat.scrollTop = threadChat.scrollHeight;
}

function setBackBadge(visible) {
  if (!backBadge) return;
  backBadge.hidden = !visible;
  if (visible) backBadge.textContent = "new";
}

function openThread(rootId) {
  openThreadRootId = String(rootId);
  clearThreadReplyTarget();
  renderThread(openThreadRootId);
  setBackBadge(false);
  if (panel) panel.classList.add("thread-open");
  if (threadInput) threadInput.focus();
}

function closeThread() {
  openThreadRootId = "";
  setBackBadge(false);
  if (panel) panel.classList.remove("thread-open");
}

// Re-render the list and, if a thread is open, the thread view, from the current model.
function syncChat(chat) {
  setMessages(chat);
  renderChat();
  if (workingBubble) chatLog.appendChild(workingBubble);
  if (openThreadRootId) {
    if (messagesById.has(openThreadRootId)) renderThread(openThreadRootId);
    else closeThread();
  }
  chatLog.scrollTop = chatLog.scrollHeight;
}

function clearThreadReplyTarget() {
  threadReplyToId = "";
  if (threadReplyIndicator) threadReplyIndicator.hidden = true;
}
```

- [ ] **Step 3: Update `setAgentPresence` to use the model-aware render**

In `setAgentPresence` (now shifted), the working bubble is still appended to `chatLog` directly — no change needed there, but confirm `renderChat` keeps it last (it inserts roots before the working bubble via `reference`). No code change in this step; this is a read-and-verify step.

- [ ] **Step 4: Update the bottom-of-file bootstrap and event wiring**

Replace the initial render block at the end of the file. Change line 687 from:

```js
initialChat.forEach((item) => addChat(item.role, item.text, { id: item.id, reply_to: item.reply_to }));
```

to:

```js
syncChat(initialChat);
```

And wire the Back button — add near the other wiring (e.g., after the `replyIndicatorClear` line is removed in Task 5, but it is safe to add here):

```js
if (threadBack) threadBack.addEventListener("click", () => closeThread());
```

- [ ] **Step 5: Update the `agent-reply` SSE handler to use the model**

Replace the `agent-reply` listener (lines 677–680) with:

```js
events.addEventListener("agent-reply", (event) => {
  const data = JSON.parse(event.data);
  ingestIncoming({ id: data.id, role: "agent", text: data.text, reply_to: data.reply_to, at: data.at });
});
```

Add `ingestIncoming` (place it just above the `events` wiring). For this task it simply remembers + re-renders; Task 6 adds the live-append and badge:

```js
function ingestIncoming(message) {
  if (!message || !message.text) return;
  rememberMessage(message);
  renderChat();
  if (workingBubble) chatLog.appendChild(workingBubble);
  if (openThreadRootId) renderThread(openThreadRootId);
}
```

- [ ] **Step 6: Build, run the full check (existing tests must still pass), and verify boot**

Run: `cd /Users/ezeng/Coding/lavish-axi-fork && npm run check`
Expected: PASS. The queue/layout-gate tests still pass because their assertions (queued prompts, layout gate, fetch posts) are unaffected; the harness boots the rewritten file without throwing (all new `getElementById` ids resolve to harness stubs).

- [ ] **Step 7: Commit**

```bash
cd /Users/ezeng/Coding/lavish-axi-fork
git add src/chrome-client.js
git commit -m "feat(ui): render roots + thread chips, slide-out thread view, open/close"
```

---

### Task 5: Reply flow — main composer starts roots, thread composer sends replies

**Files:**

- Modify: `src/chrome-client.js` (`sendQueued` ~line 340; add `sendThreadReply`; remove dead `replyToId`/`replyIndicator*` references; event wiring ~lines 639–688)
- Modify: `test/chrome-client-threading.test.js` (add a reply-posting integration test through the harness)

**Interfaces:**

- Consumes: `openThreadRootId`, `threadReplyToId`, `requestSnapshot`, `submitQueued` (existing snapshot→submit pipeline).
- Produces: thread replies posted to `/api/:key/prompts` with a `reply_to` field.

- [ ] **Step 1: Extend the test seam to expose `openThread` (the fake DOM cannot click a chip)**

In `chrome-client.js`, update the seam block from Task 1/Step 7 to also expose the opener:

```js
if (globalThis.__lavishTest) {
  globalThis.__lavishTest.threading = {
    resolveRootId,
    groupThreads,
    formatRelativeTime,
    threadChipLabel,
    shouldFlagBackBadge,
  };
  globalThis.__lavishTest.openThread = openThread;
}
```

In `test/helpers/chrome-harness.js`, add to the returned object:

```js
    threadingOpen(id) {
      return context.__lavishTest.openThread(id);
    },
```

- [ ] **Step 2: Write the failing reply-posting test**

Add to `test/chrome-client-threading.test.js` (add `flushPromises` to the existing import from `./helpers/chrome-harness.js`):

```js
test("thread composer posts a reply carrying reply_to", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return { ok: true };
    },
  });

  // Seed a root via the transcript, open its thread, type a reply, send through the snapshot path.
  chrome.eventSource().listeners.get("chat-sync")({
    data: JSON.stringify({ chat: [{ id: "root1", role: "agent", text: "Root message", at: 1 }] }),
  });
  chrome.threadingOpen("root1");
  chrome.element("threadInput").value = "A threaded reply";
  chrome.element("threadSend").onclick();
  chrome.sendFrameMessage({ type: "lavish:snapshot", snapshot: "uid=1 body" });
  await flushPromises();

  const replyPost = posts.find((p) => p.url === "/api/abc/prompts");
  assert.ok(replyPost, "a prompts POST was made");
  assert.equal(replyPost.body.prompts[0].reply_to, "root1");
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd /Users/ezeng/Coding/lavish-axi-fork && node --test test/chrome-client-threading.test.js`
Expected: FAIL — there is no `threadSend` handler yet, so no `reply_to` post.

- [ ] **Step 4: Make the main composer send roots only**

In `sendQueued` (line 340), remove the `reply_to` attachment and the optimistic `reply_to`. Replace lines 346–360 (the `const text = …` block through `render();`) with:

```js
const text = chatInput.value.trim();
if (text) {
  const message = { uid: "", prompt: text, selector: "", tag: "message", text: "Freeform message" };
  queued.push(message);
  persistQueuedPrompts();
  rememberMessage({ role: "user", text });
  renderChat();
  if (workingBubble) chatLog.appendChild(workingBubble);
  chatInput.value = "";
  render();
}
```

- [ ] **Step 5: Add `sendThreadReply` and its submit path**

Add after `sendQueued` (before `submitQueued`):

```js
// Send a reply from the thread composer. Carries reply_to (the targeted sub-message, or the open
// thread's root) so the server threads it and the agent sees what it answered.
function sendThreadReply() {
  if (ended || !openThreadRootId) return;
  const text = threadInput.value.trim();
  if (!text) return;
  const replyTo = threadReplyToId || openThreadRootId;
  const message = { uid: "", prompt: text, selector: "", tag: "message", text: "Freeform message", reply_to: replyTo };
  queued.push(message);
  persistQueuedPrompts();
  rememberMessage({ role: "user", text, reply_to: replyTo });
  renderChat();
  if (workingBubble) chatLog.appendChild(workingBubble);
  renderThread(openThreadRootId);
  threadInput.value = "";
  clearThreadReplyTarget();
  render();
  requestSnapshot("submit");
}
```

- [ ] **Step 6: Remove dead reply-indicator references and wire the thread composer**

Delete the now-dead line near the bottom (line 684):

```js
if (replyIndicatorClear) replyIndicatorClear.onclick = () => clearReplyTarget();
```

Add thread composer wiring near the other input wiring (after the `chatInput` keydown handler, ~line 649):

```js
if (threadSend) threadSend.onclick = () => sendThreadReply();
if (threadInput) {
  threadInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendThreadReply();
    }
  });
}
if (threadReplyIndicatorClear) threadReplyIndicatorClear.onclick = () => clearThreadReplyTarget();
```

- [ ] **Step 7: Run the threading tests, then the full check**

Run: `cd /Users/ezeng/Coding/lavish-axi-fork && node --test test/chrome-client-threading.test.js`
Expected: PASS (reply posts with `reply_to: "root1"`).

Run: `cd /Users/ezeng/Coding/lavish-axi-fork && npm run check`
Expected: PASS — and note the existing queue test still posts prompts without `reply_to` for the main composer.

- [ ] **Step 8: Commit**

```bash
cd /Users/ezeng/Coding/lavish-axi-fork
git add src/chrome-client.js test/chrome-client-threading.test.js test/helpers/chrome-harness.js
git commit -m "feat(ui): main composer starts roots; thread composer sends replies with reply_to"
```

---

### Task 6: Live-update routing — append into the open thread or flag the Back badge

**Files:**

- Modify: `src/chrome-client.js` (`ingestIncoming` from Task 4)
- Modify: `test/chrome-client-threading.test.js` (badge behavior tests)

**Interfaces:**

- Consumes: `shouldFlagBackBadge`, `openThreadRootId`, `messagesById`.
- Produces: Back badge visibility driven by cross-thread activity; live thread append.

- [ ] **Step 1: Write the failing badge tests**

Add to `test/chrome-client-threading.test.js`:

```js
test("incoming reply to the open thread does not flag the Back badge", async () => {
  const chrome = await createChromeHarness();
  chrome.eventSource().listeners.get("chat-sync")({
    data: JSON.stringify({ chat: [{ id: "root1", role: "agent", text: "Root", at: 1 }] }),
  });
  chrome.threadingOpen("root1");
  chrome.eventSource().listeners.get("agent-reply")({
    data: JSON.stringify({ id: "r2", role: "agent", text: "in-thread reply", reply_to: "root1", at: 2 }),
  });
  assert.equal(chrome.element("backBadge").hidden, true);
});

test("incoming activity outside the open thread flags the Back badge", async () => {
  const chrome = await createChromeHarness();
  chrome.eventSource().listeners.get("chat-sync")({
    data: JSON.stringify({ chat: [{ id: "root1", role: "agent", text: "Root", at: 1 }] }),
  });
  chrome.threadingOpen("root1");
  chrome.eventSource().listeners.get("agent-reply")({
    data: JSON.stringify({ id: "root2", role: "agent", text: "a new root", at: 2 }),
  });
  assert.equal(chrome.element("backBadge").hidden, false);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd /Users/ezeng/Coding/lavish-axi-fork && node --test test/chrome-client-threading.test.js`
Expected: FAIL — `ingestIncoming` does not yet set the badge.

- [ ] **Step 3: Implement badge + live-append routing in `ingestIncoming`**

Replace `ingestIncoming` (from Task 4) with:

```js
function ingestIncoming(message) {
  if (!message || !message.text) return;
  const flagBadge = shouldFlagBackBadge(openThreadRootId, message, messagesById) || flagsNewRoot(message);
  rememberMessage(message);
  renderChat();
  if (workingBubble) chatLog.appendChild(workingBubble);
  if (openThreadRootId) {
    renderThread(openThreadRootId);
    if (flagBadge) setBackBadge(true);
  }
}

// A brand-new root (no reply_to, not yet in the model) is "outside" any open thread, so it should
// also flag the badge. shouldFlagBackBadge already covers replies to other roots.
function flagsNewRoot(message) {
  if (!openThreadRootId) return false;
  const id = message.id != null ? String(message.id) : "";
  return !message.reply_to && id !== openThreadRootId;
}
```

- [ ] **Step 4: Run the threading tests, then the full check**

Run: `cd /Users/ezeng/Coding/lavish-axi-fork && node --test test/chrome-client-threading.test.js`
Expected: PASS (both badge tests + earlier tests).

Run: `cd /Users/ezeng/Coding/lavish-axi-fork && npm run check`
Expected: PASS.

- [ ] **Step 5: Build and commit**

```bash
cd /Users/ezeng/Coding/lavish-axi-fork
node scripts/build.js
git add src/chrome-client.js test/chrome-client-threading.test.js
git commit -m "feat(ui): live-route agent replies into the open thread; Back badge for outside activity"
```

---

### Task 7: Codex ↔ Claude convergence review (required pre-push gate)

Run the adversarial cross-AI loop over BOTH the previously unreviewed UI commits and the new thread-panel work. This is a gate, not a code task; there is no new test file, but every accepted finding is fixed test-first and the suite stays green.

**Scope of the diff to review:** `git diff d6fed75..HEAD` (covers `bec8d91` wrap fix, `d76b9c0` markdown/reply-to-own, and Tasks 1–6).

- [ ] **Step 1: Capture the review diff**

```bash
cd /Users/ezeng/Coding/lavish-axi-fork
git diff d6fed75..HEAD > /private/tmp/claude-503/-Users-ezeng-Coding-company-framework/eaf52ee2-48de-403f-9860-e1614d2d58e1/scratchpad/thread-panel-review.diff
```

- [ ] **Step 2: Run the Codex reviewer (background, no `timeout` wrapper)**

Write a review prompt to `scratchpad/codex-prompt.txt` (ask Codex to review the diff for correctness, XSS/escaping in the new innerHTML paths, threading edge cases, event-listener leaks, and the removed reply-indicator dead code), then:

```bash
codex exec --sandbox read-only - < /private/tmp/claude-503/-Users-ezeng-Coding-company-framework/eaf52ee2-48de-403f-9860-e1614d2d58e1/scratchpad/codex-prompt.txt
```

Run it in the background; bound a hang by killing `pkill -f "codex exec"`. (macOS has no GNU `timeout`.)

- [ ] **Step 3: Run a blind Claude reviewer**

Dispatch a `general-purpose` subagent with ONLY the diff and the spec (`docs/superpowers/specs/2026-06-24-thread-panel-design.md`), asking for an independent severity-ranked review with no knowledge of the Codex findings.

- [ ] **Step 4: Verify every finding, fix real ones test-first, reject wrong ones**

For each accepted finding: write a failing test (where unit-testable), fix, confirm green, commit. Re-run both reviewers each round. Repeat until BOTH agree there are no remaining BLOCKER/HIGH/MEDIUM findings. Pay special attention to: HTML escaping in `buildBubble` (chip label and message text), listener accumulation on re-render, and the `reply_to` validation still enforced server-side.

- [ ] **Step 5: Final full check**

Run: `cd /Users/ezeng/Coding/lavish-axi-fork && npm run check`
Expected: PASS.

---

### Task 8: Playwright E2E verification (required pre-push gate)

Verify the running product as an end user would, per the engineering bar. Playwright is used out-of-repo (do NOT add it to `package.json`).

**Files:**

- Create: `scratchpad/verify-thread-panel.mjs` (Playwright script; lives in the session scratchpad, not the repo)
- Create: a tiny test artifact HTML to review (e.g. `scratchpad/verify-artifact.html`)

- [ ] **Step 1: Rebuild and start a lavish session**

```bash
cd /Users/ezeng/Coding/lavish-axi-fork && node scripts/build.js
lavish-axi ~/path/to/scratchpad/verify-artifact.html
```

Capture the printed `url` and session `key`.

- [ ] **Step 2: Write the Playwright verification script**

`scratchpad/verify-thread-panel.mjs` should, against the session URL (use `npx playwright` or a globally available playwright):

1. Seed a root: `POST /api/<key>/agent-reply {text:"Root message about the hero"}` → capture id `A`.
2. Seed a reply: `POST /api/<key>/agent-reply {text:"A threaded reply", reply_to:A}`.
3. Open the chrome page; assert a `.thread-chip` reading `1 reply` is visible on root `A`.
4. Click the chip; assert `.panel.thread-open` and that `#threadChat` shows both the root and the reply.
5. While the thread is open, seed a new root: `POST /api/<key>/agent-reply {text:"Unrelated new root"}`; assert `#backBadge` becomes visible.
6. Type into `#threadInput` and click `#threadSend`; assert the optimistic reply appears in `#threadChat`.
7. Assert no horizontal overflow: `document.documentElement.scrollWidth <= window.innerWidth`.

- [ ] **Step 3: Run the verification and confirm every assertion passes**

Run the script; expected: all assertions pass, screenshot saved. Fix any real defect found (loop back through the relevant task), rebuild, re-verify.

- [ ] **Step 4: End the session**

```bash
lavish-axi end ~/path/to/scratchpad/verify-artifact.html
```

---

### Task 9: Push to the fork

- [ ] **Step 1: Confirm gates are green**

Confirm Task 7 (both reviewers agree) and Task 8 (all Playwright assertions pass) are complete and `npm run check` is green on HEAD.

- [ ] **Step 2: Push**

```bash
cd /Users/ezeng/Coding/lavish-axi-fork
git push fork feat/realtime-sse-threading
```

(Remote `fork` is `git@github.com:eloise-idealab/lavish-axi.git` — SSH auths as eloise-idealab; do not use the HTTPS `origin`.)

- [ ] **Step 3: Report the pushed range and the PR-create URL**

Report `git log --oneline d6fed75..HEAD` and the PR URL: `https://github.com/eloise-idealab/lavish-axi/pull/new/feat/realtime-sse-threading`.

---

## Self-Review

**Spec coverage:**

- Placement (drill-in slide-out) → Tasks 2 (scaffold), 3 (CSS), 4 (open/close). ✅
- One-level threading derived client-side, server untouched → Task 1 (helpers), Task 4 (render); no server handler touched (only the `createChromeHtml` template). ✅
- Roots in list, replies in thread, chips on roots with ≥1 reply → Task 4. ✅
- Main composer starts roots; reply only inside a thread; old reply-indicator removed → Task 2 (markup removal), Task 5. ✅
- Live updates + Back badge → Task 6. ✅
- Edge cases (dangling/cyclic reply_to, id-less optimistic, agent-working placeholder, reload rebuild) → Task 1 tests + Task 4 `renderChat`/`syncChat`. ✅
- Testing strategy (pure helpers unit-tested, E2E live) → Task 1 + Task 8. ✅
- Convergence review of prior commits + this work before push → Task 7. ✅

**Placeholder scan:** None. Every code step contains concrete, final code. (Task 5 was reordered so the `threadingOpen` seam is established before the test that uses it.) Task 8's Playwright script is described as numbered assertions rather than full code because it is an out-of-repo, environment-specific harness driven during the verification gate, not committed source.

**Type consistency:** `messagesById`/`messageOrder`/`openThreadRootId`/`threadReplyToId` names are consistent across Tasks 4–6. Helper names (`resolveRootId`, `groupThreads`, `formatRelativeTime`, `threadChipLabel`, `shouldFlagBackBadge`) match between Task 1 definitions, the seam, and Tasks 4–6 call sites. Element ids match between Task 2 markup and Task 4 refs.
