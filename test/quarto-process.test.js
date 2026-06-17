import assert from "node:assert/strict";
import test from "node:test";
import { detectQuarto, quartoOutputFile, renderQuarto } from "../src/quarto-process.js";
import { mkdtemp, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("quartoOutputFile derives correct path", () => {
  assert.equal(quartoOutputFile("/foo/bar/doc.qmd"), "/foo/bar/doc.html");
  assert.equal(quartoOutputFile("doc.rmd"), "doc.html");
  assert.equal(quartoOutputFile("test.md"), "test.html");
});

test("quarto rendering and detection", async () => {
  const detect = await detectQuarto();
  assert.equal(typeof detect.ok, "boolean");

  if (!detect.ok) {
    // If quarto is not installed, renderQuarto should fail gracefully.
    const render = await renderQuarto("nonexistent.qmd");
    assert.equal(render.ok, false);
    return;
  }

  // If quarto is installed, perform a real rendering test.
  const tempDir = await mkdtemp(path.join(tmpdir(), "lavish-quarto-test-"));
  const qmdFile = path.join(tempDir, "document.qmd");
  const qmdContent = `---
title: "Test Document"
format: html
---

# Hello Quarto

This is a test.
`;

  try {
    await writeFile(qmdFile, qmdContent, "utf8");
    const render = await renderQuarto(qmdFile);
    assert.equal(render.ok, true);
    assert.equal(render.outputFile, path.join(tempDir, "document.html"));

    // Verify output exists
    await assert.doesNotReject(access(render.outputFile));
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});
