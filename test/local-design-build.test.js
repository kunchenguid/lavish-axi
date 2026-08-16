import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createDesignOutput } from "../src/design-reference.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

test("design output exposes executable base and themed build commands", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lavish-design-command-"));
  try {
    const builderDir = path.join(root, "checkout path", "it's $(unsafe)");
    const builder = path.join(builderDir, "build-css.mjs");
    const artifact = path.join(root, "artifact file.html");
    await mkdir(builderDir, { recursive: true });
    await writeFile(builder, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
    await writeFile(artifact, "<!doctype html><title>artifact</title>\n");

    const output = createDesignOutput({ cssBuilderPath: builder });
    assert.ok(output.styling.build_command);
    assert.ok(output.styling.themed_build_command);
    const baseCommand = output.styling.build_command.replace("'<artifact.html>'", shellQuote(artifact));
    const base = spawnSync(baseCommand, { encoding: "utf8", shell: true });
    assert.equal(base.status, 0, base.stderr);
    assert.deepEqual(JSON.parse(base.stdout), [artifact, "--minify"]);

    const themedCommand = output.styling.themed_build_command
      .replace("'<artifact.html>'", shellQuote(artifact))
      .replace("'<daisyui-theme>'", shellQuote("night"));
    const themed = spawnSync(themedCommand, { encoding: "utf8", shell: true });
    assert.equal(themed.status, 0, themed.stderr);
    assert.deepEqual(JSON.parse(themed.stdout), [artifact, "--minify", "--theme", "night"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CSS builder preserves the last good stylesheet until validation succeeds", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lavish-css-builder-"));
  try {
    const localDir = path.join(root, "local");
    const sourceDir = path.join(root, "src");
    const binDir = path.join(localDir, "node_modules", ".bin");
    const artifactDir = path.join(root, "artifacts");
    await mkdir(binDir, { recursive: true });
    await mkdir(sourceDir, { recursive: true });
    await mkdir(artifactDir, { recursive: true });
    await copyFile(path.join(projectRoot, "local", "build-css.mjs"), path.join(localDir, "build-css.mjs"));
    await copyFile(path.join(projectRoot, "src", "design-reference.js"), path.join(sourceDir, "design-reference.js"));
    await copyFile(path.join(projectRoot, "src", "playbooks.js"), path.join(sourceDir, "playbooks.js"));

    const fakeTailwind = path.join(binDir, "tailwindcss");
    await writeFile(
      fakeTailwind,
      '#!/usr/bin/env node\nconst fs=require("node:fs");const args=process.argv.slice(2);const out=args[args.indexOf("-o")+1];fs.writeFileSync(out,process.env.FAKE_TAILWIND_OUTPUT||"");process.exit(Number(process.env.FAKE_TAILWIND_STATUS||0));\n',
    );
    await chmod(fakeTailwind, 0o755);

    const artifact = path.join(artifactDir, "artifact.html");
    const stylesheet = path.join(artifactDir, "artifact.css");
    const builder = path.join(localDir, "build-css.mjs");
    await writeFile(artifact, '<!doctype html><div class="btn">Hello</div>\n');

    async function runBuilder(output, status) {
      return spawnSync(process.execPath, [builder, artifact, "--minify"], {
        encoding: "utf8",
        env: { ...process.env, FAKE_TAILWIND_OUTPUT: output, FAKE_TAILWIND_STATUS: String(status) },
      });
    }

    await writeFile(stylesheet, ".last-good{display:block}\n");
    const failed = await runBuilder(".partial{", 1);
    assert.equal(failed.status, 1);
    assert.equal(await readFile(stylesheet, "utf8"), ".last-good{display:block}\n");

    const empty = await runBuilder("", 0);
    assert.equal(empty.status, 1);
    assert.equal(await readFile(stylesheet, "utf8"), ".last-good{display:block}\n");

    const succeeded = await runBuilder(".btn{display:inline-flex}\n", 0);
    assert.equal(succeeded.status, 0, succeeded.stderr);
    assert.equal(await readFile(stylesheet, "utf8"), ".btn{display:inline-flex}\n");

    assert.equal(
      (await readdir(artifactDir)).some((name) => name.startsWith(".artifact.css.build-")),
      false,
    );
    assert.equal(
      (await readdir(localDir)).some((name) => name.startsWith(".build-")),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
