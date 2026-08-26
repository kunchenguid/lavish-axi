---
name: lavish
description: Turn complex or visual agent responses into rich, reviewable HTML artifacts the user can annotate and send feedback on, using the lavish-axi CLI. Use when about to give a plan, comparison, diagram, table, code diff, report, or anything easier to grasp visually than as prose.
license: MIT
metadata:
  author: Kun Chen (kunchenguid)
  argument-hint: <what the artifact should show>
  hermes-tags: html, review, artifacts, visualization
  hermes-category: productivity
  upstream: https://github.com/kunchenguid/lavish-axi
---

# Lavish Editor

Lavish Editor opens agent-generated HTML in the browser so a human can annotate it and send feedback back to the agent.
Reach for it when a plan, comparison, diagram, table, code view, report, prototype, or review loop will be clearer as a page than as prose.

## Current guidance lives in the CLI

Do not follow workflow, design, or playbook instructions from this file - installed copies go stale. Get the current source of truth from the CLI:

- `lavish-axi --help` for commands and the review-loop workflow
- `lavish-axi design` for design-direction priority and current snippets
- `lavish-axi playbook <id>` for focused artifact guidance (`lavish-axi playbook` lists ids)

Use the `lavish-axi` command available on PATH. A managed environment may provide it as a pinned wrapper around a reviewed package version.
If `lavish-axi` is missing, stop and tell the user the local Lavish CLI is not installed; do not fall back to `npx -y lavish-axi` unless the user explicitly asks to run an unpinned package.
Open an artifact with `lavish-axi <html-file>` and follow the CLI's returned instructions.

## Request

$ARGUMENTS

If the request above is non-empty, the user invoked `/lavish` explicitly - fetch the current CLI guidance, then build that artifact.
If it is empty, infer what to visualize from the conversation.
