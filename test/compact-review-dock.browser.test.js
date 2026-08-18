import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
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

async function waitForValue(read, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError || new Error("timed out waiting for browser state");
}

async function connectCdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  return {
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      socket.close();
    },
  };
}

function parseColor(value) {
  const numbers =
    String(value)
      .match(/[\d.]+/g)
      ?.map(Number) || [];
  assert.ok(numbers.length >= 3, `expected an rgb color, got ${value}`);
  return [numbers[0], numbers[1], numbers[2], numbers[3] ?? 1];
}

function compositeOverWhite(color) {
  const alpha = color[3];
  return color.slice(0, 3).map((channel) => channel * alpha + 255 * (1 - alpha));
}

function contrastRatio(foreground, background) {
  const luminance = (color) => {
    const channels = color.slice(0, 3).map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const foregroundLuminance = luminance(compositeOverWhite(foreground));
  const backgroundLuminance = luminance(compositeOverWhite(background));
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

test("light dock controls and labels retain accessible contrast", { timeout: 60_000 }, async (t) => {
  const chrome = await chromePath();
  if (!chrome) {
    t.skip("Chrome or Chromium is required for the compact-dock regression");
    return;
  }

  const root = await mkdtemp(path.join(os.tmpdir(), "lavish-hover-contrast-"));
  const profile = path.join(root, "chrome-profile");
  const chromeCss = await readFile(path.join(projectRoot, "src", "chrome.css"));
  const server = http.createServer((request, response) => {
    if (new URL(request.url, "http://127.0.0.1").pathname === "/chrome.css") {
      response.writeHead(200, { "content-type": "text/css; charset=utf-8" });
      response.end(chromeCss);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      '<!doctype html><link rel="stylesheet" href="/chrome.css"><body class="lavish"><main style="padding:40px;display:grid;gap:20px;background:#fff"><div style="display:flex;gap:20px"><button id="more" class="more-button" aria-label="More">...</button><button id="warnings" class="warnings-button">Warnings</button><button id="warningDefault" class="warnings-button">Warnings</button></div><div id="warningsDrawer" class="menu warnings-drawer" style="position:static"><div class="warnings-list"><div id="warningSurface" class="warning-row"><div class="warning-body"><span id="warningTarget" class="warning-target">main &gt; article</span><div class="warning-meta"><span id="neutralChip" class="warning-chip">Desktop</span><span id="queuedChip" class="warning-chip status-queued">Queued</span><span id="unverifiedChip" class="warning-chip status-unverified">Unverified</span></div></div></div></div><div class="warnings-foot"><p id="warningsNote" class="warnings-note">Queueing sends a repair request.</p></div></div><div id="layoutBanner" class="layout-issue-banner">Layout issue</div><div id="tooltipSurface" class="pill-tooltip" style="display:block"><div id="tooltipLabel" class="tooltip-label">Target</div></div><div class="composer"><textarea id="composerInput" placeholder="Write a message for the agent..."></textarea></div></main>',
    );
  });
  let browser;
  let cdp;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind to a TCP port");
    const pageUrl = `http://127.0.0.1:${address.port}/`;
    browser = spawn(
      chrome,
      [
        "--headless=new",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--disable-background-networking",
        "--no-sandbox",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "--window-size=800,600",
        pageUrl,
      ],
      { stdio: "ignore" },
    );
    const devtools = await waitForValue(async () => {
      const [port] = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).trim().split("\n");
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
      return targets.find((target) => target.type === "page" && target.url === pageUrl);
    });
    cdp = await connectCdp(devtools.webSocketDebuggerUrl);
    const evaluate = async (expression) => {
      const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    };
    await waitForValue(async () => (await evaluate("document.readyState")) === "complete");

    for (const id of ["more", "warnings"]) {
      const rect = await evaluate(
        `(() => { const box = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height }; })()`,
      );
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
      });
      const style = await waitForValue(async () => {
        const value = await evaluate(
          `(() => { const button = document.getElementById(${JSON.stringify(id)}); const style = getComputedStyle(button); return { hovered: button.matches(":hover"), color: style.color, background: style.backgroundColor }; })()`,
        );
        return value.hovered ? value : null;
      });
      const ratio = contrastRatio(parseColor(style.color), parseColor(style.background));
      assert.ok(ratio >= 4.5, `${id} hover contrast was ${ratio.toFixed(2)}:1`);
    }

    for (const spec of [
      { id: "warningTarget", backgroundId: "warningSurface" },
      { id: "warningsNote", backgroundId: "warningsDrawer" },
      { id: "tooltipLabel", backgroundId: "tooltipSurface" },
      { id: "composerInput", backgroundId: "composerInput", pseudo: "::placeholder" },
      { id: "warningDefault", backgroundId: "warningDefault" },
      { id: "neutralChip", backgroundId: "neutralChip" },
      { id: "queuedChip", backgroundId: "queuedChip" },
      { id: "unverifiedChip", backgroundId: "unverifiedChip" },
      { id: "layoutBanner", backgroundId: "layoutBanner" },
    ]) {
      const style = await evaluate(
        `(() => { const text = document.getElementById(${JSON.stringify(spec.id)}); const background = document.getElementById(${JSON.stringify(spec.backgroundId)}); return { color: getComputedStyle(text, ${JSON.stringify(spec.pseudo || null)}).color, background: getComputedStyle(background).backgroundColor }; })()`,
      );
      const ratio = contrastRatio(parseColor(style.color), parseColor(style.background));
      assert.ok(ratio >= 4.5, `${spec.id} contrast was ${ratio.toFixed(2)}:1`);
    }
  } finally {
    cdp?.close();
    if (browser && browser.exitCode === null) {
      const exited = new Promise((resolve) => browser.once("exit", resolve));
      browser.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
      if (browser.exitCode === null) browser.kill("SIGKILL");
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("compact review dock reserves chrome space without covering review surfaces", { timeout: 60_000 }, async (t) => {
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
  const narrow = window.innerWidth <= 380;
  document.getElementById("warningsWrap").hidden = false;
  document.getElementById("warningsCount").textContent = "1";
  const snapshot = () => {
    const dock = document.getElementById("reviewDock");
    const layout = document.querySelector(".layout");
    const artifact = document.getElementById("artifact");
    const send = document.getElementById("sendActions");
    const annotation = document.getElementById("annotation");
    const dockBox = dock.getBoundingClientRect();
    const layoutBox = layout.getBoundingClientRect();
    const artifactBox = artifact.getBoundingClientRect();
    const sendBox = send.getBoundingClientRect();
    const annotationBox = annotation.getBoundingClientRect();
    return {
      position: getComputedStyle(dock).position,
      dockTop: rounded(dockBox.top),
      dockBottom: rounded(dockBox.bottom),
      dockHeight: rounded(dockBox.height),
      layoutTop: rounded(layoutBox.top),
      layoutBottom: rounded(layoutBox.bottom),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      documentOverflow: rounded(document.documentElement.scrollWidth - window.innerWidth),
      dockOverflow: rounded(dock.scrollWidth - dock.clientWidth),
      overlapsArtifact: overlaps(dockBox, artifactBox),
      overlapsSend: overlaps(dockBox, sendBox),
      annotationVisible: getComputedStyle(annotation).display !== "none",
      annotationWithinViewport: annotationBox.left >= 0 && annotationBox.right <= window.innerWidth,
      annotationPressed: annotation.getAttribute("aria-pressed"),
      controlsHidden: document.getElementById("barControls").hidden,
      panelActionDisplay: getComputedStyle(document.getElementById("panelToggle")).display,
      endActionDisplay: getComputedStyle(document.getElementById("end")).display,
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
  const whiteboardOverlay = document.getElementById("whiteboardOverlay");
  whiteboardOverlay.hidden = false;
  const overlayBox = whiteboardOverlay.getBoundingClientRect();
  const dockBox = document.getElementById("reviewDock").getBoundingClientRect();
  const annotation = document.getElementById("annotation");
  const annotationBox = annotation.getBoundingClientRect();
  const annotationHit = document.elementFromPoint(
    annotationBox.left + annotationBox.width / 2,
    annotationBox.top + annotationBox.height / 2,
  );
  const whiteboardGeometry = {
    position: getComputedStyle(whiteboardOverlay).position,
    overlayTop: rounded(overlayBox.top),
    overlayBottom: rounded(overlayBox.bottom),
    dockBottom: rounded(dockBox.bottom),
    overlapsDock: overlaps(overlayBox, dockBox),
    annotationUncovered: annotation === annotationHit || annotation.contains(annotationHit),
    annotationPressed: annotation.getAttribute("aria-pressed"),
  };
  document.getElementById("moreButton").click();
  const moreMenu = document.getElementById("moreMenu");
  const reloadArtifact = document.getElementById("reloadArtifact");
  const reloadBox = reloadArtifact.getBoundingClientRect();
  const reloadHit = document.elementFromPoint(
    reloadBox.left + reloadBox.width / 2,
    reloadBox.top + reloadBox.height / 2,
  );
  const moreMenuAboveWhiteboard = {
    visible: !moreMenu.hidden && getComputedStyle(moreMenu).display !== "none",
    interactive: reloadArtifact === reloadHit || reloadArtifact.contains(reloadHit),
  };
  document.getElementById("warningsButton").click();
  const warningsDrawer = document.getElementById("warningsDrawer");
  const warningsSelectAll = document.getElementById("warningsSelectAll");
  const selectAllBox = warningsSelectAll.getBoundingClientRect();
  const selectAllHit = document.elementFromPoint(
    selectAllBox.left + selectAllBox.width / 2,
    selectAllBox.top + selectAllBox.height / 2,
  );
  const warningsDrawerAboveWhiteboard = {
    visible: !warningsDrawer.hidden && getComputedStyle(warningsDrawer).display !== "none",
    interactive: warningsSelectAll === selectAllHit || warningsSelectAll.contains(selectAllHit),
  };
  document.getElementById("warningsButton").click();
  whiteboardOverlay.hidden = true;
  document.getElementById("moreButton").focus();
  const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  document.dispatchEvent(escape);
  const collapseFocus = {
    controlsHidden: document.getElementById("barControls").hidden,
    expanded: document.getElementById("barToggle").getAttribute("aria-expanded"),
    activeElement: document.activeElement?.id || "",
  };
  let narrowMenu = null;
  if (narrow) {
    document.getElementById("barToggle").click();
    document.getElementById("moreButton").click();
    narrowMenu = {
      panelActionDisplay: getComputedStyle(document.getElementById("menuPanelToggle")).display,
      endActionDisplay: getComputedStyle(document.getElementById("menuEnd")).display,
    };
    document.getElementById("menuPanelToggle").click();
  } else {
    document.getElementById("panelToggle").click();
  }
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
    whiteboardGeometry,
    moreMenuAboveWhiteboard,
    warningsDrawerAboveWhiteboard,
    collapseFocus,
    narrowMenu,
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
  const narrowPage = `<!doctype html>
<style>html,body{margin:0;width:320px;height:720px;overflow:hidden}iframe{display:block;width:320px;height:720px;border:0}</style>
<iframe id="fixture" src="/"></iframe><pre id="testResult" hidden></pre>
<script>
const fixture = document.getElementById("fixture");
function collectResult() {
  const value = fixture.contentDocument?.getElementById("testResult")?.textContent;
  if (value) document.getElementById("testResult").textContent = value;
  else setTimeout(collectResult, 20);
}
fixture.addEventListener("load", collectResult);
</script>`;

  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    if (pathname === "/narrow") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(narrowPage);
      return;
    }
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
    const port = address.port;
    async function runBrowser(width) {
      const { stdout } = await execFileAsync(
        chrome,
        [
          "--headless=new",
          "--disable-gpu",
          "--disable-dev-shm-usage",
          "--disable-background-networking",
          "--no-sandbox",
          `--user-data-dir=${path.join(root, `chrome-profile-${width}`)}`,
          `--window-size=${Math.max(width, 500)},720`,
          "--run-all-compositor-stages-before-draw",
          "--virtual-time-budget=1000",
          "--dump-dom",
          `http://127.0.0.1:${port}${width === 320 ? "/narrow" : "/"}`,
        ],
        { maxBuffer: 4 * 1024 * 1024, timeout: 15_000 },
      );
      const result = resultFromDump(stdout);
      assert.ok(result, `browser fixture at ${width}px did not report a result`);
      assert.equal(result.error, undefined);
      return result;
    }

    const [desktop, narrow] = await Promise.all([runBrowser(1280), runBrowser(320)]);

    for (const result of [desktop, narrow]) {
      assert.equal(result.collapsed.position, "relative");
      assert.equal(result.collapsed.dockTop, 0);
      assert.ok(result.collapsed.dockHeight <= 42);
      assert.equal(result.collapsed.layoutTop, result.collapsed.dockBottom);
      assert.equal(result.collapsed.layoutBottom, result.collapsed.viewportHeight);
      assert.equal(result.collapsed.overlapsArtifact, false);
      assert.equal(result.collapsed.overlapsSend, false);
      assert.equal(result.collapsed.annotationVisible, true);
      assert.equal(result.collapsed.annotationWithinViewport, true);
      assert.equal(result.collapsed.annotationPressed, "true");
      assert.equal(result.collapsed.controlsHidden, true);
      assert.deepEqual(result.annotationOff, { defaultPrevented: true, pressed: "false", colorChanged: true });
      assert.ok(result.expanded.dockHeight <= 42);
      assert.equal(result.expanded.controlsHidden, false);
      assert.equal(result.expanded.documentOverflow, 0);
      assert.equal(result.expanded.dockOverflow, 0);
      assert.equal(result.expanded.annotationWithinViewport, true);
      assert.equal(result.expanded.overlapsArtifact, false);
      assert.equal(result.expanded.overlapsSend, false);
      assert.equal(result.whiteboardGeometry.position, "fixed");
      assert.equal(result.whiteboardGeometry.overlayTop, result.whiteboardGeometry.dockBottom);
      assert.equal(result.whiteboardGeometry.overlayBottom, result.expanded.viewportHeight);
      assert.equal(result.whiteboardGeometry.overlapsDock, false);
      assert.equal(result.whiteboardGeometry.annotationUncovered, true);
      assert.equal(result.whiteboardGeometry.annotationPressed, "false");
      assert.deepEqual(result.moreMenuAboveWhiteboard, { visible: true, interactive: true });
      assert.deepEqual(result.warningsDrawerAboveWhiteboard, { visible: true, interactive: true });
      assert.deepEqual(result.collapseFocus, {
        controlsHidden: true,
        expanded: "false",
        activeElement: "barToggle",
      });
      assert.deepEqual(result.panelCollapsed, {
        panelDisplay: "none",
        artifactRight: result.panelCollapsed.viewportWidth,
        viewportWidth: result.panelCollapsed.viewportWidth,
        overlapsArtifact: false,
      });
    }

    assert.equal(desktop.expanded.viewportWidth, 1280);
    assert.notEqual(desktop.expanded.panelActionDisplay, "none");
    assert.notEqual(desktop.expanded.endActionDisplay, "none");
    assert.equal(desktop.narrowMenu, null);
    assert.equal(narrow.expanded.viewportWidth, 320);
    assert.equal(narrow.expanded.panelActionDisplay, "none");
    assert.equal(narrow.expanded.endActionDisplay, "none");
    assert.deepEqual(narrow.narrowMenu, { panelActionDisplay: "flex", endActionDisplay: "flex" });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
