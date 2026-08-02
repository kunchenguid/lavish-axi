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
// Usage:  node <this> <artifact.html> [--minify] [--theme <daisyui-theme>]
// Output: <artifact-basename>.css next to the artifact, plus the <link> tag to paste.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DAISYUI_THEMES } from "../src/design-reference.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "node_modules", ".bin", "tailwindcss");
const USAGE = "usage: node build-css.mjs <artifact.html> [--minify] [--theme <daisyui-theme>]";

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

// A DaisyUI theme only exists in the output if the build was told to compile it, so the
// theme list `lavish-axi design` advertises is only honest with this flag in place.
const argv = process.argv.slice(2);
const minify = argv.includes("--minify");
const themeFlag = argv.indexOf("--theme");
let theme = null;
if (themeFlag !== -1) {
  theme = argv[themeFlag + 1];
  if (!theme || theme.startsWith("--")) fail(`--theme needs a theme name\n${USAGE}`);
  if (!DAISYUI_THEMES.includes(theme)) {
    fail(`unknown DaisyUI theme "${theme}" - pick one of: ${DAISYUI_THEMES.join(", ")}`);
  }
  argv.splice(themeFlag, 2);
}

const args = argv.filter((a) => a !== "--minify");
if (args.length !== 1) fail(USAGE);

const artifact = resolve(args[0]);
if (!existsSync(artifact)) fail(`no such file: ${artifact}`);
if (!existsSync(CLI)) fail(`toolchain missing - run: npm install --prefix ${HERE}`);

// light and dark always ship; --theme only changes which one is the default.
const themeList = theme
  ? [`${theme} --default`, ...["light", "dark"].filter((t) => t !== theme)]
  : ["light --default", "dark"];

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
    '   data-theme="dark" rather than following the OS, so artifacts stay light unless asked.',
    "   --theme <name> makes another DaisyUI theme the default; light and dark stay available. */",
    '@plugin "daisyui" {',
    `  themes: ${themeList.join(", ")};`,
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
