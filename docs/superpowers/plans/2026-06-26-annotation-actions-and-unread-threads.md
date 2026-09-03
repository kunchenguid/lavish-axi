# Annotation actions + Unread thread replies — Implementation Plan

> **Status: SHIPPED.** This plan was implemented and merged on branch `merge/main-into-sse`; it is kept as a historical record of how the work was scoped, not as outstanding work. The unchecked `- [ ]` boxes below are the original task list as written before implementation - do not re-execute this plan. The current behavior contract lives in README.md (user-facing), the `lavish-axi` CLI guidance strings (agent-facing), and AGENTS.md (architecture invariants).

> **For agentic workers (historical):** this plan was executed with superpowers:subagent-driven-development. Steps used checkbox (`- [ ]`) syntax for tracking while it was in flight.

**Goal:** Two independent lavish-chrome improvements shipped together — (A) make the annotation card's three actions explicit (Cancel / Queue / Send), and (B) mark thread chips that have unread replies (solid brass + dot + "N new").

**Architecture:** (A) is a self-contained change to the in-iframe annotation card in `src/artifact-sdk.js` (markup + wiring + shadow-DOM styles). (B) adds a session-only client-side read model to `src/chrome-client.js` (a `seenReplyCount` map + pure helpers) plus an unread chip style in `src/chrome.css`. Neither touches the server, the thread/reply model, or each other.

**Tech Stack:** Vanilla browser JS (classic scripts, no bundler), plain CSS with design tokens, `node:test` + the `node:vm` fake-DOM harness (`test/helpers/chrome-harness.js`) for unit tests, Playwright (out-of-repo) for the E2E gate.

## Global Constraints

- `npm run check` must be green before every commit: `build` → `lint` (eslint, incl. `no-undef`/`no-unused-vars`) → `format:check` (prettier) → `typecheck` (`tsc --noEmit`, checkJs on — annotate with JSDoc) → `test` (`node --test`) → `build-skill --check`.
- `src/chrome-client.js` and `src/artifact-sdk.js` are CLASSIC scripts (no ESM `import`/`export` added to runtime code paths). `src/artifact-sdk.js` exports helpers for tests but `createArtifactSdk` is serialized via `.toString()` into the page, so anything used inside it must be DEFINED inside it. Do NOT change `scripts/build.js`.
- The server (`src/server.js`), the thread/reply model, the Back-badge logic, and the queue/pill message contract (`lavish:queuePrompt`, `lavish:sendQueuedPrompts`) are reused unchanged.
- Line numbers below are approximate (earlier edits drift them); locate every edit by the quoted content.
- Branch is `feat/realtime-sse-threading`; commit there. Do NOT push until the convergence + Playwright gates pass (see Gates).
- Rebuild with `node scripts/build.js` after editing `src/`.

---

## Feature A — Annotation actions (Cancel / Queue / Send)

Spec: `docs/superpowers/specs/2026-06-26-annotation-actions-design.md`.
Today the card row is `[Cancel] [Queue]` (the `.lavish-send` button is labelled "Queue" and only queues); send-now is hidden behind ⌘/Ctrl+Enter. This adds an explicit **Send** button and makes Cancel a ghost on the left.

### Task 1: Three-action annotation card

**Files:**

- Modify: `src/artifact-sdk.js` — the shadow style string in `ensureShadow()` (~line 650), the card markup in `showAnnotationCard()` (~line 693), and the button wiring (~lines 701–720).

**Interfaces:**

- Consumes: existing `queuePrompt(prompt, opts)`, `sendQueuedPrompts()`, `closeCard()` (all already defined inside `createArtifactSdk`).
- Produces: a card whose row is Cancel (ghost) · spacer · Queue (steel) · Send (brass), wired so Cancel discards, Queue queues, Send queues+sends.

- [ ] **Step 1: Update the shadow-DOM card styles**

In the long `style.textContent` string inside `ensureShadow()`, make these two exact replacements:

Replace:

```
.lavish-annotation-card .lavish-row{display:flex;gap:8px;justify-content:flex-end;margin-top:8px}
```

with:

```
.lavish-annotation-card .lavish-row{display:flex;gap:8px;align-items:center;margin-top:8px}.lavish-annotation-card .lavish-spacer{flex:1}
```

Replace:

```
.lavish-annotation-card .lavish-cancel{background:var(--steel-700);color:var(--fg)}
```

with:

```
.lavish-annotation-card .lavish-queue{background:var(--steel-700);color:var(--fg)}.lavish-annotation-card .lavish-queue:hover{background:var(--steel-600)}.lavish-annotation-card .lavish-cancel{background:transparent;color:var(--fg-faint)}.lavish-annotation-card .lavish-cancel:hover{color:var(--fg)}
```

(`.lavish-send` stays brass; the `.lavish-annotation-card button{...}` base rule is unchanged.)

- [ ] **Step 2: Update the card row markup**

In `showAnnotationCard`, replace the row substring:

```
'</div><div class="lavish-row"><button class="lavish-cancel" type="button">Cancel</button><button class="lavish-send" type="button">Queue</button></div>';
```

with:

```
'</div><div class="lavish-row"><button class="lavish-cancel" type="button">Cancel</button><span class="lavish-spacer"></span><button class="lavish-queue" type="button">Queue</button><button class="lavish-send" type="button">Send</button></div>';
```

- [ ] **Step 3: Rewire the buttons + keyboard**

Replace the wiring block:

```
    const textarea = /** @type {HTMLTextAreaElement | null} */ (card.querySelector("textarea"));
    const cancelButton = /** @type {HTMLButtonElement | null} */ (card.querySelector(".lavish-cancel"));
    const sendButton = /** @type {HTMLButtonElement | null} */ (card.querySelector(".lavish-send"));
    if (!textarea || !cancelButton || !sendButton) return;

    cancelButton.onclick = closeCard;
    sendButton.onclick = () => {
      const prompt = textarea.value.trim();
      if (prompt) queuePrompt(prompt, { ...c, queueKey: "" });
      closeCard();
    };
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        const sendNow = (event.ctrlKey || event.metaKey) && !!textarea.value.trim();
        sendButton.click();
        // postMessage delivery is ordered, so the queued prompt lands before the send.
        if (sendNow) sendQueuedPrompts();
      }
    });
```

with:

```
    const textarea = /** @type {HTMLTextAreaElement | null} */ (card.querySelector("textarea"));
    const cancelButton = /** @type {HTMLButtonElement | null} */ (card.querySelector(".lavish-cancel"));
    const queueButton = /** @type {HTMLButtonElement | null} */ (card.querySelector(".lavish-queue"));
    const sendButton = /** @type {HTMLButtonElement | null} */ (card.querySelector(".lavish-send"));
    if (!textarea || !cancelButton || !queueButton || !sendButton) return;

    cancelButton.onclick = closeCard;
    queueButton.onclick = () => {
      const prompt = textarea.value.trim();
      if (prompt) queuePrompt(prompt, { ...c, queueKey: "" });
      closeCard();
    };
    sendButton.onclick = () => {
      const prompt = textarea.value.trim();
      if (prompt) {
        queuePrompt(prompt, { ...c, queueKey: "" });
        // postMessage delivery is ordered, so the queued prompt lands before the send.
        sendQueuedPrompts();
      }
      closeCard();
    };
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        if (event.ctrlKey || event.metaKey) sendButton.click();
        else queueButton.click();
      }
    });
```

- [ ] **Step 4: Build, run the full check, commit**

Run: `cd /Users/ezeng/Coding/lavish-axi-fork && npm run check`
Expected: PASS (existing `artifact-sdk.test.js` pure-function tests and the rest of the suite stay green; the card change has no unit test — its behavior is verified by the Playwright E2E gate, because the card lives in a shadow DOM built via `innerHTML`, which the `node:vm` fake DOM cannot exercise without a disproportionate harness; this is the spec's explicit call).

```bash
cd /Users/ezeng/Coding/lavish-axi-fork
node scripts/build.js
git add src/artifact-sdk.js
git commit -m "feat(annotate): explicit Cancel / Queue / Send actions on the annotation card"
```

---

## Feature B — Unread thread replies

Spec: `docs/superpowers/specs/2026-06-26-unread-thread-replies-design.md`.
A session-only read model marks thread chips that have replies you haven't opened since they arrived; unread chips render solid brass + dot + "N new".

### Task 2: Read model + pure helpers (fully unit-tested)

**Files:**

- Modify: `src/chrome-client.js` — add state + helpers near the other threading helpers and state; wire baseline into `syncChat`, mark-seen into `openThread` and the open-thread live-append paths; extend the `globalThis.__lavishTest` seam.
- Modify: `test/chrome-client-threading.test.js` — unit tests.
- Modify: `test/helpers/chrome-harness.js` — expose the new seam query.

**Interfaces:**

- Produces (defined in `chrome-client.js`):
  - `unreadReplyCount(rootId: string, currentCount: number, seenMap: Map<string,number>): number` — `max(0, currentCount - (seenMap.get(rootId) ?? 0))`.
  - `isThreadUnread(rootId, currentCount, seenMap): boolean` — `unreadReplyCount(...) > 0`.
  - state `seenReplyCount: Map<string,number>`, `seenBaselined: boolean`.
  - `markThreadSeen(rootId: string)` — sets `seenReplyCount[rootId]` to that root's current reply count.
  - `threadUnreadCount(rootId): number` — current unread count for a root (used by `renderChat` in Task B2 and the test seam).
- The seam exposes `unreadReplyCount`, `isThreadUnread`, and `threadUnreadCount`; the harness exposes `threadingUnread(rootId)`.

- [ ] **Step 1: Write failing unit tests**

Add to `test/chrome-client-threading.test.js`:

```js
test("unreadReplyCount is the count beyond seen, never negative", async () => {
  const { unreadReplyCount } = await threading();
  const seen = new Map([["a", 2]]);
  assert.equal(unreadReplyCount("a", 3, seen), 1);
  assert.equal(unreadReplyCount("a", 2, seen), 0);
  assert.equal(unreadReplyCount("a", 1, seen), 0); // seen ahead of count → clamp 0
  assert.equal(unreadReplyCount("b", 2, seen), 2); // unseen root → all unread
});

test("threads are read at load baseline, unread on a later reply, read again on open", async () => {
  const chrome = await createChromeHarness();
  const sync = chrome.eventSource().listeners.get("chat-sync");
  // Baseline load: a root with one existing reply.
  sync({
    data: JSON.stringify({
      chat: [
        { id: "root1", role: "agent", text: "Root", at: 1 },
        { id: "r1", role: "agent", text: "first reply", reply_to: "root1", at: 2 },
      ],
    }),
  });
  assert.equal(chrome.threadingUnread("root1"), 0); // existing replies are read at load

  // A new reply arrives into the (closed) thread → unread.
  chrome.eventSource().listeners.get("agent-reply")({
    data: JSON.stringify({ id: "r2", role: "agent", text: "new reply", reply_to: "root1", at: 3 }),
  });
  assert.equal(chrome.threadingUnread("root1"), 1);

  // Opening the thread marks it read.
  chrome.threadingOpen("root1");
  assert.equal(chrome.threadingUnread("root1"), 0);
});

test("a reply into the currently open thread does not become unread", async () => {
  const chrome = await createChromeHarness();
  chrome.eventSource().listeners.get("chat-sync")({
    data: JSON.stringify({ chat: [{ id: "root1", role: "agent", text: "Root", at: 1 }] }),
  });
  chrome.threadingOpen("root1");
  chrome.eventSource().listeners.get("agent-reply")({
    data: JSON.stringify({ id: "r1", role: "agent", text: "in-thread", reply_to: "root1", at: 2 }),
  });
  assert.equal(chrome.threadingUnread("root1"), 0);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd /Users/ezeng/Coding/lavish-axi-fork && node --test test/chrome-client-threading.test.js`
Expected: FAIL — `chrome.threadingUnread` / `unreadReplyCount` undefined.

- [ ] **Step 3: Add state + helpers**

Near the threading state block (after `let openThreadRootId = "";`), add:

```js
/** @type {Map<string, number>} */
const seenReplyCount = new Map();
let seenBaselined = false;
```

Near the other pure helpers (after `shouldFlagBackBadge`), add:

```js
// How many replies in a thread the user has not seen yet (never negative).
/** @param {string} rootId @param {number} currentCount @param {Map<string, number>} seenMap @returns {number} */
function unreadReplyCount(rootId, currentCount, seenMap) {
  const seen = seenMap.get(String(rootId)) || 0;
  return Math.max(0, currentCount - seen);
}

/** @param {string} rootId @param {number} currentCount @param {Map<string, number>} seenMap @returns {boolean} */
function isThreadUnread(rootId, currentCount, seenMap) {
  return unreadReplyCount(rootId, currentCount, seenMap) > 0;
}
```

After `renderThread` (or near `openThread`), add the model-aware helpers:

```js
// Current reply count for one root, from the live model.
function replyCountForRoot(rootId) {
  const { repliesByRoot } = groupThreads(orderedMessages());
  return (repliesByRoot.get(String(rootId)) || []).length;
}

function threadUnreadCount(rootId) {
  return unreadReplyCount(String(rootId), replyCountForRoot(rootId), seenReplyCount);
}

// Mark a thread read: the user has now seen all its current replies.
function markThreadSeen(rootId) {
  seenReplyCount.set(String(rootId), replyCountForRoot(rootId));
}

// On the first authoritative transcript, treat every existing thread as read.
function baselineSeenOnce() {
  if (seenBaselined) return;
  seenBaselined = true;
  const { roots } = groupThreads(orderedMessages());
  for (const root of roots) {
    if (root.id != null) markThreadSeen(String(root.id));
  }
}
```

- [ ] **Step 4: Wire baseline + mark-seen into the lifecycle**

In `syncChat`, after `setMessages(chat); renderChat();` and before the open-thread re-render, add the baseline call:

```js
baselineSeenOnce();
```

(Order: `setMessages` populates the model first, so `baselineSeenOnce` counts real replies; it runs once.)

In `openThread`, after `openThreadRootId = String(rootId);`, add:

```js
markThreadSeen(openThreadRootId);
```

In `ingestIncoming`, after `rememberMessage(message);` and inside the `if (openThreadRootId)` block where the open thread is re-rendered, mark the open thread seen so a live reply into it never shows unread:

```js
if (openThreadRootId) {
  renderThread(openThreadRootId);
  markThreadSeen(openThreadRootId);
  if (flagBadge) setBackBadge(true);
}
```

In `sendThreadReply`, after `renderThread(openThreadRootId);`, add:

```js
markThreadSeen(openThreadRootId);
```

- [ ] **Step 5: Expose on the seam + harness**

In the `globalThis.__lavishTest` block, add:

```js
globalThis.__lavishTest.unreadReplyCount = unreadReplyCount;
globalThis.__lavishTest.isThreadUnread = isThreadUnread;
globalThis.__lavishTest.threadUnreadCount = threadUnreadCount;
```

Update the `threading()` seam object to also include `unreadReplyCount` and `isThreadUnread` (so `const { unreadReplyCount } = await threading()` works), and in `test/helpers/chrome-harness.js` add to the returned object:

```js
    threadingUnread(rootId) {
      return context.__lavishTest.threadUnreadCount(rootId);
    },
```

- [ ] **Step 6: Run tests, then the full check, commit**

Run: `cd /Users/ezeng/Coding/lavish-axi-fork && node --test test/chrome-client-threading.test.js`
Expected: PASS (all three new tests + existing).

Run: `cd /Users/ezeng/Coding/lavish-axi-fork && npm run check`
Expected: PASS.

```bash
cd /Users/ezeng/Coding/lavish-axi-fork
git add src/chrome-client.js test/chrome-client-threading.test.js test/helpers/chrome-harness.js
git commit -m "feat(ui): session-only unread read-model for threads (baseline, mark-seen, helpers)"
```

### Task 3: Unread chip rendering + style

**Files:**

- Modify: `src/chrome-client.js` — `buildBubble` (chip markup) and `renderChat` (compute unread + label).
- Modify: `src/chrome.css` — `.thread-chip .dot` and `.thread-chip.unread`.
- Modify: `test/chrome-client-threading.test.js` — chip-markup unit tests.

**Interfaces:**

- Consumes: `threadUnreadCount` (Task 2), `threadChipLabel`.
- Produces: an unread chip — `class="thread-chip unread"`, a `<span class="dot"></span>`, label "N new".

- [ ] **Step 1: Write failing chip-markup tests**

Add to `test/chrome-client-threading.test.js`:

```js
test("an unread chip renders the unread class, a dot, and an 'N new' label", async () => {
  const chrome = await createChromeHarness();
  const el = chrome.threadingBuildBubble(
    { id: "root1", role: "agent", text: "Root" },
    { chip: "2 new", chipUnread: true },
  );
  assert.match(el.innerHTML, /thread-chip unread/);
  assert.match(el.innerHTML, /class="dot"/);
  assert.match(el.innerHTML, /2 new/);
});

test("a read chip has no unread class and keeps the replies label", async () => {
  const chrome = await createChromeHarness();
  const el = chrome.threadingBuildBubble(
    { id: "root1", role: "agent", text: "Root" },
    { chip: "3 replies · 5m", chipUnread: false },
  );
  assert.doesNotMatch(el.innerHTML, /thread-chip unread/);
  assert.match(el.innerHTML, /3 replies · 5m/);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd /Users/ezeng/Coding/lavish-axi-fork && node --test test/chrome-client-threading.test.js`
Expected: FAIL — `buildBubble` ignores `chipUnread`; no `.dot` span.

- [ ] **Step 3: Update `buildBubble` chip markup**

In `buildBubble`, change the signature to accept `chipUnread` and rebuild the chip markup. Replace:

```js
function buildBubble(message, { chip = null, isRoot = false, reply = false } = {}) {
```

with:

```js
function buildBubble(message, { chip = null, chipUnread = false, isRoot = false, reply = false } = {}) {
```

And replace the chip block:

```js
if (chip) {
  html +=
    '<button class="thread-chip" type="button" data-root-id="' +
    escapeHtml(String(message.id)) +
    '">' +
    escapeHtml(chip) +
    "</button>";
}
```

with:

```js
if (chip) {
  html +=
    '<button class="thread-chip' +
    (chipUnread ? " unread" : "") +
    '" type="button" data-root-id="' +
    escapeHtml(String(message.id)) +
    '"><span class="dot"></span>' +
    escapeHtml(chip) +
    "</button>";
}
```

- [ ] **Step 4: Compute unread in `renderChat`**

In `renderChat`, replace the chip computation:

```js
let chip = null;
if (replies.length) {
  const lastAt = replies[replies.length - 1].at;
  chip = threadChipLabel(replies.length, lastAt, now);
}
chatLog.insertBefore(buildBubble(root, { chip, reply }), reference);
```

with (note: `reply` is still computed as today — `replies.length ? false : (isLocalId(id) ? false : "open")`):

```js
let chip = null;
let chipUnread = false;
if (replies.length) {
  const unread = unreadReplyCount(id, replies.length, seenReplyCount);
  if (unread > 0) {
    chipUnread = true;
    chip = unread === 1 ? "1 new" : unread + " new";
  } else {
    chip = threadChipLabel(replies.length, replies[replies.length - 1].at, now);
  }
}
chatLog.insertBefore(buildBubble(root, { chip, chipUnread, reply }), reference);
```

(Keep the existing `const reply = ...` line above this block unchanged.)

- [ ] **Step 5: Add the unread chip CSS**

Append to the `.thread-chip` block area in `src/chrome.css`:

```css
.thread-chip .dot {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-pill);
  background: var(--accent);
  display: none;
}
.thread-chip.unread {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--brass-ink);
}
.thread-chip.unread .dot {
  display: block;
  background: var(--brass-ink);
}
```

- [ ] **Step 6: Run tests, full check, build, commit**

Run: `cd /Users/ezeng/Coding/lavish-axi-fork && node --test test/chrome-client-threading.test.js`
Expected: PASS.

Run: `cd /Users/ezeng/Coding/lavish-axi-fork && npm run check`
Expected: PASS.

```bash
cd /Users/ezeng/Coding/lavish-axi-fork
node scripts/build.js
git add src/chrome-client.js src/chrome.css test/chrome-client-threading.test.js
git commit -m "feat(ui): unread thread chips — solid brass + dot + 'N new'"
```

---

## Gates (run by the controller after the tasks, before push)

### Gate 1: Codex ↔ Claude convergence

Capture the combined diff for this branch's new work (`git diff <pre-feature-base>..HEAD -- src test`), run the Codex reviewer (`codex exec --sandbox read-only - < prompt.txt`, background, no `timeout`) and a blind Claude reviewer in parallel over both features. Verify each finding, fix test-first, repeat until BOTH agree there are no remaining BLOCKER/HIGH/MEDIUM issues. Watch especially for: escaping of the "N new"/chip text and the annotation card markup; the baseline-once flag not re-baselining on later syncs; mark-seen covering every read path (open, live-append, send); and Queue-vs-Send wiring (Queue must NOT send).

### Gate 2: Playwright E2E (real browser, out-of-repo harness)

- **Annotation:** with Annotate mode on, click an element, type a note. Assert: **Queue** adds a pending pill and posts NO prompts; **Send** posts the prompts to `/api/:key/prompts` and clears the pill; **Cancel** removes the card with no pill and no request; the row shows Cancel left, Queue+Send right, no overflow.
- **Unread:** seed a root + reply (read at load); post a new `agent-reply` into that thread while it's closed → assert its chip gains `.thread-chip.unread` and reads "1 new"; open the thread → assert it reverts to muted "N replies · <time>".

### Gate 3: Push

Only after Gates 1–2 pass and `npm run check` is green: `git push fork feat/realtime-sse-threading`. Report the pushed range and the PR-create URL.

---

## Self-Review

**Spec coverage:**

- Annotation spec → Task 1 (markup, wiring, styles, keyboard) + Gate 2 (E2E behavior). ✅
- Unread read model (baseline, mark-seen, session-only, helpers) → Task 2. ✅
- Unread chip (solid brass + dot + "N new"; read = muted "N replies · time") → Task 3. ✅
- Both: server untouched, Back badge untouched → no task modifies `server.js` or the badge logic. ✅
- Testing (pure helpers + E2E for unread; E2E for annotation) → Task B1/B2 unit tests + Gate 2. ✅
- Convergence before push → Gate 1. ✅

**Placeholder scan:** None — every step has concrete code or an exact command. The annotation task deliberately has no unit test (justified inline + covered by Gate 2), which is a stated decision, not a placeholder.

**Type consistency:** `unreadReplyCount(rootId, currentCount, seenMap)`, `isThreadUnread`, `threadUnreadCount(rootId)`, `markThreadSeen`, `seenReplyCount`, `seenBaselined` are named consistently across B1 definitions, the seam, the harness (`threadingUnread`), and B2's `renderChat` call. `buildBubble`'s new `chipUnread` option matches between B2 Step 3 (definition) and Step 4 (call site) and the tests. The annotation button classes (`.lavish-cancel`/`.lavish-queue`/`.lavish-send`/`.lavish-spacer`) match between the styles (A1 Step 1), markup (Step 2), and wiring (Step 3).
