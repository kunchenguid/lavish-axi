// Generates the root plugin.json from package.json so the Agent Plugins manifest never
// drifts from the published package identity.
//
//   node scripts/build-plugin.js          # write the file
//   node scripts/build-plugin.js --check  # fail (exit 1) if the committed file is stale
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createPluginManifestJson } from "../src/plugin.js";

const target = new URL("../plugin.json", import.meta.url);
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const expected = createPluginManifestJson(packageJson);
const check = process.argv.includes("--check");

if (check) {
  let actual = null;
  try {
    actual = await readFile(target, "utf8");
  } catch {
    // missing file falls through to the mismatch branch below
  }
  if (actual !== expected) {
    console.error("plugin.json is out of date. Run `node scripts/build-plugin.js` and commit the result.");
    process.exit(1);
  }
  console.log("plugin.json is up to date.");
} else {
  await writeFile(target, expected);
  console.log(`Wrote ${fileURLToPath(target)}`);
}
