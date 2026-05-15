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
- **Battery included** - Lavish Editor teaches your agent good visualization for common use cases such as technial plans, design explorations and more out of the box.

Lavish Editor is an [AXI](https://axi.md), which means -

- It's just a CLI any capable agent can run without setup.
- No skills required. Agents learn to use AXIs by using them.
- It's optimized for agent ergonomics. TOON output, long polling, and contextual disclosure making it highly token efficient.

## Quick Start

Just tell your agent:

```sh
Use `npx lavish-axi` to write a technical plan for what we discussed.
```

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
- **Portable artifacts** - The artifact runs in an iframe while Lavish injects a small SDK for annotations, snapshots, and feedback controls. Lavish does not inject any design system, so the saved HTML file renders identically whether you open it through `lavish-axi` or directly in a browser. Run `lavish-axi design` for a copy-pasteable CDN snippet to opt in to Tailwind CSS v4 + DaisyUI v5, or use any other design system (or none).
- **Live reload** - Lavish watches the HTML artifact file by default. To also reload on sibling asset changes, add `data-lavish-live-reload-root` to the root element or `<meta name="lavish-live-reload" content="root">`.
- **Feedback controls** - Mark buttons, choices, and other interactive elements with `data-lavish-action` so Lavish does not annotate them, then call `window.lavish.queuePrompt()` or `window.lavish.sendQueuedPrompts()` from the control handler.
- **Agent presence** - The browser shows when no agent is listening, still queues feedback for the next `lavish-axi poll`, and only blocks sending while the agent is working on delivered feedback.
- **Precise targets** - Text annotations include selected text plus range anchors, so agents are not limited to whole-element selectors.
- **Local-first state** - Session state stays under `.lavish-axi/` in the workspace.

## CLI Reference

| Command                       | Description                                                  |
| ----------------------------- | ------------------------------------------------------------ |
| `lavish-axi`                  | Show current sessions and usage guidance.                    |
| `lavish-axi <html-file>`      | Open or resume a Lavish Editor session.                      |
| `lavish-axi poll <html-file>` | Long-poll until the user sends feedback or ends the session. |
| `lavish-axi end <html-file>`  | End a session.                                               |
| `lavish-axi playbook [id]`    | List focused artifact guidance or show one playbook.         |
| `lavish-axi design`           | Show CDN snippet + DaisyUI component reference (opt-in).     |
| `lavish-axi server`           | Run the local Lavish Editor server.                          |

Known playbook IDs: `diagram`, `table`, `comparison`, `plan`, `diff`, `input`, `slides`.

### Flags

| Command                  | Flag                  | Description                                                                              |
| ------------------------ | --------------------- | ---------------------------------------------------------------------------------------- |
| `lavish-axi <html-file>` | `--no-open`           | Ensure the server/session exists without opening another browser window.                 |
| `lavish-axi poll`        | `--agent-reply "..."` | Show the agent's reply in the existing browser chat before polling again.                |
| `lavish-axi poll`        | `--timeout-ms <ms>`   | Test/debug escape hatch only; agents should normally omit it.                            |
| `lavish-axi server`      | `--verbose`           | Log session and watcher events to stderr; can also be enabled with `LAVISH_AXI_DEBUG=1`. |

## Development

```sh
pnpm run check          # Run all verification commands
pnpm run build          # Bundle the publishable CLI, chrome, and design assets
pnpm test               # Run node:test tests
pnpm run lint           # Run ESLint
pnpm run format:check   # Check Prettier formatting
pnpm run typecheck      # Run TypeScript checkJs validation
```
