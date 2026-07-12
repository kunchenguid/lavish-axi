import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { sanitizeWhiteboardScene } from "./whiteboard-core.js";

// Sidecar persistence for whiteboard scenes, kept out of `state.json` on
// purpose: `SessionStore` rewrites the whole state file on every operation, so
// multi-hundred-KB Excalidraw scenes autosaving every second would turn each
// unrelated store write into a large rewrite. Scenes live as one JSON file per
// (session key, diagram index) under `<state-dir>/whiteboards/`, next to the
// published `.excalidraw`/`.png` feedback files the agent reads.

const KEY_RE = /^[0-9a-f]{16}$/;
const writeTails = new Map();
let temporaryFileId = 0;

export function isValidWhiteboardKey(key) {
  return KEY_RE.test(String(key || ""));
}

export function isValidDiagramIndex(index) {
  const number = Number(index);
  return Number.isInteger(number) && number >= 0 && number <= 999;
}

function assertValidRef(key, index) {
  if (!isValidWhiteboardKey(key)) throw new Error(`invalid whiteboard session key: ${key}`);
  if (!isValidDiagramIndex(index)) throw new Error(`invalid whiteboard diagram index: ${index}`);
}

export function whiteboardDir(stateDir, key) {
  return path.join(stateDir, "whiteboards", String(key));
}

function workingFile(stateDir, key, index) {
  return path.join(whiteboardDir(stateDir, key), `${Number(index)}.json`);
}

function writeQueueKey(stateDir, key, index) {
  return `${path.resolve(stateDir)}\u0000${key}\u0000${Number(index)}`;
}

function queueWhiteboardWrite(stateDir, key, index, operation) {
  const queueKey = writeQueueKey(stateDir, key, index);
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

export function whiteboardFeedbackPaths(stateDir, key, index) {
  assertValidRef(key, index);
  const dir = whiteboardDir(stateDir, key);
  return {
    scenePath: path.join(dir, `${Number(index)}.excalidraw`),
    previewPath: path.join(dir, `${Number(index)}.png`),
  };
}

// Working state: the editable scene, the conversion baseline used for edit
// summaries, and the hash of the Mermaid source the scene was converted from.
export async function saveWhiteboard(stateDir, key, index, { sourceHash, scene, baseline = null }) {
  assertValidRef(key, index);
  const record = {
    source_hash: String(sourceHash || ""),
    updated_at: new Date().toISOString(),
    scene: sanitizeWhiteboardScene(scene),
    baseline: baseline ?? null,
  };
  return queueWhiteboardWrite(stateDir, key, index, async () => {
    await mkdir(whiteboardDir(stateDir, key), { recursive: true });
    await writeFileAtomically(workingFile(stateDir, key, index), `${JSON.stringify(record)}\n`);
    return record;
  });
}

export async function loadWhiteboard(stateDir, key, index) {
  assertValidRef(key, index);
  try {
    const raw = await readFile(workingFile(stateDir, key, index), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return {
      source_hash: String(parsed.source_hash || ""),
      updated_at: String(parsed.updated_at || ""),
      scene: parsed.scene ?? null,
      baseline: parsed.baseline ?? null,
    };
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

// Publish the agent-facing feedback files: a standalone `.excalidraw` scene
// JSON and a PNG preview. Called at queue time so the paths embedded in the
// queued prompt always point at the exact reviewed state.
export async function writeWhiteboardFeedbackFiles(stateDir, key, index, { scene, pngDataUrl = "" }) {
  assertValidRef(key, index);
  const { scenePath, previewPath } = whiteboardFeedbackPaths(stateDir, key, index);
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
  return queueWhiteboardWrite(stateDir, key, index, async () => {
    await mkdir(whiteboardDir(stateDir, key), { recursive: true });
    await writeFileAtomically(scenePath, `${JSON.stringify(sceneJson, null, 2)}\n`);
    if (png) {
      await writeFileAtomically(previewPath, png);
      return { scenePath, previewPath };
    }
    return { scenePath, previewPath: "" };
  });
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
