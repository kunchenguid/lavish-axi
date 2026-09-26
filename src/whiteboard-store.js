import crypto from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { normalizePageIdentity } from "./artifact-page.js";
import { sanitizeWhiteboardScene } from "./whiteboard-core.js";

// Sidecar persistence for whiteboard scenes, kept out of `state.json` on
// purpose: `SessionStore` rewrites the whole state file on every operation, so
// multi-hundred-KB Excalidraw scenes autosaving every second would turn each
// unrelated store write into a large rewrite. Scenes live as one JSON file per
// (session key, page, diagram index) under `<state-dir>/whiteboards/`, next to
// the published `.excalidraw`/`.png` feedback files the agent reads.
//
// The direct files under `<state-dir>/whiteboards/<session-key>/` are the
// legacy entry namespace. They deliberately remain at their old paths: old
// queued prompts can still point at them, and moving them during migration
// would make those prompts unreadable. A page-aware sibling lives below a
// full SHA-256 digest of its canonical page instead. We never look in the
// legacy directory as a fallback for a sibling read.

const KEY_RE = /^[0-9a-f]{16}$/;
const INDEX_RE = /^\d{1,3}$/;

const writeTails = new Map();
let temporaryFileId = 0;

/**
 * A persistence error with a stable code for route callers. In particular,
 * page mismatches are not treated as a cache miss: a digest directory that
 * contains a record for another page is corrupt or tampered with and must be
 * rejected without leaking its contents.
 */
export class WhiteboardStoreError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "WhiteboardStoreError";
    this.code = code;
  }
}

export function isValidWhiteboardKey(key) {
  return typeof key === "string" && KEY_RE.test(key);
}

/**
 * Diagram indices are intentionally small because they become part of a
 * filesystem name and a tuple-scoped write key. Numeric strings are accepted
 * for compatibility with Express route parameters; whitespace, booleans,
 * null, decimals, signs and exponent notation are not.
 */
export function isValidDiagramIndex(index) {
  if (typeof index === "number") {
    return Number.isInteger(index) && index >= 0 && index <= 999;
  }
  if (typeof index !== "string" || !INDEX_RE.test(index)) return false;
  return Number(index) <= 999;
}

function normalizedDiagramIndex(index) {
  if (!isValidDiagramIndex(index)) {
    throw new WhiteboardStoreError("INVALID_INDEX", `invalid whiteboard diagram index: ${index}`);
  }
  return Number(index);
}

/**
 * Page identities are already canonicalized by the server's artifact
 * resolver. The store still validates their shape because it is also used by
 * delayed saves and feedback exports, after the live artifact may have gone
 * away. Do not normalize here: changing the spelling before hashing would let
 * two callers claim different identities for the same on-disk record.
 */
export function isValidWhiteboardPage(page) {
  return typeof page === "string" && normalizePageIdentity(page) === page;
}

function normalizedPage(page) {
  if (!isValidWhiteboardPage(page)) {
    throw new WhiteboardStoreError("INVALID_PAGE", `invalid whiteboard page: ${String(page)}`);
  }
  return page;
}

function assertValidRef(key, index) {
  if (!isValidWhiteboardKey(key)) {
    throw new WhiteboardStoreError("INVALID_SESSION_KEY", `invalid whiteboard session key: ${String(key)}`);
  }
  return normalizedDiagramIndex(index);
}

export function whiteboardDir(stateDir, key) {
  if (!isValidWhiteboardKey(key)) {
    throw new WhiteboardStoreError("INVALID_SESSION_KEY", `invalid whiteboard session key: ${String(key)}`);
  }
  return path.join(stateDir, "whiteboards", key);
}

/**
 * Return the full SHA-256 digest of the complete canonical page identity.
 * Hashing the complete value (rather than a prefix) keeps similarly named
 * pages in separate namespaces and makes the digest safe as a path segment.
 */
export function whiteboardPageDigest(page) {
  const canonicalPage = normalizedPage(page);
  return crypto.createHash("sha256").update(canonicalPage, "utf8").digest("hex");
}

/**
 * Directory for the page-aware sibling namespace. This function is deliberately
 * strict: callers must not pass an empty or path-like page and then rely on a
 * fallback to the entry namespace.
 */
export function whiteboardPageDir(stateDir, key, page) {
  const sessionDir = whiteboardDir(stateDir, key);
  return path.join(sessionDir, whiteboardPageDigest(page));
}

function workingFile(stateDir, key, index, page = undefined) {
  const normalizedIndex = assertValidRef(key, index);
  const directory =
    page === undefined || page === null ? whiteboardDir(stateDir, key) : whiteboardPageDir(stateDir, key, page);
  return path.join(directory, `${normalizedIndex}.json`);
}

function pagePaths(stateDir, key, index, page = undefined) {
  const normalizedIndex = assertValidRef(key, index);
  const directory =
    page === undefined || page === null ? whiteboardDir(stateDir, key) : whiteboardPageDir(stateDir, key, page);
  const canonicalPage = page === undefined || page === null ? undefined : normalizedPage(page);
  return {
    directory,
    workingPath: path.join(directory, `${normalizedIndex}.json`),
    scenePath: path.join(directory, `${normalizedIndex}.excalidraw`),
    previewPath: path.join(directory, `${normalizedIndex}.png`),
    index: normalizedIndex,
    page: canonicalPage,
    pageDigest: canonicalPage === undefined ? "" : whiteboardPageDigest(canonicalPage),
  };
}

function writeQueueKey(stateDir, key, index, page = undefined) {
  const pageKey = page === undefined || page === null ? "<entry>" : `page:${page}`;
  return `${path.resolve(stateDir)}\u0000${key}\u0000${pageKey}\u0000${Number(index)}`;
}

function queueWhiteboardWrite(stateDir, key, index, page, operation) {
  const queueKey = writeQueueKey(stateDir, key, index, page);
  const prior = writeTails.get(queueKey) || Promise.resolve();
  const result = prior.catch(() => {}).then(operation);
  const tail = result.catch(() => {});
  writeTails.set(queueKey, tail);
  tail.finally(() => {
    if (writeTails.get(queueKey) === tail) writeTails.delete(queueKey);
  });
  return result;
}

async function writeFileAtomically(file, content) {
  const temporary = `${file}.${process.pid}.${++temporaryFileId}.tmp`;
  try {
    await writeFile(temporary, content);
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function pageFromOptions(options) {
  if (typeof options === "string") return options;
  if (!options || typeof options !== "object") return undefined;
  if (!Object.hasOwn(options, "page")) return undefined;
  return options.page;
}

function recordPage(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return undefined;
  if (Object.hasOwn(record, "page")) return record.page;
  // Accept a hand-written early candidate record during the migration window,
  // but all writes below use the short `page` field as the canonical spelling.
  if (Object.hasOwn(record, "canonical_page")) return record.canonical_page;
  return undefined;
}

function assertStoredPage(record, expectedPage, file) {
  const stored = recordPage(record);
  if (expectedPage === undefined || expectedPage === null) {
    // A direct entry sidecar is allowed to be the old page-less shape. A
    // non-empty page claim in that location is never treated as entry data.
    if (stored !== undefined && stored !== null && stored !== "") {
      throw new WhiteboardStoreError(
        "PAGE_MISMATCH",
        `whiteboard record page mismatch for ${file}: expected entry namespace`,
      );
    }
    return;
  }
  const canonicalPage = normalizedPage(expectedPage);
  if (stored !== canonicalPage) {
    throw new WhiteboardStoreError(
      "PAGE_MISMATCH",
      `whiteboard record page mismatch for ${file}: expected ${canonicalPage}`,
    );
  }
}

function parseStoredRecord(raw, expectedPage, file) {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  assertStoredPage(parsed, expectedPage, file);
  const page = recordPage(parsed);
  const normalized = {
    source_hash: String(parsed.source_hash || ""),
    text_metrics_version: Math.max(0, Math.floor(Number(parsed.text_metrics_version) || 0)),
    updated_at: String(parsed.updated_at || ""),
    scene: parsed.scene ?? null,
    baseline: parsed.baseline ?? null,
  };
  // Keep the page on page-aware records so route callers can carry the
  // verified identity forward. Legacy entry callers retain their old shape.
  if (page !== undefined && page !== null && page !== "") normalized.page = page;
  return normalized;
}

async function loadWhiteboardAtPath(file, expectedPage) {
  try {
    const raw = await readFile(file, "utf8");
    return parseStoredRecord(raw, expectedPage, file);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function assertExistingRecordPage(file, expectedPage) {
  try {
    const raw = await readFile(file, "utf8");
    // Parse and validate before replacing a record. This prevents a manually
    // planted digest directory for another page from being silently clobbered.
    parseStoredRecord(raw, expectedPage, file);
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }
}

/**
 * Legacy entry feedback paths. With no fourth argument this retains the exact
 * pre-migration direct paths. An explicit `{ page }` (or page string) selects
 * the page-aware sibling namespace without changing the legacy call shape.
 */
export function whiteboardFeedbackPaths(stateDir, key, index, options = undefined) {
  const page = pageFromOptions(options);
  const paths = pagePaths(stateDir, key, index, page);
  return { scenePath: paths.scenePath, previewPath: paths.previewPath };
}

/** Explicit page-aware feedback paths. */
export function whiteboardFeedbackPathsForPage(stateDir, key, page, index) {
  const paths = pagePaths(stateDir, key, index, normalizedPage(page));
  return { scenePath: paths.scenePath, previewPath: paths.previewPath };
}

/**
 * Working state: the editable scene, the conversion baseline used for edit
 * summaries, and the hash of the Mermaid source the scene was converted from.
 * `options.page` is optional for legacy entry callers; page-aware callers can
 * use `saveWhiteboardForPage` below.
 *
 * @param {string} stateDir
 * @param {string} key
 * @param {number|string} index
 * @param {Record<string, any>} [options]
 */
export async function saveWhiteboard(stateDir, key, index, options = {}) {
  const { sourceHash, textMetricsVersion = 0, scene, baseline = null, page = undefined } = options;
  const normalizedIndex = assertValidRef(key, index);
  const canonicalPage = page === undefined || page === null ? undefined : normalizedPage(page);
  const record = {
    source_hash: String(sourceHash || ""),
    text_metrics_version: Math.max(0, Math.floor(Number(textMetricsVersion) || 0)),
    updated_at: new Date().toISOString(),
    scene: sanitizeWhiteboardScene(scene),
    baseline: baseline ?? null,
  };
  if (canonicalPage !== undefined) record.page = canonicalPage;
  const file = workingFile(stateDir, key, normalizedIndex, canonicalPage);
  const directory = path.dirname(file);
  return queueWhiteboardWrite(stateDir, key, normalizedIndex, canonicalPage, async () => {
    await mkdir(directory, { recursive: true });
    await assertExistingRecordPage(file, canonicalPage);
    await writeFileAtomically(file, `${JSON.stringify(record)}\n`);
    return record;
  });
}

/** Save working state under a canonical sibling page. */
export async function saveWhiteboardForPage(stateDir, key, page, index, options = {}) {
  const canonicalPage = normalizedPage(page);
  return saveWhiteboard(stateDir, key, index, { ...options, page: canonicalPage });
}

/**
 * Legacy entry read. A page-aware call must use `loadWhiteboardForPage`; an
 * entry read never searches digest directories and a sibling read never
 * searches this direct namespace.
 */
export async function loadWhiteboard(stateDir, key, index, options = undefined) {
  const page = pageFromOptions(options);
  const normalizedIndex = assertValidRef(key, index);
  const canonicalPage = page === undefined || page === null ? undefined : normalizedPage(page);
  return loadWhiteboardAtPath(workingFile(stateDir, key, normalizedIndex, canonicalPage), canonicalPage);
}

/** Load working state from one explicit canonical sibling page. */
export async function loadWhiteboardForPage(stateDir, key, page, index) {
  const canonicalPage = normalizedPage(page);
  const normalizedIndex = assertValidRef(key, index);
  return loadWhiteboardAtPath(workingFile(stateDir, key, normalizedIndex, canonicalPage), canonicalPage);
}

// Publish the agent-facing feedback files: a standalone `.excalidraw` scene
// JSON and a PNG preview. Called at queue time so the paths embedded in the
// queued prompt always point at the exact reviewed state.
/**
 * @param {string} stateDir
 * @param {string} key
 * @param {number|string} index
 * @param {Record<string, any>} [options]
 */
export async function writeWhiteboardFeedbackFiles(stateDir, key, index, options = {}) {
  const { scene, pngDataUrl = "", page = undefined } = options;
  const normalizedIndex = assertValidRef(key, index);
  const canonicalPage = page === undefined || page === null ? undefined : normalizedPage(page);
  const paths = pagePaths(stateDir, key, normalizedIndex, canonicalPage);
  const sanitizedScene = sanitizeWhiteboardScene(scene);
  const sceneJson = {
    type: "excalidraw",
    version: 2,
    source: "lavish-axi",
    elements: Array.isArray(sanitizedScene?.elements) ? sanitizedScene.elements : [],
    appState: sanitizedScene?.appState || {},
    files: sanitizedScene?.files && typeof sanitizedScene.files === "object" ? sanitizedScene.files : {},
  };
  const png = decodePngDataUrl(pngDataUrl);
  return queueWhiteboardWrite(stateDir, key, normalizedIndex, canonicalPage, async () => {
    await mkdir(paths.directory, { recursive: true });
    // The working record is the canonical-page verification record. If it
    // already exists, do not allow a feedback write to proceed through a
    // manually corrupted namespace. Legacy entry files remain page-less.
    await assertExistingRecordPage(paths.workingPath, canonicalPage);
    await writeFileAtomically(paths.scenePath, `${JSON.stringify(sceneJson, null, 2)}\n`);
    if (png) {
      await writeFileAtomically(paths.previewPath, png);
      return { scenePath: paths.scenePath, previewPath: paths.previewPath };
    }
    return { scenePath: paths.scenePath, previewPath: "" };
  });
}

/** Publish feedback files under one explicit canonical sibling page. */
export async function writeWhiteboardFeedbackFilesForPage(stateDir, key, page, index, options = {}) {
  const canonicalPage = normalizedPage(page);
  return writeWhiteboardFeedbackFiles(stateDir, key, index, { ...options, page: canonicalPage });
}

export function decodePngDataUrl(dataUrl) {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!match) return null;
  try {
    return Buffer.from(match[1], "base64");
  } catch {
    return null;
  }
}
