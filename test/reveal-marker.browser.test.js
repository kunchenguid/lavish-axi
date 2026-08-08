import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createSdkJs } from "../src/server.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

async function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return "";
}

const page = `<!doctype html>
<html><head><meta charset="utf-8"><title>reveal marker</title>
<style>body{margin:0;font:16px/1.5 sans-serif}.filler{height:250vh;background:#eee}
#target{margin:0 40px;padding:24px;background:#cfe;border:1px solid #391}</style>
</head><body>
<div class="filler">top filler - the target must start well below the fold</div>
<div id="target">Reveal me</div>
<div class="filler">bottom filler - leaves room to scroll past the target</div>
<script src="/sdk.js"></script>
<script src="/fixture.js"></script>
</body></html>`;

// A source-level assertion cannot prove the marker lands on the element - only that the code is
// shaped a certain way. This drives the real reveal path in a real browser: the box must sit on
// its element after the smooth scroll settles, and must stay there through a later scroll, which
// a one-shot getBoundingClientRect read can never do.
test("the reveal marker lands on its element and tracks it through scrolling", { timeout: 120_000 }, async (t) => {
  const chrome = await chromePath();
  if (!chrome) {
    t.skip("Chrome or Chromium is required for the reveal-marker regression");
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "lavish-reveal-marker-"));
  const files = new Map([
    ["index.html", page],
    ["sdk.js", createSdkJs("reveal-marker-test")],
    ["fixture.js", await readFile(path.join(projectRoot, "test/fixtures/reveal-marker.browser.js"), "utf8")],
  ]);

  /** @type {(value: unknown) => void} */
  let report = () => {};
  const reported = new Promise((resolve) => {
    report = resolve;
  });

  const server = http.createServer((request, response) => {
    if (request.method === "POST" && request.url === "/result") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        response.writeHead(204).end();
        try {
          report(JSON.parse(body));
        } catch (error) {
          report({ pass: false, error: `unparseable result: ${String(error)}` });
        }
      });
      return;
    }
    const name = request.url === "/" ? "index.html" : decodeURIComponent(String(request.url).slice(1));
    const body = files.get(name);
    if (body === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "content-type": name.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(body);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind to a TCP port");

  const browser = spawn(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "--no-first-run",
      `--user-data-dir=${path.join(root, "chrome-profile")}`,
      "--window-size=1200,800",
      `http://127.0.0.1:${address.port}/`,
    ],
    { stdio: "ignore" },
  );

  try {
    // unref so a fixture that reports promptly does not hold the event loop open for the
    // whole fallback window.
    const result = await Promise.race([
      reported,
      new Promise((resolve) => setTimeout(() => resolve(null), 60_000).unref()),
    ]);

    assert.ok(result, "browser fixture did not report a result");
    assert.equal(result.pass, true, result.error);

    // Preconditions - without these the assertions below would pass vacuously.
    assert.equal(result.startedAtTop, true, "the page must start at the top so revealing has to scroll");
    assert.equal(result.targetBelowFold, true, "the target must start off-screen");
    assert.equal(result.scrollSettled, true, "scrolling never settled");
    assert.ok(result.scrolledBy > 0, "revealing the target scrolled the page");
    assert.equal(result.markerPresent, true, "a reveal marker was drawn");

    // Without these, a marker that expired mid-fixture would surface as a null dereference rather
    // than as the timing miss it is.
    assert.ok(result.afterScroll, "the marker was gone before its position could be measured after the scroll settled");
    assert.equal(
      result.markerPresentAfterFurtherScroll,
      true,
      "the marker was gone before its position could be measured after the second scroll",
    );
    assert.ok(result.afterFurtherScroll, "no marker position was measured after the second scroll");

    // 1px of tolerance for subpixel layout; the pre-fix bug drifts by the whole scroll distance.
    assert.ok(
      result.afterScroll.dy <= 1 && result.afterScroll.dx <= 1,
      `the marker must frame its element once the scroll settles, drifted by ${JSON.stringify(result.afterScroll)}`,
    );
    assert.ok(
      result.afterFurtherScroll.dy <= 1 && result.afterFurtherScroll.dx <= 1,
      `the marker must keep tracking through later scrolling, drifted by ${JSON.stringify(result.afterFurtherScroll)}`,
    );
  } finally {
    browser.kill("SIGKILL");
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    await rm(root, { recursive: true, force: true });
  }
});
