import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PLUGIN_SCHEMA_URL,
  computeVsCodePluginLocationsUpdate,
  createPluginManifest,
  createPluginManifestJson,
  isStalePluginLocation,
  linkCursorLocalPlugin,
  normalizeRepositoryUrl,
  readPluginManifest,
  resolveCursorLocalPluginsDir,
  resolvePluginRoot,
  resolveVsCodeSettingsFile,
  writeTextFileAtomically,
} from "../src/plugin.js";
import { validateSkillMarkdown } from "../src/skill.js";

// Closed manifest schema from agent-plugins.org/schemas/1.0.0/plugin.schema.json.
const ALLOWED_MANIFEST_FIELDS = [
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions",
];
const MANIFEST_NAME_PATTERN = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lavish-plugin-"));
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writePlugin(root, name) {
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "plugin.json"), JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, name }));
  return root;
}

test("generated manifest satisfies the closed Agent Plugins 1.0.0 schema", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const manifest = createPluginManifest(packageJson);

  assert.equal(manifest.$schema, PLUGIN_SCHEMA_URL, "targets the canonical schema identifier");
  assert.match(manifest.name, MANIFEST_NAME_PATTERN);
  assert.ok(manifest.name.length >= 1 && manifest.name.length <= 64);

  for (const field of Object.keys(manifest)) {
    assert.ok(ALLOWED_MANIFEST_FIELDS.includes(field), `\`${field}\` is a permitted top-level field`);
  }
  // `author` is itself closed to name/email/url.
  for (const field of Object.keys(manifest.author)) {
    assert.ok(["name", "email", "url"].includes(field), `author.${field} is permitted`);
  }
  assert.ok(Array.isArray(manifest.keywords));
});

test("generated manifest tracks package.json rather than restating it", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const manifest = createPluginManifest(packageJson);

  assert.equal(manifest.name, packageJson.name);
  assert.equal(manifest.version, packageJson.version);
  assert.equal(manifest.description, packageJson.description);
  assert.equal(manifest.license, packageJson.license);
  assert.deepEqual(manifest.keywords, packageJson.keywords);
});

test("committed plugin.json stays in sync with package.json", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const committed = await readFile(new URL("../plugin.json", import.meta.url), "utf8");

  assert.equal(committed, createPluginManifestJson(packageJson), "run `npm run build:plugin` and commit the result");
});

test("normalizeRepositoryUrl converts npm git URLs to plain https", () => {
  assert.equal(
    normalizeRepositoryUrl({ url: "git+https://github.com/kunchenguid/lavish-axi.git" }),
    "https://github.com/kunchenguid/lavish-axi",
  );
  assert.equal(normalizeRepositoryUrl("https://example.com/x"), "https://example.com/x");
  assert.equal(normalizeRepositoryUrl(undefined), undefined);
});

test("the package root is itself a discoverable Agent Plugin", async () => {
  // This is the whole point of the adoption: no separate plugin artifact to publish.
  const root = resolvePluginRoot();
  const manifest = readPluginManifest(root);
  assert.ok(manifest, "plugin.json sits at the plugin root");

  // Spec section 7.1: each immediate child of skills/ holding a regular SKILL.md is one skill.
  const entries = await readdir(path.join(root, "skills"), { withFileTypes: true });
  const discovered = entries.filter(
    (entry) => entry.isDirectory() && existsSync(path.join(root, "skills", entry.name, "SKILL.md")),
  );
  assert.deepEqual(
    discovered.map((entry) => entry.name),
    ["lavish"],
    "exactly the lavish skill is discovered",
  );

  const skill = await readFile(path.join(root, "skills", "lavish", "SKILL.md"), "utf8");
  assert.deepEqual(validateSkillMarkdown(skill, { directoryName: "lavish" }).errors, []);
});

test("the plugin declares no MCP servers", async () => {
  // lavish-axi's agent surface is the CLI itself; an mcp.json would add a second contract.
  assert.equal(existsSync(path.join(resolvePluginRoot(), "mcp.json")), false);
});

test("VS Code registration adds the plugin root and is idempotent", () => {
  const [first, changedFirst] = computeVsCodePluginLocationsUpdate({}, "/pkg/lavish-axi", "lavish-axi");
  assert.equal(changedFirst, true);
  assert.deepEqual(first["chat.pluginLocations"], { "/pkg/lavish-axi": true });

  const [second, changedSecond] = computeVsCodePluginLocationsUpdate(first, "/pkg/lavish-axi", "lavish-axi");
  assert.equal(changedSecond, false, "re-running registers nothing new");
  assert.deepEqual(second, first);
});

test("VS Code registration preserves unrelated settings and other plugins", () => {
  const settings = {
    "editor.fontSize": 13,
    "chat.pluginLocations": { "/somewhere/other-plugin": true },
  };
  const [updated] = computeVsCodePluginLocationsUpdate(settings, "/pkg/lavish-axi", "lavish-axi");

  assert.equal(updated["editor.fontSize"], 13);
  assert.equal(updated["chat.pluginLocations"]["/somewhere/other-plugin"], true, "another plugin is untouched");
  assert.equal(updated["chat.pluginLocations"]["/pkg/lavish-axi"], true);
  assert.deepEqual(settings["chat.pluginLocations"], { "/somewhere/other-plugin": true }, "input is not mutated");
});

test("VS Code registration repairs a relocated install without dropping foreign entries", () => {
  const dir = tempDir();
  const stale = writePlugin(path.join(dir, "old", "lavish-axi"), "lavish-axi");
  const foreign = writePlugin(path.join(dir, "other-plugin"), "other-plugin");
  const current = writePlugin(path.join(dir, "new", "lavish-axi"), "lavish-axi");

  const settings = { "chat.pluginLocations": { [stale]: true, [foreign]: true } };
  const [updated, changed] = computeVsCodePluginLocationsUpdate(settings, current, "lavish-axi");

  assert.equal(changed, true);
  assert.equal(updated["chat.pluginLocations"][stale], undefined, "the previous lavish-axi location is dropped");
  assert.equal(updated["chat.pluginLocations"][foreign], true, "a different plugin survives");
  assert.equal(updated["chat.pluginLocations"][current], true);
});

test("a removed install directory is only treated as stale when it was ours", () => {
  const dir = tempDir();
  assert.equal(isStalePluginLocation(path.join(dir, "gone", "lavish-axi"), "lavish-axi"), true);
  assert.equal(isStalePluginLocation(path.join(dir, "gone", "someone-else"), "lavish-axi"), false);
});

test("Cursor registration links, no-ops, and repairs the local plugin slot", () => {
  const dir = tempDir();
  const localPlugins = path.join(dir, "local");
  const pluginRoot = writePlugin(path.join(dir, "pkg", "lavish-axi"), "lavish-axi");

  const linked = linkCursorLocalPlugin(localPlugins, pluginRoot, "lavish-axi");
  assert.equal(linked.status, "linked");
  assert.equal(path.resolve(readlinkSync(linked.target)), pluginRoot);

  assert.equal(linkCursorLocalPlugin(localPlugins, pluginRoot, "lavish-axi").status, "current");

  const moved = writePlugin(path.join(dir, "pkg2", "lavish-axi"), "lavish-axi");
  const repaired = linkCursorLocalPlugin(localPlugins, moved, "lavish-axi");
  assert.equal(repaired.status, "repaired");
  assert.equal(path.resolve(readlinkSync(repaired.target)), moved);
});

test("Cursor registration refuses to clobber a real directory in the slot", () => {
  const dir = tempDir();
  const localPlugins = path.join(dir, "local");
  const occupied = path.join(localPlugins, "lavish-axi");
  mkdirSync(occupied, { recursive: true });
  writeFileSync(path.join(occupied, "keep.txt"), "user content");

  const result = linkCursorLocalPlugin(localPlugins, path.join(dir, "pkg"), "lavish-axi");

  assert.equal(result.status, "occupied");
  assert.equal(lstatSync(occupied).isDirectory(), true);
  assert.equal(existsSync(path.join(occupied, "keep.txt")), true, "user content survives");
});

test("Cursor registration replaces a dangling symlink", () => {
  const dir = tempDir();
  const localPlugins = path.join(dir, "local");
  mkdirSync(localPlugins, { recursive: true });
  symlinkSync(path.join(dir, "vanished"), path.join(localPlugins, "lavish-axi"));
  const pluginRoot = writePlugin(path.join(dir, "pkg", "lavish-axi"), "lavish-axi");

  const result = linkCursorLocalPlugin(localPlugins, pluginRoot, "lavish-axi");

  assert.equal(result.status, "repaired");
  assert.equal(path.resolve(readlinkSync(result.target)), pluginRoot);
});

test("Cursor registration preserves the old link when replacement fails", async () => {
  const dir = tempDir();
  const localPlugins = path.join(dir, "local");
  const original = writePlugin(path.join(dir, "old", "lavish-axi"), "lavish-axi");
  const replacement = writePlugin(path.join(dir, "new", "lavish-axi"), "lavish-axi");
  mkdirSync(localPlugins, { recursive: true });
  const target = path.join(localPlugins, "lavish-axi");
  symlinkSync(original, target);

  assert.throws(() =>
    linkCursorLocalPlugin(localPlugins, replacement, "lavish-axi", {
      renameSync: () => {
        throw new Error("replacement failed");
      },
    }),
  );

  assert.equal(path.resolve(readlinkSync(target)), original);
  assert.deepEqual(await readdir(localPlugins), ["lavish-axi"]);
});

test("atomic text replacement preserves the original when swapping fails", async () => {
  const dir = tempDir();
  const target = path.join(dir, "settings.json");
  writeFileSync(target, "original");

  assert.throws(() =>
    writeTextFileAtomically(target, "replacement", {
      renameSync: () => {
        throw new Error("replacement failed");
      },
    }),
  );

  assert.equal(await readFile(target, "utf8"), "original");
  assert.deepEqual(await readdir(dir), ["settings.json"]);
});

test("atomic text replacement preserves restricted permissions", { skip: process.platform === "win32" }, () => {
  const dir = tempDir();
  const target = path.join(dir, "settings.json");
  writeFileSync(target, "original");
  chmodSync(target, 0o600);

  writeTextFileAtomically(target, "replacement");

  assert.equal(statSync(target).mode & 0o777, 0o600);
});

test("client config locations follow each platform's convention", () => {
  assert.equal(
    resolveVsCodeSettingsFile({}, "/home/kun", "darwin"),
    "/home/kun/Library/Application Support/Code/User/settings.json",
  );
  assert.equal(resolveVsCodeSettingsFile({}, "/home/kun", "linux"), "/home/kun/.config/Code/User/settings.json");
  assert.equal(
    resolveVsCodeSettingsFile({ XDG_CONFIG_HOME: "/xdg" }, "/home/kun", "linux"),
    "/xdg/Code/User/settings.json",
  );
  assert.equal(
    resolveVsCodeSettingsFile({ APPDATA: "C:\\Users\\kun\\AppData\\Roaming" }, "C:\\Users\\kun", "win32"),
    path.join("C:\\Users\\kun\\AppData\\Roaming", "Code", "User", "settings.json"),
  );
  assert.equal(resolveCursorLocalPluginsDir("/home/kun"), "/home/kun/.cursor/plugins/local");
});
