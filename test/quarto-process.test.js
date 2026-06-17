import assert from "node:assert/strict";
import test from "node:test";
import {
  detectQuarto,
  quartoOutputFile,
  renderQuarto,
  isQuartoShinyFile,
  launchQuartoShiny,
} from "../src/quarto-process.js";
import { mkdtemp, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { findFreePort } from "../src/shiny-process.js";

test("quartoOutputFile derives correct path", () => {
  assert.equal(quartoOutputFile("/foo/bar/doc.qmd"), "/foo/bar/doc.html");
  assert.equal(quartoOutputFile("doc.rmd"), "doc.html");
  assert.equal(quartoOutputFile("test.md"), "test.html");
});

test("isQuartoShinyFile detects shiny server configuration", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "lavish-quarto-shiny-test-"));
  const nonShinyFile = path.join(tempDir, "non-shiny.qmd");
  const shinyFile1 = path.join(tempDir, "shiny1.qmd");
  const shinyFile2 = path.join(tempDir, "shiny2.qmd");

  try {
    await writeFile(nonShinyFile, "---\ntitle: test\n---\n", "utf8");
    await writeFile(shinyFile1, "---\ntitle: test\nserver: shiny\n---\n", "utf8");
    await writeFile(shinyFile2, "---\ntitle: test\nserver:\n  type: shiny\n---\n", "utf8");

    assert.equal(await isQuartoShinyFile(nonShinyFile), false);
    assert.equal(await isQuartoShinyFile(shinyFile1), true);
    assert.equal(await isQuartoShinyFile(shinyFile2), true);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
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

test("launchQuartoShiny starts and stops successfully", async () => {
  const detect = await detectQuarto();
  if (!detect.ok) {
    return;
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), "lavish-quarto-shiny-run-"));
  const qmdFile = path.join(tempDir, "app.qmd");
  const qmdContent = `---
title: "Shiny App"
format: html
server: shiny
---

\`\`\`{r}
numericInput("n", "N", 10)
\`\`\`

\`\`\`{r}
#| context: server
\`\`\`
`;

  try {
    await writeFile(qmdFile, qmdContent, "utf8");
    const freePort = await findFreePort();
    const app = await launchQuartoShiny(qmdFile, { port: freePort });
    assert.ok(app.process);
    assert.equal(app.port, freePort);
    assert.match(app.url, new RegExp(`127.0.0.1:${freePort}`));

    app.kill();
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});
