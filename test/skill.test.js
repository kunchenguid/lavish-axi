import assert from "node:assert/strict";
import test from "node:test";

import { createHomeOutput } from "../src/cli.js";
import {
  ALLOWED_SKILL_FRONTMATTER_KEYS,
  SKILL_DESCRIPTION,
  createSkillMarkdown,
  parseSkillFrontmatter,
  validateSkillMarkdown,
} from "../src/skill.js";

// LOCAL PATCH: upstream rewrites every command into the `npx -y lavish-axi` form. This install
// is `npm link`-ed from the checkout, so npx would fetch the UNPATCHED package from npm and
// silently undo every patch in this fork. Commands pass through unchanged; see the
// "never routes commands through npx" test below for the guard that matters.
function skillCommandText(text) {
  return text;
}

test("createSkillMarkdown emits valid frontmatter naming the lavish skill", () => {
  const { frontmatter, errors } = parseSkillFrontmatter(createSkillMarkdown());

  assert.deepEqual(errors, [], "frontmatter parses as plain block-style YAML");
  assert.equal(frontmatter.name, "lavish");
  assert.equal(frontmatter.description, SKILL_DESCRIPTION);
});

test("createSkillMarkdown emits Hermes Agent metadata as string-valued frontmatter", () => {
  const { frontmatter } = parseSkillFrontmatter(createSkillMarkdown());

  assert.deepEqual(frontmatter.metadata, {
    author: "Kun Chen (kunchenguid)",
    "argument-hint": "<what the artifact should show>",
    "hermes-tags": "html, review, artifacts, visualization",
    "hermes-category": "productivity",
  });
  assert.equal(frontmatter.version, undefined, "version is omitted to avoid release churn");
});

test("createSkillMarkdown conforms to the Agent Skills frontmatter contract", () => {
  // Agent Plugins delegates skill validity to Agent Skills and silently skips any skill
  // that fails it, so a regression here would quietly remove the skill from the plugin.
  const { valid, errors } = validateSkillMarkdown(createSkillMarkdown(), { directoryName: "lavish" });

  assert.deepEqual(errors, []);
  assert.ok(valid);
});

test("createSkillMarkdown keeps every frontmatter field in the allowed set", () => {
  const { frontmatter } = parseSkillFrontmatter(createSkillMarkdown());

  for (const key of Object.keys(frontmatter)) {
    assert.ok(ALLOWED_SKILL_FRONTMATTER_KEYS.includes(key), `\`${key}\` is an allowed Agent Skills field`);
  }
});

test("validateSkillMarkdown rejects the shapes the reference validator rejects", () => {
  const flowCollection = "---\nname: lavish\ndescription: d\nmetadata:\n  tags: [a, b]\n---\nbody";
  assert.match(validateSkillMarkdown(flowCollection).errors.join("\n"), /flow collection/);

  const unknownField = "---\nname: lavish\ndescription: d\nargument-hint: x\n---\nbody";
  assert.match(validateSkillMarkdown(unknownField).errors.join("\n"), /unexpected frontmatter field `argument-hint`/);

  const nested = "---\nname: lavish\ndescription: d\nmetadata:\n  hermes:\n    category: p\n---\nbody";
  assert.match(validateSkillMarkdown(nested).errors.join("\n"), /nests deeper than one level/);

  const mismatched = "---\nname: lavish\ndescription: d\n---\nbody";
  assert.match(
    validateSkillMarkdown(mismatched, { directoryName: "other" }).errors.join("\n"),
    /must match skill name/,
  );

  const missing = "---\nname: lavish\n---\nbody";
  assert.match(validateSkillMarkdown(missing).errors.join("\n"), /`description` is required/);
});

test("createSkillMarkdown handles explicit /lavish invocation arguments", () => {
  const md = createSkillMarkdown();
  const body = md.slice(md.indexOf("\n---\n", 4) + 5);

  assert.ok(body.includes("$ARGUMENTS"), "body consumes slash-command arguments");
  assert.match(body, /empty/i, "explains the model-invoked case where no arguments are passed");
});

test("createSkillMarkdown mirrors the no-args home output", () => {
  const md = createSkillMarkdown();
  const home = createHomeOutput({ bin: "lavish-axi", sessions: [], includeSessions: false, agent: "static" });

  assert.ok(md.includes(skillCommandText(home.description)), "includes the product description");

  for (const item of home.visual_guidance) {
    assert.ok(md.includes(item), `includes visual guidance: ${item.slice(0, 32)}...`);
  }

  for (const playbook of home.playbooks) {
    assert.ok(md.includes(playbook.id), `includes playbook id: ${playbook.id}`);
    assert.ok(md.includes(playbook.use_when), `includes playbook use_when: ${playbook.id}`);
  }

  for (const item of home.help) {
    const skillItem = skillCommandText(item);
    assert.ok(md.includes(skillItem), `includes help: ${skillItem.slice(0, 32)}...`);
  }
});

test("createSkillMarkdown explains the open-time self-paint warning", () => {
  const md = createSkillMarkdown();
  const workflow = md.slice(md.indexOf("## Workflow"), md.indexOf("## Visual guidance"));

  const openIndex = workflow.indexOf("to open or resume a review session");
  const pollIndex = workflow.indexOf("to long-poll");
  assert.ok(openIndex > 0 && openIndex < pollIndex, "opening comes before polling");
  assert.match(workflow, /self_paint_warning/, "the workflow explains the open-time warning");
});

test("createSkillMarkdown requires an observable wake path for every poll", () => {
  const md = createSkillMarkdown();
  const workflow = md.slice(md.indexOf("## Workflow"), md.indexOf("## Poll contract"));
  const pollContract = md.slice(md.indexOf("## Poll contract"), md.indexOf("## Visual guidance"));

  assert.match(workflow, /follow the single Poll contract below/i);
  assert.match(pollContract, /Keep .*poll in the foreground by default.*return the feedback directly to the agent/i);
  assert.match(pollContract, /harness-native tracked background-job facility/i);
  assert.match(pollContract, /completion result is guaranteed to resume or notify the same agent/i);
  assert.match(pollContract, /Never use `nohup`/);
  assert.match(pollContract, /shell `&`/);
  assert.match(pollContract, /`disown`/);
  assert.match(pollContract, /redirected fire-and-forget processes/);
  assert.match(pollContract, /detached terminal without an explicit verified callback/);
  assert.match(
    pollContract,
    /If the harness has no completion-aware background facility, use the foreground poll or first wire a verified wake callback into the surrounding supervisor/i,
  );
  assert.match(pollContract, /Do not tell the user the artifact is being monitored until that wake path is live/i);
  assert.match(pollContract, /resume that same tracked (?:command|process)/i);
  assert.match(pollContract, /longest practical blocking wait/i);
  assert.match(pollContract, /short fixed intervals/i);
  assert.match(pollContract, /empty wait result must not trigger fresh reasoning or narration/i);
  assert.match(pollContract, /do not substitute agent-status polling/i);
  assert.match(pollContract, /`Send & End` ends the session.*final feedback is still delivered once.*polling stops/i);
  assert.match(pollContract, /(?:do|must) not reopen (?:it|the session) uninvited/i);
  assert.match(pollContract, /queued feedback is never lost/);
  assert.equal(
    md.split("harness-native tracked background-job facility").length - 1,
    1,
    "the generated skill owns the wake-path contract in one section",
  );
  assert.match(md, /## Codex callback adapter/);
});

test("createSkillMarkdown keeps Codex waiting inside one callback-owning exec cell", () => {
  const md = createSkillMarkdown();
  const adapter = md.slice(md.indexOf("## Codex callback adapter"), md.indexOf("## Visual guidance"));

  assert.match(adapter, /one `functions\.exec` cell/i);
  assert.match(adapter, /`yield_control\(\)` once/i);
  assert.match(adapter, /keep the long `tools\.write_stdin` waits inside that cell/i);
  assert.match(adapter, /`notify\(\.\.\.\)` only with the final poll output/i);
  assert.match(adapter, /waiting model-free/i);
  assert.match(adapter, /do not make the model call `functions\.wait`/i);
  assert.match(adapter, /do not spawn a polling subagent/i);
  assert.match(adapter, /If code-mode callbacks are unavailable/i);
  assert.doesNotMatch(adapter, /app-server|thread\/resume/i);
});

test("createSkillMarkdown keeps model choice inherited and waiting model-free", () => {
  const md = createSkillMarkdown();

  assert.match(md, /Lavish does not choose or change the agent's model or reasoning effort/i);
  assert.match(md, /inherits the active agent/i);
  assert.match(md, /keep the waiting phase model-free/i);
  assert.match(md, /do not spawn a separate or cheaper agent solely to poll/i);
});

test("createSkillMarkdown keeps layout detection passive", () => {
  const md = createSkillMarkdown();

  assert.match(md, /layout issues are filed passively/);
  assert.match(
    md,
    /ordinary (?:tag )?[`"]layout-warnings[`"] prompt only when the user selects and queues (?:them|the fixes)/,
  );
  assert.doesNotMatch(md, /returned as `layout_warnings`/);
  assert.doesNotMatch(md, /If poll returns `layout_warnings`/);
});

test("createSkillMarkdown requires opening every matching playbook", () => {
  const md = createSkillMarkdown();
  const playbooksSection = md.slice(md.indexOf("## Playbooks"), md.indexOf("## Commands & rules"));

  assert.ok(playbooksSection.includes("combines several playbooks"), "explains artifacts span playbooks");
  assert.ok(playbooksSection.includes("MUST open each matching playbook"), "requires opening matching playbooks");
  assert.ok(playbooksSection.includes("do not hand-build boxes-and-arrows"), "names the diagram anti-pattern");
});

test("createSkillMarkdown does not leak live session state", () => {
  const md = createSkillMarkdown();
  assert.ok(!md.includes("pending_prompts"), "no session bookkeeping fields");
  assert.ok(!/\/session\/[0-9a-f]{8}/.test(md), "no live session URLs");
});

test("createSkillMarkdown omits setup guidance", () => {
  // Installation is the user's business; the skill is agent-facing guidance only.
  const md = createSkillMarkdown();
  assert.doesNotMatch(md, /setup hooks/);
  assert.doesNotMatch(md, /setup plugin/);
});

// LOCAL PATCH: this is the single most load-bearing patch in the fork. Every other patch lives
// in this checkout's dist; one `npx -y` anywhere in the skill sends the agent to the published
// package instead, and the artifact silently lands in the repo, styled from a CDN, with sharing
// live again. The failure is invisible - it still works, just unpatched.
test("createSkillMarkdown never routes commands through npx", () => {
  const md = createSkillMarkdown();

  // No command in the skill may be an npx invocation. The one permitted mention of the word is
  // the prohibition itself, which is asserted below.
  assert.doesNotMatch(md, /`npx/);
  assert.doesNotMatch(md, /npx -y/);
  assert.match(md, /`npm link`-ed from a git checkout/);
  assert.match(md, /Always invoke the bare `lavish-axi \.\.\.` command/);
  assert.match(md, /NEVER run it through npx/);
  assert.match(md, /Run `lavish-axi <html-file>` to open or resume a review session/);
  assert.match(md, /Run `lavish-axi end <html-file>` when the review is finished/);
});

// LOCAL PATCH: the artifact must never land in the working directory or any git repo.
test("createSkillMarkdown puts artifacts in /tmp, never in the working directory", () => {
  const md = createSkillMarkdown();

  assert.match(md, /default location `\/tmp\/<name>\.html`/);
  assert.match(md, /never inside the project working directory or any git repo/);
  assert.doesNotMatch(md, /default location `\.lavish\//);
});
