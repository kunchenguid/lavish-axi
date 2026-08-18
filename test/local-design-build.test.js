import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
      "error: toolchain missing; reinstall lavish-axi with its production dependencies, then retry",
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

test(
  "CSS builder preserves POSIX backslashes and control characters in artifact paths",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lavish-css-posix-path-"));
    try {
      const artifact = path.join(root, "report\\draft\nline.html");
      const stylesheet = path.join(root, "report\\draft\nline.css");
      await writeFile(artifact, '<!doctype html><div class="bg-red-500">Hello</div>\n');

      const result = spawnSync(process.execPath, [path.join(projectRoot, "local", "build-css.mjs"), artifact], {
        encoding: "utf8",
      });

      assert.equal(result.status, 0, result.stderr);
      assert.match(await readFile(stylesheet, "utf8"), /\.bg-red-500/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("packaged tarball ships an executable CSS builder and runtime dependencies", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lavish-css-package-"));
  const readOnlyDirs = [];
  try {
    const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    assert.equal(packed.status, 0, packed.stderr);
    const [{ filename }] = JSON.parse(packed.stdout);
    const tarball = path.join(root, filename);

    for (const nodeLinker of ["isolated", "hoisted"]) {
      const installDir = path.join(root, nodeLinker);
      await mkdir(installDir, { recursive: true });
      const extracted = spawnSync("tar", ["-xzf", tarball, "-C", installDir, "--strip-components=1"], {
        encoding: "utf8",
      });
      assert.equal(extracted.status, 0, extracted.stderr);
      await copyFile(path.join(projectRoot, "pnpm-lock.yaml"), path.join(installDir, "pnpm-lock.yaml"));
      await writeFile(path.join(installDir, ".npmrc"), `node-linker=${nodeLinker}\n`);
      const installed = spawnSync("pnpm", ["install", "--prod", "--offline", "--ignore-scripts", "--frozen-lockfile"], {
        cwd: installDir,
        encoding: "utf8",
      });
      assert.equal(installed.status, 0, `${installed.stderr}\n${installed.stdout}`);

      const packageDir = installDir;
      const manifest = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
      assert.equal(manifest.dependencies["@tailwindcss/cli"], "4.2.4");
      assert.equal(manifest.dependencies.tailwindcss, "4.2.4");
      assert.ok(manifest.dependencies.daisyui);

      const stateDir = path.join(installDir, "state");
      const design = spawnSync(process.execPath, [path.join(packageDir, "dist", "cli.mjs"), "design"], {
        encoding: "utf8",
        env: { ...process.env, LAVISH_AXI_STATE_DIR: stateDir, LAVISH_AXI_TELEMETRY: "0" },
      });
      assert.equal(design.status, 0, design.stderr);
      assert.match(design.stdout, /build_argv/);
      assert.match(design.stdout, /dist\/build-css\.mjs/);
      assert.doesNotMatch(design.stdout, /build_argv: null/);

      const artifact = path.join(installDir, `${nodeLinker} artifact.html`);
      await writeFile(artifact, '<!doctype html><button class="btn btn-primary">Ship</button>\n');
      const distDir = path.join(packageDir, "dist");
      await chmod(distDir, 0o555);
      readOnlyDirs.push(distDir);
      const build = spawnSync(
        process.execPath,
        [path.join(packageDir, "dist", "build-css.mjs"), artifact, "--minify"],
        { encoding: "utf8" },
      );
      assert.equal(build.status, 0, build.stderr);
      assert.match(await readFile(path.join(installDir, `${nodeLinker} artifact.css`), "utf8"), /\.btn/);
      assert.equal(
        (await readdir(distDir)).some((name) => name.startsWith(".build-") || name.includes(".input-")),
        false,
      );
    }
  } finally {
    for (const dir of readOnlyDirs) await chmod(dir, 0o755).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("CSS builder runs the package JavaScript entrypoint and preserves the last good stylesheet", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lavish-css-builder-"));
  try {
    const localDir = path.join(root, "local");
    const sourceDir = path.join(root, "src");
    const cliDir = path.join(root, "node_modules", "@tailwindcss", "cli");
    const tailwindDir = path.join(root, "node_modules", "tailwindcss");
    const daisyuiDir = path.join(root, "node_modules", "daisyui");
    const artifactDir = path.join(root, "artifacts");
    await mkdir(path.join(cliDir, "dist"), { recursive: true });
    await mkdir(tailwindDir, { recursive: true });
    await mkdir(daisyuiDir, { recursive: true });
    await mkdir(localDir, { recursive: true });
    await mkdir(sourceDir, { recursive: true });
    await mkdir(artifactDir, { recursive: true });
    await copyFile(path.join(projectRoot, "local", "build-css.mjs"), path.join(localDir, "build-css.mjs"));
    await copyFile(path.join(projectRoot, "src", "design-reference.js"), path.join(sourceDir, "design-reference.js"));
    await copyFile(path.join(projectRoot, "src", "playbooks.js"), path.join(sourceDir, "playbooks.js"));

    await writeFile(
      path.join(cliDir, "package.json"),
      JSON.stringify({
        type: "module",
        exports: { "./package.json": "./package.json" },
        bin: { tailwindcss: "./dist/index.mjs" },
      }),
    );
    await writeFile(
      path.join(tailwindDir, "package.json"),
      JSON.stringify({ type: "module", exports: { "./index.css": "./index.css" } }),
    );
    await writeFile(path.join(tailwindDir, "index.css"), "@theme {}\n");
    await writeFile(path.join(daisyuiDir, "package.json"), JSON.stringify({ type: "module", main: "./index.js" }));
    await writeFile(path.join(daisyuiDir, "index.js"), "export default {};\n");
    const fakeTailwind = path.join(cliDir, "dist", "index.mjs");
    await writeFile(
      fakeTailwind,
      'import fs from "node:fs";const args=process.argv.slice(2);const out=args[args.indexOf("-o")+1];fs.writeFileSync(out,process.env.FAKE_TAILWIND_OUTPUT||"");process.exit(Number(process.env.FAKE_TAILWIND_STATUS||0));\n',
    );

    const artifact = path.join(artifactDir, "artifact.html");
    const stylesheet = path.join(artifactDir, "artifact.css");
    const builder = path.join(localDir, "build-css.mjs");
    await writeFile(artifact, '<!doctype html><div class="btn">Hello</div>\n');

    async function runBuilder(output, status, target = artifact) {
      return spawnSync(process.execPath, [builder, target, "--minify"], {
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

    const hostileArtifact = path.join(artifactDir, `report "&?#'.html`);
    await writeFile(hostileArtifact, '<!doctype html><div class="btn">Hello</div>\n');
    const hostile = await runBuilder(".btn{display:inline-flex}\n", 0, hostileArtifact);
    assert.equal(hostile.status, 0, hostile.stderr);
    assert.match(hostile.stdout, /href="report%20%22%26%3F%23&#39;\.css"/);
    assert.equal(await readFile(path.join(artifactDir, `report "&?#'.css`), "utf8"), ".btn{display:inline-flex}\n");

    assert.equal(
      (await readdir(artifactDir)).some((name) => name.startsWith(".artifact.css.build-")),
      false,
    );
    assert.equal(
      (await readdir(artifactDir)).some((name) => name.includes(".input-")),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
