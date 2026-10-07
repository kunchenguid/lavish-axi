import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createExcalidrawLibraryCache, loadExcalidrawLibraries } from "../src/whiteboard-library-store.js";
import { LIBRARY_FILE_MAX_BYTES } from "../src/whiteboard-libraries.js";

const library = (name) =>
  JSON.stringify({
    libraryItems: [{ name, elements: [{ id: name, type: "rectangle", x: 0, y: 0, width: 1, height: 1 }] }],
  });

test("loadExcalidrawLibraries returns nothing for a missing directory", async () => {
  const result = await loadExcalidrawLibraries(path.join(tmpdir(), "lavish-no-such-library-dir"));
  assert.deepEqual(result.libraries, []);
  assert.deepEqual(result.skipped, []);
});

test("loadExcalidrawLibraries skips colliding ids, oversized files, and bad JSON with reasons", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-libraries-"));
  try {
    await writeFile(path.join(dir, "AWS Icons.excalidrawlib"), library("Lambda"));
    await writeFile(path.join(dir, "aws_icons.excalidrawlib"), library("S3"));
    await writeFile(path.join(dir, "huge.excalidrawlib"), Buffer.alloc(LIBRARY_FILE_MAX_BYTES + 1, 32));
    await writeFile(path.join(dir, "broken.excalidrawlib"), "{");
    await writeFile(path.join(dir, "readme.md"), "not a library");
    const { libraries, skipped } = await loadExcalidrawLibraries(dir);
    assert.deepEqual(
      libraries.map((entry) => [entry.id, entry.items.map((item) => item.name)]),
      [["aws-icons", ["Lambda"]]],
    );
    assert.deepEqual(
      skipped.map((entry) => [path.basename(entry.file), entry.reason]),
      [
        ["aws_icons.excalidrawlib", 'another file already uses the library id "aws-icons"'],
        ["broken.excalidrawlib", "not valid JSON"],
        ["huge.excalidrawlib", "larger than 10 MB"],
      ],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the library cache re-reads only when the directory changes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-libraries-cache-"));
  try {
    const load = createExcalidrawLibraryCache();
    await writeFile(path.join(dir, "one.excalidrawlib"), library("A"));
    const first = await load(dir);
    assert.equal(await load(dir), first);
    await writeFile(path.join(dir, "two.excalidrawlib"), library("B"));
    const second = await load(dir);
    assert.notEqual(second, first);
    assert.deepEqual(
      second.libraries.map((entry) => entry.id),
      ["one", "two"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
