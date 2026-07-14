import { POLL_SEND_AND_END_RULE, POLL_WAKE_PATH_RULES, createHomeOutput } from "./cli.js";
import { PLAYBOOK_ROUTER_HELP } from "./playbooks.js";

// Trigger string Claude Code (and other agents) match against to auto-load the skill.
// Kept terse and outcome-focused so it fires on "about to show something visual" intents.
export const SKILL_DESCRIPTION =
  "Turn complex or visual agent responses into rich, reviewable HTML artifacts the user can " +
  "annotate and send feedback on, using the lavish-axi CLI. Use when about to give a plan, " +
  "comparison, diagram, table, code diff, report, or anything easier to grasp visually than as prose.";

function bullets(items) {
  return items.map((item) => `- ${item}`).join("\n");
}

function playbookList(playbooks) {
  return playbooks.map((p) => `- \`${p.id}\` - ${p.use_when}`).join("\n");
}

function skillCommandText(text) {
  return text.replaceAll("`lavish-axi", "`npx -y lavish-axi");
}

/**
 * Render the installable SKILL.md for the lavish skill. The body mirrors what
 * `lavish-axi` prints with no arguments (minus live session state), while the
 * frontmatter adds discovery metadata for Agent Skills and Hermes Agent.
 *
 * @returns {string} full SKILL.md contents including YAML frontmatter
 */
export function createSkillMarkdown() {
  const home = createHomeOutput({ bin: "lavish-axi", sessions: [], includeSessions: false, agent: "static" });

  return `---
name: lavish
description: ${SKILL_DESCRIPTION}
argument-hint: <what the artifact should show>
author: Kun Chen (kunchenguid)
metadata:
  hermes:
    tags: [html, review, artifacts, visualization]
    category: productivity
---

# Lavish Editor

${skillCommandText(home.description)}

You do not need lavish-axi installed globally - invoke it with \`npx -y lavish-axi <html-file>\`.
If lavish-axi output shows a follow-up command starting with \`lavish-axi\`, run it as \`npx -y lavish-axi ...\` instead.
In restricted subprocess sandboxes, CI, or agent harnesses where \`npx -y\` exits opaquely (for example with status 216), use an already-installed copy directly: \`node "$(npm root)/lavish-axi/dist/cli.mjs" <html-file>\` for a local install, \`node "$(npm root -g)/lavish-axi/dist/cli.mjs" <html-file>\` for a global install, or the bare \`lavish-axi <html-file>\` bin after installing once.

## Request

$ARGUMENTS

If the request above is non-empty, the user invoked \`/lavish\` explicitly - build an HTML artifact for that request now, following the workflow below.
If it is empty, infer what to visualize from the conversation.

## When to use

${home.help[home.help.length - 1]}

## Workflow

1. Create the HTML artifact (default location \`.lavish/<name>.html\` in the working directory).
2. Run \`npx -y lavish-axi <html-file>\` to open or resume a review session in the browser.
3. Run \`npx -y lavish-axi poll <html-file>\` to long-poll for the user's annotations, queued prompts, and browser-reported \`layout_warnings\`.
   On the first poll, prefer \`--agent-reply "<one-line summary of what you built and what to review first>"\` so the conversation panel opens with context.
   The poll stays silent until the user acts or the real browser reports fresh layout warnings - leave it running, never kill it.
${POLL_WAKE_PATH_RULES.map((rule) => `   ${skillCommandText(rule)}`).join("\n")}
4. If poll returns \`layout_warnings\`, follow the returned \`next_step\`: fix and re-check fresh error-severity findings, but proceed with a note instead of looping when every current warning is persistent or low-severity.
5. Apply human feedback, then poll again with \`--agent-reply "<message>"\` to reply in the browser and keep the loop going under the same foreground-or-verified-wake-path rule.
6. Run \`npx -y lavish-axi end <html-file>\` when the review is finished.
7. ${POLL_SEND_AND_END_RULE} Deliver any remaining updates directly in this conversation.

## Visual guidance

${bullets(home.visual_guidance)}

## Playbooks

Run \`npx -y lavish-axi playbook <id>\` for focused, detailed guidance on any of these.
${PLAYBOOK_ROUTER_HELP}
For flows, architecture, state, or sequence diagrams, do not hand-build boxes-and-arrows from div/flexbox; open the diagram playbook and use the theme-aware Mermaid snippet from \`npx -y lavish-axi design\` unless SVG is needed for richly annotated nodes.

${playbookList(home.playbooks)}

## Commands & rules

${bullets(home.help.map(skillCommandText))}
`;
}
