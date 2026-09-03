# Annotation actions — Cancel / Queue / Send — design

Date: 2026-06-26
Branch: `feat/realtime-sse-threading`
Status: shipped - implemented and merged on branch `merge/main-into-sse`. The Context section below describes the chrome as it was BEFORE this change; for current behavior see README.md, the `lavish-axi` CLI guidance, and AGENTS.md.

## Context (state before this change)

When you annotate an element in the lavish chrome (Annotate mode on, click a non-native element), the in-iframe SDK (`createArtifactSdk` → `showAnnotationCard` in `src/artifact-sdk.js`) pops a small card in a shadow DOM.
The card has a heading, a textarea, a hint line, and a button row.
Before this change that row was **Cancel** and **Queue** (the `.lavish-send` button was labelled "Queue" and only added the annotation to the pending-prompt pills); the only way to send to the agent immediately was the hidden `⌘/Ctrl+Enter` keyboard shortcut.

The reviewer asked, while testing, for the three actions to be explicit: when annotating, offer **Cancel**, **Queue**, and **Send**.

## Goal

Make the annotation card's three actions visible and unambiguous — discard, hold for later, or send to the agent now — instead of hiding "send now" behind a keyboard shortcut.

## Design

### Action row (the "split" layout, approved)

The `.lavish-row` becomes: **Cancel** as a quiet ghost button on the left, then a flexible spacer, then **Queue** (secondary) and **Send** (brass primary) right-aligned.
At the card's 320px width this reads cleanly and gives a single obvious primary action without crowding.

```
┌ Annotate <h1> ───────────────────────┐
│ [ textarea … ]                        │
│ Enter to queue · ⌘+Enter to send now  │
│ Cancel              [ Queue ] [ Send ]│
└───────────────────────────────────────┘
```

### Behaviors

- **Cancel** — `closeCard()`. Discards the annotation; sends no message; always closes regardless of textarea content.
- **Queue** — if the textarea has non-empty trimmed text, `queuePrompt(prompt, { ...context, queueKey: "" })`, then `closeCard()`. Adds a pending pill; does NOT send. (This is exactly today's `.lavish-send`/"Queue" behavior.)
- **Send** — if the textarea has non-empty trimmed text, `queuePrompt(...)` then `sendQueuedPrompts()`, then `closeCard()`. Queues the annotation and immediately sends the whole pending batch to the agent. (This is exactly what `⌘/Ctrl+Enter` does today, now also a button.)
- An empty textarea on Queue/Send is a no-op that simply closes the card (mirrors the current empty-guard).

### Keyboard (unchanged)

`Enter` = Queue, `⌘/Ctrl+Enter` = Send.
The hint line stays "Enter to queue · ⌘+Enter to send now", which now matches the buttons one-to-one.

### Styling

In the shadow-DOM `<style>` block inside `ensureShadow()`:

- `.lavish-cancel` → ghost: transparent background, muted text (`--fg-faint`), hover to `--fg`; tighter horizontal padding so it reads as a quiet text button on the left.
- `.lavish-queue` → secondary: the steel fill that `.lavish-cancel` uses today (`--steel-700` bg, `--fg` text), hover `--steel-600`.
- `.lavish-send` → brass primary (unchanged): `--accent` bg, `--brass-ink` text, hover `--accent-hover`.
- `.lavish-row` → keep `display:flex; gap:8px; align-items:center`, and push Cancel left via a flexible spacer element (a `<span>` with `flex:1`) between Cancel and the Queue/Send pair (rather than `justify-content:flex-end`).

### Markup

`showAnnotationCard` builds the row as:

```
<div class="lavish-row">
  <button class="lavish-cancel" type="button">Cancel</button>
  <span class="lavish-spacer"></span>
  <button class="lavish-queue" type="button">Queue</button>
  <button class="lavish-send" type="button">Send</button>
</div>
```

Wiring (replacing the current two-button wiring):

- `cancelButton.onclick = closeCard`
- `queueButton.onclick = () => { const p = textarea.value.trim(); if (p) queuePrompt(p, { ...c, queueKey: "" }); closeCard(); }`
- `sendButton.onclick = () => { const p = textarea.value.trim(); if (p) { queuePrompt(p, { ...c, queueKey: "" }); sendQueuedPrompts(); } closeCard(); }`

The existing textarea keydown handler keeps Enter→Queue and ⌘/Ctrl+Enter→Send by calling the same `queueButton`/`sendButton` clicks (so the keyboard and buttons share one code path).

## Scope

This touches only `showAnnotationCard` (markup + wiring) and the shadow-DOM style block in `ensureShadow()`, both inside `createArtifactSdk` in `src/artifact-sdk.js`.
Text-selection annotations (the `range` branch) use the same card and therefore get the same three actions for free.
Native interactive controls (radios, inputs, buttons, …) bypass the card entirely — unchanged.

## Out of scope (YAGNI)

- The pending-prompt pill system, the chrome composer, and the `lavish:queuePrompt` / `lavish:sendQueuedPrompts` message contract — all reused as-is.
- Changing keyboard-shortcut semantics.
- Any change to the thread panel or the chrome (`chrome-client.js`, `server.js`).

## Testing

- **Playwright E2E (primary gate)**, the same approach used to verify the thread panel: drive a real browser with Annotate mode on, click an element, type a note, and assert:
  1. **Queue** adds a pending pill (the `#annotationPills` area in the chrome) and does NOT post prompts to `/api/:key/prompts`.
  2. **Send** posts the prompts to the agent (a `/api/:key/prompts` request fires) and clears the pending pill.
  3. **Cancel** removes the card and leaves no pill and no request.
  4. The card row shows Cancel on the left and Queue + Send on the right (no overflow).
- **Unit (action→message mapping):** if a minimal fake-DOM harness for `createArtifactSdk`/`showAnnotationCard` is practical (mirroring the `node:vm` fake-DOM pattern in `test/helpers/chrome-harness.js` — `document.createElement`, `attachShadow`, `querySelector`, a captured `parent.postMessage`), unit-test that Queue posts exactly `[lavish:queuePrompt]`, Send posts `[lavish:queuePrompt, lavish:sendQueuedPrompts]`, and Cancel posts nothing. If the shadow-DOM card proves too heavy to fake cleanly, the plan may rely on the Playwright E2E for the button behavior and keep `artifact-sdk.test.js` focused on the existing pure helpers — the plan will make this call explicitly rather than leave it vague.
- `npm run check` stays green throughout.

## Convergence review (required before push)

Run the Codex↔Claude convergence loop over the diff before pushing, same as the thread panel: verify each finding, fix test-first, repeat until both reviewers agree there are no remaining BLOCKER/HIGH/MEDIUM issues.
