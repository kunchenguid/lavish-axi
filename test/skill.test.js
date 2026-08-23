import assert from "node:assert/strict";
import test from "node:test";

import { POLL_SEND_AND_END_RULE, POLL_WAKE_PATH_RULES, createHomeOutput } from "../src/cli.js";
import { DESIGN_PRIORITY_RULE } from "../src/design-reference.js";
import { PLAYBOOK_ROUTER_HELP } from "../src/playbooks.js";
import {
  ALLOWED_SKILL_FRONTMATTER_KEYS,
  MAX_SKILL_MARKDOWN_CHARS,
  SKILL_DESCRIPTION,
  createSkillMarkdown,
  parseSkillFrontmatter,
  validateSkillMarkdown,
} from "../src/skill.js";

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

test("createSkillMarkdown stays a short stub that defers to the CLI", () => {
  const md = createSkillMarkdown();

  assert.ok(md.length <= MAX_SKILL_MARKDOWN_CHARS, "the generated skill stays drastically smaller than CLI guidance");
  assert.match(md, /Lavish Editor/);
  assert.match(md, /`npx -y lavish-axi --help`/);
  assert.match(md, /`npx -y lavish-axi design`/);
  assert.match(md, /`npx -y lavish-axi playbook <id>`/);
  assert.match(md, /stale/i);
});

test("createSkillMarkdown does not bake CLI-owned guidance into the skill", () => {
  const md = createSkillMarkdown();
  const home = createHomeOutput({ bin: "lavish-axi", sessions: [], includeSessions: false, agent: "static" });

  for (const item of home.visual_guidance) {
    assert.ok(!md.includes(item), `must not copy visual guidance: ${item.slice(0, 48)}...`);
  }

  for (const playbook of home.playbooks) {
    assert.ok(!md.includes(playbook.use_when), `must not copy playbook use_when: ${playbook.id}`);
  }

  for (const item of POLL_WAKE_PATH_RULES) {
    assert.ok(!md.includes(item), `must not copy poll wake-path rule: ${item.slice(0, 48)}...`);
  }

  assert.ok(!md.includes(POLL_SEND_AND_END_RULE), "must not copy the Send & End rule");
  assert.ok(!md.includes(PLAYBOOK_ROUTER_HELP), "must not copy playbook-router help");
  assert.ok(!md.includes(DESIGN_PRIORITY_RULE), "must not copy the design-priority rule");
  assert.doesNotMatch(md, /self_paint_warning/);
  assert.doesNotMatch(md, /## Workflow/);
  assert.doesNotMatch(md, /## Visual guidance/);
  assert.doesNotMatch(md, /## Playbooks/);
  assert.doesNotMatch(md, /## Commands & rules/);
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
