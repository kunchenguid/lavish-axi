# AGENTS.md

This file provides guidance to coding agents when working with code in this repository.

## Commands

```sh
pnpm run check          # Run build, lint, format check, typecheck, and tests
pnpm run build          # Bundle dist/cli.mjs and copy chrome/design assets into dist
pnpm test               # node:test runner (test/*.test.js)
pnpm run lint           # ESLint over bin src test scripts
pnpm run format:check   # Prettier check
pnpm run typecheck      # tsc --noEmit (checkJs mode)
```

Run a single test file: `node --test test/server.test.js`.
Filter by test name: `node --test --test-name-pattern "createOpenOutput" test/cli-output.test.js`.

The `prepack` script runs `build` automatically, so publishing always ships a fresh bundle.

## Project Conventions

- Node 22+, ESM-only JavaScript (`"type": "module"`). No TypeScript source - `.js` files validated via TS `checkJs`.
- Use TDD for bug fixes and new features (see `test-driven-development` skill).
- Run `pnpm run check` before pushing.
- Do not hand-edit `CHANGELOG.md` or `.release-please-manifest.json` - release-please owns them.
- Human-authored PRs to `main` must go through [`no-mistakes`](https://github.com/kunchenguid/no-mistakes); CI enforces a deterministic signature in the PR body. See CONTRIBUTING.md.

## Architecture

Lavish Editor is a CLI + local HTTP server that opens agent-generated HTML artifacts in a browser, lets the user annotate elements or selected text ranges, and ships those annotations back to the agent over a long-polling API.

### Process model

The CLI (`bin/lavish-axi.js` -> `src/cli.js`) is the user-facing entry point.
The first command that needs the server spawns `lavish-axi server` as a **detached** background process (`src/cli.js:startServer`) and waits for `/health`, which returns `{ ok, app, version }`.
Subsequent CLI invocations reuse the running server only when its health version matches the current CLI version; stale servers are asked to `POST /shutdown`, and pre-handshake servers may be SIGTERM'd by port PID before the upgraded server is spawned.
Port defaults to 4387 (`LAVISH_AXI_PORT`).

State lives at `~/.lavish-axi/state.json` (override with `LAVISH_AXI_STATE_DIR`). All sessions across all projects share this one file, keyed by a sha256 prefix of the canonicalized file path - so the CLI never needs opaque session IDs; the canonical HTML path _is_ the identity (`src/session-store.js:sessionKey`).

### Request flow

1. `lavish-axi <file.html>` (`openCommand`) -> POST `/api/sessions` -> `SessionStore.upsertSession` -> server returns `http://localhost:PORT/session/<key>` and the CLI calls `open` to launch the browser.
2. The browser loads `GET /session/:key`, which serves a chrome page (`createChromeHtml`) containing an iframe pointing at `/artifact/:key/index.html`, a stylesheet at `/chrome.css`, and browser behavior at `/chrome-client.js`.
   The chrome client reads its session bootstrap from the `lavish-session` JSON script in the page.
3. The artifact route reads the HTML from disk and runs `injectLavishSdk` (`src/html-transform.js`) to append `<script src="/sdk.js?key=...">` at the end of `<body>`. Nothing else is injected - artifacts stay byte-identical (apart from the SDK script tag) so they remain portable when opened directly without the server.
4. Sibling assets resolve under `/artifact/:key/<path>`, sandboxed to the artifact's directory (`resolveArtifactAsset` rejects paths that escape via `..`). The packaged Tailwind/DaisyUI assets are still served from `/design/:asset` so older artifacts that link them keep working, but new artifacts are no longer auto-wired to those routes.
5. User actions in the iframe `postMessage` to the chrome (queue prompts, request snapshot, end session). The chrome POSTs collected prompts to `/api/:key/prompts`, which queues them in the session store and emits a `feedback` event. Text selection prompts use `tag: "text"` and preserve a structured `target` with `type: "text-range"`, selected text, `commonAncestorSelector`, and start/end boundary anchors.
6. `lavish-axi poll <file.html>` (`pollCommand`) hits `GET /api/poll`. If queued prompts exist, it records that an agent has observed the session and returns immediately; otherwise it marks the session as actively listening and long-polls on an `EventEmitter` until a `feedback` or `ended` event fires (default: no timeout - `--timeout-ms` is a test escape hatch).
7. The `/events/:key` SSE stream emits `agent-presence` states: `waiting` before any poll has attached, `listening` while a poll is active, and `working` after a poll has delivered feedback and released.
   The chrome uses this state to show the waiting banner, allow queued feedback while waiting or listening, and block sends only while working.
8. `--agent-reply` posts a chat message into the session before polling, so the agent's reply renders in the browser conversation panel via the `/events/:key` SSE stream.

### Live reload

When a session opens, `chokidar` watches the artifact file itself by default - watching the entire parent directory recursively saturated the event loop when artifacts lived inside large trees like `~`.
Artifacts can opt back into directory-wide live reload by adding `data-lavish-live-reload-root` to a root element or `<meta name="lavish-live-reload" content="root">`; that switches the watcher to the artifact's directory (excluding `.git`, `node_modules`, `dist`, `build`, `.lavish-axi`).
Any file change emits a `reload` event, which the SSE endpoint pushes to the chrome page, which reloads the iframe.
During version-driven shutdown, the server sends a `chrome-reload` SSE event so open browser chromes wait for the replacement server and then reload the whole chrome page.
Hand-edited files in `dist/` won't trigger reloads.
Run `lavish-axi server --verbose` (or set `LAVISH_AXI_DEBUG=1`) to log session and watcher events to stderr when diagnosing wedges.

### AXI integration

The CLI is built on `axi-sdk-js` (`runAxiCli`). The `home()` callback returns the rich object shown when the user runs `lavish-axi` with no arguments - this is the same TOON-serialized output that lands in the agent's `SessionStart` hook (`sessions`, `visual_guidance`, `playbooks`, `help`). Top-level `--help` returns the same static guidance without dynamic sessions, `lavish-axi playbook [playbook_id]` exposes focused artifact guidance, and `lavish-axi design` prints copy-pasteable Tailwind/DaisyUI CDN URLs plus the DaisyUI component reference (opt-in - artifacts stay portable by default). The bare-arg form (`lavish-axi some.html`) is normalized into `["open", "some.html"]` by `normalizeArgv`.

### Telemetry

`src/telemetry.js` posts anonymous events to an Umami endpoint.
The website ID and host can be baked into the bundle at build time via `LAVISH_AXI_UMAMI_HOST`/`LAVISH_AXI_UMAMI_WEBSITE_ID` env vars (consumed by `scripts/build.js` and inlined as `process.env.LAVISH_AXI_BUILD_UMAMI_*` defines).
The build also inlines `package.json`'s version as `process.env.LAVISH_AXI_BUILD_VERSION` for the CLI/server version handshake, with source runs falling back to reading `package.json`.
Users opt out with `LAVISH_AXI_TELEMETRY=0`.
The client is best-effort and must never affect CLI behavior - all errors are swallowed.
No need to explicitly document the telemetry behaviors.

## Things to know when editing

- `canonicalFile` runs `realpath`, so symlinks resolve to their target before becoming session keys. Two paths that refer to the same file always collapse to one session.
- The SDK injected into artifacts lives in `src/artifact-sdk.js` and is wrapped by `createSdkJs`. It executes inside an iframe sandboxed with `allow-scripts allow-forms allow-popups allow-downloads` (no `allow-same-origin`), so it cannot read the chrome's DOM - communication is `postMessage` only. Design assets (Tailwind, DaisyUI) are not auto-injected: agents that want them should paste the CDN snippet from `lavish-axi design` into the artifact's `<head>`, or use any other styling approach.
- Artifact controls marked with `data-lavish-action` and their descendants are ignored by annotation handlers and get a pointer cursor, so use that marker on SDK-powered controls that call `window.lavish.queuePrompt()` or `window.lavish.sendQueuedPrompts()`.
- For text annotations, `prompt.selector` is the common ancestor/container selector, not the complete identity. Use the `target` range boundaries and snapshot context to locate the exact selected text.
- `SessionStore` re-reads and re-writes the entire `state.json` on every operation. There's no in-memory cache and no locking - acceptable because writes are infrequent and serialized through the single server process.
- Tests use `LAVISH_AXI_STATE_DIR` and ephemeral ports to stay isolated. When adding tests that spin up the server, do the same.
