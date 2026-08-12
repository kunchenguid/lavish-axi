import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  addRegistryComponent,
  createComponent,
  createRecipe,
  inspectComponent,
  inspectRecipe,
  listComponents,
  registerComponent,
  removeComponent,
  searchComponents,
  setRecipeTokens,
  updateRecipeComponents,
  updateRecipeRequiredComponents,
  updateRecipeSlots,
} from "../src/artifact-registry.js";
import { composeArtifact } from "../src/artifact-composer.js";

async function project() {
  return mkdtemp(path.join(os.tmpdir(), "lavish-registry-test-"));
}

test("built-in components are discoverable without exposing template source", async () => {
  const root = await project();
  const listed = await listComponents({ projectRoot: root });
  const searched = await searchComponents("markdown source", { projectRoot: root });
  const inspected = await inspectComponent("markdown-code", { projectRoot: root });

  assert.deepEqual(
    listed.map((item) => item.name),
    ["data-table", "markdown-code", "page-section"],
  );
  assert.equal(searched[0].name, "markdown-code");
  assert.equal(inspected.name, "markdown-code");
  assert.deepEqual(inspected.required_inputs, ["content", "title"]);
  assert.equal(Object.hasOwn(inspected, "template"), false);
  assert.match(inspected.next_step, /compose|source/);
});

test("an agent can create, register, inspect, and remove a project component", async () => {
  const root = await project();
  const created = await createComponent("status-pill", {
    projectRoot: root,
    summary: "Show one status",
    useWhen: "A record needs a compact status label",
  });
  const source = path.join(root, "lavish", "components", "status-pill");
  await writeFile(path.join(source, "template.mustache"), '<span class="status-pill">{{label}}</span>\n');
  await writeFile(path.join(source, "example.toon"), "label: Ready\n");

  assert.ok(created.changed_paths.every((file) => file.startsWith("lavish/")));

  const registered = await registerComponent(source, { projectRoot: root });
  const inspected = await inspectComponent("status-pill", { projectRoot: root });

  assert.equal(registered.component.name, "status-pill");
  assert.deepEqual(inspected.required_inputs, ["label"]);
  assert.ok(registered.changed_paths.includes("lavish/registry.json"));
  assert.ok(registered.changed_paths.includes("lavish/shadcn/registry.json"));

  const removed = await removeComponent("status-pill", { projectRoot: root });
  assert.equal(removed.removed, "status-pill");
  await assert.rejects(inspectComponent("status-pill", { projectRoot: root }), /Unknown component/);
});

test("registration rejects unescaped component inputs", async () => {
  const root = await project();
  await createComponent("unsafe", { projectRoot: root, summary: "Unsafe", useWhen: "Never" });
  const source = path.join(root, "lavish", "components", "unsafe");
  await writeFile(path.join(source, "template.mustache"), "<div>{{{content}}}</div>\n");
  await writeFile(path.join(source, "example.toon"), "content: unsafe\n");

  await assert.rejects(registerComponent(source, { projectRoot: root }), /unescaped.*content/i);
});

test("recipes are agent-operated and inject their token stylesheet", async () => {
  const root = await project();
  await createRecipe("incident-review", { projectRoot: root, summary: "Review an incident" });
  await updateRecipeComponents("incident-review", "page-section", "add", { projectRoot: root });
  const tokens = path.join(root, "lavish", "recipes", "incident-review", "tokens.css");
  await writeFile(tokens, ":root { --incident-accent: #b45309; }\n");
  await setRecipeTokens("incident-review", tokens, { projectRoot: root });

  const composition = path.join(root, "incident.toon");
  await writeFile(
    composition,
    ["title: Incident review", "components[1]{component,slot,data}:", "  page-section,body,section.toon", ""].join(
      "\n",
    ),
  );
  await writeFile(path.join(root, "section.toon"), "title: Result\ncontent: Service restored\n");
  const output = path.join(root, "incident.html");

  const result = await composeArtifact("incident-review", composition, output, { projectRoot: root });
  const html = await readFile(output, "utf8");
  const css = await readFile(path.join(root, "incident.assets", "styles.css"), "utf8");

  assert.equal(result.components[0].name, "page-section");
  assert.match(html, /<h2>Result<\/h2>/);
  assert.match(html, /incident\.assets\/styles\.css/);
  assert.match(css, /--incident-accent/);
});

test("two OpenSpec artifacts reuse registered markup through compact TOON calls", async () => {
  const root = await project();
  const firstInput = path.join(root, "first.toon");
  const secondInput = path.join(root, "second.toon");
  const firstData = path.join(root, "first-source.toon");
  const secondData = path.join(root, "second-source.toon");

  await writeFile(firstData, 'title: Proposal\ncontent: "# First\\n\\n`alpha`"\n');
  await writeFile(secondData, 'title: Specification\ncontent: "# Second\\n\\n`beta`"\n');
  await writeFile(
    firstInput,
    "title: First review\ncomponents[1]{component,slot,data}:\n  markdown-code,body,first-source.toon\n",
  );
  await writeFile(
    secondInput,
    "title: Second review\ncomponents[1]{component,slot,data}:\n  markdown-code,body,second-source.toon\n",
  );

  const firstOutput = path.join(root, "first.html");
  const secondOutput = path.join(root, "second.html");
  await composeArtifact("openspec-review", firstInput, firstOutput, { projectRoot: root });
  await composeArtifact("openspec-review", secondInput, secondOutput, { projectRoot: root });

  const first = await readFile(firstOutput, "utf8");
  const second = await readFile(secondOutput, "utf8");
  assert.match(first, /<pre[^>]*><code class="language-markdown">/);
  assert.match(second, /<pre[^>]*><code class="language-markdown">/);
  assert.match(first, /&lt;|# First/);
  assert.doesNotMatch(await readFile(firstInput, "utf8"), /<pre|<code|class=/);
  assert.doesNotMatch(await readFile(secondInput, "utf8"), /<pre|<code|class=/);
  const measured = await composeArtifact("openspec-review", firstInput, firstOutput, { projectRoot: root });
  assert.ok(measured.input_bytes < measured.artifact_bytes);
  assert.ok(measured.markup_bytes_avoided > 0);
  assert.ok(measured.input_reduction_percent > 0);
});

test("component source paths cannot escape the project", async () => {
  const root = await project();
  const outside = await project();
  await assert.rejects(registerComponent(outside, { projectRoot: root }), /inside.*project/i);
});

test("agents can operate recipe slots and required component calls", async () => {
  const root = await project();
  await createRecipe("decision-record", { projectRoot: root, summary: "Review a decision" });
  await updateRecipeSlots("decision-record", "evidence", "add", { projectRoot: root });
  await updateRecipeRequiredComponents("decision-record", "data-table", "add", { projectRoot: root });

  const recipe = await inspectRecipe("decision-record", { projectRoot: root });
  assert.deepEqual(recipe.slots, ["body", "evidence"]);
  assert.deepEqual(recipe.components, ["data-table"]);
  assert.deepEqual(recipe.required_components, ["data-table"]);
});

test("shadcn imports use declared Lavish source files and support dry runs", async () => {
  const root = await project();
  const item = {
    name: "status-pill",
    files: [
      {
        path: "status-pill/component.toon",
        content: "name: status-pill\nsummary: Show status\nuse_when: A status is useful\n",
      },
      { path: "status-pill/template.mustache", content: "<strong>{{label}}</strong>\n" },
      { path: "status-pill/example.toon", content: "label: Ready\n" },
      { path: "status-pill/ignored.txt", content: "not part of the Lavish convention\n" },
    ],
  };
  const getItems = async () => [item];

  const planned = await addRegistryComponent("https://example.test/r/status-pill.json", {
    projectRoot: root,
    dryRun: true,
    getItems,
  });
  assert.equal(planned.installed, false);
  assert.deepEqual(planned.planned_paths, [
    "lavish/components/status-pill/component.toon",
    "lavish/components/status-pill/example.toon",
    "lavish/components/status-pill/template.mustache",
  ]);

  const installed = await addRegistryComponent("https://example.test/r/status-pill.json", {
    projectRoot: root,
    getItems,
  });
  assert.equal(installed.installed, true);
  assert.equal((await inspectComponent("status-pill", { projectRoot: root })).origin, "project");
});

test("composition rejects a project source swapped to an outside symlink", async () => {
  const root = await project();
  const outside = await project();
  await createComponent("safe-card", { projectRoot: root });
  const source = path.join(root, "lavish", "components", "safe-card");
  await writeFile(path.join(source, "template.mustache"), "<p>{{content}}</p>\n");
  await writeFile(path.join(source, "example.toon"), "content: Safe\n");
  await registerComponent(source, { projectRoot: root });
  await createRecipe("safe-review", { projectRoot: root });
  await updateRecipeComponents("safe-review", "safe-card", "add", { projectRoot: root });
  await writeFile(path.join(outside, "outside.mustache"), "<script>outside()</script>\n");
  await rename(path.join(source, "template.mustache"), path.join(source, "template.original.mustache"));
  await symlink(path.join(outside, "outside.mustache"), path.join(source, "template.mustache"));
  await writeFile(path.join(root, "card.toon"), "content: Safe\n");
  await writeFile(path.join(root, "input.toon"), "components[1]{component,slot,data}:\n  safe-card,body,card.toon\n");

  await assert.rejects(
    composeArtifact("safe-review", path.join(root, "input.toon"), path.join(root, "output.html"), {
      projectRoot: root,
    }),
    /must stay inside/i,
  );
});

test("composition refuses output and asset symlinks that escape the project", async () => {
  const root = await project();
  const outside = await project();
  await createRecipe("safe-review", { projectRoot: root });
  await writeFile(path.join(root, "input.toon"), "components[0]{component,slot}:\n");
  const outsideOutput = path.join(outside, "outside.html");
  await writeFile(outsideOutput, "unchanged\n");
  await symlink(outsideOutput, path.join(root, "output.html"));

  await assert.rejects(
    composeArtifact("safe-review", path.join(root, "input.toon"), path.join(root, "output.html"), {
      projectRoot: root,
    }),
    /must stay inside/i,
  );
  assert.equal(await readFile(outsideOutput, "utf8"), "unchanged\n");

  await mkdir(path.join(outside, "assets"));
  await symlink(path.join(outside, "assets"), path.join(root, "safe.assets"));
  await assert.rejects(
    composeArtifact("safe-review", path.join(root, "input.toon"), path.join(root, "safe.html"), {
      projectRoot: root,
    }),
    /must stay inside/i,
  );
});

test("new recipes enforce a token stylesheet by default", async () => {
  const root = await project();
  await createRecipe("project-review", { projectRoot: root });
  const recipe = await inspectRecipe("project-review", { projectRoot: root });
  await writeFile(path.join(root, "input.toon"), "components[0]{component,slot}:\n");
  const output = path.join(root, "output.html");

  await composeArtifact("project-review", path.join(root, "input.toon"), output, { projectRoot: root });

  assert.equal(recipe.tokens, "tokens.css");
  assert.match(await readFile(path.join(root, "output.assets", "styles.css"), "utf8"), /color-scheme/);
});

test("partial inputs become part of the parent component contract", async () => {
  const root = await project();
  await createComponent("status-pill", { projectRoot: root });
  const partial = path.join(root, "lavish", "components", "status-pill");
  await writeFile(path.join(partial, "template.mustache"), "<strong>{{label}}</strong>\n");
  await writeFile(path.join(partial, "example.toon"), "label: Ready\n");
  await registerComponent(partial, { projectRoot: root });
  await createComponent("status-card", { projectRoot: root });
  const parent = path.join(root, "lavish", "components", "status-card");
  await writeFile(path.join(parent, "template.mustache"), "<article>{{> status-pill}}</article>\n");
  await writeFile(path.join(parent, "example.toon"), "label: Ready\n");
  await registerComponent(parent, { projectRoot: root });
  await createRecipe("status-review", { projectRoot: root });
  await updateRecipeComponents("status-review", "status-card", "add", { projectRoot: root });
  await writeFile(path.join(root, "status.toon"), "label: Ready\n");
  await writeFile(
    path.join(root, "input.toon"),
    "components[1]{component,slot,data}:\n  status-card,body,status.toon\n",
  );
  const output = path.join(root, "status.html");
  await composeArtifact("status-review", path.join(root, "input.toon"), output, { projectRoot: root });

  assert.deepEqual((await inspectComponent("status-card", { projectRoot: root })).required_inputs, ["label"]);
  assert.match(await readFile(output, "utf8"), /<strong>Ready<\/strong>/);
});

test("required components must be unrequired before recipe removal", async () => {
  const root = await project();
  await createRecipe("required-review", { projectRoot: root });
  await updateRecipeRequiredComponents("required-review", "data-table", "add", { projectRoot: root });

  await assert.rejects(
    updateRecipeComponents("required-review", "data-table", "remove", { projectRoot: root }),
    /unrequire it before removing/i,
  );
  assert.deepEqual((await inspectRecipe("required-review", { projectRoot: root })).components, ["data-table"]);
});

test("failed registry imports leave no destination and can be retried", async () => {
  const root = await project();
  const item = {
    name: "retry-card",
    files: [
      { path: "component.toon", content: "name: retry-card\n" },
      { path: "template.mustache", content: "<p>{{label}}</p>\n" },
      { path: "example.toon", content: "wrong: value\n" },
    ],
  };
  const getItems = async () => [item];

  await assert.rejects(addRegistryComponent("retry-card", { projectRoot: root, getItems }), /example/i);
  item.files[2].content = "label: Ready\n";
  const installed = await addRegistryComponent("retry-card", { projectRoot: root, getItems });

  assert.equal(installed.installed, true);
});
