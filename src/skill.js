import { createHomeOutput } from "./cli.js";

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
 * `lavish-axi` prints with no arguments (minus live session state), so the
 * skill and the SessionStart hook deliver the same guidance from one source.
 *
 * @returns {string} full SKILL.md contents including YAML frontmatter
 */
export function createSkillMarkdown() {
  const home = createHomeOutput({ bin: "lavish-axi", sessions: [], includeSessions: false });

  return `---
name: lavish
description: ${SKILL_DESCRIPTION}
argument-hint: <what the artifact should show>
---

# Lavish Editor

${skillCommandText(home.description)}

You do not need lavish-axi installed globally - invoke it with \`npx -y lavish-axi <html-file>\`.
If lavish-axi output shows a follow-up command starting with \`lavish-axi\`, run it as \`npx -y lavish-axi ...\` instead.

## Request

$ARGUMENTS

If the request above is non-empty, the user invoked \`/lavish\` explicitly - build an HTML artifact for that request now, following the workflow below.
If it is empty, infer what to visualize from the conversation.

## When to use

${home.help[home.help.length - 1]}

## Workflow

1. Create the HTML artifact (default location \`.lavish/<name>.html\` in the working directory).
2. Run \`npx -y lavish-axi <html-file>\` to open or resume a review session in the browser.
3. Run \`npx -y lavish-axi poll <html-file>\` to long-poll for the user's annotations and queued prompts.
4. Apply the feedback, then poll again with \`--agent-reply "<message>"\` to reply in the browser and keep the loop going.
5. Run \`npx -y lavish-axi end <html-file>\` when the review is finished.

## Visual guidance

${bullets(home.visual_guidance)}

## Playbooks

Run \`npx -y lavish-axi playbook <id>\` for focused, detailed guidance on any of these:

${playbookList(home.playbooks)}

## Commands & rules

${bullets(home.help.map(skillCommandText))}
`;
}
