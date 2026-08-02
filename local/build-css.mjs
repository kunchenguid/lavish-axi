#!/usr/bin/env node
// LOCAL ADDITION (not upstream): per-artifact Tailwind + DaisyUI compiler.
//
// Why this exists: this install removed the Tailwind/DaisyUI CDN fallback, because a CDN
// artifact is not self-contained - `lavish-axi export` inlines LOCAL assets only, so a
// CDN-styled export still needs network (and jsdelivr specifically is unreliable here).
// But throwing out the CDN also threw out the component vocabulary, which is the actually
// useful half. This gets it back: compile only the classes THIS artifact uses into a
// sibling .css file. Self-contained, no runtime compile, no CDN.
//
// Usage:  node <this> <artifact.html> [--minify]
// Output: <artifact-basename>.css next to the artifact, plus the <link> tag to paste.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "node_modules", ".bin", "tailwindcss");

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2).filter((a) => a !== "--minify");
const minify = process.argv.includes("--minify");
if (args.length !== 1) fail("usage: node build-css.mjs <artifact.html> [--minify]");

const artifact = resolve(args[0]);
if (!existsSync(artifact)) fail(`no such file: ${artifact}`);
if (!existsSync(CLI)) fail(`toolchain missing - run: npm install --prefix ${HERE}`);

const outDir = dirname(artifact);
const outName = `${basename(artifact).replace(/\.html?$/i, "")}.css`;
const outPath = join(outDir, outName);

// Tailwind v4 takes its content sources from CSS, not flags. `source(none)` turns off
// automatic directory scanning so a stray file in /tmp can never widen the build, then a
// single explicit @source pins it to this one artifact.
//
// The generated input.css must live inside `local/`: Tailwind resolves `@import
// "tailwindcss"` and `@plugin "daisyui"` from the input file's own directory, so an
// input in the OS temp dir cannot see local/node_modules.
const work = mkdtempSync(join(HERE, ".build-"));
const input = join(work, "input.css");
writeFileSync(
  input,
  [
    '@import "tailwindcss" source(none);',
    `@source "${artifact.replace(/["\\]/g, "\\$&")}";`,
    "",
    "/* Light is the default theme here by house rule; dark ships but is opt-in via",
    '   data-theme="dark" rather than following the OS, so artifacts stay light unless asked. */',
    '@plugin "daisyui" {',
    "  themes: light --default, dark;",
    "}",
    "",
  ].join("\n"),
);

const run = spawnSync(CLI, ["-i", input, "-o", outPath, ...(minify ? ["--minify"] : [])], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
rmSync(work, { recursive: true, force: true });

if (run.status !== 0) {
  fail(`tailwind build failed\n${run.stderr || run.stdout || ""}`.trim());
}

// An empty-ish output means the scan matched nothing - almost always a wrong path or an
// artifact that has no utility classes yet. Say so instead of shipping a blank stylesheet.
const bytes = statSync(outPath).size;
const hasRules = /\{/.test(readFileSync(outPath, "utf8"));
if (!hasRules) {
  fail(`built ${outPath} but it contains no rules - does ${basename(artifact)} actually use Tailwind/DaisyUI classes?`);
}

console.log(
  [
    `built: ${outPath}  (${(bytes / 1024).toFixed(1)} KB${minify ? ", minified" : ""})`,
    "",
    "Paste into the artifact's <head> - relative path, never a leading slash:",
    `  <link rel="stylesheet" href="${outName}">`,
    "",
    "Keep the .css beside the .html: lavish serves siblings, and `lavish-axi export`",
    "inlines local assets into a single portable file.",
    "Re-run this after adding classes - the build only includes classes present at build time.",
  ].join("\n"),
);
