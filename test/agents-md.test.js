import assert from "node:assert/strict";
import { readFile, lstat } from "node:fs/promises";
import test from "node:test";

const CLAUDE_POINTER = `<!-- Points Claude at AGENTS.md via import; edit AGENTS.md, not this file. -->
@AGENTS.md
`;

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

test("CLAUDE.md is a real pointer file importing AGENTS.md, not a symlink", async () => {
  const claude = new URL("../CLAUDE.md", import.meta.url);
  const [stats, contents] = await Promise.all([lstat(claude), readFile(claude, "utf8")]);

  // A symlink here is a footgun: writing to CLAUDE.md would follow it and
  // destroy AGENTS.md. The `@AGENTS.md` import loads the same content with no
  // extra turns, and a stray write only clobbers this two-line file.
  assert.equal(stats.isSymbolicLink(), false);
  assert.equal(contents, CLAUDE_POINTER);
});
