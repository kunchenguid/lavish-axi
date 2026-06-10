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

Lavish Editor opens agent-generated HTML files in a local browser, lets you pinpoint elements or selected text and send feedback to the agent to address.

- **Local only** - Work with your local HTML artifacts with a local CLI. Zero cloud dependency.
- **Human-AI collaboration** - Annotate elements, selected text ranges, and send messages to the agent without leaving Lavish Editor.
- **Battery included** - Lavish Editor teaches your agent good visualization for common use cases such as product or technical plans, design explorations and more out of the box.

Lavish Editor is an [AXI](https://axi.md), which means -

- It's just a CLI any capable agent can run without setup.
- No skills required. Agents learn to use AXIs by using them.
- It's optimized for agent ergonomics. TOON output, long polling, and contextual disclosure making it highly token efficient.

## Quick Start

Just tell your agent:

```sh
Use `npx lavish-axi` to write a product or technical plan for what we discussed.
```

That works with zero setup - Lavish is an AXI, so any capable agent can run the CLI directly.

To make your agent reach for Lavish on its own (without you naming it every time), install the agent hooks as instructed below.

## Install

**npm**

```sh
npm install -g lavish-axi
```

**From source**

```sh
git clone https://github.com/kunchenguid/lavish-axi.git
cd lavish-axi
pnpm install --frozen-lockfile
pnpm run build
pnpm link
```

## Teach Your Agent About Lavish (recommended)

Lavish does not wire itself into your agent automatically, so in a fresh session your agent would not know to use it.
There are two ways to fix that - **you only need one.**
We recommend the hook.

### Option A: Session hook (recommended)

Run this once to opt in:

```sh
lavish-axi setup hooks
```

This installs a `SessionStart` hook for **Claude Code**, **Codex**, and **OpenCode** that feeds Lavish's ambient context (open sessions, visualization playbooks, and usage guidance) into your agent at the start of each session.
With the hook installed, your agent learns to turn complex responses into rich, reviewable HTML artifacts proactively - no need to mention `lavish-axi` by name.

**Restart your agent session after running this** so the new hook takes effect.

### Option B: Install as a skill

Prefer the [Agent Skills](https://agentskills.io) format, or use an agent that supports it?
Install Lavish as a skill with [`npx skills`](https://github.com/vercel-labs/skills):

```sh
npx skills add kunchenguid/lavish-axi --skill lavish
```

This drops a `lavish` skill into your agent's skills directory (`.claude/skills/` for example; add `-g` for `~/.claude/skills/`).
The skill carries the same guidance the hook delivers, but it loads on demand when the agent recognizes a task that calls for a visual artifact, rather than every session.
In agents that expose skills as slash commands (Claude Code, for example), you can also invoke it explicitly with `/lavish <what the artifact should show>`.
It does not surface your live open sessions - run `lavish-axi setup hooks` if you want that ambient context too.

### No setup at all

Lavish also works fully as a plain CLI - just tell your agent to `npx lavish-axi <file.html>` as shown in the Quick Start.

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
│ or elements, or        │
│ sends chat feedback    │
└───────┬────────────────┘
        ▼
┌────────────────────────┐
│ lavish-axi poll waits  │
│ and returns prompts    │
└────────────────────────┘
```

- **File-path identity** - Sessions are keyed by the canonical HTML file path, so agents do not need opaque IDs.
- **Portable artifacts** - The artifact runs in an iframe while Lavish injects a small SDK for annotations, snapshots, and feedback controls. Lavish does not inject any design system, so the saved HTML file renders identically whether you open it through `lavish-axi` or directly in a browser. Choose a design system in priority order: follow a user-requested look first, match the current project's design system or conventions next, and otherwise run `lavish-axi design` for a copy-pasteable Tailwind CSS v4 + DaisyUI v5 CDN fallback.
- **Local assets** - Copy local images, CSS, fonts, and scripts next to the HTML artifact and reference them with relative paths from that directory; root-prefixed paths such as `/assets/logo.png` will not resolve through Lavish's artifact route.
- **Live reload** - Lavish watches the HTML artifact file by default and preserves the artifact iframe scroll position across reloads. To also reload on sibling asset changes, add `data-lavish-live-reload-root` to the root element or `<meta name="lavish-live-reload" content="root">`.
- **Feedback controls** - Native form controls (radios, checkboxes, inputs, selects, buttons, labels, contenteditable) are interactive automatically, so they do not need `data-lavish-action`; wire their handlers to `window.lavish.queuePrompt()` or `window.lavish.sendQueuedPrompts()` to send feedback.
  Mark only custom (non-native) clickable elements with `data-lavish-action` so Lavish does not annotate them.
  The browser chrome keeps editing actions in the overflow menu (copy path, reload artifact, copy DOM snapshot, end session) and can submit queued prompts with **Send & end session**, which delivers the prompts before ending the session.
- **Agent presence** - The browser shows when no agent is listening, keeps queued feedback for the next successful `lavish-axi poll` send even across reloads, and only blocks sending while the agent is working on delivered feedback.
- **Precise targets** - Text annotations include selected text plus range anchors, so agents are not limited to whole-element selectors.
- **Server cleanup** - The detached server stops after the last session ends when nothing is connected, or after `LAVISH_AXI_IDLE_TIMEOUT_MS` (default 30 minutes) with no browser or poll connections.
  Set `LAVISH_AXI_IDLE_TIMEOUT_MS=0` or `off` to disable idle self-shutdown.
- **Local-first state** - Session state stays under `.lavish-axi/` in the workspace.

## CLI Reference

| Command                       | Description                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `lavish-axi`                  | Show current sessions and usage guidance.                                                                                |
| `lavish-axi <html-file>`      | Open or resume a Lavish Editor session.                                                                                  |
| `lavish-axi poll <html-file>` | Long-poll until the user sends feedback or ends the session.                                                             |
| `lavish-axi end <html-file>`  | End a session.                                                                                                           |
| `lavish-axi stop`             | Shut down the background server.                                                                                         |
| `lavish-axi playbook [id]`    | List focused artifact guidance or show one playbook.                                                                     |
| `lavish-axi design`           | Show CDN snippet + DaisyUI component reference (opt-in).                                                                 |
| `lavish-axi setup hooks`      | Install or repair optional SessionStart hooks for Claude Code, Codex, and OpenCode; restart the agent session afterward. |
| `lavish-axi server`           | Run the local Lavish Editor server.                                                                                      |

Known playbook IDs: `diagram`, `table`, `comparison`, `plan`, `diff`, `input`, `slides`.

### Flags

| Command                  | Flag                  | Description                                                                                                                                                                                                                         |
| ------------------------ | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lavish-axi <html-file>` | `--no-open`           | Ensure the server/session exists without opening another browser window.                                                                                                                                                            |
| `lavish-axi poll`        | `--agent-reply "..."` | Show the agent's reply in the existing browser chat before polling again.                                                                                                                                                           |
| `lavish-axi poll`        | `--timeout-ms <ms>`   | Test/debug escape hatch only; agents should normally omit it.                                                                                                                                                                       |
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
