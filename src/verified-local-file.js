import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";

function identity(stats) {
  return { dev: stats.dev, ino: stats.ino };
}

export function sameFileIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

export async function fileIdentityForPath(file, { openFile = open } = {}) {
  let handle;
  try {
    handle = await openFile(file, "r");
    const details = await handle.stat({ bigint: true });
    return details.isFile() ? identity(details) : null;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function openVerifiedLocalFile(
  file,
  { confineDir = null, forbiddenFileIdentities = [], openFile = open, realpathFile = realpath, statFile = stat } = {},
) {
  const handle = await openFile(file, "r");
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) {
      throw Object.assign(new Error(`refusing to read non-regular file ${file}`), { code: "OUTSIDE_ROOT" });
    }
    const canonical = await realpathFile(file);
    const current = await statFile(canonical, { bigint: true });
    if (!current.isFile() || !sameFileIdentity(identity(opened), identity(current))) {
      throw Object.assign(new Error(`refusing to read changed local file ${file}`), { code: "FILE_CHANGED" });
    }
    if (confineDir) {
      let root;
      try {
        root = await realpathFile(confineDir);
      } catch {
        root = path.resolve(confineDir);
      }
      const relative = path.relative(root, canonical);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw Object.assign(new Error(`refusing to read ${file} outside the artifact directory`), {
          code: "OUTSIDE_ROOT",
        });
      }
    }
    const openedIdentity = identity(opened);
    if (forbiddenFileIdentities.some((forbidden) => sameFileIdentity(openedIdentity, forbidden))) {
      throw Object.assign(new Error(`refusing to read protected local file ${file}`), { code: "OUTSIDE_ROOT" });
    }
    return { handle, file: canonical, stats: opened };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function readVerifiedLocalFile(file, options = {}) {
  // Metadata may reject an oversized asset even when its bytes are unreadable.
  // This preflight never authorizes a read: confinement, protected identity, and
  // the size checks still run on the handle whose bytes we actually consume.
  if (Number.isFinite(options.maxAssetBytes) || Number.isFinite(options.maxBundleRemaining)) {
    const preflight = await (options.statFile || stat)(file, { bigint: true });
    rejectOversizedFile(preflight.size, options);
  }
  const opened = await openVerifiedLocalFile(file, options);
  try {
    rejectOversizedFile(opened.stats.size, options);
    return await opened.handle.readFile();
  } finally {
    await opened.handle.close();
  }
}

function rejectOversizedFile(size, options) {
  if (Number.isFinite(options.maxAssetBytes) && size > BigInt(options.maxAssetBytes)) {
    throw Object.assign(new Error(`${size} bytes exceeds per-asset cap ${options.maxAssetBytes}`), {
      code: "TOO_LARGE",
    });
  }
  if (Number.isFinite(options.maxBundleRemaining) && size > BigInt(options.maxBundleRemaining)) {
    throw Object.assign(new Error(`would exceed per-bundle cap ${options.maxBundleBytes}`), { code: "TOO_LARGE" });
  }
}
