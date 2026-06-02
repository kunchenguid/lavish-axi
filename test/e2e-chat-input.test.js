import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";

import { serve } from "../src/server.js";

const ARTIFACT_HTML = "<!doctype html><html><body><h1>Test</h1></body></html>";

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-e2e-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, ARTIFACT_HTML);
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  const res = await fetch(`http://127.0.0.1:${server.port}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file: artifact }),
  });
  const { url } = await res.json();
  return { dir, server, url };
}

async function teardown(server, dir) {
  await server.close();
  await rm(dir, { recursive: true, force: true });
}

test("Enter key in chat input sends the message", async () => {
  const { dir, server, url } = await setup();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(url);
    await page.waitForSelector("#chatInput");

    await page.fill("#chatInput", "hello from Enter key");
    await page.press("#chatInput", "Enter");

    await page.waitForSelector(".bubble.user");
    const bubbleText = await page.textContent(".bubble.user div");
    assert.equal(bubbleText, "hello from Enter key");

    const inputValue = await page.inputValue("#chatInput");
    assert.equal(inputValue, "", "input should be cleared after sending");
  } finally {
    await browser.close();
    await teardown(server, dir);
  }
});

test("Enter key in annotation card queues the annotation without Shift", async () => {
  const { dir, server, url } = await setup();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(url);

    // Click the h1 inside the artifact iframe to open the annotation card
    const artifactFrame = page.frameLocator("#artifact");
    await artifactFrame.locator("h1").click();

    // Annotation card appears inside the iframe's shadow DOM
    const annotationTextarea = artifactFrame.getByPlaceholder("Tell the agent what to change about this element...");
    await annotationTextarea.waitFor();
    await annotationTextarea.fill("make the heading bigger");
    await annotationTextarea.press("Enter");

    // Card should close and a pill should appear in the chrome
    await page.waitForSelector(".annotation-pills .pill");
    const pillText = await page.textContent(".annotation-pills .pill span");
    assert.ok(pillText?.includes("make the heading bigger"));
  } finally {
    await browser.close();
    await teardown(server, dir);
  }
});

test("Shift+Enter inserts a newline instead of sending", async () => {
  const { dir, server, url } = await setup();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(url);
    await page.waitForSelector("#chatInput");

    await page.fill("#chatInput", "line one");
    await page.press("#chatInput", "Shift+Enter");
    await page.type("#chatInput", "line two");

    const inputValue = await page.inputValue("#chatInput");
    assert.equal(inputValue, "line one\nline two", "Shift+Enter should insert a newline");

    const bubbles = await page.$$(".bubble.user");
    assert.equal(bubbles.length, 0, "no message should have been sent");
  } finally {
    await browser.close();
    await teardown(server, dir);
  }
});
