<h1 align="center">lavish-axi</h1>
<p align="center">
  <a href="https://github.com/kunchenguid/lavish/actions/workflows/ci.yml"
    ><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/kunchenguid/lavish/ci.yml?style=flat-square&label=ci"
  /></a>
  <a href="https://github.com/kunchenguid/lavish/actions/workflows/release-please.yml"
    ><img alt="Release" src="https://img.shields.io/github/actions/workflow/status/kunchenguid/lavish/release-please.yml?style=flat-square&label=release"
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

Lavish Editor opens an agent-generated HTML file in a local browser, lets you pinpoint elements and send feedback.

- **Browser-native review** - Serve local HTML artifacts with relative JS/CSS/assets intact.
- **Precise feedback** - Click elements, queue annotation & prompts , and send them back to the agent.
- **Agent-ergonomic interface** - Follows [AXI principles](https://axi.md), use TOON output, long polling, and contextual disclosure that keep autonomous agents on track.

## Quick Start

Tell your agent:

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
git clone https://github.com/kunchenguid/lavish.git
cd lavish
npm ci
npm run build
npm link
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
│ Human annotates or     │
│ sends chat feedback    │
└───────┬────────────────┘
        ▼
┌────────────────────────┐
│ lavish-axi poll waits  │
│ and returns prompts    │
└────────────────────────┘
```

- **File-path identity** - Sessions are keyed by the canonical HTML file path, so agents do not need opaque IDs.
- **Sandboxed artifact** - The artifact runs in an iframe while Lavish injects a small SDK for annotations and snapshots.
- **Local-first state** - Session state stays under `.lavish-axi/` in the workspace.

## CLI Reference

| Command                       | Description                                                  |
| ----------------------------- | ------------------------------------------------------------ |
| `lavish-axi`                  | Show current sessions and usage guidance.                    |
| `lavish-axi <html-file>`      | Open or resume a Lavish Editor session.                      |
| `lavish-axi poll <html-file>` | Long-poll until the user sends feedback or ends the session. |
| `lavish-axi end <html-file>`  | End a session.                                               |

### Flags

| Command                  | Flag                  | Description                                                               |
| ------------------------ | --------------------- | ------------------------------------------------------------------------- |
| `lavish-axi <html-file>` | `--no-open`           | Ensure the server/session exists without opening another browser window.  |
| `lavish-axi poll`        | `--agent-reply "..."` | Show the agent's reply in the existing browser chat before polling again. |
| `lavish-axi poll`        | `--timeout-ms <ms>`   | Test/debug escape hatch only; agents should normally omit it.             |

## Development

```sh
npm run check          # Run all verification commands
npm run build          # Bundle the publishable CLI
npm test               # Run node:test tests
npm run lint           # Run ESLint
npm run format:check   # Check Prettier formatting
npm run typecheck      # Run TypeScript checkJs validation
```
