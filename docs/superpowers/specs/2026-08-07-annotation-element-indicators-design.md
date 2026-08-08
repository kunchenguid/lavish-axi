# Annotation element indicators

Date: 2026-08-07
Status: approved

## Problem

Lavish's annotation flow lets a reviewer mark up an element, text range, or
Mermaid node with a note. Once queued, the only visible trace is a pill above
the chat input; once sent, the annotation simply disappears from the panel
with no visible record and no link back to what it was about. There is no
way to see, at a glance on the artifact, which elements already have an
annotation, and no way to navigate between an annotation and the element it
targets in either direction.

## Goals

- Every annotated element (queued or sent) shows a small on-page indicator.
- Clicking the indicator jumps to/highlights the corresponding entry in the
  panel.
- Clicking an annotation's entry in the panel reveals its element on the
  page (reusing the existing `lavish:revealElement` pulse-highlight).
- Applies uniformly to element annotations, text-range annotations, and
  Mermaid-node annotations.
- Sent annotations become visible, durable panel entries for the first time
  (today they vanish with no trace once sent).
- Indicators survive an artifact reload.
- Multiple annotations on the same element collapse to a single dot; clicking
  it jumps to the earliest one.
- A target that no longer resolves (element removed/changed) degrades
  gracefully: no page-side dot is drawn for it, and the panel-side pin icon
  stays visible but is inert on click.

## Non-goals

- Changing the visual design of the pill tray or chat log beyond adding one
  small icon/dot and one new panel section.
- Precise sub-element targeting for text ranges or Mermaid nodes beyond what
  `selector` already resolves to today (this matches the existing precision
  of `revealElement`, used today for layout-warning "Reveal").
- Interleaving sent annotations into the chat log's chronological order (see
  the Architecture correction below for why they get their own section
  instead).
- A push/SSE channel for sent annotations. The tab that sends an annotation
  already holds its full `id`/`selector`/`target`/`text` locally before the
  request goes out, so it renders its own new entry immediately on a
  successful response — no round-trip data needed. Only a reload needs the
  server-persisted copy.

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

**Correction found while mapping files for the implementation plan:** the
original draft of this section assumed a sent annotation becomes a chat
bubble in `session.chat`. It does not. `session-store.js` only appends to
`session.chat` when `prompt.tag === "message"` (free-typed messages only);
every annotation prompt's `tag` is the target's element tag (or
`"mermaid-node"` / `"text"`), so annotations never reach `session.chat`.
They go into `session.prompts`, a write-only outbox the agent's CLI polls
and drains via `takeFeedback` (`session-store.js:422-461`), which clears it
to `[]` on every poll. Today, once an annotation is sent, it simply
disappears from the panel — there is no existing "sent annotation" UI at
all.

This feature therefore adds a new durable, human-visible record —
**`session.annotations`** — separate from both `session.chat` (free-text
transcript) and `session.prompts` (transient agent outbox). Each sent
annotation appends one record here (`{ id, selector, target, tag, text,
prompt, at }`) that survives the outbox being drained on the next poll. The
panel renders these in their own **Annotations** section, replacing the
pill tray's role once an item is sent (queued-but-unsent annotations still
show as pills, as today) rather than expecting them to appear as chat
bubbles, since they never did. This section sits separately from the chat
log rather than interleaved into it — a deliberate choice to keep the
smaller, more surgical change over rewriting chat's chronological rendering
to merge two different record types.

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

### Chat panel — Annotations section and pin affordance

A new panel section (`#annotationsSent`, rendered between the chat log and
the queued-pill tray) lists every sent annotation for the session, each as a
small entry with its `text`/`prompt` preview and a pin icon — visually
consistent with the existing pill's target-selector tooltip. The
queued-pill tray keeps its current role for not-yet-sent annotations and
also gains the same pin icon for consistency (pills are annotations too).

Clicking a pin (in either the queued tray or the sent-annotations section)
calls `postToFrame({ type: "lavish:revealElement", selector })` — the
existing mechanism, unchanged. If the selector doesn't resolve on the page
side, `revealElement` already no-ops silently, which is exactly the "inert
icon" behavior wanted for a stale target — no new error state needed on
either side.

### Chat panel — annotation registry

A small in-memory map from `annotationId → { selector, target }` is built
from two sources:

- `queued` (already has `selector`/`target` on each item).
- `sentAnnotations`, a new in-memory array the panel maintains: seeded from
  `initialAnnotations` (see Server, below) on load, and appended to locally
  and immediately whenever `submitQueuedOnce` successfully sends
  annotation-tagged prompts (`tag !== "message"`) — using the data the panel
  already has, no server round-trip needed.

Whenever either source changes, the panel recomputes the deduped list and
posts `setAnnotationTargets` to the iframe.

On `lavish:openAnnotation`, the panel finds the pill or sent-annotation entry
with the matching `id` and scrolls it into view with a brief highlight
(visually mirroring the page-side reveal-marker pulse, for symmetry).

### Server

Two changes:

1. `session-store.js`'s prompt-submission path currently builds
   `userMessages` only from `tag === "message"` prompts
   (`session-store.js:136-138`) and never touches annotation-tagged prompts
   beyond appending them to the transient `session.prompts` outbox. It gains
   a parallel `newAnnotations` derivation: every accepted prompt with a
   non-empty `selector` (i.e. `tag !== "message"`) becomes a record
   `{ id, selector, target, tag, text, prompt, at }` appended to
   `session.annotations` (a new array on the session, alongside `chat` and
   `prompts`, persisted the same way and never cleared by `takeFeedback` —
   it's a durable log, not an outbox).
2. `server.js`'s panel HTML template gains `initialAnnotations:
session.annotations || []` alongside the existing `initialChat: session.chat
|| []` (`server.js:1476`), so a reload can seed the sent-annotations
   section without waiting on any live channel.

## Data flow

1. User annotates an element/text/Mermaid node. The SDK's `queuePrompt` mints
   `annotationId` (`crypto.randomUUID()`) and includes it in the
   `lavish:queuePrompt` payload alongside the existing `selector`/`target`.
2. The panel's `enqueuePrompt` stores the prompt as-is in `queued` (already
   persisted to `sessionStorage`, so it survives reload pre-send). The pill
   tray renders as today. The panel recomputes and posts
   `setAnnotationTargets`; the SDK draws/updates badges.
3. On send, `submitQueuedOnce` posts the full prompt objects (now including
   `id`/`selector`/`target`) to `/api/:key/prompts`, same as today.
4. The server appends a matching `session.annotations` record for each
   annotation-tagged prompt (see Server, above). The POST response itself is
   unchanged (`{ status: "queued", pending_prompts }}`) — the panel doesn't
   need it to carry the new data back.
5. On a successful send, the panel itself moves the just-sent
   annotation-tagged prompts from `queued` into `sentAnnotations` and renders
   them in the new Annotations section. The panel's annotation registry
   updates and re-posts `setAnnotationTargets` so badges persist across the
   queued→sent transition with no visual jump (the dot doesn't disappear and
   reappear).
6. On artifact reload, the panel HTML is re-rendered server-side with
   `initialAnnotations` seeding `sentAnnotations`, and the chrome re-sends
   `setAnnotationTargets` once the iframe signals ready — same pattern as
   today's `initialChat` seeding, no separate replay mechanism needed.

## Error handling

- **Selector doesn't resolve** (element removed/changed): page-side badge
  isn't drawn; the panel-side pin icon stays but is inert on click via
  `revealElement`'s existing silent no-op.
- **Old queued items in `sessionStorage` from before this change ships**
  (missing `annotationId`): treated as "no target" — falls back to today's
  plain pill with no icon. Forward-compatible, no migration needed.
- **Mermaid re-render changes node structure**: same best-effort selector
  resolution the codebase already accepts for layout-warning `revealElement`
  calls today — not a regression, just extending an accepted limitation to a
  new caller.

## Testing

- Extend `session-store` unit tests to assert annotation-tagged prompts
  produce matching `session.annotations` records (`id`/`selector`/`target`
  preserved) while `tag === "message"` prompts keep flowing into
  `session.chat` exactly as today, and confirm `takeFeedback` draining
  `session.prompts` does not touch `session.annotations`.
- Add a focused test (using the existing `vm`-based `chrome-client.js`
  harness in `test/chrome-client-queue.test.js`) asserting: a sent
  annotation's prompt moves from `queued` into the new sent-annotations
  section without a server round-trip, its pin icon posts
  `lavish:revealElement` with the right selector, and `setAnnotationTargets`
  is (re-)posted after send.
- Add a focused test for the SDK's badge dedupe-by-resolved-element logic and
  its stale-selector no-op behavior (exact harness to match whatever the
  existing `artifact-sdk.js` tests use — to be confirmed during
  implementation, since `createArtifactSdk` isn't currently exercised by
  `test/artifact-sdk.test.js`, only its pure helper exports are).
- Manual verification in a real Chrome session: queue an element annotation,
  a text annotation, and a Mermaid-node annotation; send one; reload; click
  both directions (badge → panel, panel pin → badge/element) for both queued
  and sent annotations.
