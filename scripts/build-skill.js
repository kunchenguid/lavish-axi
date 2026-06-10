// Generates skills/lavish/SKILL.md from the shared no-args home output so the
// installable skill never drifts from what `lavish-axi` (and the SessionStart hook) print.
//
//   node scripts/build-skill.js          # write the file
//   node scripts/build-skill.js --check  # fail (exit 1) if the committed file is stale
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createSkillMarkdown } from "../src/skill.js";

const target = new URL("../skills/lavish/SKILL.md", import.meta.url);
const expected = createSkillMarkdown();
const check = process.argv.includes("--check");

if (check) {
  let actual = null;
  try {
    actual = await readFile(target, "utf8");
  } catch {
    // missing file falls through to the mismatch branch below
  }
  if (actual !== expected) {
    console.error("skills/lavish/SKILL.md is out of date. Run `node scripts/build-skill.js` and commit the result.");
    process.exit(1);
  }
  console.log("skills/lavish/SKILL.md is up to date.");
} else {
  await mkdir(new URL("../skills/lavish/", import.meta.url), { recursive: true });
  await writeFile(target, expected);
  console.log(`Wrote ${fileURLToPath(target)}`);
}
