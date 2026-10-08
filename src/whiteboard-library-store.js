import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  LIBRARY_DIR_NAME,
  LIBRARY_FILE_EXTENSION,
  LIBRARY_FILE_MAX_BYTES,
  LIBRARY_MAX_ITEMS,
  LIBRARY_TOTAL_MAX_BYTES,
  libraryIdFromFileName,
  parseExcalidrawLibrary,
} from "./whiteboard-libraries.js";

// User-supplied libraries live next to state.json. Lavish only ever reads
// this directory; the user copies files in.
export function excalidrawLibrariesDir(stateRoot) {
  return path.join(stateRoot, LIBRARY_DIR_NAME);
}

async function listLibraryFiles(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return [];
    throw error;
  }
  const files = [];
  for (const name of names.sort()) {
    if (!name.toLowerCase().endsWith(LIBRARY_FILE_EXTENSION)) continue;
    const file = path.join(dir, name);
    try {
      const info = await stat(file);
      files.push({ name, file, size: info.size, mtimeMs: info.mtimeMs, isFile: info.isFile() });
    } catch (error) {
      files.push({ name, file, size: 0, mtimeMs: 0, error: error?.code || String(error) });
    }
  }
  return files;
}

/**
 * @param {string} dir
 * @returns {Promise<{ dir: string, libraries: { id: string, file: string, items: { ref: string, name: string, elements: any[] }[] }[], skipped: { file: string, reason: string }[] }>}
 */
export async function loadExcalidrawLibraries(dir) {
  const libraries = [];
  const skipped = [];
  const ids = new Set();
  let totalBytes = 0;
  let totalItems = 0;
  for (const { name, file, size, isFile, error } of await listLibraryFiles(dir)) {
    if (error) {
      skipped.push({ file, reason: `could not read the file (${error})` });
      continue;
    }
    if (!isFile) {
      skipped.push({ file, reason: "not a file" });
      continue;
    }
    const id = libraryIdFromFileName(name);
    if (!id) {
      skipped.push({ file, reason: "file name has no letters or digits to use as a library id" });
      continue;
    }
    if (ids.has(id)) {
      skipped.push({ file, reason: `another file already uses the library id "${id}"` });
      continue;
    }
    if (size > LIBRARY_FILE_MAX_BYTES) {
      skipped.push({ file, reason: `larger than ${LIBRARY_FILE_MAX_BYTES / 1024 / 1024} MB` });
      continue;
    }
    if (totalBytes + size > LIBRARY_TOTAL_MAX_BYTES) {
      skipped.push({ file, reason: `libraries together exceed ${LIBRARY_TOTAL_MAX_BYTES / 1024 / 1024} MB` });
      continue;
    }
    let library;
    try {
      library = parseExcalidrawLibrary(await readFile(file, "utf8"), { id });
    } catch (error) {
      skipped.push({ file, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (totalItems + library.items.length > LIBRARY_MAX_ITEMS) {
      skipped.push({ file, reason: `libraries together exceed ${LIBRARY_MAX_ITEMS} items` });
      continue;
    }
    ids.add(id);
    totalBytes += size;
    totalItems += library.items.length;
    libraries.push({ ...library, file });
  }
  return { dir, libraries, skipped };
}

/**
 * Re-parses only when a library file is added, removed, or rewritten. Each
 * snapshot carries a `version`, so callers can tell whether two requests saw
 * the same libraries.
 * @returns {(dir: string) => Promise<Awaited<ReturnType<typeof loadExcalidrawLibraries>> & { version: string }>}
 */
export function createExcalidrawLibraryCache() {
  let signature = "";
  /** @type {Promise<Awaited<ReturnType<typeof loadExcalidrawLibraries>> & { version: string }> | null} */
  let cached = null;
  return async (dir) => {
    const files = await listLibraryFiles(dir);
    const next = JSON.stringify([dir, files.map(({ name, size, mtimeMs }) => [name, size, mtimeMs])]);
    if (!cached || next !== signature) {
      signature = next;
      const version = createHash("sha256").update(next).digest("hex").slice(0, 16);
      cached = loadExcalidrawLibraries(dir).then((result) => ({ ...result, version }));
      cached.catch(() => {
        signature = "";
      });
    }
    return cached;
  };
}
