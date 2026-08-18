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

- **Local-first** - Review local HTML artifacts with a local CLI and no cloud dependency in the feedback loop; this installation disables third-party hosted sharing.
- **Human-AI collaboration** - Annotate elements and selected text ranges, edit Mermaid diagrams as whiteboards, and send messages to the agent without leaving Lavish Editor.
- **Battery included** - Lavish Editor teaches your agent good visualization for common use cases such as product or technical plans, design explorations and more out of the box.

Lavish Editor is an [AXI](https://axi.md), which means -

- It's just a CLI any capable agent can run after this patched checkout is linked.
- It's optimized for agent ergonomics. TOON output, long polling, and contextual disclosure making it highly token efficient.
- The skill and hooks below only handle discovery; agents learn to use the AXI by using it.

## Quick Start

First complete the [from-source setup](#from-source) so the patched CLI and its local design toolchain are linked on this machine.
Then install the Lavish skill in the [Agent Skills](https://agentskills.io) format with [`npx skills`](https://github.com/vercel-labs/skills):

```sh
npx skills add kunchenguid/lavish-axi --skill lavish
```

The skill deliberately teaches your agent to use the bare `lavish-axi` command, which resolves to that linked checkout.
Do not substitute `npx -y lavish-axi`: it fetches the public package and bypasses this installation's local policies and toolchain.
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

### Direct CLI use

After completing the [from-source setup](#from-source), you can skip the skill and tell your agent:

```
Use `lavish-axi` to write a product or technical plan for what we discussed.
```

### Session hook

Want Lavish's ambient context - including your live open sessions - fed into every agent session instead of loading on demand?
After linking the source checkout, opt into the hook:

```sh
lavish-axi setup hooks
```

This installs a `SessionStart` hook for **Claude Code**, **Codex**, **OpenCode**, and **GitHub Copilot CLI** that surfaces open sessions, visualization playbooks, and usage guidance at the start of each session.
Unlike the skill, the hook also shows your live open sessions, so a fresh agent session can resume an in-flight review.
**Restart your agent session after running this** so the new hook takes effect.

### Agent Plugin

Lavish also ships as an [Agent Plugin](https://agent-plugins.org) - the vendor-neutral packaging standard for skills and MCP servers - so clients that speak that format can load it directly.

**No marketplace is involved.** The linked package _is_ the plugin: `plugin.json` sits at the package root next to the `skills/` directory. After linking the source checkout, register it:

```sh
lavish-axi setup plugin
```

That registers the installed package with every supported client it finds - **VS Code**, **Cursor**, and **GitHub Copilot CLI** - and reports which ones were absent. It is opt-in and idempotent, and it repairs the registered path after a reinstall or relocation. Reload each client afterward.

Each client is registered independently: one that cannot be registered is reported with what to do about it, and never blocks the others or fails the command.

To register by hand instead, point any client at the package directory (`npm root -g`/`lavish-axi`):

| Client             | Register with                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| VS Code            | `"chat.pluginLocations": { "<package-dir>": true }` in user settings                                               |
| Cursor             | link the package dir at `~/.cursor/plugins/local/lavish-axi` (`setup plugin` handles Windows link compatibility)   |
| GitHub Copilot CLI | `copilot plugin install <package-dir>` (or `copilot plugin install kunchenguid/lavish-axi` straight from the repo) |

Codex and ChatGPT install plugins only from marketplace sources, so Codex users should use the session hook above instead.
Lavish declares no MCP server - the CLI itself is the agent interface - so a plugin install brings the same `lavish` skill, and the skill and plugin are alternatives rather than a stack.

### From source

```sh
git clone https://github.com/kunchenguid/lavish-axi.git
cd lavish-axi
pnpm install --frozen-lockfile
npm install --prefix local
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
│ chat, or queues layout │
│ issues from the inbox  │
└───────┬────────────────┘
        ▼
┌────────────────────────┐
│ lavish-axi poll waits  │
│ and returns prompts    │
│ the user queued        │
└────────────────────────┘
```

- **File-path identity** - Sessions are keyed by the canonical HTML file path, so agents do not need opaque IDs.
- **Portable artifacts** - The artifact runs in an iframe while Lavish injects a small SDK for annotations, snapshots, feedback controls, and render-time layout checks.
  Lavish does not inject any design system, so the saved HTML file renders identically whether you open it through `lavish-axi` or directly in a browser.
  Run `lavish-axi design` for the single source of agent-facing design guidance, the local Tailwind+DaisyUI build command, and the pinned Mermaid CDN snippet.
- **Self-paint warning** - `lavish-axi <html-file>` and `export` run a render-free check for artifacts missing an explicit page background and return a one-line `self_paint_warning`.
  The check fails open - any stylesheet link, `@import`, Tailwind runtime script, `color-scheme`, or `html`/`body`/`:root` background signal suppresses it - and it never blocks the open.
- **Open-time layout gate** - The browser chrome masks an artifact only while the real in-iframe audit waits for fonts and final geometry.
  The first completed check always reveals the artifact, whatever it found; the gate never holds the review hostage waiting for a repair.
  The user can click **Show anyway**, and a bounded safety timeout fails open when no check has completed.
- **Layout issues inbox** - Detection is passive. After fonts and finite animations settle, the injected SDK confirms severe failures from direct rendered evidence such as materially escaped meaningful content or required controls, clipped text fragments, viewport reachability, or near-total semantic occlusion.
  Explicit ellipsis and line clamp, standard visually hidden accessibility text, intentional scrollers or masks, parent overhang, generic element scroll geometry, decorative overlap, and uncertain motion do not produce findings by themselves.
  Proven failures are filed in the **Layout issues** inbox inside the slim review dock above the artifact. The dock keeps the Annotate switch visible, collapses the low-frequency controls by default, mirrors the unresolved count on its entrypoint, and expands within one narrow chrome-owned row without covering the artifact or composer.
  Its drawer lists each issue with severity, a plain-language explanation, the affected viewport, the target/component identity, when it was last seen, and its lifecycle state, plus per-issue **Reveal** (highlight it in the artifact) and **Dismiss** actions.
  Nothing is selected by default. The user picks issues (or **Select all**) and **Queue selected fixes** turns that whole group into one ordinary queued prompt, tagged `layout-warnings`, that reaches the agent through the normal feedback path when they send.
  Detection never returns `lavish-axi poll` and never wakes an agent; only the user queueing a fix does. The one exception is a fatal `artifact_failures` response, for failures that make the review itself unusable, such as the artifact document or one of its own local assets failing to load.
- **Layout issue lifecycle** - Each issue is identified by a stable fingerprint of the diagnostic rule, the normalized target identity, and the viewport class, so repeat detections update one record instead of inflating the count.
  `Open` means the latest completed check for its viewport still detects it. `Queued for fix` means the user asked for a repair - it stays unresolved and counted, and cannot be queued again while that request is outstanding.
  `Resolved` requires a newer successful artifact load plus a complete check at the same viewport that no longer detects it; it then leaves the count but keeps a bounded history.
  `Still present` (recurring) means a queued issue survived a newer revision, so it is selectable again with its earlier attempt retained. `Unverified` means a reload or check failed or was incomplete, so the prior issue was preserved rather than cleared. `Returned` means a resolved issue came back on a later revision.
  Dismissal applies only to the current artifact revision; a later revision surfaces the issue again if it is still detected. A check at one viewport never clears an issue found at another, and a viewport removed from the configured diagnostic set (`LAVISH_AXI_DIAGNOSTIC_VIEWPORTS`, default all) is marked obsolete with an explicit reason rather than reading as fixed.
- **Local assets** - Copy local images, CSS, fonts, and scripts next to the HTML artifact and reference them with relative paths from that directory; root-prefixed paths such as `/assets/logo.png` will not resolve through Lavish's artifact route.
- **Export** - `lavish-axi export` writes `<name>.export.html` by inlining local assets only, stripping the annotation SDK, and leaving remote CDN/font references as links that still need network access.
  Hosted sharing is disabled in this installation. `lavish-axi share` refuses without reading or uploading the artifact; use export for a portable local copy.
  Bundling never fetches remote URLs, Lavish itself does not set a CSP, local reads stay confined and size-capped, and absolute `file://` paths outside safe inlined asset references are redacted before output.
  Per-asset and per-bundle inline caps default to 10 MB and 25 MB, overridable with `LAVISH_AXI_EXPORT_MAX_ASSET_BYTES` and `LAVISH_AXI_EXPORT_MAX_BUNDLE_BYTES`.
  Unresolved local assets or export notices such as author-set CSP meta tags and redacted file URLs are surfaced in command or browser output.
- **Live reload** - Lavish watches the HTML artifact file by default and preserves review context across reloads: the artifact iframe scroll position, an open annotation card's unsent text, and answers to `data-lavish-question` controls (application-owned form state is left alone). While a queued layout-issue batch is outstanding, closely spaced saves coalesce so one batch of fixes costs one refresh. To also reload on sibling asset changes, add `data-lavish-live-reload-root` to the root element or `<meta name="lavish-live-reload" content="root">`.
- **Feedback controls** - Native controls (radios, checkboxes, inputs, selects, buttons, labels, disclosure summaries, contenteditable) are interactive automatically, so they do not need `data-lavish-action`.
  For reversible choices, let option clicks update local state, then queue exactly one final answer from a per-question submit or Queue answer button with `window.lavish.queuePrompt()`.
  Mark only custom (non-native) clickable elements with `data-lavish-action` so Lavish does not annotate them, and use `data-lavish-question` or `queueKey` when pre-send updates for the same question should replace each other.
  Queued annotation preview pills and chat history share a scrollable Conversation panel above a sticky composer, so long feedback queues do not push the text box or send controls off screen.
  The browser chrome lives in a slim review dock above the artifact. Annotate and its current mode stay visible so the Cmd/Ctrl+I state is always apparent; expanding the dock reveals the conversation-panel toggle, the editing overflow menu (copy path, reload artifact, copy DOM snapshot, export standalone HTML), and a high-contrast **End session** action without covering the artifact or composer. The composer exposes **Send & End** beside **Send to Agent** to submit queued prompts and user-ended attribution together.
- **Keyboard shortcuts** - In the chrome composer, Enter sends queued prompts and Shift+Enter inserts a newline.
  In the annotation card, Enter queues the annotation, Shift+Enter inserts a newline, and Ctrl+Enter (Cmd+Enter on macOS) queues it and sends all queued prompts immediately.
  Cmd+Enter or Ctrl+Enter also sends the current queue while focus is elsewhere in the browser chrome.
  Cmd+I or Ctrl+I toggles between annotate and explore mode from either the browser chrome or the artifact iframe, including while focus is in a textarea or control.
  `Cmd+\` or `Ctrl+\` collapses or restores the conversation panel from either the browser chrome or the artifact iframe.
  Cmd+Shift+E or Ctrl+Shift+E ends the review session from the browser chrome, artifact iframe, or full-screen whiteboard.
  PageUp, PageDown, Home, and End still navigate the artifact while focus is in the chrome, except while typing or navigating a chrome-owned panel; Escape closes the full-screen whiteboard unless a text field or link dialog is active.
- **Agent presence** - The browser shows when no agent is listening, keeps queued feedback for the next successful `lavish-axi poll` send even across reloads, and only blocks human sends while the agent is working on delivered feedback; the agent's reply (`--agent-reply`) concludes that work and re-enables sends.
  The no-timeout poll always writes an immediate stderr banner so it is visibly not hung; it adds the periodic stderr wait ticks only in an interactive terminal, so when stderr is piped (as under agent harnesses) the captured output carries no tick noise. Stdout always stays reserved for the final response; if the poll is interrupted or times out, re-run it because queued feedback is never lost.
  Codex-specific guidance keeps that poll attached to the active turn instead of hiding it in a background task, because completed background tasks may not resume the agent.
- **Session end etiquette** - Lavish tracks who ended a session: a human clicking **End session** (or **Send & end session**) in the browser is a user-initiated end, while `lavish-axi end <html-file>` is agent-initiated.
  A plain `lavish-axi <html-file>` after a user-initiated end refuses to reopen the browser and returns guidance instead; pass `--reopen` only when the user asks for further review or something important needs their visual attention.
  Agent-initiated ends keep reopening normally, same as before.
  `lavish-axi poll`'s `ended` response and the `feedback` response for the final batch before an end both carry `next_step` guidance telling the agent to stop polling and deliver remaining updates in chat instead of reopening.
- **Precise targets** - Text annotations include selected text plus range anchors, so agents are not limited to whole-element selectors.
- **Image attachments** - Attach reference images (PNG, JPEG, WebP) to an annotation by pasting, drag-dropping, or using the annotation card's **Attach image** picker; each shows a thumbnail chip with upload, remove, retry, and error states.
  Images are stored under the state dir and the queued prompt carries a server-generated absolute `path` and content-hash `id` (plus mime and dimensions) - never the raw bytes - so `lavish-axi poll` hands the agent a local file path to open.
  Limits are `LAVISH_AXI_MAX_ATTACHMENT_BYTES` (default 10 MiB per image), `LAVISH_AXI_MAX_ATTACHMENTS_PER_PROMPT` (default 4), and `LAVISH_AXI_MAX_PROMPT_ATTACHMENT_BYTES` (default 25 MiB per annotation); if any image is missing or any annotation breaches a count or byte cap, the entire send batch is rejected, the queue is preserved, and the reason is surfaced in the composer rather than silently dropping images.
  As a browser-side abuse guard, each chrome page allows 30 upload attempts per rolling minute, 4 uploads in flight at once, and 256 MiB of attempted image bytes over its lifetime; rejected uploads stay visible on their annotation card for retry or removal.
  Attachments are cleaned up by `LAVISH_AXI_ATTACHMENT_TTL_MS` (default 7 days; `0`/`off` disables) but only once no pending prompt still references them; `LAVISH_AXI_MAX_ATTACHMENT_DISK_MB` (default 512 MiB; `0`/`off` disables) caps total attachment disk.
  The cap is enforced when an image is uploaded, not just periodically: the upload first reclaims unreferenced files (oldest first, and never one added within the last hour), and if it still would not fit, that upload is refused with a storage-full error on its chip instead of discarding an image an annotation is about to send.
- **Mermaid diagrams** - In the Lavish browser, every rendered Mermaid diagram in a `.mermaid` container becomes a locked inline preview for an Excalidraw whiteboard.
  Click the preview to open the full-viewport editor; inline diagrams never unlock or edit in place.
  Whiteboard scenes autosave locally.
  If a live reload changes the Mermaid source, the whiteboard shows that its edits are stale; reopening it lets the reviewer re-convert and discard the saved edits or keep editing the saved scene.
  Use **Queue feedback** to add a bounded edit summary plus local `.excalidraw` scene and PNG preview paths to the Conversation panel, then click **Send to Agent** to deliver it.
  The agent updates the artifact's Mermaid source, which remains authoritative.
  Flowchart, sequence, class, ER, and state diagrams convert to editable shapes; other diagram types are images that reviewers can draw and annotate.
  Lavish changes only the browser view, so saved, standalone, and exported artifacts still render plain Mermaid.
- **Server cleanup** - The detached server stops after the last session ends when nothing is connected, or after `LAVISH_AXI_IDLE_TIMEOUT_MS` (default 30 minutes) with no browser or poll connections.
  Set `LAVISH_AXI_IDLE_TIMEOUT_MS=0` or `off` to disable idle self-shutdown.
- **Local-first state** - Session state stays under `~/.lavish-axi/` by default, or `LAVISH_AXI_STATE_DIR` when set.
- **Diagnostic viewports** - `LAVISH_AXI_DIAGNOSTIC_VIEWPORTS` sets which viewport classes the layout-issue inbox tracks (`mobile`, `compact`, `desktop`; comma-separated, default all). Warnings whose class leaves the set are marked obsolete with an explicit reason instead of silently reading as fixed.
- **Server port** - Set `LAVISH_AXI_PORT` to choose the server port; it defaults to `4387`.
- **Network binding** - The server binds to loopback (`127.0.0.1`) by default. Set `LAVISH_AXI_HOST` to bind elsewhere; a wildcard (`0.0.0.0` or `::`) binds every interface. Binding beyond loopback exposes an unauthenticated server that can read and serve arbitrary local files to anything that can reach it, so only do so on a trusted network. Set `LAVISH_AXI_LINK_HOST` to control the hostname written into generated session links (defaults to the bind address, or loopback when bound to a wildcard).
- **Allowed hosts** - To defend against DNS rebinding, the server rejects (`403`) any request whose `Host` header is missing or not one it answers to: the loopback names (`127.0.0.1`, `::1`, `localhost`) plus the configured bind and link host. If you reach the server under another name - a wildcard bind accessed by LAN IP, a reverse-proxy hostname, or an extra interface - list those names in `LAVISH_AXI_ALLOWED_HOSTS` (whitespace-separated) to allow them. Behind a reverse proxy, the forwarded `X-Forwarded-Host` is validated against the same list, so add your public hostname there and have the proxy send it together with `X-Forwarded-Proto`. Set `LAVISH_AXI_ALLOWED_HOSTS` to `*` to disable the check entirely (only when the server sits behind your own authentication or proxy).
- **Browser opening** - Set `LAVISH_AXI_NO_OPEN=1`, equivalent to `--no-open`, to create or resume a session without launching a browser window.

## CLI Reference

| Command                         | Description                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lavish-axi`                    | Show current sessions and usage guidance.                                                                                                                                                                                                                                                                                                    |
| `lavish-axi update`             | Check for or apply the latest npm release through the AXI SDK self-updater.                                                                                                                                                                                                                                                                  |
| `lavish-axi <html-file>`        | Open or resume a Lavish Editor session, with the open-time layout gate enabled by default. Unresolved layout issues from earlier in the session are preserved. Refuses to reopen a session the user explicitly ended from the browser unless `--reopen` is passed.                                                                           |
| `lavish-axi poll <html-file>`   | Long-poll until the user sends feedback or ends the session; detected layout issues wait in the user's Layout issues inbox and arrive only when queued. Leave no-timeout polls running, or re-run them if interrupted. Codex guidance keeps polls attached to the active turn. On `status: ended`, stop polling and do not reopen uninvited. |
| `lavish-axi end <html-file>`    | End a session as the agent; unlike a user-initiated end from the browser, this still allows a plain reopen later.                                                                                                                                                                                                                            |
| `lavish-axi export <html-file>` | Write a portable copy of the artifact: one HTML file with its local assets inlined, so it opens with no server and no sibling files. Remote CDN/font references are left as links.                                                                                                                                                           |
| `lavish-axi share <html-file>`  | Disabled in this installation; refuses without reading or uploading the artifact. Use `lavish-axi export` for a portable local copy.                                                                                                                                                                                                         |
| `lavish-axi stop`               | Shut down the background server.                                                                                                                                                                                                                                                                                                             |
| `lavish-axi playbook [id]`      | List focused artifact guidance or show one playbook; agents must open each matching playbook before writing HTML.                                                                                                                                                                                                                            |
| `lavish-axi design`             | Show agent-facing design guidance, the local Tailwind+DaisyUI build command, and the pinned Mermaid CDN snippet.                                                                                                                                                                                                                             |
| `lavish-axi setup hooks`        | Install or repair optional SessionStart hooks for Claude Code, Codex, OpenCode, and GitHub Copilot CLI; restart the agent session afterward.                                                                                                                                                                                                 |
| `lavish-axi setup plugin`       | Register the installed package as an [Agent Plugin](https://agent-plugins.org) in VS Code, Cursor, and GitHub Copilot CLI; opt-in, idempotent, no marketplace involved. Reload each client afterward.                                                                                                                                        |
| `lavish-axi server`             | Run the local Lavish Editor server.                                                                                                                                                                                                                                                                                                          |

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
