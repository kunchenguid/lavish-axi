import assert from "node:assert/strict";
import { readFile, readlink } from "node:fs/promises";
import test from "node:test";

const MAINTENANCE_PREAMBLE = `## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
`;

test("AGENTS.md ends with the canonical self-governance preamble", async () => {
  const agents = await readFile(new URL("../AGENTS.md", import.meta.url), "utf8");

  assert.equal([...agents.matchAll(/^## Maintaining this file$/gm)].length, 1);
  assert.ok(agents.endsWith(`\n\n${MAINTENANCE_PREAMBLE}`));
});

test("CLAUDE.md keeps the root agent guidance available through its symlink", async () => {
  const claude = new URL("../CLAUDE.md", import.meta.url);
  const [target, agents, throughClaude] = await Promise.all([
    readlink(claude),
    readFile(new URL("../AGENTS.md", import.meta.url), "utf8"),
    readFile(claude, "utf8"),
  ]);

  assert.equal(target, "AGENTS.md");
  assert.equal(throughClaude, agents);
});
