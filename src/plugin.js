import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Canonical schema identifier for the Agent Plugins version this manifest targets.
// Clients select their local validation rules from this string; they never fetch it.
export const PLUGIN_SCHEMA_URL = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

// Not in package.json (npm infers no author), so the one authoritative copy lives here.
const PLUGIN_AUTHOR = Object.freeze({ name: "Kun Chen", url: "https://github.com/kunchenguid" });

/**
 * @typedef {object} AtomicFsOperations
 * @property {typeof writeFileSync} [writeFileSync]
 * @property {typeof renameSync} [renameSync]
 * @property {typeof rmSync} [rmSync]
 * @property {typeof symlinkSync} [symlinkSync]
 */

/**
 * @typedef {object} PluginManifest
 * @property {string} $schema canonical Agent Plugins schema identifier
 * @property {string} name plugin name
 * @property {string} [version] plugin version
 * @property {string} [description] short description
 * @property {{ name?: string, email?: string, url?: string }} [author] author object
 * @property {string} [homepage] documentation URL
 * @property {string} [repository] source repository URL
 * @property {string} [license] SPDX license identifier
 * @property {string[]} [keywords] discovery tags
 */

/**
 * Build the Agent Plugins manifest from package.json so the two can never disagree.
 * Field order matches the published schema's reading order.
 *
 * @param {Record<string, any>} packageJson parsed package.json
 * @returns {PluginManifest} plugin.json contents
 */
export function createPluginManifest(packageJson) {
  return {
    $schema: PLUGIN_SCHEMA_URL,
    name: packageJson.name,
    version: packageJson.version,
    description: packageJson.description,
    author: PLUGIN_AUTHOR,
    homepage: packageJson.homepage,
    // The schema wants a plain URL string; package.json carries npm's `git+….git` form.
    repository: normalizeRepositoryUrl(packageJson.repository),
    license: packageJson.license,
    keywords: packageJson.keywords,
  };
}

/**
 * @param {Record<string, any>} packageJson parsed package.json
 * @returns {string} formatted plugin.json, newline-terminated to match Prettier
 */
export function createPluginManifestJson(packageJson) {
  return `${JSON.stringify(createPluginManifest(packageJson), null, 2)}\n`;
}

/**
 * @param {{ url?: string } | string | undefined} repository package.json `repository`
 * @returns {string | undefined} plain https URL
 */
export function normalizeRepositoryUrl(repository) {
  const url = typeof repository === "string" ? repository : repository?.url;
  if (!url) return undefined;
  return url.replace(/^git\+/, "").replace(/\.git$/, "");
}

/**
 * Absolute path of the plugin root - the directory holding `plugin.json` and `skills/`.
 * `../` from this module is the package root when running the published bundle and the
 * repository root when running from source, so both resolve to a real plugin directory.
 *
 * @returns {string} absolute plugin root path
 */
export function resolvePluginRoot() {
  return path.resolve(fileURLToPath(new URL("../", import.meta.url)));
}

/**
 * Read a directory's plugin manifest, if it holds one.
 *
 * @param {string} root candidate plugin root
 * @returns {Record<string, any> | null} parsed manifest, or null when absent/unreadable
 */
export function readPluginManifest(root) {
  try {
    return JSON.parse(readFileSync(path.join(root, "plugin.json"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * True when `candidate` is a stale registration of this same plugin: a directory that
 * still declares our plugin name, or one that has vanished but sits where our package
 * lived. Path repair only ever drops entries we can positively attribute to ourselves,
 * so a user's unrelated plugin locations survive untouched.
 *
 * @param {string} candidate registered path
 * @param {string} pluginName manifest name to attribute
 * @returns {boolean} whether the entry is a stale copy of this plugin
 */
export function isStalePluginLocation(candidate, pluginName) {
  const manifest = readPluginManifest(candidate);
  if (manifest) return manifest.name === pluginName;
  return !existsSync(candidate) && path.basename(candidate) === pluginName;
}

/**
 * Compute the VS Code settings update that registers this plugin root, dropping stale
 * registrations of the same plugin left behind by a reinstall or relocation.
 *
 * @param {Record<string, any>} settings parsed VS Code user settings
 * @param {string} pluginRoot absolute plugin root
 * @param {string} pluginName manifest name
 * @returns {[Record<string, any>, boolean]} updated settings and whether anything changed
 */
export function computeVsCodePluginLocationsUpdate(settings, pluginRoot, pluginName) {
  const updated = structuredClone(settings && typeof settings === "object" ? settings : {});
  const existing = updated["chat.pluginLocations"];
  /** @type {Record<string, unknown>} */
  const locations = existing && typeof existing === "object" && !Array.isArray(existing) ? { ...existing } : {};
  let changed = false;

  for (const key of Object.keys(locations)) {
    if (key !== pluginRoot && isStalePluginLocation(key, pluginName)) {
      delete locations[key];
      changed = true;
    }
  }

  if (locations[pluginRoot] !== true) {
    locations[pluginRoot] = true;
    changed = true;
  }

  updated["chat.pluginLocations"] = locations;
  return [updated, changed];
}

/**
 * Per-platform VS Code user settings file.
 *
 * @param {NodeJS.ProcessEnv} [env] process environment
 * @param {string} [homeDir] home directory
 * @param {NodeJS.Platform} [platform] host platform
 * @returns {string} absolute settings.json path
 */
export function resolveVsCodeSettingsFile(env = process.env, homeDir = os.homedir(), platform = process.platform) {
  if (platform === "win32") {
    return path.join(env.APPDATA || path.join(homeDir, "AppData", "Roaming"), "Code", "User", "settings.json");
  }
  if (platform === "darwin") {
    return path.join(homeDir, "Library", "Application Support", "Code", "User", "settings.json");
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(homeDir, ".config"), "Code", "User", "settings.json");
}

/**
 * Directory Cursor loads unpacked local plugins from.
 *
 * @param {string} [homeDir] home directory
 * @returns {string} absolute local-plugins directory
 */
export function resolveCursorLocalPluginsDir(homeDir = os.homedir()) {
  return path.join(homeDir, ".cursor", "plugins", "local");
}

/**
 * @param {string} file target file
 * @param {string} content replacement contents
 * @param {AtomicFsOperations} [operations] filesystem operations
 */
export function writeTextFileAtomically(file, content, operations = {}) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const write = operations.writeFileSync || writeFileSync;
  const rename = operations.renameSync || renameSync;
  const remove = operations.rmSync || rmSync;
  try {
    write(temporary, content, "utf8");
    rename(temporary, file);
  } catch (error) {
    try {
      remove(temporary, { force: true });
    } catch {}
    throw error;
  }
}

/**
 * Point Cursor's local plugin slot at the installed package via symlink, which is what
 * Cursor's own docs recommend so an upgrade in place needs no re-registration.
 *
 * Never clobbers a real directory sitting in the slot - that is someone's own plugin.
 *
 * @param {string} localPluginsDir Cursor local plugins directory
 * @param {string} pluginRoot absolute plugin root
 * @param {string} pluginName manifest name
 * @param {AtomicFsOperations} [operations] filesystem operations
 * @returns {{ status: "linked" | "repaired" | "current" | "occupied", target: string }} outcome
 */
export function linkCursorLocalPlugin(localPluginsDir, pluginRoot, pluginName, operations = {}) {
  const target = path.join(localPluginsDir, pluginName);
  const createSymlink = operations.symlinkSync || symlinkSync;
  const rename = operations.renameSync || renameSync;
  const remove = operations.rmSync || rmSync;
  let existing = null;
  try {
    existing = lstatSync(target);
  } catch {
    // absent: fall through to a fresh link
  }

  if (existing && !existing.isSymbolicLink()) {
    return { status: "occupied", target };
  }
  if (existing) {
    if (path.resolve(readlinkSync(target)) === pluginRoot) return { status: "current", target };
    mkdirSync(localPluginsDir, { recursive: true });
    const replacement = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      createSymlink(pluginRoot, replacement);
      rename(replacement, target);
    } catch (error) {
      try {
        remove(replacement, { force: true });
      } catch {}
      throw error;
    }
    return { status: "repaired", target };
  }

  mkdirSync(localPluginsDir, { recursive: true });
  createSymlink(pluginRoot, target);
  return { status: "linked", target };
}
