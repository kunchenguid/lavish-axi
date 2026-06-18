# Lavish Editor — UI kit

A clickable design reference for the **Lavish Editor chrome** that the `lavish-axi` CLI launches in a browser.
The production chrome in `src/chrome.css`, `src/server.js`, and `src/chrome-client.js` is canonical; it now uses the v2 top bar with an **Annotate** switch, an overflow menu for editing actions, a split **Send to Agent** button with **Send & end session**, and an open-time layout gate that reuses the ended-session card visual language.
This kit remains useful for token-driven components and interaction exploration, but check the production files before copying exact chrome structure.

Open `index.html` and try:

1. Hover any element in the "artifact" pane — you'll see the brass annotation outline.
2. Click an element. The **Annotate** card pops up positioned near it.
3. Type a note and queue it - a pill appears in the composer below the chat.
4. Stack a few pills, then hit **Send to Agent**.
   The pills clear; a sage "working…" bubble appears; a faked reply lands a second later.
5. In production, use the **Annotate** switch to leave editing mode and the overflow menu for copy path, reload artifact, copy DOM snapshot, and end session.

Everything is fake — there's no `lavish-axi` server backing it. The reply text is canned. The DOM snapshot is not transmitted anywhere.

## Files

- `index.html` — entry; pulls React, Babel, and every JSX file in order.
- `app.jsx` — top-level `App` component. Holds chat / queued-prompts / annotation state.
- `TopBar.jsx` - v2 56px sticky bar reference with the brand, Annotate switch, and overflow menu for editing actions.
- `Artifact.jsx` — the faux landing page rendered where the agent's HTML normally goes.
- `AnnotationCard.jsx` — floating card that opens when an element is clicked.
- `ChatPanel.jsx` — side panel: heading + chat log + composer.
- `Bubbles.jsx` — `UserBubble`, `AgentBubble`, `WorkingBubble`.
- `Pills.jsx` — queued-prompt chip with × close affordance.

## Not implemented (on purpose)

This is a **kit**, not a build of the product. Skipped:

- The real iframe sandbox + `postMessage` wire (the artifact is rendered inline; we listen to clicks directly).
- Text-range selection annotations; the product can annotate selected text, but this kit only recreates element-click annotations.
- The open-time layout gate that masks artifacts until the production in-iframe audit reports no error-severity layout findings.
- The `EventSource` reload pipe, the `chokidar` watcher.
- DOM snapshot serialization. `lavish.snapshot()` would produce something like the tree in `src/artifact-sdk.js`; we don't.
- File-path identity, session store, long-polling.

Read `src/server.js`, `src/chrome-client.js`, `src/chrome.css`, and `src/artifact-sdk.js` in the lavish-axi repo for the canonical behaviour.
