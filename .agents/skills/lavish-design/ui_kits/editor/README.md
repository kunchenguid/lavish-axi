# Lavish Editor — UI kit

A high-fidelity, clickable recreation of the **Lavish Editor chrome** that the `lavish-axi` CLI launches in a browser. Every styling value (colors, radii, shadows, spacing, type) is pulled either directly from `src/server.js` in the [`kunchenguid/lavish-axi`](https://github.com/kunchenguid/lavish-axi) repo or from `colors_and_type.css` in the parent of this folder.

Open `index.html` and try:

1. Hover any element in the "artifact" pane — you'll see the brass annotation outline.
2. Click an element. The **Annotate** card pops up positioned near it.
3. Type a note and **Queue Prompt** — a pill appears in the composer below the chat.
4. Stack a few pills, then hit **Send to Agent**. The pills clear; a sage "working…" bubble appears; a faked reply lands a second later.
5. Toggle **Annotation: On / Off** in the top bar to leave editing mode.
6. **End Session** shows the closing state.

Everything is fake — there's no `lavish-axi` server backing it. The reply text is canned. The DOM snapshot is not transmitted anywhere.

## Files

- `index.html` — entry; pulls React, Babel, and every JSX file in order.
- `app.jsx` — top-level `App` component. Holds chat / queued-prompts / annotation state.
- `TopBar.jsx` — the 56px sticky bar (brand · file path · Annotation toggle · End Session).
- `Artifact.jsx` — the faux landing page rendered where the agent's HTML normally goes.
- `AnnotationCard.jsx` — floating card that opens when an element is clicked.
- `ChatPanel.jsx` — side panel: heading + chat log + composer.
- `Bubbles.jsx` — `UserBubble`, `AgentBubble`, `WorkingBubble`.
- `Pills.jsx` — queued-prompt chip with × close affordance.

## Not implemented (on purpose)

This is a **kit**, not a build of the product. Skipped:

- The real iframe sandbox + `postMessage` wire (the artifact is rendered inline; we listen to clicks directly).
- The `EventSource` reload pipe, the `chokidar` watcher.
- DOM snapshot serialization. `lavish.snapshot()` would produce something like the tree in `src/server.js`; we don't.
- File-path identity, session store, long-polling.

Read `src/server.js` in the lavish-axi repo for the canonical behaviour.
