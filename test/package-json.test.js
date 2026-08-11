import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function extractFrontmatter(markdown) {
  const end = markdown.indexOf("\n---\n", 4);

  assert.ok(markdown.startsWith("---\n"), "starts with frontmatter fence");
  assert.ok(end > 0, "frontmatter is closed");

  return markdown.slice(4, end);
}

function frontmatterHasInternalMetadata(frontmatter) {
  const lines = frontmatter.split("\n");
  const metadataIndex = lines.findIndex((line) => line === "metadata:");

  if (metadataIndex === -1) {
    return false;
  }

  for (const line of lines.slice(metadataIndex + 1)) {
    if (!line.startsWith(" ")) {
      return false;
    }

    if (line === "  internal: true") {
      return true;
    }
  }

  return false;
}

test("check script runs all verification commands", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const checkCommands = packageJson.scripts.check.split(" && ");

  assert.deepEqual(checkCommands, [
    "npm run build",
    "npm run lint",
    "npm run format:check",
    "npm run typecheck",
    "npm test",
    "node scripts/build-skill.js --check",
    "node scripts/build-plugin.js --check",
  ]);
});

test("installable skill stays in sync with the no-args home output", async () => {
  const { createSkillMarkdown } = await import("../src/skill.js");
  const committed = await readFile(new URL("../skills/lavish/SKILL.md", import.meta.url), "utf8");

  assert.equal(committed, createSkillMarkdown(), "run `npm run build:skill` and commit the result");
});

test("published package includes the installable skill", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.ok(packageJson.files.includes("skills/lavish"));
});

test("published package root is a complete Agent Plugin", async () => {
  // The tarball root doubles as the plugin root, so both the manifest and the skills it
  // discovers have to ship; without either, an installed copy is not installable as a plugin.
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.ok(packageJson.files.includes("plugin.json"));
  assert.ok(packageJson.files.includes("skills/lavish"));
});

test("release-please keeps the plugin manifest version in step with the package", async () => {
  const config = JSON.parse(await readFile(new URL("../release-please-config.json", import.meta.url), "utf8"));

  assert.deepEqual(config.packages["."]["extra-files"], [{ type: "json", path: "plugin.json", jsonpath: "$.version" }]);
});

test("lavish-design agent skill is marked internal for skills CLI discovery", async () => {
  const skillMd = await readFile(new URL("../.agents/skills/lavish-design/SKILL.md", import.meta.url), "utf8");
  const frontmatter = extractFrontmatter(skillMd);

  assert.match(frontmatter, /^name: lavish-design$/m);
  assert.equal(frontmatterHasInternalMetadata(frontmatter), true);
});

test("public lavish skill is not marked internal", async () => {
  const skillMd = await readFile(new URL("../skills/lavish/SKILL.md", import.meta.url), "utf8");
  const frontmatter = extractFrontmatter(skillMd);

  assert.equal(frontmatterHasInternalMetadata(frontmatter), false);
});

test("public skill internal guard scans the whole metadata block", () => {
  const frontmatter = ["name: lavish", "metadata:", "  hermes:", "    category: productivity", "  internal: true"].join(
    "\n",
  );

  assert.equal(frontmatterHasInternalMetadata(frontmatter), true);
});

test("build copies local design assets for published artifact injection", async () => {
  const buildScript = await readFile(new URL("../scripts/build.js", import.meta.url), "utf8");

  assert.match(buildScript, /daisyui\.css/);
  assert.match(buildScript, /daisyui-themes\.css/);
  assert.match(buildScript, /tailwindcss-browser\.js/);
});

test("package metadata matches the GitHub repository used for npm provenance", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.equal(packageJson.repository.url, "git+https://github.com/kunchenguid/lavish-axi.git");
  assert.equal(packageJson.bugs.url, "https://github.com/kunchenguid/lavish-axi/issues");
  assert.equal(packageJson.homepage, "https://github.com/kunchenguid/lavish-axi#readme");
});

test("pnpm lock root importer matches the publish manifest", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const pnpmLock = await readFile(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");

  for (const [name, specifier] of Object.entries(packageJson.dependencies)) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedSpecifier = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    assert.match(pnpmLock, new RegExp(`["']?${escapedName}["']?:[\\s\\S]*?specifier: ${escapedSpecifier}`));
  }
});

test("release workflow publishes from the release tag checkout", async () => {
  const workflow = await readFile(new URL("../.github/workflows/release-please.yml", import.meta.url), "utf8");

  assert.match(
    workflow,
    /uses: actions\/checkout@v6\n\s+if: \$\{\{ steps\.release\.outputs\.release_created \}\}\n\s+with:\n\s+ref: \$\{\{ steps\.release\.outputs\.tag_name \}\}/,
  );
});

test("release workflow keeps telemetry env during npm publish prepack", async () => {
  const workflow = await readFile(new URL("../.github/workflows/release-please.yml", import.meta.url), "utf8");

  assert.match(
    workflow,
    /run: npm publish --access public --provenance\n\s+if: \$\{\{ steps\.release\.outputs\.release_created \}\}\n\s+env:\n\s+LAVISH_AXI_UMAMI_HOST: https:\/\/a\.kunchenguid\.com\n\s+LAVISH_AXI_UMAMI_WEBSITE_ID: \$\{\{ vars\.LAVISH_AXI_UMAMI_WEBSITE_ID \}\}/,
  );
});
