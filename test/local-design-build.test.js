import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createDesignOutput } from "../src/design-reference.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

test("design output exposes executable injection-safe base and themed argv", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lavish-design-command-"));
  try {
    const pathSpecial = `spaces $HOME %TEMP% 'single' $(unsafe)`;
    const marker = path.join(root, "shell-injection-marker");
    const argumentSpecial = `${pathSpecial} "double" $(touch ${marker})`;
    const builderDir = path.join(root, "checkout path", pathSpecial);
    const builder = path.join(builderDir, "build-css.mjs");
    const artifact = path.join(root, `artifact ${pathSpecial}.html`);
    await mkdir(builderDir, { recursive: true });
    await writeFile(builder, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
    await writeFile(artifact, "<!doctype html><title>artifact</title>\n");

    const output = createDesignOutput({ cssBuilderPath: builder, platform: "win32" });
    assert.equal(output.styling.build_command, null);
    assert.equal(output.styling.themed_build_command, null);
    const baseArgv = output.styling.build_argv?.map((arg) => (arg === "<artifact.html>" ? artifact : arg));
    assert.ok(baseArgv);
    const base = spawnSync(baseArgv[0], baseArgv.slice(1), { encoding: "utf8" });
    assert.equal(base.status, 0, base.stderr);
    assert.deepEqual(JSON.parse(base.stdout), [artifact, "--minify"]);

    const themedArgv = output.styling.themed_build_argv?.map((arg) => {
      if (arg === "<artifact.html>") return artifact;
      if (arg === "<daisyui-theme>") return argumentSpecial;
      return arg;
    });
    assert.ok(themedArgv);
    const themed = spawnSync(themedArgv[0], themedArgv.slice(1), { encoding: "utf8" });
    assert.equal(themed.status, 0, themed.stderr);
    assert.deepEqual(JSON.parse(themed.stdout), [artifact, "--minify", "--theme", argumentSpecial]);
    await assert.rejects(access(marker));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing CSS toolchain guidance is non-executable in hostile checkout paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lavish-css-missing-"));
  try {
    const checkout = path.join(root, "checkout $HOME %TEMP% 'single' $(touch shell-marker)");
    const localDir = path.join(checkout, "local");
    const sourceDir = path.join(checkout, "src");
    await mkdir(localDir, { recursive: true });
    await mkdir(sourceDir, { recursive: true });
    await copyFile(path.join(projectRoot, "local", "build-css.mjs"), path.join(localDir, "build-css.mjs"));
    await copyFile(path.join(projectRoot, "src", "design-reference.js"), path.join(sourceDir, "design-reference.js"));
    await copyFile(path.join(projectRoot, "src", "playbooks.js"), path.join(sourceDir, "playbooks.js"));
    const artifact = path.join(root, "artifact with spaces.html");
    await writeFile(artifact, "<!doctype html><title>artifact</title>\n");

    const result = spawnSync(process.execPath, [path.join(localDir, "build-css.mjs"), artifact], {
      cwd: root,
      encoding: "utf8",
    });

    assert.equal(result.status, 1);
    assert.equal(
      result.stderr.trim(),
      "error: toolchain missing; install the dependencies declared by local/package.json, then retry",
    );
    assert.doesNotMatch(result.stderr, /npm install|--prefix|\$HOME|%TEMP%|\$\(touch/);
    await assert.rejects(access(path.join(root, "shell-marker")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CSS builder rejects directory artifact paths before scanning", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lavish-css-directory-"));
  try {
    const result = spawnSync(process.execPath, [path.join(projectRoot, "local", "build-css.mjs"), root], {
      encoding: "utf8",
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /error: not a file:/);
    assert.doesNotMatch(result.stderr, /toolchain missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CSS builder runs the package JavaScript entrypoint and preserves the last good stylesheet", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lavish-css-builder-"));
  try {
    const localDir = path.join(root, "local");
    const sourceDir = path.join(root, "src");
    const cliDir = path.join(localDir, "node_modules", "@tailwindcss", "cli");
    const artifactDir = path.join(root, "artifacts");
    await mkdir(path.join(cliDir, "dist"), { recursive: true });
    await mkdir(sourceDir, { recursive: true });
    await mkdir(artifactDir, { recursive: true });
    await copyFile(path.join(projectRoot, "local", "build-css.mjs"), path.join(localDir, "build-css.mjs"));
    await copyFile(path.join(projectRoot, "src", "design-reference.js"), path.join(sourceDir, "design-reference.js"));
    await copyFile(path.join(projectRoot, "src", "playbooks.js"), path.join(sourceDir, "playbooks.js"));

    await writeFile(
      path.join(cliDir, "package.json"),
      JSON.stringify({ type: "module", bin: { tailwindcss: "./dist/index.mjs" } }),
    );
    const fakeTailwind = path.join(cliDir, "dist", "index.mjs");
    await writeFile(
      fakeTailwind,
      'import fs from "node:fs";const args=process.argv.slice(2);const out=args[args.indexOf("-o")+1];fs.writeFileSync(out,process.env.FAKE_TAILWIND_OUTPUT||"");process.exit(Number(process.env.FAKE_TAILWIND_STATUS||0));\n',
    );

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
