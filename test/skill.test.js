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

function skillCommandText(text) {
  return text.replaceAll("`lavish-axi", "`npx -y lavish-axi");
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
  const workflow = md.slice(md.indexOf("## Workflow"), md.indexOf("## Visual guidance"));

  assert.match(workflow, /Keep .*poll in the foreground by default.*return the feedback directly to the agent/i);
  assert.match(workflow, /harness-native tracked background-job facility/i);
  assert.match(workflow, /completion result is guaranteed to resume or notify the same agent/i);
  assert.match(workflow, /Never use `nohup`/);
  assert.match(workflow, /shell `&`/);
  assert.match(workflow, /`disown`/);
  assert.match(workflow, /redirected fire-and-forget processes/);
  assert.match(workflow, /detached terminal without an explicit verified callback/);
  assert.match(
    workflow,
    /If the harness has no completion-aware background facility, use the foreground poll or first wire a verified wake callback into the surrounding supervisor/i,
  );
  assert.match(workflow, /Do not tell the user the artifact is being monitored until that wake path is live/i);
  assert.match(workflow, /`Send & End` ends the session.*final feedback is still delivered once.*polling stops/i);
  assert.match(workflow, /(?:do|must) not reopen (?:it|the session) uninvited/i);
  assert.match(workflow, /queued feedback is never lost/);
  assert.doesNotMatch(md, /Codex detected/);
});

test("createSkillMarkdown keeps layout detection passive", () => {
  const md = createSkillMarkdown();

  assert.match(md, /layout issues are filed passively/);
  assert.match(md, /ordinary `layout-warnings` prompt only when the user selects and queues them/);
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

test("createSkillMarkdown uses non-interactive npx commands", () => {
  const md = createSkillMarkdown();

  assert.match(md, /`npx -y lavish-axi <html-file>`/);
  assert.match(md, /If lavish-axi output shows a follow-up command starting with `lavish-axi`/);
  assert.match(md, /run it as `npx -y lavish-axi/);
  assert.doesNotMatch(md, /`npx lavish-axi/);
  assert.doesNotMatch(md, /Run `lavish-axi/);
});

test("createSkillMarkdown documents installed-copy fallback for restricted sandboxes", () => {
  const md = createSkillMarkdown();

  assert.match(md, /restricted subprocess sandboxes/);
  assert.match(md, /status 216/);
  assert.match(md, /`node "\$\(npm root\)\/lavish-axi\/dist\/cli\.mjs" <html-file>`/);
  assert.match(md, /`node "\$\(npm root -g\)\/lavish-axi\/dist\/cli\.mjs" <html-file>`/);
  assert.match(md, /bare `lavish-axi <html-file>` bin/);
});
