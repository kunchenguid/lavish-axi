import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const crossSpawn = createRequire(import.meta.url)("cross-spawn");

// Canonical schema identifier for the Agent Plugins version this manifest targets.
// Clients select their local validation rules from this string; they never fetch it.
export const PLUGIN_SCHEMA_URL = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

// Not in package.json (npm infers no author), so the one authoritative copy lives here.
const PLUGIN_AUTHOR = Object.freeze({ name: "Kun Chen", url: "https://github.com/kunchenguid" });

export function spawnPluginClientSync(command, args) {
  return crossSpawn.sync(command, args, { encoding: "utf8" });
}

/**
 * @typedef {object} AtomicFsOperations
 * @property {typeof chmodSync} [chmodSync]
 * @property {typeof writeFileSync} [writeFileSync]
 * @property {typeof renameSync} [renameSync]
 * @property {typeof rmSync} [rmSync]
 * @property {typeof statSync} [statSync]
 * @property {typeof symlinkSync} [symlinkSync]
 * @property {NodeJS.Platform} [platform]
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
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  if (platform === "win32") {
    return platformPath.join(
      env.APPDATA || platformPath.join(homeDir, "AppData", "Roaming"),
      "Code",
      "User",
      "settings.json",
    );
  }
  if (platform === "darwin") {
    return platformPath.join(homeDir, "Library", "Application Support", "Code", "User", "settings.json");
  }
  return platformPath.join(
    env.XDG_CONFIG_HOME || platformPath.join(homeDir, ".config"),
    "Code",
    "User",
    "settings.json",
  );
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
  const chmod = operations.chmodSync || chmodSync;
  const stat = operations.statSync || statSync;
  let mode;
  try {
    mode = stat(file).mode & 0o777;
  } catch {
    // A new file has no mode to preserve.
  }
  try {
    write(temporary, content, mode === undefined ? "utf8" : { encoding: "utf8", mode });
    if (mode !== undefined) chmod(temporary, mode);
    rename(temporary, file);
  } catch (error) {
    try {
      remove(temporary, { force: true });
    } catch {
      // Preserve the original replacement error.
    }
    throw error;
  }
}

/**
 * Create a directory link, preferring a junction on Windows.
 *
 * A Windows *directory symlink* needs SeCreateSymbolicLinkPrivilege - Developer Mode or
 * an elevated shell - which an ordinary account does not have, so plain `symlinkSync`
 * fails with EPERM there. A junction points at a local directory with no extra rights,
 * so Cursor registration keeps working on a normal Windows install. Everywhere else the
 * default symlink is correct.
 *
 * @param {(target: string, linkPath: string, type?: string) => void} createSymlink link creator
 * @param {string} pluginRoot absolute plugin root the link points at
 * @param {string} linkPath absolute path of the link to create
 * @param {NodeJS.Platform} platform host platform
 */
function createDirectoryLink(createSymlink, pluginRoot, linkPath, platform) {
  if (platform === "win32") {
    try {
      createSymlink(pluginRoot, linkPath, "junction");
      return;
    } catch {
      // Fall through: a junction can fail across volumes, where a symlink may still work.
    }
  }
  createSymlink(pluginRoot, linkPath);
}

/**
 * Point Cursor's local plugin slot at the installed package via a directory link, so an
 * upgrade in place needs no re-registration.
 *
 * Never clobbers a real directory sitting in the slot. Link failures are returned as an
 * unsupported outcome so one client cannot abort registration of the others.
 *
 * @param {string} localPluginsDir Cursor local plugins directory
 * @param {string} pluginRoot absolute plugin root
 * @param {string} pluginName manifest name
 * @param {AtomicFsOperations} [operations] filesystem operations
 * @returns {{ status: "linked" | "repaired" | "current" | "occupied" | "unsupported", target: string, reason?: string }} outcome
 */
export function linkCursorLocalPlugin(localPluginsDir, pluginRoot, pluginName, operations = {}) {
  const target = path.join(localPluginsDir, pluginName);
  const platform = operations.platform || process.platform;
  const createSymlink = (linkTarget, linkPath) =>
    createDirectoryLink(operations.symlinkSync || symlinkSync, linkTarget, linkPath, platform);
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
    const previous = `${target}.${process.pid}.${randomUUID()}.old`;
    let movedPrevious = false;
    try {
      createSymlink(pluginRoot, replacement);
      if (platform === "win32") {
        // Windows cannot rename over an existing directory symlink. Move the old link
        // aside first and restore it if installing the replacement does not complete.
        rename(target, previous);
        movedPrevious = true;
      }
      rename(replacement, target);
      if (movedPrevious) remove(previous, { force: true });
    } catch (error) {
      try {
        remove(replacement, { force: true });
        if (movedPrevious) rename(previous, target);
      } catch {
        // Preserve the original replacement error.
      }
      // The existing registration is intact after rollback; report rather than throw so
      // one unlinkable client never aborts registration of the others.
      return { status: "unsupported", target, reason: linkFailureReason(error) };
    }
    return { status: "repaired", target };
  }

  mkdirSync(localPluginsDir, { recursive: true });
  try {
    createSymlink(pluginRoot, target);
  } catch (error) {
    return { status: "unsupported", target, reason: linkFailureReason(error) };
  }
  return { status: "linked", target };
}

/** @param {unknown} error thrown link-creation error @returns {string} short reason */
function linkFailureReason(error) {
  const message = String(error instanceof Error ? error.message : error).split("\n")[0];
  return message || "link creation failed";
}
