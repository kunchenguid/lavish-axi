import assert from "node:assert/strict";
import test from "node:test";

import { createHomeOutput } from "../src/cli.js";
import { SKILL_DESCRIPTION, createSkillMarkdown } from "../src/skill.js";

function skillCommandText(text) {
  return text.replaceAll("`lavish-axi", "`npx -y lavish-axi");
}

test("createSkillMarkdown emits valid frontmatter naming the lavish skill", () => {
  const md = createSkillMarkdown();
  assert.ok(md.startsWith("---\n"), "starts with frontmatter fence");
  const end = md.indexOf("\n---\n", 4);
  assert.ok(end > 0, "frontmatter is closed");
  const frontmatter = md.slice(4, end);
  assert.match(frontmatter, /^name: lavish$/m);
  assert.match(frontmatter, /^description: /m);
  assert.match(frontmatter, /^argument-hint: /m);
  assert.ok(frontmatter.includes(SKILL_DESCRIPTION), "frontmatter carries the skill description");
});

test("createSkillMarkdown emits Hermes Agent metadata in frontmatter", () => {
  const md = createSkillMarkdown();
  const frontmatter = md.slice(4, md.indexOf("\n---\n", 4));

  assert.match(frontmatter, /^author: Kun Chen \(kunchenguid\)$/m);
  assert.match(frontmatter, /^metadata:\n {2}hermes:\n {4}tags: \[[^\]]+\]\n {4}category: \S+$/m);
  assert.doesNotMatch(frontmatter, /^version:/m, "version is omitted to avoid release churn");
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

test("createSkillMarkdown omits setup hooks guidance", () => {
  const md = createSkillMarkdown();
  assert.doesNotMatch(md, /setup hooks/);
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
