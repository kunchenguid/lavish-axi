import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("check script runs all verification commands", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const checkCommands = packageJson.scripts.check.split(" && ");

  assert.deepEqual(checkCommands, [
    "npm run build",
    "npm run lint",
    "npm run format:check",
    "npm run typecheck",
    "npm test",
  ]);
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

test("package lock root bin matches the publish manifest", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const packageLock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));

  assert.deepEqual(packageLock.packages[""].bin, packageJson.bin);
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
