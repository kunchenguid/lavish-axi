import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { decode } from "@toon-format/toon";

const cli = path.resolve(import.meta.dirname, "../bin/lavish-axi.js");

async function workspace() {
  return mkdtemp(path.join(os.tmpdir(), "lavish-registry-cli-"));
}

function run(root, args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, LAVISH_AXI_TELEMETRY: "0", LAVISH_AXI_STATE_DIR: path.join(root, ".state") },
    timeout: 15_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return /** @type {Record<string, any>} */ (decode(result.stdout));
}

test("registry and recipe discovery are compact AXI commands", async () => {
  const root = await workspace();
  const registry = run(root, ["registry", "search", "markdown"]);
  const recipes = run(root, ["recipe", "list"]);

  assert.equal(registry.components[0].name, "markdown-code");
  assert.deepEqual(Object.keys(registry.components[0]).sort(), ["name", "origin", "summary", "use_when"]);
  assert.equal(recipes.recipes[0].name, "openspec-review");
});

test("agent mutation commands create reviewable component sources", async () => {
  const root = await workspace();
  const created = run(root, [
    "registry",
    "create",
    "status-pill",
    "--summary",
    "Show one status",
    "--use-when",
    "A compact status is useful",
  ]);
  const source = path.join(root, "lavish", "components", "status-pill");
  await writeFile(path.join(source, "template.mustache"), "<strong>{{label}}</strong>\n");
  await writeFile(path.join(source, "example.toon"), "label: Ready\n");
  const registered = run(root, ["registry", "register", "lavish/components/status-pill"]);

  assert.ok(created.changed_paths.includes("lavish/components/status-pill/template.mustache"));
  assert.equal(registered.component.name, "status-pill");
  assert.match(await readFile(path.join(root, "lavish", "registry.json"), "utf8"), /status-pill/);
});

test("compose turns TOON component calls into a complete artifact", async () => {
  const root = await workspace();
  await writeFile(path.join(root, "source.toon"), 'title: Proposal\ncontent: "# Use the registry"\n');
  await writeFile(
    path.join(root, "review.toon"),
    "title: Registry review\ncomponents[1]{component,slot,data}:\n  markdown-code,body,source.toon\n",
  );

  const output = run(root, ["compose", "openspec-review", "--input", "review.toon", "--out", "review.html"]);
  const html = await readFile(path.join(root, "review.html"), "utf8");

  assert.equal(output.artifact, "review.html");
  assert.equal(output.recipe, "openspec-review");
  assert.match(html, /<code class="language-markdown"># Use the registry<\/code>/);
  assert.match(output.next_step, /lavish-axi review\.html/);
});
