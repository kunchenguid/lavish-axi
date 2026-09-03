# Thread panel (Slack-style slide-out) — design

Date: 2026-06-24
Branch: `feat/realtime-sse-threading`
Status: shipped - implemented and merged on branch `merge/main-into-sse`. The Context section below describes the chrome as it was BEFORE this change; for current behavior see README.md, the `lavish-axi` CLI guidance, and AGENTS.md.

## Context (state before this change)

The lavish chrome is a CSS grid: the artifact `<iframe>` (`.frame`) fills the main area, and the chat lives in a right-hand `.panel` of width `--panel-w` (360px).
Before this change the chat was a flat transcript.
`addChat(role, text, meta)` appended one `.bubble` per message into `chatLog`; a `reply_to` only rendered an inline `.reply-quote` snippet above the bubble; every message with an id got a hover Reply button.
Reply state lived in `replyToId` plus a `.reply-indicator` strip above the single composer; sending carried `reply_to`.
The server stores a flat transcript of `{ role, text, at, id, reply_to? }`, mints ids server-side, validates that any `reply_to` is a real id in the transcript, and broadcasts `agent-reply` and `chat-sync` over SSE.

This design replaces the flat inline-quote rendering with true Slack-style threads: roots stay in the list, replies collapse into a slide-out thread view.

## Goal

Let a reviewer hold focused side-conversations ("threads") with the agent under any message, without losing sight of the artifact being reviewed, and without the main chat list filling up with reply noise.

## Placement decision — Drill-in (slide-out)

The thread view reuses the existing chat panel rather than taking new screen width.
Clicking a thread slides the root list out and the thread in from the right within the same 360px panel; a `‹ Back` button returns.
The artifact never shrinks or gets covered.

This was chosen over two alternatives, validated against an interactive mockup:

- **Second column** (thread opens as its own third grid column): keeps the root list visible alongside the thread, but narrows the artifact whenever a thread is open. Rejected: in a design-review tool the artifact is the point and should keep its width.
- **Overlay** (thread floats over the artifact): hides the design while you discuss it. Rejected for the same reason, more severely.

Drill-in is also the smallest rendering change (a sub-view swap inside the existing panel, no top-level grid restructure) and matches the literal "slide-out" intent.

Its one cost — the root list is hidden while a thread is open — is mitigated by an unread badge on the Back button (see Live updates).

## Threading model (client-side derivation)

Threading is derived entirely on the client from the existing `reply_to` field.
The server is not changed.

- **Root**: a message with no `reply_to`. Roots render in the main list.
- **Reply**: a message with a `reply_to`. Replies never render in the main list; they render only inside their thread.
- **Root resolution**: `resolveRoot(id)` walks `reply_to` upward until it reaches a message with no `reply_to`. The walk is cycle-safe (a `Set` of visited ids; if a cycle or a dangling `reply_to` is hit, the message is treated as its own root so nothing is ever dropped).
- **One level of display**: a reply to a reply still resolves to the same root and displays flat under that root, ordered by time. We keep the precise `reply_to` pointer on the wire (so the agent still receives exactly which message a reply answered), but the _display_ is one level deep.

Client state, replacing the current `chatMessages: Map<id, text>`:

- `messagesById: Map<id, msg>` — full message objects, not just text.
- `order: string[]` — message ids in transcript order.
- Derived per render: `repliesByRoot: Map<rootId, msg[]>` and a root list.

## Rendering

The `.panel` gains two stacked sub-views.

### `.chat-pane` (root list)

- Renders only roots into `chatLog`, in order, reusing the existing bubble markup and `renderInlineMarkdown` for agent bubbles.
- A root with ≥1 reply gets a **thread chip**: `💬 N replies · <relative time of last reply>`. The chip is the primary affordance to open the thread.
- Hover Reply on a root opens that root's thread (even when it has no replies yet) and focuses the panel composer.
- The main composer at the bottom of `.chat-pane` now sends **new top-level messages** (no `reply_to`); the old `.reply-indicator` strip above it is removed, since replying is now done from inside a thread rather than against the main composer.

### `.thread-pane` (thread view)

- `position: absolute` over the panel; `display: none` when closed, animating in (`slideInRight`) on open. Closed = no off-screen box, so there is no horizontal overflow (verified against the browser layout audit during mockup review).
- Header: `‹ Back` (with unread badge slot), a thread title, and the count.
- Body: the pinned root bubble, a "N replies" rule, then the replies flat in time order. Agent bubbles render inline markdown; user text is escaped.
- Footer: a **reply composer** that always carries `reply_to`.
- Hover Reply on an individual reply sets the reply target to that specific message; the default target when opening a thread is the root.

## Interaction flows

- **Open**: click a chip or Reply → `openThread(rootId)` renders the thread and sets `openThreadId`; clears the Back badge.
- **Close**: `‹ Back` → `closeThread()` hides the pane; `openThreadId = null`.
- **Send a new message**: main composer → queued prompt with no `reply_to` → appears as a new root.
- **Reply**: panel composer → carries `reply_to` (the specific targeted message) → server validates and broadcasts; the reply lands under the root's thread.
- **Live updates** (`agent-reply`, `chat-sync`): rebuild the model and re-render the list (chip counts update).
  - If the new message belongs to the currently open thread, append it to the thread view live.
  - If a thread is open and new activity lands in a different thread or as a new root, set the red **Back badge** so the reviewer knows the list changed while they were reading.

## Server

Unchanged.

The transcript already carries `reply_to`, the server already mints ids and validates `reply_to ∈ transcript`, and `agent-reply` / `chat-sync` already deliver every message with its id and `reply_to`.
Thread grouping is a pure client-side derivation, which keeps the risk low and the SSE-hardened server code untouched.

## Edge cases

- **Root with zero replies**: no chip; Reply opens an otherwise-empty thread (root pinned + composer) so a thread can be started.
- **Dangling or cyclic `reply_to`**: `resolveRoot` falls back to treating the message as its own root; the message is always rendered, never dropped.
- **Agent-working placeholder**: the `.agent-working` presence bubble is not a real transcript message; it stays in the main list and is excluded from threading.
- **Reply to a reply**: resolves to the shared root; displayed flat under it.
- **Reload / full `chat-sync`**: the model is rebuilt from the whole transcript, so threads and chips reconstruct deterministically; if a thread was open, it re-renders from the fresh data.

## Testing

- Extract the derivation as pure, DOM-free functions so they unit-test in Node alongside the existing suite: `resolveRoot` (chain walk, cycle/dangling safety), thread grouping (`repliesByRoot`, ordering), chip predicate (≥1 reply), and last-reply timestamp.
- Keep `npm run check` green (build, eslint, prettier, tsc, skill, vitest).
- DOM rendering and the slide/badge behavior are verified end-to-end in a live lavish session (open a thread, post an agent reply into it, confirm the chip count, the live append, and the Back badge for cross-thread activity), matching the "reproduce/verify E2E as an end user would" bar.

## Convergence review (required before push)

Per the handoff, two prior UI commits were never run through the Codex↔Claude convergence loop, and this panel work has not been either.
Before anything is pushed to the fork:

1. Run the Codex↔Claude convergence loop over `git diff d6fed75..HEAD` (the prior `bec8d91` wrap fix and `d76b9c0` markdown/reply-to-own) **plus** the new thread-panel diff.
2. Verify each finding (reject wrong ones), fix real ones test-first, and repeat until both reviewers agree there are no remaining BLOCKER/HIGH/MEDIUM issues.
3. Only then push `feat/realtime-sse-threading` to `fork` (`git@github.com:eloise-idealab/lavish-axi.git`).

## Out of scope (YAGNI)

- Arbitrary nested threads (we stay one level deep, like Slack).
- Per-thread unread _counts_ (a single boolean Back badge is enough for a single reviewer).
- Server-side thread aggregation or a thread index endpoint (client derivation suffices at this transcript size).
- Collapsing/pinning threads, thread search, reactions.

## Files touched

- `src/chrome-client.js` — thread model, `resolveRoot`/grouping helpers, chat-pane vs thread-pane rendering, open/close, reply targeting, live-update routing, Back badge.
- `src/chrome.css` — `.chat-pane` / `.thread-pane`, slide-out animation, thread chip, Back button + badge, thread composer.
- `src/server.js` `createChromeHtml` — the chrome HTML template gains the thread-pane scaffold (header, thread chat container, reply composer).
- Build artifact `dist/` is regenerated by `node scripts/build.js`; the globally linked `lavish-axi` picks it up after a tab reload.
