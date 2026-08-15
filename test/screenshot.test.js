import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { createScreenshotOutput } from "../src/cli.js";
import {
  captureFullPageScreenshot,
  chromeExecutableCandidates,
  findChromeExecutable,
  screenshotFileName,
  ScreenshotError,
} from "../src/screenshot.js";

const runBrowserE2e = process.env.LAVISH_AXI_BROWSER_E2E === "1";

test("screenshotFileName mirrors the export naming convention with a .screenshot.png suffix", () => {
  assert.equal(screenshotFileName("/tmp/report.html"), "report.screenshot.png");
  assert.equal(screenshotFileName("/tmp/report.htm"), "report.screenshot.png");
  assert.equal(screenshotFileName("/tmp/REPORT.HTML"), "REPORT.screenshot.png");
  assert.equal(screenshotFileName(""), "artifact.screenshot.png");
});

test("findChromeExecutable honors the explicit env override authoritatively", () => {
  const fileExists = (candidate) => candidate === "/opt/chrome/chrome";
  assert.equal(
    findChromeExecutable({ platform: "darwin", env: { LAVISH_AXI_CHROME_PATH: "/opt/chrome/chrome" }, fileExists }),
    "/opt/chrome/chrome",
  );
  // A set-but-missing override must NOT silently fall through to another browser.
  assert.equal(
    findChromeExecutable({ platform: "darwin", env: { LAVISH_AXI_CHROME_PATH: "/missing/chrome" }, fileExists }),
    null,
  );
});

test("findChromeExecutable walks absolute candidates on darwin", () => {
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const fileExists = (candidate) => candidate === chrome;
  assert.equal(findChromeExecutable({ platform: "darwin", env: {}, fileExists }), chrome);
  assert.equal(findChromeExecutable({ platform: "darwin", env: {}, fileExists: () => false }), null);
});

test("findChromeExecutable resolves relative candidates against PATH entries", () => {
  const fileExists = (candidate) => candidate === path.join("/usr", "bin", "chromium");
  const found = findChromeExecutable({
    platform: "linux",
    env: { PATH: ["/usr/bin", "/usr/local/bin"].join(path.delimiter) },
    fileExists,
  });
  assert.equal(found, path.join("/usr", "bin", "chromium"));
});

test("chromeExecutableCandidates covers the mainstream browsers per platform", () => {
  assert.ok(chromeExecutableCandidates("darwin", {}).some((candidate) => candidate.includes("Google Chrome.app")));
  assert.ok(chromeExecutableCandidates("linux", {}).includes("google-chrome"));
  assert.ok(chromeExecutableCandidates("linux", {}).includes("chromium"));
  assert.ok(
    chromeExecutableCandidates("win32", { PROGRAMFILES: "C:\\Program Files" }).some((candidate) =>
      candidate.endsWith("chrome.exe"),
    ),
  );
});

test("screenshot output reports the written PNG with its full-page dimensions", () => {
  const output = createScreenshotOutput({
    source: "/tmp/report.html",
    output: "/tmp/report.screenshot.png",
    bytes: 1234,
    width: 1280,
    height: 6400,
    viewportWidth: 1280,
  });
  assert.deepEqual(output.screenshot, {
    source: "/tmp/report.html",
    output: "/tmp/report.screenshot.png",
    bytes: 1234,
    width: 1280,
    height: 6400,
    viewport_width: 1280,
  });
  assert.match(output.next_step, /full-page PNG screenshot/);
  assert.match(output.next_step, /1280x6400/);
  assert.match(output.next_step, /no Lavish server/);
});

test("captureFullPageScreenshot reports a missing browser distinctly", async () => {
  await assert.rejects(
    () =>
      captureFullPageScreenshot("file:///tmp/none.html", {
        env: { LAVISH_AXI_CHROME_PATH: "", PATH: "" },
        platform: "linux",
        executable: "",
      }),
    (error) => {
      assert.ok(error instanceof ScreenshotError);
      assert.equal(error.code, "BROWSER_NOT_FOUND");
      return true;
    },
  );
});

/** @param {Buffer} png @returns {{ width: number, height: number }} dimensions from the IHDR header */
function pngDimensions(png) {
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "not a PNG file");
  assert.equal(png.subarray(12, 16).toString("ascii"), "IHDR");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

test(
  "full-page screenshot captures the entire scroll height of a tall artifact",
  { skip: !runBrowserE2e, timeout: 120_000 },
  async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "lavish-screenshot-test-"));
    try {
      const sections = Array.from(
        { length: 40 },
        (_, index) =>
          `<section style="height: 200px; background: ${index % 2 ? "#eef" : "#efe"}"><h2>Section ${index + 1}</h2></section>`,
      ).join("\n");
      const file = path.join(temp, "tall-report.html");
      await writeFile(
        file,
        `<!doctype html><html><head><meta charset="utf-8"><title>Tall report</title></head>` +
          `<body style="margin: 0"><h1>Long scroll report</h1>\n${sections}\n</body></html>`,
      );

      const viewportWidth = 1000;
      const { png, width, height } = await captureFullPageScreenshot(pathToFileURL(file).href, {
        width: viewportWidth,
      });
      const parsed = pngDimensions(png);
      assert.equal(parsed.width, width);
      assert.equal(parsed.height, height);
      assert.equal(width, viewportWidth);
      // 40 sections x 200px plus the heading - far taller than any default viewport, which is
      // the whole point of a long screenshot. Viewport-only captures would come back ~900px.
      assert.ok(height >= 8000, `expected a full-document height, got ${height}`);

      const out = path.join(temp, "out.png");
      await writeFile(out, png);
      const reread = pngDimensions(await readFile(out));
      assert.deepEqual(reread, { width, height });
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);

test(
  "full-page screenshot renders relative sibling assets from the artifact directory",
  { skip: !runBrowserE2e, timeout: 120_000 },
  async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "lavish-screenshot-assets-"));
    try {
      // 1x1 opaque red PNG.
      const redPixel = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      );
      await writeFile(path.join(temp, "pixel.png"), redPixel);
      const file = path.join(temp, "with-asset.html");
      await writeFile(
        file,
        `<!doctype html><html><body style="margin: 0">` +
          `<img src="pixel.png" style="display: block; width: 64px; height: 64px">` +
          `</body></html>`,
      );
      const { png, width } = await captureFullPageScreenshot(pathToFileURL(file).href, { width: 400 });
      const parsed = pngDimensions(png);
      assert.equal(parsed.width, width);
      assert.ok(parsed.height >= 64);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);
