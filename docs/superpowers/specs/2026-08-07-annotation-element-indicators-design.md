# Annotation element indicators

Date: 2026-08-07
Status: approved

## Problem

Lavish's annotation flow lets a reviewer mark up an element, text range, or
Mermaid node with a note. Once queued, the only visible trace is a pill above
the chat input; once sent, the note becomes a plain chat bubble with no link
back to what it was about. There is no way to see, at a glance on the
artifact, which elements already have an annotation, and no way to navigate
between a chat entry and the element it targets in either direction.

## Goals

- Every annotated element (queued or sent) shows a small on-page indicator.
- Clicking the indicator jumps to/highlights the corresponding entry in the
  chat panel.
- Clicking an annotation's entry in the chat panel reveals its element on the
  page (reusing the existing `lavish:revealElement` pulse-highlight).
- Applies uniformly to element annotations, text-range annotations, and
  Mermaid-node annotations.
- Indicators survive an artifact reload.
- Multiple annotations on the same element collapse to a single dot; clicking
  it jumps to the earliest one.
- A target that no longer resolves (element removed/changed) degrades
  gracefully: no page-side dot is drawn for it, and the chat-side pin icon
  stays visible but is inert on click.

## Non-goals

- Changing the visual design of the pill tray or chat bubbles beyond adding
  one small icon/dot.
- Precise sub-element targeting for text ranges or Mermaid nodes beyond what
  `selector` already resolves to today (this matches the existing precision
  of `revealElement`, used today for layout-warning "Reveal").
- Server-side annotation IDs / durable identity beyond what's needed for this
  feature (no new persistence concept beyond storing what's already on the
  prompt object).

## Architecture

Three existing layers keep their current roles:

- **SDK** (`src/artifact-sdk.js`) — runs inside the iframe, owns the
  annotation card, hover highlighting, and the existing `revealElement`
  pulse-marker mechanism.
- **Chat panel** (`src/chrome-client.js`) — the parent chrome UI, owns the
  queued-pill tray and the chat log.
- **Server** (`src/server.js`, `src/session-store.js`) — persists chat and
  session state.

One new concept threads through all three: a stable `annotationId`, minted
once per annotation and carried unchanged through queue → send → persistence
→ resync.

Two new postMessage message types are added to the existing iframe↔chrome
protocol:

- **chrome → iframe**: `lavish:setAnnotationTargets` — the current list of
  `{ id, selector, target }` for every annotation the panel knows about
  (queued and sent). Sent after every queue change and after every chat
  sync.
- **iframe → chrome**: `lavish:openAnnotation` — `{ id }`, fired when a
  page-side badge is clicked.

The existing `lavish:revealElement` channel is reused unchanged for the
chat→element direction.

## Components

### SDK — badge overlay

A new badge layer lives in the same shadow root as the existing
reveal-marker/annotation-card UI, so it is excluded from the layout-warning
audit like all other Lavish-owned UI (`isLavishUi`).

On receiving `setAnnotationTargets`:

1. Resolve each entry's `selector` via `safeQuerySelector` (the same helper
   `revealElement` already uses).
2. Dedupe by resolved element: multiple annotation ids on the same element
   collapse to one dot. "Earliest" is determined by array order (the panel
   sends the list in send/queue order).
3. Draw a small accent-colored dot pinned to that element's corner
   (`getBoundingClientRect`-based, same positioning approach as the reveal
   marker).
4. Entries whose selector doesn't resolve are simply not drawn.

Unlike the transient reveal marker (a one-shot 2.4s pulse), badges are
persistent, so position must be kept in sync: scroll/resize listeners plus a
bounded `requestAnimationFrame` loop that runs only while at least one badge
is present (no continuous polling when there are no annotations).

Clicking a dot posts `lavish:openAnnotation` with that dot's representative
`id` (the earliest one collapsed into it).

### Chat panel — bubble affordance

`addChat` / `syncChat` gain an optional target (`{ id, selector, target }`)
per chat item. When present, the rendered bubble gets a small pin icon.
Clicking it calls `postToFrame({ type: "lavish:revealElement", selector })` —
the existing mechanism, unchanged. If the selector doesn't resolve on the
page side, `revealElement` already no-ops silently, which is exactly the
"inert icon" behavior wanted for a stale target — no new error state needed
on either side.

The queued-pill tray already shows a target-selector tooltip; it also gains
the same pin icon / `revealElement` click behavior for consistency, since
pills are annotations too.

### Chat panel — annotation registry

A small in-memory map from `annotationId → { selector, target }` is built
from two sources:

- `queued` (already has `selector`/`target` on each item).
- Synced chat items (once the server change below lands, these carry
  `id`/`selector`/`target` too).

Whenever either source changes, the panel recomputes the deduped list and
posts `setAnnotationTargets` to the iframe.

On `lavish:openAnnotation`, the panel finds the pill or bubble with the
matching `id` and scrolls it into view with a brief highlight (visually
mirroring the page-side reveal-marker pulse, for symmetry).

### Server

`session-store.js` currently discards everything except `role`/`text` when
turning a submitted prompt into a persisted chat entry
(`chat.push({ role: "user", text: prompt.prompt, ... })`, `session-store.js:138`).
This is extended to also carry over `id`, `selector`, and `target` from the
originating prompt when present, and whatever path already serves chat
history to the client returns them unchanged.

## Data flow

1. User annotates an element/text/Mermaid node. The SDK's `queuePrompt` mints
   `annotationId` (`crypto.randomUUID()`) and includes it in the
   `lavish:queuePrompt` payload alongside the existing `selector`/`target`.
2. The panel's `enqueuePrompt` stores the prompt as-is in `queued` (already
   persisted to `sessionStorage`, so it survives reload pre-send). The pill
   tray renders as today. The panel recomputes and posts
   `setAnnotationTargets`; the SDK draws/updates badges.
3. On send, `submitQueuedOnce` posts the full prompt objects (now including
   `id`/`selector`/`target`) to `/api/:key/prompts`.
4. The server keeps `id`/`selector`/`target` on the stored chat entry instead
   of dropping them.
5. The next chat sync (`syncChat`) receives entries with that data. Bubbles
   get pin icons; the panel's annotation registry updates; the panel
   re-posts `setAnnotationTargets` so badges persist across the queued→sent
   transition with no visual jump (the dot doesn't disappear and reappear).
6. On artifact reload, badges come back because the chrome re-syncs chat and
   re-sends `setAnnotationTargets` on iframe ready — same as initial load, no
   separate replay mechanism needed.

## Error handling

- **Selector doesn't resolve** (element removed/changed): page-side badge
  isn't drawn; chat-side pin icon stays but is inert on click via
  `revealElement`'s existing silent no-op.
- **Old queued items in `sessionStorage` from before this change ships**
  (missing `annotationId`): treated as "no target" — falls back to today's
  plain pill/bubble with no icon. Forward-compatible, no migration needed.
- **Mermaid re-render changes node structure**: same best-effort selector
  resolution the codebase already accepts for layout-warning `revealElement`
  calls today — not a regression, just extending an accepted limitation to a
  new caller.

## Testing

- Extend `session-store` unit tests to assert `id`/`selector`/`target`
  survive the prompt → chat conversion.
- Add a focused test for the SDK's badge dedupe-by-resolved-element logic and
  its stale-selector no-op behavior (exact harness to match whatever the
  existing `artifact-sdk.js` tests use — to be confirmed during
  implementation).
- Manual verification in a real Chrome session: queue an element annotation,
  a text annotation, and a Mermaid-node annotation; send one; reload; click
  both directions (badge → chat, chat pin → badge/element) for both queued
  and sent annotations.
