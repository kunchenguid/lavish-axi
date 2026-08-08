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
<html><head><meta charset="utf-8"><title>annotation badge</title>
<style>body{margin:0;font:16px/1.5 sans-serif}#spacer{height:180vh;background:#eee}
#target{margin:0 40px;padding:24px;background:#cfe;border:1px solid #391}
.filler{height:250vh;background:#f6f6f6}</style>
</head><body>
<div id="spacer">spacer - grown later to move the target without a scroll or resize event</div>
<div id="target">Annotated</div>
<div class="filler">bottom filler</div>
<script src="/sdk.js"></script>
<script src="/fixture.js"></script>
</body></html>`;

// Badges are repositioned from scroll, resize, and ResizeObserver events rather than an always-on
// frame loop, so their correctness is exactly "does the dot still sit on its element after the page
// moved?" - a question only a real browser can answer.
test(
  "annotation badges stay pinned to their element through scrolling and layout shifts",
  { timeout: 120_000 },
  async (t) => {
    const chrome = await chromePath();
    if (!chrome) {
      t.skip("Chrome or Chromium is required for the annotation-badge regression");
      return;
    }
    const root = await mkdtemp(path.join(os.tmpdir(), "lavish-annotation-badge-"));
    const files = new Map([
      ["index.html", page],
      ["sdk.js", createSdkJs("annotation-badge-test")],
      ["fixture.js", await readFile(path.join(projectRoot, "test/fixtures/annotation-badge.browser.js"), "utf8")],
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
      const result = await Promise.race([
        reported,
        new Promise((resolve) => setTimeout(() => resolve(null), 60_000).unref()),
      ]);

      assert.ok(result, "browser fixture did not report a result");
      assert.equal(result.pass, true, result.error);
      assert.equal(result.badgeCount, 1, "one badge is drawn for one annotated element");

      for (const stage of ["initial", "afterScroll", "afterLayoutShift"]) {
        assert.ok(result[stage], `no badge position was measured ${stage}`);
        assert.ok(
          result[stage].dx <= 1 && result[stage].dy <= 1,
          `the badge must sit on its element ${stage}, drifted by ${JSON.stringify(result[stage])}`,
        );
      }
    } finally {
      const exited = new Promise((resolve) => browser.once("exit", resolve));
      browser.kill("SIGKILL");
      await exited;
      server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
);
