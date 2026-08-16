import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createChromeHtml } from "../src/server.js";

const execFileAsync = promisify(execFile);
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

function resultFromDump(html) {
  const match = html.match(/<pre id="testResult"[^>]*>([\s\S]*?)<\/pre>/);
  return match?.[1] ? JSON.parse(match[1]) : null;
}

test("compact review dock reserves chrome space without covering review surfaces", { timeout: 45_000 }, async (t) => {
  const chrome = await chromePath();
  if (!chrome) {
    t.skip("Chrome or Chromium is required for the compact-dock regression");
    return;
  }

  const root = await mkdtemp(path.join(os.tmpdir(), "lavish-compact-dock-"));
  const chromeCss = await readFile(path.join(projectRoot, "src", "chrome.css"));
  const chromeClient = await readFile(path.join(projectRoot, "src", "chrome-client.js"));
  const probe = `
<pre id="testResult" hidden></pre>
<script>
Promise.resolve().then(() => {
  const rounded = (value) => Math.round(value);
  const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  const snapshot = () => {
    const dock = document.getElementById("reviewDock");
    const layout = document.querySelector(".layout");
    const artifact = document.getElementById("artifact");
    const send = document.getElementById("sendActions");
    const dockBox = dock.getBoundingClientRect();
    const layoutBox = layout.getBoundingClientRect();
    const artifactBox = artifact.getBoundingClientRect();
    const sendBox = send.getBoundingClientRect();
    return {
      position: getComputedStyle(dock).position,
      dockTop: rounded(dockBox.top),
      dockBottom: rounded(dockBox.bottom),
      dockHeight: rounded(dockBox.height),
      layoutTop: rounded(layoutBox.top),
      layoutBottom: rounded(layoutBox.bottom),
      viewportHeight: window.innerHeight,
      overlapsArtifact: overlaps(dockBox, artifactBox),
      overlapsSend: overlaps(dockBox, sendBox),
      annotationVisible: getComputedStyle(document.getElementById("annotation")).display !== "none",
      annotationPressed: document.getElementById("annotation").getAttribute("aria-pressed"),
      controlsHidden: document.getElementById("barControls").hidden,
    };
  };

  const track = document.querySelector(".switch-track");
  track.style.transition = "none";
  const onColor = getComputedStyle(track).backgroundColor;
  const collapsed = snapshot();
  const hotkey = new KeyboardEvent("keydown", { key: "i", metaKey: true, bubbles: true, cancelable: true });
  document.dispatchEvent(hotkey);
  const annotationOff = {
    defaultPrevented: hotkey.defaultPrevented,
    pressed: document.getElementById("annotation").getAttribute("aria-pressed"),
    colorChanged: getComputedStyle(track).backgroundColor !== onColor,
  };

  document.getElementById("barToggle").click();
  const expanded = snapshot();
  document.getElementById("panelToggle").click();
  const panelCollapsed = {
    panelDisplay: getComputedStyle(document.querySelector(".panel")).display,
    artifactRight: rounded(document.getElementById("artifact").getBoundingClientRect().right),
    viewportWidth: window.innerWidth,
    overlapsArtifact: overlaps(
      document.getElementById("reviewDock").getBoundingClientRect(),
      document.getElementById("artifact").getBoundingClientRect(),
    ),
  };
  document.getElementById("testResult").textContent = JSON.stringify({
    collapsed,
    annotationOff,
    expanded,
    panelCollapsed,
  });
}).catch((error) => {
  document.getElementById("testResult").textContent = JSON.stringify({ error: String(error && error.stack || error) });
});
</script>`;
  const page = createChromeHtml(
    { key: "abc", file: path.join(root, "artifact.html") },
    { layoutGateEnabled: false, chromeLoadToken: "browser-test" },
  )
    .replace(/data-artifact-src="[^"]*"/, 'data-artifact-src=""')
    .replace(
      '<script src="/chrome-client.js"></script>',
      '<script>window.EventSource=class { addEventListener() {} };</script><script src="/chrome-client.js"></script>',
    )
    .replace("</body>", `${probe}\n</body>`);

  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    if (pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(page);
      return;
    }
    if (pathname === "/chrome.css") {
      response.writeHead(200, { "content-type": "text/css; charset=utf-8" });
      response.end(chromeCss);
      return;
    }
    if (pathname === "/chrome-client.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(chromeClient);
      return;
    }
    if (pathname.startsWith("/artifact/")) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><main style='height:1600px'>Artifact</main>");
      return;
    }
    if (pathname === "/events/abc") {
      response.writeHead(204).end();
      return;
    }
    if (pathname.endsWith("/artifact-loads/begin")) {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ artifact_revision: 1, artifact_load_token: "browser-load" }));
      });
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });

  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind to a TCP port");
    const { stdout } = await execFileAsync(
      chrome,
      [
        "--headless=new",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--disable-background-networking",
        "--no-sandbox",
        `--user-data-dir=${path.join(root, "chrome-profile")}`,
        "--window-size=1280,720",
        "--run-all-compositor-stages-before-draw",
        "--virtual-time-budget=1000",
        "--dump-dom",
        `http://127.0.0.1:${address.port}/`,
      ],
      { maxBuffer: 4 * 1024 * 1024, timeout: 15_000 },
    );
    const result = resultFromDump(stdout);
    assert.ok(result, "browser fixture did not report a result");
    assert.equal(result.error, undefined);
    assert.equal(result.collapsed.position, "relative");
    assert.equal(result.collapsed.dockTop, 0);
    assert.ok(result.collapsed.dockHeight <= 42);
    assert.equal(result.collapsed.layoutTop, result.collapsed.dockBottom);
    assert.equal(result.collapsed.layoutBottom, result.collapsed.viewportHeight);
    assert.equal(result.collapsed.overlapsArtifact, false);
    assert.equal(result.collapsed.overlapsSend, false);
    assert.equal(result.collapsed.annotationVisible, true);
    assert.equal(result.collapsed.annotationPressed, "true");
    assert.equal(result.collapsed.controlsHidden, true);
    assert.deepEqual(result.annotationOff, { defaultPrevented: true, pressed: "false", colorChanged: true });
    assert.ok(result.expanded.dockHeight <= 42);
    assert.equal(result.expanded.controlsHidden, false);
    assert.equal(result.expanded.overlapsArtifact, false);
    assert.equal(result.expanded.overlapsSend, false);
    assert.deepEqual(result.panelCollapsed, {
      panelDisplay: "none",
      artifactRight: result.panelCollapsed.viewportWidth,
      viewportWidth: result.panelCollapsed.viewportWidth,
      overlapsArtifact: false,
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
