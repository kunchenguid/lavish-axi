# Unread thread replies — design

Date: 2026-06-26
Branch: `feat/realtime-sse-threading`
Status: shipped - implemented and merged on branch `merge/main-into-sse`. The Context section below describes the chrome as it was BEFORE this change; for current behavior see README.md, the `lavish-axi` CLI guidance, and AGENTS.md.

## Context (state before this change)

The thread panel groups replies under a root and shows a reply-count chip on roots with ≥1 reply ("3 replies · 5m").
Before this change the only unread signal was the transient **Back badge**, which lit only while you were reading a _different_ thread (`shouldFlagBackBadge` + `setBackBadge`) and cleared on `openThread`/`closeThread`.
In the root list there was no per-thread read/unread state: a chip looked identical whether or not the agent had posted new replies you hadn't seen.
So a reply that landed in a thread you were not currently viewing was easy to miss once you were back in the list.

## Goal

Make it obvious, at a glance in the root list, which threads have replies you haven't read yet.

## Design

### Read model (client-side, session-only)

- Track `seenReplyCount: Map<rootId, number>` — how many replies in each thread the user has seen.
- **Baseline once on first load:** the first `syncChat` (initial transcript) marks every thread as seen (`seenReplyCount[rootId] = current reply count`), so opening the review does NOT flag every existing thread as unread. A `seenBaselined` flag guards this so later syncs don't re-baseline.
- **Becomes unread:** any later `syncChat` or `agent-reply` that grows a thread's reply count beyond its seen count makes it unread. `seenReplyCount` is preserved across model rebuilds (it is independent of the message model, which is cleared and rebuilt by `setMessages`).
- **Marked read:** `openThread(rootId)` sets `seenReplyCount[rootId] = current reply count` for that root. A reply that arrives into the _currently open_ thread (live append in `ingestIncoming`/`sendThreadReply` when `openThreadRootId === rootId`) also bumps the seen count, so you never see your own open thread as unread.
- **Persistence:** in memory only. A page reload rebuilds the model and re-baselines, so everything is read again. (Approved YAGNI call — reloads are rare in a review session.)

### Unread count + chip

- `unreadReplyCount(rootId, currentReplyCount, seenMap)` (pure) = `max(0, currentReplyCount - (seenMap.get(rootId) ?? 0))`.
- A thread is **unread** when `unreadReplyCount > 0`.
- In `renderChat`, for each root with replies:
  - **Read** chip (unread count 0): current muted style, label `threadChipLabel(count, lastAt, now)` → "N replies · <time>".
  - **Unread** chip (unread count > 0): solid-brass style with a leading dot, label **"N new"** where N is the unread count (no timestamp — "new" carries the recency). Singular "1 new".

### Chip markup + styling

- `buildBubble` gains an `unread` flag alongside the existing `chip`. The chip button always contains a `<span class="dot"></span>` plus the label span; CSS hides the dot unless the chip is unread.

```
<button class="thread-chip[ unread]" type="button" data-root-id="<id>"><span class="dot"></span><label></button>
```

- `src/chrome.css`:
  - `.thread-chip .dot { width:6px; height:6px; border-radius:50%; background: var(--accent); display:none; }`
  - `.thread-chip.unread { background: var(--accent); border-color: var(--accent); color: var(--brass-ink); }`
  - `.thread-chip.unread .dot { display:block; background: var(--brass-ink); }`
  - The read `.thread-chip` rule is unchanged.

### Relationship to the Back badge

Unchanged and complementary: the Back badge still flashes the moment activity lands outside the open thread; the unread chip is the persistent marker you see when you return to the list.
(Aside: the real `formatRelativeTime` only emits "just now" for < 5s, then "30s/5m/3h/2d" — there is no plain "now"; unread chips show no time at all.)

## Scope

`src/chrome-client.js` — `seenReplyCount` map + `seenBaselined` flag, baseline in `syncChat`, mark-seen in `openThread` and the open-thread live-append paths, `unreadReplyCount`/`isThreadUnread` pure helpers (exposed on the `globalThis.__lavishTest` seam), and the unread flag + "N new" label in `renderChat`/`buildBubble`.
`src/chrome.css` — the `.thread-chip .dot` and `.thread-chip.unread` rules.
No server change; the thread model, Back badge, reply flow, and annotation card are untouched.

## Out of scope (YAGNI)

- Cross-reload persistence of seen-state (sessionStorage).
- A global unread total/badge on the panel header.
- Marking individual replies (vs. whole threads) read.
- Any change to the Back-badge logic.

## Testing

- **Unit (pure helpers, via the `__lavishTest` seam + the `node:vm` harness):**
  - `unreadReplyCount` arithmetic (never negative; 0 when seen ≥ count; positive when count grew).
  - Baseline behavior: after the first `syncChat`, no thread is unread; after a later `agent-reply` adds a reply to a thread, that thread is unread; `openThread` clears it.
  - A reply into the currently open thread does NOT mark it unread.
- **Playwright E2E (primary visual gate),** same approach as the thread panel: seed a root + reply (read at load), then post a new `agent-reply` into that thread while it's closed → assert its chip gains `.thread-chip.unread` and reads "1 new"; open the thread → assert the chip reverts to muted "N replies · <time>".
- `npm run check` stays green.

## Convergence review (required before push)

Run the Codex↔Claude convergence loop over the combined diff (this + the annotation-actions feature) before pushing, verifying each finding and fixing test-first until both reviewers agree there are no remaining BLOCKER/HIGH/MEDIUM issues.
