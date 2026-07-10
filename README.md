<h1 align="center">lavish-axi</h1>
<p align="center">
  <a href="https://github.com/kunchenguid/lavish-axi/actions/workflows/ci.yml"
    ><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/kunchenguid/lavish-axi/ci.yml?style=flat-square&label=ci"
  /></a>
  <a href="https://github.com/kunchenguid/lavish-axi/actions/workflows/release-please.yml"
    ><img alt="Release" src="https://img.shields.io/github/actions/workflow/status/kunchenguid/lavish-axi/release-please.yml?style=flat-square&label=release"
  /></a>
  <a href="https://www.npmjs.com/package/lavish-axi"
    ><img alt="npm" src="https://img.shields.io/npm/v/lavish-axi?style=flat-square"
  /></a>
  <a href="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=flat-square"
    ><img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=flat-square"
  /></a>
  <a href="https://x.com/kunchenguid"
    ><img alt="X" src="https://img.shields.io/badge/X-@kunchenguid-black?style=flat-square"
  /></a>
  <a href="https://discord.gg/Wsy2NpnZDu"
    ><img alt="Discord" src="https://img.shields.io/discord/1439901831038763092?style=flat-square&label=discord"
  /></a>
</p>

<h3 align="center">For when a rich editor is not rich enough.</h3>

<p align="center">
  <img alt="Lavish Editor demo" src="lavish-editor-marketing/renders/lavish-editor-marketing.gif" width="960" />
</p>

HTML is the new markdown. Lavish is the new editor for your HTML artifacts.

Agents are good at producing rich HTML artifacts, but the human-agent collaboration loop on such artifacts is lacking and falls back into screenshots and long responses for “tell me what to change.”
That loses the thing HTML is best at: interactivity.

Lavish Editor opens agent-generated HTML files in a local browser, lets you pinpoint elements and selected text, edit rendered Mermaid diagrams as whiteboards, and send feedback to the agent to address.

- **Local-first** - Review local HTML artifacts with a local CLI and no cloud dependency in the core feedback loop; hosted sharing through third-party ht-ml.app is explicit and opt-in.
- **Human-AI collaboration** - Annotate elements and selected text ranges, edit Mermaid diagrams as whiteboards, and send messages to the agent without leaving Lavish Editor.
- **Battery included** - Lavish Editor teaches your agent good visualization for common use cases such as product or technical plans, design explorations and more out of the box.

Lavish Editor is an [AXI](https://axi.md), which means -

- It's just a CLI any capable agent can run without setup.
- It's optimized for agent ergonomics. TOON output, long polling, and contextual disclosure making it highly token efficient.
- The skill and hooks below only handle discovery; agents learn to use the AXI by using it.

## Quick Start

Install the Lavish skill in the [Agent Skills](https://agentskills.io) format with [`npx skills`](https://github.com/vercel-labs/skills):

```sh
npx skills add kunchenguid/lavish-axi --skill lavish
```

That is the entire setup - no npm install needed.
The skill teaches your agent to run Lavish through `npx -y lavish-axi`, so the CLI comes along on demand.
In restricted subprocess sandboxes, CI, or agent harnesses where `npx -y` exits opaquely, the skill also documents direct installed-copy fallbacks through the local or global npm install path.
Its frontmatter also includes Hermes Agent metadata, so Hermes-compatible harnesses can categorize and surface it as a first-class productivity skill.
This installs the public `lavish` skill.
The repository also contains an internal `lavish-design` brand skill for maintainers; default `npx skills add ... --list` and skills.sh discovery hide it unless `INSTALL_INTERNAL_SKILLS=1` is set.

Then, in agents that expose skills as slash commands (Claude Code, for example), invoke it directly:

```
/lavish let's discuss our plan here
```

Or just ask for anything that is easier to grasp visually - a plan, comparison, diagram, table, code view, or report - and the agent loads the skill on its own when it recognizes the task.

By default the skill lands in the current project's skills directory (`.claude/skills/`, for example); add `-g` to install it for all projects (`~/.claude/skills/`).

## Other Ways to Use Lavish

The skill is the recommended path, but it is not the only one.

### Zero setup

Lavish is an AXI, so any capable agent can run the CLI directly with nothing installed at all.
Just tell your agent:

```
Use `npx -y lavish-axi` to write a product or technical plan for what we discussed.
```

### Session hook

Want Lavish's ambient context - including your live open sessions - fed into every agent session instead of loading on demand?
Install the CLI globally and opt into the hook:

```sh
npm install -g lavish-axi
lavish-axi setup hooks
```

This installs a `SessionStart` hook for **Claude Code**, **Codex**, **OpenCode**, and **GitHub Copilot CLI** that surfaces open sessions, visualization playbooks, and usage guidance at the start of each session.
Unlike the skill, the hook also shows your live open sessions, so a fresh agent session can resume an in-flight review.
**Restart your agent session after running this** so the new hook takes effect.

### From source

```sh
git clone https://github.com/kunchenguid/lavish-axi.git
cd lavish-axi
pnpm install --frozen-lockfile
pnpm run build
pnpm link
```

## How It Works

```
┌───────────────┐
│ Agent writes  │
│ artifact.html │
└───────┬───────┘
        ▼
┌────────────────────────┐
│ lavish-axi <file_path> │
│ opens local browser UI │
└───────┬────────────────┘
        ▼
┌────────────────────────┐
│ Human annotates text   │
│ or elements, sends     │
│ chat, or browser audit │
│ proves severe failures │
└───────┬────────────────┘
        ▼
┌────────────────────────┐
│ lavish-axi poll waits  │
│ and returns prompts    │
│ or severe failures     │
└────────────────────────┘
```

- **File-path identity** - Sessions are keyed by the canonical HTML file path, so agents do not need opaque IDs.
- **Portable artifacts** - The artifact runs in an iframe while Lavish injects a small SDK for annotations, snapshots, feedback controls, and render-time layout checks.
  Lavish does not inject any design system, so the saved HTML file renders identically whether you open it through `lavish-axi` or directly in a browser.
  Run `lavish-axi design` for the single source of agent-facing design guidance and optional CDN or Mermaid snippets.
- **Open-time layout gate** - The browser chrome masks an artifact only while the real in-iframe audit checks for a stable, proven severe layout failure.
  A severe failure notifies the agent through the `layout_warnings` poll path and keeps the curtain up until a clean reload, while cosmetic, intentional, transient, tiny, and uncertain observations stay silent.
  The user can click **Show anyway**, and a bounded safety timeout fails open without an issue banner when no severe failure has been proven.
- **Layout failures** - After fonts and finite animations settle, the injected SDK confirms severe failures from direct rendered evidence such as materially escaped meaningful content or required controls, clipped text fragments, viewport reachability, or near-total semantic occlusion.
  Explicit ellipsis and line clamp, standard visually hidden accessibility text, intentional scrollers or masks, parent overhang, generic element scroll geometry, decorative overlap, and uncertain motion do not produce findings by themselves.
  Proven failures are returned from `lavish-axi poll` in `layout_warnings` with `selector`, `kind`, `axis`, `overflowPx`, `viewportWidth`, `severity`, and `persistent`.
  Every returned failure should be fixed and rechecked before asking the human to review.
- **Local assets** - Copy local images, CSS, fonts, and scripts next to the HTML artifact and reference them with relative paths from that directory; root-prefixed paths such as `/assets/logo.png` will not resolve through Lavish's artifact route.
- **Export and sharing** - `lavish-axi export` writes `<name>.export.html` by inlining local assets only, stripping the annotation SDK, and leaving remote CDN/font references as links that still need network access.
  `lavish-axi share` publishes the same local-inlined HTML to [ht-ml.app](https://ht-ml.app), a third-party hosting service not part of Lavish.
  Publishing sends the artifact to ht-ml.app's servers, public by default, or private and password-protected with `--password`; the response includes a secret `update_key` shown once for later management.
  Bundling never fetches remote URLs, Lavish itself does not set a CSP, local reads stay confined and size-capped, and absolute `file://` paths outside safe inlined asset references are redacted before output.
  Per-asset and per-bundle inline caps default to 10 MB and 25 MB, overridable with `LAVISH_AXI_EXPORT_MAX_ASSET_BYTES` and `LAVISH_AXI_EXPORT_MAX_BUNDLE_BYTES`.
  Unresolved local assets or export notices such as author-set CSP meta tags and redacted file URLs are surfaced in command or browser output.
  Use `--token` or `LAVISH_AXI_HTML_APP_TOKEN` for an optional bearer token; set `LAVISH_AXI_HTML_APP_API_URL` only when overriding the ht-ml.app API base.
- **Live reload** - Lavish watches the HTML artifact file by default and preserves the artifact iframe scroll position across reloads. To also reload on sibling asset changes, add `data-lavish-live-reload-root` to the root element or `<meta name="lavish-live-reload" content="root">`.
- **Feedback controls** - Native controls (radios, checkboxes, inputs, selects, buttons, labels, disclosure summaries, contenteditable) are interactive automatically, so they do not need `data-lavish-action`.
  For reversible choices, let option clicks update local state, then queue exactly one final answer from a per-question submit or Queue answer button with `window.lavish.queuePrompt()`.
  Mark only custom (non-native) clickable elements with `data-lavish-action` so Lavish does not annotate them, and use `data-lavish-question` or `queueKey` when pre-send updates for the same question should replace each other.
  Queued annotation preview pills and chat history share a scrollable Conversation panel above a sticky composer, so long feedback queues do not push the text box or send controls off screen.
  The browser chrome keeps editing actions in the overflow menu (copy path, reload artifact, copy DOM snapshot, export standalone HTML, publish link, end session), while the composer exposes **Send & End** beside **Send to Agent** to submit queued prompts and user-ended attribution together.
- **Keyboard shortcuts** - In the chrome composer, Enter sends queued prompts and Shift+Enter inserts a newline.
  In the annotation card, Enter queues the annotation, Shift+Enter inserts a newline, and Ctrl+Enter (Cmd+Enter on macOS) queues it and sends all queued prompts immediately.
  Cmd+I or Ctrl+I toggles between annotate and explore mode from either the browser chrome or the artifact iframe, including while focus is in a textarea or control.
- **Agent presence** - The browser shows when no agent is listening, keeps queued feedback and proven severe layout failures for the next successful `lavish-axi poll` send even across reloads, and only blocks human sends while the agent is working on delivered feedback; the agent's reply (`--agent-reply`) concludes that work and re-enables sends.
  The no-timeout poll writes an immediate stderr banner and periodic stderr heartbeats while stdout stays reserved for the final response; if the poll is interrupted or times out, re-run it because queued feedback is never lost.
  Codex-specific guidance keeps that poll attached to the active turn instead of hiding it in a background task, because completed background tasks may not resume the agent.
- **Session end etiquette** - Lavish tracks who ended a session: a human clicking **End session** (or **Send & end session**) in the browser is a user-initiated end, while `lavish-axi end <html-file>` is agent-initiated.
  A plain `lavish-axi <html-file>` after a user-initiated end refuses to reopen the browser and returns guidance instead; pass `--reopen` only when the user asks for further review or something important needs their visual attention.
  Agent-initiated ends keep reopening normally, same as before.
  `lavish-axi poll`'s `ended` response and the `feedback` response for the final batch before an end both carry `next_step` guidance telling the agent to stop polling and deliver remaining updates in chat instead of reopening.
- **Precise targets** - Text annotations include selected text plus range anchors, so agents are not limited to whole-element selectors.
- **Mermaid diagrams** - In the Lavish browser, every rendered Mermaid diagram in a `.mermaid` container becomes an embedded editable Excalidraw whiteboard.
  Click a diagram to unlock editing, and use its Fullscreen action to edit it over the whole viewport.
  Whiteboard scenes autosave locally.
  If a live reload changes the Mermaid source, the whiteboard shows that its edits are stale; reopening it lets the reviewer re-convert and discard the saved edits or keep editing the saved scene.
  Use **Queue feedback** to add a bounded edit summary plus local `.excalidraw` scene and PNG preview paths to the Conversation panel, then click **Send to Agent** to deliver it.
  The agent updates the artifact's Mermaid source, which remains authoritative.
  Flowchart, sequence, class, ER, and state diagrams convert to editable shapes; other diagram types are images that reviewers can draw and annotate.
  Lavish changes only the browser view, so saved, standalone, and exported artifacts still render plain Mermaid.
- **Server cleanup** - The detached server stops after the last session ends when nothing is connected, or after `LAVISH_AXI_IDLE_TIMEOUT_MS` (default 30 minutes) with no browser or poll connections.
  Set `LAVISH_AXI_IDLE_TIMEOUT_MS=0` or `off` to disable idle self-shutdown.
- **Local-first state** - Session state stays under `~/.lavish-axi/` by default, or `LAVISH_AXI_STATE_DIR` when set.
- **Server port** - Set `LAVISH_AXI_PORT` to choose the server port; it defaults to `4387`.
- **Network binding** - The server binds to loopback (`127.0.0.1`) by default. Set `LAVISH_AXI_HOST` to bind elsewhere; a wildcard (`0.0.0.0` or `::`) binds every interface. Binding beyond loopback exposes an unauthenticated server that can read and serve arbitrary local files to anything that can reach it, so only do so on a trusted network. Set `LAVISH_AXI_LINK_HOST` to control the hostname written into generated session links (defaults to the bind address, or loopback when bound to a wildcard).
- **Browser opening** - Set `LAVISH_AXI_NO_OPEN=1`, equivalent to `--no-open`, to create or resume a session without launching a browser window.

## CLI Reference

| Command                         | Description                                                                                                                                                                                                                                                                                    |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lavish-axi`                    | Show current sessions and usage guidance.                                                                                                                                                                                                                                                      |
| `lavish-axi update`             | Check for or apply the latest npm release through the AXI SDK self-updater.                                                                                                                                                                                                                    |
| `lavish-axi <html-file>`        | Open or resume a Lavish Editor session, with the open-time layout gate enabled by default. Refuses to reopen a session the user explicitly ended from the browser unless `--reopen` is passed.                                                                                                 |
| `lavish-axi poll <html-file>`   | Long-poll until the user sends feedback, ends the session, or the browser proves a severe layout failure; leave no-timeout polls running, or re-run them if interrupted. Codex guidance keeps polls attached to the active turn. On `status: ended`, stop polling and do not reopen uninvited. |
| `lavish-axi end <html-file>`    | End a session as the agent; unlike a user-initiated end from the browser, this still allows a plain reopen later.                                                                                                                                                                              |
| `lavish-axi export <html-file>` | Write a portable copy of the artifact: one HTML file with its local assets inlined, so it opens with no server and no sibling files. Remote CDN/font references are left as links.                                                                                                             |
| `lavish-axi share <html-file>`  | Publish the artifact (local assets inlined) to [ht-ml.app](https://ht-ml.app), a third-party host not part of Lavish, and print a visitable URL plus a secret update key; shares are public by default, and `--password` makes viewers enter the password before viewing.                      |
| `lavish-axi stop`               | Shut down the background server.                                                                                                                                                                                                                                                               |
| `lavish-axi playbook [id]`      | List focused artifact guidance or show one playbook; agents must open each matching playbook before writing HTML.                                                                                                                                                                              |
| `lavish-axi design`             | Show agent-facing design guidance, including optional CDN and Mermaid snippets.                                                                                                                                                                                                                |
| `lavish-axi setup hooks`        | Install or repair optional SessionStart hooks for Claude Code, Codex, OpenCode, and GitHub Copilot CLI; restart the agent session afterward.                                                                                                                                                   |
| `lavish-axi server`             | Run the local Lavish Editor server.                                                                                                                                                                                                                                                            |

Known playbook IDs: `diagram`, `table`, `comparison`, `plan`, `code`, `input`, `slides`.
One artifact often combines several playbooks, such as a plan that includes a comparison and a diagram, so agents must match against each `use_when` trigger and open every matching playbook before writing HTML.
For flows, architecture, state, or sequence diagrams, open the diagram playbook for the recommended tooling and SVG guidance.

### Flags

| Command                  | Flag                  | Description                                                                                                                                                                                                                         |
| ------------------------ | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lavish-axi <html-file>` | `--no-open`           | Ensure the server/session exists without opening another browser window.                                                                                                                                                            |
| `lavish-axi <html-file>` | `--no-gate`           | Skip the open-time layout curtain for this browser open.                                                                                                                                                                            |
| `lavish-axi <html-file>` | `--reopen`            | Reopen a session the user explicitly ended from the browser; without it, a plain open refuses and explains why instead of reopening uninvited.                                                                                      |
| `lavish-axi update`      | `--check`             | Report current vs latest npm version without installing an update.                                                                                                                                                                  |
| `lavish-axi export`      | `--out <path>`        | Write the export to a specific path instead of `<name>.export.html` next to the source.                                                                                                                                             |
| `lavish-axi share`       | `--password <pw>`     | Make the third-party ht-ml.app page private; viewers must supply the password.                                                                                                                                                      |
| `lavish-axi share`       | `--token <t>`         | Attach an optional bearer token (`LAVISH_AXI_HTML_APP_TOKEN`); never required to publish.                                                                                                                                           |
| `lavish-axi poll`        | `--agent-reply "..."` | Show the agent's reply in the existing browser chat and re-enable human sends before polling again.                                                                                                                                 |
| `lavish-axi poll`        | `--timeout-ms <ms>`   | Test/debug escape hatch only; agents should normally omit it and leave the long poll running.                                                                                                                                       |
| `lavish-axi stop`        | `--port <port>`       | Shut down a server running on a non-default port.                                                                                                                                                                                   |
| `lavish-axi server`      | `--verbose`           | Log session and watcher events to stderr; can also be enabled with `LAVISH_AXI_DEBUG=1`. Detached server output is appended to `~/.lavish-axi/server.log` (or `LAVISH_AXI_STATE_DIR/server.log`) for startup and crash diagnostics. |

## Development

```sh
pnpm run check          # Run all verification commands
pnpm run build          # Bundle the publishable CLI, chrome, and design assets
pnpm run build:skill    # Regenerate the installable lavish skill
pnpm test               # Run node:test tests
pnpm run lint           # Run ESLint
pnpm run format:check   # Check Prettier formatting
pnpm run typecheck      # Run TypeScript checkJs validation
```
