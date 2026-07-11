import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  decodePngDataUrl,
  isValidDiagramIndex,
  isValidWhiteboardKey,
  loadWhiteboard,
  saveWhiteboard,
  whiteboardFeedbackPaths,
  writeWhiteboardFeedbackFiles,
} from "../src/whiteboard-store.js";

const KEY = "0123456789abcdef";
// A 1x1 transparent PNG.
const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function withTempDir(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-whiteboard-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("saveWhiteboard/loadWhiteboard strips persisted theme and canvas background", async () => {
  await withTempDir(async (dir) => {
    const scene = {
      elements: [{ id: "A", type: "rectangle" }],
      appState: { theme: "dark", viewBackgroundColor: "#121212", scrollX: 12 },
      files: {},
    };
    const baseline = { elements: [{ id: "A", type: "rectangle" }] };
    await saveWhiteboard(dir, KEY, 0, { sourceHash: "hash-1", scene, baseline });
    const loaded = await loadWhiteboard(dir, KEY, 0);
    assert.equal(loaded.source_hash, "hash-1");
    assert.deepEqual(loaded.scene, {
      ...scene,
      appState: { scrollX: 12 },
    });
    assert.deepEqual(loaded.baseline, baseline);
    assert.ok(loaded.updated_at);
  });
});

test("loadWhiteboard returns null when nothing was saved", async () => {
  await withTempDir(async (dir) => {
    assert.equal(await loadWhiteboard(dir, KEY, 3), null);
  });
});

test("saveWhiteboard overwrites prior state for the same diagram", async () => {
  await withTempDir(async (dir) => {
    await saveWhiteboard(dir, KEY, 1, { sourceHash: "h1", scene: { elements: [] }, baseline: null });
    await saveWhiteboard(dir, KEY, 1, { sourceHash: "h2", scene: { elements: [{ id: "B" }] }, baseline: null });
    const loaded = await loadWhiteboard(dir, KEY, 1);
    assert.equal(loaded.source_hash, "h2");
    assert.equal(loaded.scene.elements.length, 1);
  });
});

test("concurrent saves preserve the most recent scene", async () => {
  await withTempDir(async (dir) => {
    const slowScene = { elements: [{ id: "old", text: "x".repeat(8 * 1024 * 1024) }] };
    const latestScene = { elements: [{ id: "latest" }] };
    await Promise.all([
      saveWhiteboard(dir, KEY, 5, { sourceHash: "old", scene: slowScene, baseline: null }),
      saveWhiteboard(dir, KEY, 5, { sourceHash: "latest", scene: latestScene, baseline: null }),
    ]);
    const loaded = await loadWhiteboard(dir, KEY, 5);
    assert.equal(loaded.source_hash, "latest");
    assert.deepEqual(loaded.scene, latestScene);
  });
});

test("store rejects invalid keys and indexes (path traversal guard)", async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(() => saveWhiteboard(dir, "../../etc", 0, { sourceHash: "", scene: null }), /invalid/);
    await assert.rejects(() => saveWhiteboard(dir, KEY, "../7", { sourceHash: "", scene: null }), /invalid/);
    await assert.rejects(() => loadWhiteboard(dir, "ZZZZ", 0), /invalid/);
    await assert.rejects(() => writeWhiteboardFeedbackFiles(dir, KEY, -1, { scene: null }), /invalid/);
  });
});

test("isValidWhiteboardKey / isValidDiagramIndex validate shapes", () => {
  assert.equal(isValidWhiteboardKey(KEY), true);
  assert.equal(isValidWhiteboardKey("0123"), false);
  assert.equal(isValidWhiteboardKey("0123456789ABCDEF"), false);
  assert.equal(isValidDiagramIndex(0), true);
  assert.equal(isValidDiagramIndex("12"), true);
  assert.equal(isValidDiagramIndex(1000), false);
  assert.equal(isValidDiagramIndex(-1), false);
  assert.equal(isValidDiagramIndex(1.5), false);
});

test("writeWhiteboardFeedbackFiles writes a standalone .excalidraw and a PNG", async () => {
  await withTempDir(async (dir) => {
    const { scenePath, previewPath } = await writeWhiteboardFeedbackFiles(dir, KEY, 2, {
      scene: { elements: [{ id: "A", type: "rectangle" }], appState: { theme: "light" }, files: {} },
      pngDataUrl: PNG_DATA_URL,
    });
    assert.deepEqual({ scenePath, previewPath }, whiteboardFeedbackPaths(dir, KEY, 2));
    const scene = JSON.parse(await readFile(scenePath, "utf8"));
    assert.equal(scene.type, "excalidraw");
    assert.equal(scene.version, 2);
    assert.equal(scene.source, "lavish-axi");
    assert.equal(scene.elements[0].id, "A");
    assert.deepEqual(scene.appState, {});
    const png = await readFile(previewPath);
    assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  });
});

test("writeWhiteboardFeedbackFiles tolerates a missing or invalid preview", async () => {
  await withTempDir(async (dir) => {
    const { scenePath, previewPath } = await writeWhiteboardFeedbackFiles(dir, KEY, 4, {
      scene: { elements: [] },
      pngDataUrl: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
    });
    assert.ok(scenePath.endsWith("4.excalidraw"));
    assert.equal(previewPath, "");
  });
});

test("decodePngDataUrl only accepts base64 PNG data URLs", () => {
  assert.ok(decodePngDataUrl(PNG_DATA_URL) instanceof Buffer);
  assert.equal(decodePngDataUrl("data:image/jpeg;base64,abcd"), null);
  assert.equal(decodePngDataUrl("not-a-data-url"), null);
  assert.equal(decodePngDataUrl(null), null);
});
