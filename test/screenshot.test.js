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
  prepareSnapshotDocument,
  renderSettleExpression,
  restoreAttributesExpression,
  sanitizeSnapshotRootAttributes,
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

test("sanitizeSnapshotRootAttributes accepts a clean map and rejects crafted shapes", () => {
  assert.deepEqual(sanitizeSnapshotRootAttributes(undefined), {});
  assert.deepEqual(sanitizeSnapshotRootAttributes(null), {});
  assert.deepEqual(sanitizeSnapshotRootAttributes({ "data-lang": "zh", class: "dark" }), {
    "data-lang": "zh",
    class: "dark",
  });
  assert.equal(sanitizeSnapshotRootAttributes("data-lang"), null);
  assert.equal(sanitizeSnapshotRootAttributes(["data-lang"]), null);
  assert.equal(sanitizeSnapshotRootAttributes({ "data-lang": 42 }), null);
  assert.equal(sanitizeSnapshotRootAttributes({ '"><script>': "x" }), null);
  assert.equal(sanitizeSnapshotRootAttributes({ "data-x": "v".repeat(3000) }), null);
  const tooMany = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`data-a${index}`, "v"]));
  assert.equal(sanitizeSnapshotRootAttributes(tooMany), null);
});

test("prepareSnapshotDocument pins a base href first in head and strips the injected SDK tag", () => {
  const snapshot =
    '<!DOCTYPE html>\n<html data-lang="zh"><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head>' +
    '<body><script src="/sdk.js?key=abc"></script></body></html>';
  const prepared = prepareSnapshotDocument(snapshot, "file:///tmp/artifacts/");
  // The base must precede every relative URL in the document.
  assert.ok(prepared.indexOf('<base href="file:///tmp/artifacts/">') < prepared.indexOf('href="style.css"'));
  assert.ok(prepared.startsWith("<!DOCTYPE html>"));
  // Lavish's own injected SDK tag can only 404 from a file:// render - it is stripped.
  assert.ok(!prepared.includes("/sdk.js"));
  assert.ok(prepared.includes('data-lang="zh"'));

  // Documents without a <head> still get a base the parser accepts.
  const noHead = prepareSnapshotDocument("<html><body>x</body></html>", "file:///tmp/a/");
  assert.ok(noHead.includes('<head><base href="file:///tmp/a/"></head>'));
  const bare = prepareSnapshotDocument("<p>fragment</p>", "file:///tmp/a/");
  assert.ok(bare.startsWith('<base href="file:///tmp/a/">'));
});

test("restoreAttributesExpression embeds the snapshot attributes as a safe literal", () => {
  const expression = restoreAttributesExpression({ "data-lang": "zh", class: 'quoted"value' });
  assert.match(expression, /document\.documentElement/);
  assert.match(expression, /setAttribute/);
  assert.match(expression, /removeAttribute/);
  // The attributes arrive as a JSON literal: quotes are escaped, never interpolated raw.
  assert.ok(expression.includes(JSON.stringify({ "data-lang": "zh", class: 'quoted"value' })));
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

test(
  "snapshot capture re-applies live root attributes the artifact's init script resets (WYSIWYG)",
  { skip: !runBrowserE2e, timeout: 120_000 },
  async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "lavish-screenshot-wysiwyg-"));
    try {
      // The field pattern behind the bug report: a localStorage-backed language toggle that
      // applies data-lang to the document root, with CSS showing one language band. The
      // artifact's init script runs again in the fresh capture profile, finds EMPTY storage,
      // and resets data-lang to "en" - so a snapshot render without the root-attribute restore
      // shows the default language even though the reviewer had switched to Chinese.
      const artifact = path.join(temp, "skills-map.html");
      await writeFile(
        artifact,
        `<!doctype html><html data-lang="en"><head><meta charset="utf-8"><style>` +
          `html[data-lang="en"] .zh { display: none; } html[data-lang="zh"] .en { display: none; }` +
          `.en-band { height: 500px; background: #00f; } .zh-band { height: 2000px; background: #f00; }` +
          `</style></head><body style="margin: 0">` +
          `<div class="en en-band">Hello</div><div class="zh zh-band">你好</div>` +
          `<script>` +
          `var lang = "en";` +
          `try { lang = localStorage.getItem("amap-lang") || "en"; } catch (error) {}` +
          `document.documentElement.setAttribute("data-lang", lang);` +
          `function toggle(lang) {` +
          `  try { localStorage.setItem("amap-lang", lang); } catch (error) {}` +
          `  document.documentElement.setAttribute("data-lang", lang);` +
          `}` +
          `</script></body></html>`,
      );

      // What the editor's SDK serializes after the reviewer switched to 中文: the same document,
      // but the root carries the live data-lang="zh" (localStorage itself stays in the sandboxed
      // editor session and cannot ride along).
      const liveHtml = await readFile(artifact, "utf8");
      const toggledLiveHtml = liveHtml.replace('data-lang="en"', 'data-lang="zh"');
      const baseHref = pathToFileURL(`${temp}${path.sep}`).href;
      const snapshotFile = path.join(temp, "snapshot.html");
      await writeFile(snapshotFile, prepareSnapshotDocument(toggledLiveHtml, baseHref), "utf8");

      // Without the restore the init script's clobber wins: the capture shows the DEFAULT
      // language (the pre-fix behavior the captain hit).
      const withoutRestore = await captureFullPageScreenshot(pathToFileURL(snapshotFile).href, { width: 900 });
      assert.ok(
        withoutRestore.height < 1000,
        `without restore the init script resets to the short EN band, got ${withoutRestore.height}`,
      );

      // The editor export passes the live root attributes: the capture must show 中文.
      const withRestore = await captureFullPageScreenshot(pathToFileURL(snapshotFile).href, {
        width: 900,
        restoreAttributes: { "data-lang": "zh" },
      });
      assert.ok(
        withRestore.height >= 2000,
        `with restore the capture must render the tall ZH band, got ${withRestore.height}`,
      );
      assert.notDeepEqual(withRestore.png, withoutRestore.png);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);
