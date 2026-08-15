import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { AxiError } from "axi-sdk-js";

import { assertScreenshotOutputTarget, createScreenshotOutput } from "../src/cli.js";
import {
  captureFullPageScreenshot,
  CdpConnection,
  chromeExecutableCandidates,
  findChromeExecutable,
  renderSettleExpression,
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

// --- Regression tests for the capture deadline, async-render settle, and --out overwrite guard ---

/**
 * A fake Chrome child process whose stderr can be driven by the test.
 * @returns {import("node:child_process").ChildProcess & { killedWith?: string }}
 */
function fakeChromeChild() {
  /** @type {any} */
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = (/** @type {string} */ signal) => {
    child.killed = true;
    child.killedWith = signal;
    return true;
  };
  return child;
}

/** @param {import("node:child_process").ChildProcess} child @returns {typeof import("node:child_process").spawn} */
function spawnReturning(child) {
  return /** @type {any} */ (() => child);
}

test("capture deadline settles a Chrome that never publishes its DevTools URL", { timeout: 15_000 }, async () => {
  const child = fakeChromeChild();
  // The stall: stderr stays silent and the process never exits. Before the fix the launch wait
  // had no connection to the deadline, so this hung forever and leaked the browser + profile.
  // A real Chrome keeps the event loop alive (pipes, socket); the fake needs a stand-in so the
  // unref'd deadline timer can fire.
  const keepAlive = setInterval(() => {}, 25);
  const spawnImpl = spawnReturning(child);
  try {
    await assert.rejects(
      () =>
        captureFullPageScreenshot("file:///tmp/artifact.html", {
          executable: "/fake/chrome",
          timeoutMs: 200,
          spawnImpl,
        }),
      (error) => {
        assert.ok(error instanceof ScreenshotError);
        assert.equal(error.code, "TIMEOUT");
        assert.match(error.message, /timed out after 200ms/);
        return true;
      },
    );
  } finally {
    clearInterval(keepAlive);
  }
  assert.equal(child.killed, true, "the stalled browser must be killed");
  assert.equal(child.killedWith, "SIGKILL");
});

/** A fake DevTools socket that opens and answers every command, but never emits events. */
class QuietDevToolsSocket {
  constructor() {
    this.handlers = new Map();
    queueMicrotask(() => this.emit("open", {}));
  }

  addEventListener(type, handler) {
    const list = this.handlers.get(type) || [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  emit(type, event) {
    for (const handler of this.handlers.get(type) || []) handler(event);
  }

  send(frame) {
    const message = JSON.parse(frame);
    const result =
      message.method === "Target.createTarget"
        ? { targetId: "target-1" }
        : message.method === "Target.attachToTarget"
          ? { sessionId: "session-1" }
          : {};
    queueMicrotask(() => this.emit("message", { data: JSON.stringify({ id: message.id, result }) }));
  }

  close() {}
}

test("capture deadline settles a navigation that never fires Page.loadEventFired", { timeout: 15_000 }, async () => {
  const child = fakeChromeChild();
  const keepAlive = setInterval(() => {}, 25);
  const spawnImpl = /** @type {typeof import("node:child_process").spawn} */ (
    /** @type {any} */ (
      () => {
        queueMicrotask(() => child.stderr.emit("data", "DevTools listening on ws://127.0.0.1:1/devtools/browser/fake"));
        return child;
      }
    )
  );
  // The load event never arrives; before the fix the event waiter was not reachable by the
  // deadline (failAll only rejected pending commands), so the command hung.
  try {
    await assert.rejects(
      () =>
        captureFullPageScreenshot("file:///tmp/artifact.html", {
          executable: "/fake/chrome",
          timeoutMs: 300,
          spawnImpl,
          webSocketImpl: /** @type {typeof WebSocket} */ (/** @type {any} */ (QuietDevToolsSocket)),
        }),
      (error) => error instanceof ScreenshotError && error.code === "TIMEOUT",
    );
  } finally {
    clearInterval(keepAlive);
  }
  assert.equal(child.killed, true, "the browser must be killed when the capture times out");
});

test("CdpConnection.failAll settles pending commands, event waiters, and the open handshake", async () => {
  class SilentSocket {
    addEventListener() {}
    send() {}
    close() {}
  }
  const connection = new CdpConnection(
    "ws://unused",
    /** @type {typeof WebSocket} */ (/** @type {any} */ (SilentSocket)),
  );
  const command = connection.send("Page.navigate", { url: "file:///x.html" });
  const waiter = connection.waitForEvent("Page.loadEventFired", "session-1");
  const error = new ScreenshotError("capture deadline", "TIMEOUT");
  connection.failAll(error);
  await assert.rejects(command, /capture deadline/);
  await assert.rejects(waiter, /capture deadline/);
  await assert.rejects(connection.opened, /capture deadline/);
  // A settled connection keeps working structurally: no waiters leak into the next event.
  connection.handleMessage(JSON.stringify({ method: "Page.loadEventFired", sessionId: "session-1" }));
});

test("renderSettleExpression waits for mermaid containers and a stable document height", () => {
  const expression = renderSettleExpression(10_000);
  assert.match(expression, /data-processed/);
  assert.match(expression, /querySelector\("svg"\)/);
  assert.match(expression, /scrollHeight/);
  assert.match(expression, /document\.fonts\.ready/);
  assert.match(expression, /Date\.now\(\) \+ 10000/);
  // The budget must reach the page as a plain integer, never as an interpolated object.
  assert.ok(!expression.includes("[object"));
});

test("screenshot --out refuses to overwrite the input HTML file", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lavish-screenshot-guard-"));
  try {
    const file = path.join(temp, "report.html");
    await writeFile(file, "<!doctype html><html><body>report</body></html>", "utf8");
    const canonical = await realpath(file);
    await assert.rejects(
      () => assertScreenshotOutputTarget(file, canonical),
      (error) => {
        assert.ok(error instanceof AxiError);
        assert.equal(error.code, "VALIDATION_ERROR");
        assert.match(error.message, /must not be the input HTML file/);
        return true;
      },
    );
    // A distinct output path is fine.
    await assertScreenshotOutputTarget(path.join(temp, "report.screenshot.png"), canonical);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("screenshot --out refuses a symlink that resolves to the input HTML file", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lavish-screenshot-guard-link-"));
  try {
    const file = path.join(temp, "report.html");
    await writeFile(file, "<!doctype html><html><body>report</body></html>", "utf8");
    const canonical = await realpath(file);
    const link = path.join(temp, "out.png");
    try {
      await symlink(file, link);
    } catch {
      // Symlink creation needs a privilege some environments lack; the lexical guard test
      // above still covers the refusal everywhere.
      return;
    }
    await assert.rejects(
      () => assertScreenshotOutputTarget(link, canonical),
      (error) => {
        assert.ok(error instanceof AxiError);
        assert.equal(error.code, "VALIDATION_ERROR");
        return true;
      },
    );
    assert.equal(await readFile(file, "utf8"), "<!doctype html><html><body>report</body></html>");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("screenshot CLI rejects --out equal to the input file before touching a browser", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lavish-screenshot-cli-guard-"));
  try {
    const file = path.join(temp, "report.html");
    const source = "<!doctype html><html><body>report</body></html>";
    await writeFile(file, source, "utf8");
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url)), "screenshot", "--out", file, file],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: {
          ...process.env,
          LAVISH_AXI_STATE_DIR: temp,
          LAVISH_AXI_TELEMETRY: "0",
          // Prove the guard fires before browser detection: no browser is reachable here.
          LAVISH_AXI_CHROME_PATH: "/missing/chrome",
        },
        encoding: "utf8",
      },
    );
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(`${result.stdout}\n${result.stderr}`, /must not be the input HTML file/);
    assert.equal(await readFile(file, "utf8"), source, "the artifact must survive the refused write");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test(
  "full-page screenshot waits for asynchronous Mermaid rendering before measuring",
  { skip: !runBrowserE2e, timeout: 120_000 },
  async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "lavish-screenshot-mermaid-"));
    try {
      // Serve Mermaid from the installed dependency so the suite needs no network access.
      const mermaidDist = fileURLToPath(new URL("../node_modules/mermaid/dist/mermaid.min.js", import.meta.url));
      await writeFile(path.join(temp, "mermaid.min.js"), await readFile(mermaidDist));
      // A tall vertical flowchart: rendered it is thousands of px tall; before mermaid.run()
      // finishes, the container is just a few lines of source text (~100px). The 300ms delay
      // simulates a slow asynchronous render deterministically - the pre-fix settle (fonts plus
      // two animation frames) captured long before it and measured the pre-render height.
      const chain = Array.from(
        { length: 60 },
        (_, index) => `N${index}[Step ${index}] --> N${index + 1}[Step ${index + 1}]`,
      ).join("\n  ");
      const file = path.join(temp, "diagram-report.html");
      await writeFile(
        file,
        `<!doctype html><html><head><meta charset="utf-8"><script src="mermaid.min.js"></script></head>` +
          `<body style="margin: 0"><h1>Diagram report</h1>\n` +
          `<div class="mermaid">graph TD\n  ${chain}\n</div>\n` +
          `<script>mermaid.initialize({ startOnLoad: false }); setTimeout(() => mermaid.run(), 300);</script>` +
          `</body></html>`,
      );

      const { png, height } = await captureFullPageScreenshot(pathToFileURL(file).href, { width: 900 });
      const parsed = pngDimensions(png);
      assert.equal(parsed.height, height);
      // 61 nodes at ~110px/rank: a rendered diagram clears 4000px easily, while the unrendered
      // source text would measure only a few hundred px.
      assert.ok(height >= 4000, `expected the rendered diagram height, got ${height}`);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);
