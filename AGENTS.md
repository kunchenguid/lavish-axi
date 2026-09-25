# AGENTS.md

This file is loaded every session. It keeps only rules that apply to almost every change. Detail lives in the doc that owns it.

- [README.md](README.md) owns the user-facing contract: features, CLI flags, environment variables, keyboard shortcuts, export and share, and session-end etiquette.
- CLI output owns what agents are told while using Lavish: `lavish-axi --help`, `lavish-axi design`, and `lavish-axi playbook <id>` (`src/cli.js`, `src/design-reference.js`, `src/playbooks.js`). The generated skill (`src/skill.js` to `skills/lavish/SKILL.md`) stays a stub that points at those commands. Do not copy CLI-owned instructions into the skill.
- [VISION.md](VISION.md) owns the acceptance policy. Change it only through the author.
- [docs/invariants.md](docs/invariants.md) owns architecture internals, security rationale, and easy-to-reintroduce failure modes. Read the section for the area you are editing before changing it.
- Update the owner when a contract changes. Edit this file only when an every-session rule changes.

## Commands

```sh
pnpm run check          # build, lint, format check, typecheck, tests, and skill freshness
pnpm run build          # bundle dist/cli.mjs and copy chrome/design assets into dist
pnpm run build:skill    # regenerate skills/lavish/SKILL.md from src/skill.js
pnpm test               # node:test runner (test/*.test.js)
pnpm run lint           # ESLint over bin src test scripts
pnpm run format:check   # Prettier check
pnpm run typecheck      # tsc --noEmit (checkJs)
```

One file: `node --test test/server.test.js`. One name: `node --test --test-name-pattern "createOpenOutput" test/cli-output.test.js`.
Opt-in browser suites need `chrome-devtools-axi`: `LAVISH_AXI_BROWSER_E2E=1 node --test test/layout-audit-browser.test.js test/layout-warning-inbox.browser.test.js`.
Seven-tab pool regression: `LAVISH_AXI_BROWSER_E2E=1 node --test test/event-transport.browser.test.js`.
`prepack` and `prepare` both run `build`. `pnpm run check` fails if `skills/lavish/SKILL.md` drifts from `createSkillMarkdown()`, or if root `plugin.json` drifts from `pnpm run build:plugin`. Release-please bumps `plugin.json` through `extra-files`.

## Project conventions

- Node 22+, ESM-only JavaScript (`"type": "module"`). No TypeScript source. `.js` files are validated with `checkJs`.
- Use TDD for bug fixes and new features (see the `test-driven-development` skill).
- Run `pnpm run check` before pushing.
- Treat repo-provided `.agents/` skill content as vendored. Prettier ignores it.
- Do not hand-edit `CHANGELOG.md` or `.release-please-manifest.json`. Release-please owns them.
- Human-authored PRs to `main` go through [no-mistakes](https://github.com/kunchenguid/no-mistakes) >= 1.46.0. [CONTRIBUTING.md](CONTRIBUTING.md) owns the gate, the attestation contract, and the workflow-pin rules.
- Tests that start the server set `LAVISH_AXI_STATE_DIR` and use an ephemeral port.
- `run()` returns on `--version` / `-v` / `-V` before `ensureStateDir` and telemetry (`test/cli-version.test.js`). New startup work goes after that short-circuit.
- `canonicalFile` runs `realpath`. Two paths to the same file are one session.
- `normalizeArgv` must let AXI `RESERVED_COMMANDS` (including `update`) pass through. A bare `lavish-axi update` must not become `open update`.

## Safety and correctness

Each line is the rule. [docs/invariants.md](docs/invariants.md) has the failure mode.

- The session key is the canonical artifact path. It is not a secret. No route may treat key possession as authorization. [Process model](docs/invariants.md#process-model).
- Never signal a listener by port alone. Stop only a Lavish PID bound to that exact address, or `POST /shutdown` on an owned server. [Process model](docs/invariants.md#process-model).
- Health probes use `node:http` and destroy the socket on every exit. Do not use `fetch`. [Process model](docs/invariants.md#process-model).
- Loopback binds first and is the port lock. A failed requested address stays in `pendingBinds` and is retried. Declare request-handler timers before the first bind. [Process model](docs/invariants.md#process-model).
- Host allowlist, then Origin/Referer guard. Header-less CLI control requests must keep working. `*` skips hostname membership and still rejects a malformed forwarded authority. [Process model](docs/invariants.md#process-model).
- `/api/:key/prompts`, `/share`, whiteboard writes, and attachment upload/delete are same-origin guarded. The key alone must never queue a prompt or publish. [Request flow](docs/invariants.md#request-flow).
- Layout detection never emits `feedback`. Only a user prompt and the narrow fatal artifact-failure path may wake `lavish-axi poll`. [Request flow](docs/invariants.md#request-flow).
- Poll feedback field order is `prompts`, `artifact_failures`, `next_step`, then `dom_snapshot`. Never move `next_step` after the snapshot. [Request flow](docs/invariants.md#request-flow).
- `takeFeedback` is destructive. A disconnected poll restores through `queuePrompts` `restore`: prepend, do not re-plan, re-emit `feedback`, and exempt only the request-wide attachment-ref cap. [Request flow](docs/invariants.md#request-flow).
- Every store mutation takes `store.lock`. `referencedAttachmentIds` stays lock-free. [Image attachments](docs/invariants.md#image-attachments).
- Attachment identity is the content-addressed file. `queuePrompts` re-derives path, mime, bytes, and dimensions from disk. Resolution is all-or-nothing. `boundAttachmentRefs` runs before any filesystem await. [Image attachments](docs/invariants.md#image-attachments).
- Do not put a body-parser `limit` on the attachment upload route. Drain the body, then 413. The chrome is the confused deputy for iframe uploads and shares one page-wide budget with the composer. [Image attachments](docs/invariants.md#image-attachments).
- Removing a chip never deletes an attachment. Only the reference-aware sweeper and the same-origin `DELETE` route for unreferenced attachments delete. No iframe-driven delete. Cap admission goes through `admitAttachmentCharge` and charges allocated blocks. [Image attachments](docs/invariants.md#image-attachments).
- Artifact asset serving (`/artifact/:key/<path>`) resolves with `realpath` and never serves a symlink target outside the artifact directory. [Request flow](docs/invariants.md#request-flow).
- Export makes no outbound requests. Local reads stay inside the artifact directory after `realpath`. A symlink must not escape. [Export (local-asset inlining)](docs/invariants.md#export-local-asset-inlining).
- `--unpublish` is not a deletion. There is no clear-password path. Empty share flag values are refused. A lost create response must not offer a recovery the host cannot perform. Suggested commands never contain a password placeholder. [Hosted sharing (ht-ml.app)](docs/invariants.md#hosted-sharing-ht-mlapp).
- Share passwords are minted only in `src/share-password.js`. Lavish persists neither the password nor `update_key`. [Hosted sharing (ht-ml.app)](docs/invariants.md#hosted-sharing-ht-mlapp).
- The whiteboard channel token is not a secret. Trust is session-key binding plus descent from the artifact frame (`isArtifactChildWindow`). [Whiteboard](docs/invariants.md#whiteboard-mermaid-excalidraw).
- Mermaid source stays authoritative. There is no scene-to-Mermaid reverse conversion. `mermaid` is pinned exactly. Persisted Excalidraw `appState` must not carry `theme` or a dark `viewBackgroundColor`. [Whiteboard](docs/invariants.md#whiteboard-mermaid-excalidraw).
- Every artifact-to-chrome message goes through `postArtifactMessage`. The artifact iframe stays sandboxed without `allow-same-origin`. [Things to know when editing](docs/invariants.md#things-to-know-when-editing).
- SDK helpers that the browser must call are exported functions in a module `serializeModuleHelpers` inlines. No module-level constants. [Things to know when editing](docs/invariants.md#things-to-know-when-editing).
- A layout warning clears only on a newer artifact revision plus a complete pass at the same viewport class. Do not emit `feedback` for a detection. [Passive layout-warning inbox](docs/invariants.md#passive-layout-warning-inbox).
- `resetRevisionLegend()` runs only when `replaceArtifactFrame` actually assigns `frame.src`. Reject over-long revision ids and selectors. Lookups use `Map`/`Set`. [Things to know when editing](docs/invariants.md#things-to-know-when-editing).
- A keyboard shortcut that must work in both chrome and the artifact needs a capture-phase listener in both `src/chrome-client.js` and `src/artifact-sdk.js`, and it requires a modifier. [Things to know when editing](docs/invariants.md#things-to-know-when-editing).
- Reload and gate recovery probe `/health` before navigating. Do not call `location.reload()` directly. Sticky "Lavish is not running." copy is never cleared by a later successful load. [Live reload](docs/invariants.md#live-reload).
- Shutdown banner text must be true for the `reason` that fired. Idle shutdown reloads nothing. [Live reload](docs/invariants.md#live-reload).
- `plugin.json` and `skills/lavish` stay in `package.json` `files`. Skill frontmatter stays inside `validateSkillMarkdown`'s allowed shape. An unlinkable plugin client is reported, never thrown. Do not ship `mcp.json`. [Agent Plugins packaging](docs/invariants.md#agent-plugins-packaging).
- `DESIGN_PRIORITY_RULE` is stated once in `src/design-reference.js`. Do not restate it. Do not hardcode one Mermaid theme. [AXI integration](docs/invariants.md#axi-integration).
- The internal brand skill keeps `metadata.internal: true`. The generated skill omits a `version` frontmatter field. [AXI integration](docs/invariants.md#axi-integration).
- Telemetry is best-effort and must never affect CLI behavior. Users opt out with `LAVISH_AXI_TELEMETRY=0`. [Telemetry](docs/invariants.md#telemetry).
- Self-paint stays a warning. Never block open and never auto-repair. [Things to know when editing](docs/invariants.md#things-to-know-when-editing).
- The layout audit fails open. An empty completed pass means repaired. A failed run publishes `complete: false` and no findings. [Things to know when editing](docs/invariants.md#things-to-know-when-editing).

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
