// Full-page ("long screenshot") PNG capture of a rendered HTML artifact.
//
// Lavish itself never drives a browser: the editor opens the user's own browser and talks to it
// over postMessage. A screenshot, though, must render the artifact off-screen, so this module
// spawns a dedicated headless Chrome/Chromium with a throwaway profile and talks raw CDP over
// Node 22's built-in WebSocket - no puppeteer-style dependency. The capture uses
// Page.captureScreenshot with captureBeyondViewport so the PNG spans the full scroll height of
// the document, not just the viewport.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DEFAULT_SCREENSHOT_VIEWPORT_WIDTH = 1280;
export const DEFAULT_SCREENSHOT_TIMEOUT_MS = 60_000;
// Upper bound for the in-page wait that lets asynchronous renderers (Mermaid diagrams, late
// font swaps, decoding images) finish before the document height is measured. The overall
// timeoutMs deadline always remains the outer guard.
export const SCREENSHOT_RENDER_SETTLE_MAX_MS = 10_000;
// The height a freshly created tab renders at before the full-document clip is computed.
const INITIAL_VIEWPORT_HEIGHT = 900;

/** @param {string} file artifact path @returns {string} default PNG name sitting next to the source */
export function screenshotFileName(file) {
  const base = path.basename(String(file || "artifact.html"));
  const stem = base.replace(/\.html?$/i, "");
  return `${stem || "artifact"}.screenshot.png`;
}

/**
 * Ordered Chrome/Chromium candidates for a platform. Relative entries are looked up on PATH;
 * absolute entries are checked directly. The first hit wins, so keep the mainstream browsers
 * ahead of the niche ones.
 *
 * @param {string} platform process.platform
 * @param {Record<string, string | undefined>} env environment
 * @returns {string[]}
 */
export function chromeExecutableCandidates(platform = process.platform, env = process.env) {
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ];
  }
  if (platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(Boolean);
    const relatives = [
      path.join("Google", "Chrome", "Application", "chrome.exe"),
      path.join("Chromium", "Application", "chrome.exe"),
      path.join("Microsoft", "Edge", "Application", "msedge.exe"),
    ];
    return roots.flatMap((root) => relatives.map((relative) => path.join(String(root), relative)));
  }
  return ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"];
}

/**
 * Resolve the browser binary to drive. `LAVISH_AXI_CHROME_PATH` is authoritative when set -
 * a typo there must surface as "not found", never silently fall through to another browser.
 *
 * @param {{ platform?: string, env?: Record<string, string | undefined>, fileExists?: (candidate: string) => boolean }} [options]
 * @returns {string | null} absolute path or PATH-resolved name, null when nothing qualifies
 */
export function findChromeExecutable({ platform = process.platform, env = process.env, fileExists = existsSync } = {}) {
  const explicit = String(env.LAVISH_AXI_CHROME_PATH || "").trim();
  if (explicit) return fileExists(explicit) ? explicit : null;
  const pathDirs = String(env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean);
  for (const candidate of chromeExecutableCandidates(platform, env)) {
    if (
      path.isAbsolute(candidate) ||
      candidate.includes(path.sep) ||
      (platform === "win32" && candidate.includes("\\"))
    ) {
      if (fileExists(candidate)) return candidate;
      continue;
    }
    for (const dir of pathDirs) {
      const resolved = path.join(dir, candidate);
      if (fileExists(resolved)) return resolved;
    }
  }
  return null;
}

export class ScreenshotError extends Error {
  /**
   * @param {string} message
   * @param {string} [code] stable machine-readable reason
   */
  constructor(message, code = "SCREENSHOT_FAILED") {
    super(message);
    this.name = "ScreenshotError";
    this.code = code;
  }
}

/**
 * Minimal CDP client over Node's built-in WebSocket. Handles the flat session protocol:
 * commands carry an optional sessionId, events are matched by method (+ sessionId when given).
 */
export class CdpConnection {
  /** @type {{ resolve: (value: any) => void, reject: (error: Error) => void } | undefined} */
  settleOpened;

  /** @param {string} wsUrl @param {typeof WebSocket} WebSocketImpl */
  constructor(wsUrl, WebSocketImpl = WebSocket) {
    this.ws = new WebSocketImpl(wsUrl);
    this.nextId = 1;
    /** @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void }>} */
    this.pending = new Map();
    /** @type {{ method: string, sessionId: string | undefined, resolve: (params: any) => void, reject: (error: Error) => void }[]} */
    this.eventWaiters = [];
    this.ws.addEventListener("message", (event) => this.handleMessage(String(event.data)));
    this.ws.addEventListener("close", () =>
      this.failAll(new ScreenshotError("Chrome closed the DevTools connection", "BROWSER_LOST")),
    );
    this.opened = new Promise((resolve, reject) => {
      // failAll must be able to settle the open wait too, so a capture deadline never leaves it
      // pending. Promise settlement is idempotent, so a reject after resolve is a no-op.
      this.settleOpened = { resolve, reject };
      this.ws.addEventListener("open", () => resolve(undefined), { once: true });
      this.ws.addEventListener(
        "error",
        () => reject(new ScreenshotError("Could not connect to Chrome DevTools", "BROWSER_LOST")),
        {
          once: true,
        },
      );
    });
  }

  /** @param {string} data raw frame */
  handleMessage(data) {
    /** @type {any} */
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const slot = this.pending.get(message.id);
      if (!slot) return;
      this.pending.delete(message.id);
      if (message.error)
        slot.reject(new ScreenshotError(`CDP ${message.error.message || "command failed"}`, "CDP_ERROR"));
      else slot.resolve(message.result);
      return;
    }
    if (!message.method) return;
    this.eventWaiters = this.eventWaiters.filter((waiter) => {
      if (waiter.method !== message.method) return true;
      if (waiter.sessionId !== undefined && waiter.sessionId !== message.sessionId) return true;
      waiter.resolve(message.params);
      return false;
    });
  }

  /**
   * @param {string} method CDP method
   * @param {Record<string, unknown>} [params]
   * @param {string} [sessionId] flat session to route the command to
   * @returns {Promise<any>} command result
   */
  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId;
    this.nextId += 1;
    /** @type {Record<string, unknown>} */
    const frame = { id, method, params };
    if (sessionId) frame.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(frame));
    });
  }

  /**
   * Resolve with the next matching event's params. Register before triggering the event.
   * @param {string} method @param {string | undefined} sessionId @returns {Promise<any>}
   */
  waitForEvent(method, sessionId = undefined) {
    return new Promise((resolve, reject) => {
      this.eventWaiters.push({ method, sessionId, resolve, reject });
    });
  }

  /** Settle EVERY outstanding wait - commands, event waiters, and the open handshake. */
  /** @param {Error} error */
  failAll(error) {
    for (const slot of this.pending.values()) slot.reject(error);
    this.pending.clear();
    const waiters = this.eventWaiters;
    this.eventWaiters = [];
    for (const waiter of waiters) waiter.reject(error);
    this.settleOpened?.reject(error);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // already gone
    }
  }
}

/**
 * Spawn headless Chrome and return its process plus a promise for the browser-level DevTools
 * WebSocket URL, read from the "DevTools listening on ws://..." line Chrome prints to stderr.
 * Synchronous on purpose: the caller must hold the child handle IMMEDIATELY so the capture
 * deadline can still kill a Chrome that stalls before ever publishing the URL.
 *
 * @param {string} executable
 * @param {{ width: number, profileDir: string, spawnImpl?: typeof spawn }} options
 * @returns {{ child: import("node:child_process").ChildProcess, wsUrl: Promise<string> }}
 */
function launchHeadlessChrome(executable, { width, profileDir, spawnImpl = spawn }) {
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "--mute-audio",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    `--window-size=${width},${INITIAL_VIEWPORT_HEIGHT}`,
    "about:blank",
  ];
  const child = spawnImpl(executable, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderrTail = "";
  const wsUrl = new Promise((resolve, reject) => {
    child.stderr.on("data", (chunk) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-4096);
      const match = stderrTail.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) resolve(match[1]);
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      reject(new ScreenshotError(`Chrome exited before DevTools was ready (code ${code})`, "BROWSER_LOST")),
    );
  });
  return { child, wsUrl };
}

/**
 * Render `url` in a throwaway headless Chrome profile and capture the FULL document height as
 * one PNG. The viewport is `width` px wide; the returned image is at least as tall as the
 * rendered document (long screenshot, not a viewport grab).
 *
 * @param {string} url page to render (usually a file:// URL of the artifact)
 * @param {{
 *   width?: number,
 *   timeoutMs?: number,
 *   executable?: string,
 *   env?: Record<string, string | undefined>,
 *   platform?: string,
 *   spawnImpl?: typeof spawn,
 *   webSocketImpl?: typeof WebSocket,
 * }} [options] spawnImpl/webSocketImpl are test seams for simulating a stalled browser or CDP
 *   session without a real Chrome
 * @returns {Promise<{ png: Buffer, width: number, height: number }>} PNG bytes and pixel dimensions
 */
export async function captureFullPageScreenshot(url, options = {}) {
  const {
    width = DEFAULT_SCREENSHOT_VIEWPORT_WIDTH,
    timeoutMs = DEFAULT_SCREENSHOT_TIMEOUT_MS,
    env = process.env,
    platform = process.platform,
  } = options;
  const executable = options.executable || findChromeExecutable({ env, platform });
  if (!executable) {
    throw new ScreenshotError("No Chrome or Chromium browser found for rendering the screenshot", "BROWSER_NOT_FOUND");
  }

  const profileDir = await mkdtemp(path.join(os.tmpdir(), "lavish-screenshot-"));
  /** @type {import("node:child_process").ChildProcess | null} */
  let child = null;
  /** @type {CdpConnection | null} */
  let connection = null;
  // The deadline must settle EVERY pending wait, not just in-flight CDP commands: a Chrome that
  // stalls before printing its DevTools URL (or a navigation that never fires loadEventFired)
  // would otherwise hang past timeoutMs and leak the browser and its throwaway profile. Every
  // async step below races against this rejection, and the timer also rejects the connection's
  // pending commands/event waiters and kills the browser as a belt-and-suspenders pair.
  /** @type {(error: Error) => void} */
  let rejectDeadline;
  const deadlineExceeded = new Promise((_, reject) => {
    rejectDeadline = reject;
  });
  // Mark the shared rejection handled up front so a deadline firing between steps can never
  // surface as an unhandled rejection; each step still observes it through its own race.
  deadlineExceeded.catch(() => undefined);
  const deadline = setTimeout(() => {
    const error = new ScreenshotError(`Screenshot capture timed out after ${timeoutMs}ms`, "TIMEOUT");
    rejectDeadline(error);
    connection?.failAll(error);
    if (child && !child.killed) child.kill("SIGKILL");
  }, timeoutMs);
  // The timer is only a guard; it must not keep the process alive once the capture returns.
  deadline.unref?.();
  /** Race one async step against the capture deadline. @param {Promise<any>} promise */
  const guard = (promise) => Promise.race([promise, deadlineExceeded]);

  try {
    const launched = launchHeadlessChrome(executable, { width, profileDir, spawnImpl: options.spawnImpl });
    child = launched.child;
    const wsUrl = await guard(launched.wsUrl);
    connection = new CdpConnection(wsUrl, options.webSocketImpl || WebSocket);
    await guard(connection.opened);

    const { targetId } = await guard(connection.send("Target.createTarget", { url: "about:blank" }));
    const { sessionId } = await guard(connection.send("Target.attachToTarget", { targetId, flatten: true }));

    await guard(connection.send("Page.enable", {}, sessionId));
    await guard(
      connection.send(
        "Emulation.setDeviceMetricsOverride",
        { width, height: INITIAL_VIEWPORT_HEIGHT, deviceScaleFactor: 1, mobile: false },
        sessionId,
      ),
    );
    const loaded = connection.waitForEvent("Page.loadEventFired", sessionId);
    await guard(connection.send("Page.navigate", { url }, sessionId));
    await guard(loaded);
    // `load` waits for images and stylesheets, but fonts can still swap in afterwards and
    // Mermaid-style diagrams render asynchronously (mermaid.run() takes far longer than the two
    // animation frames that used to be the whole settle). Measuring or capturing before that
    // work finishes omits the diagram from the PNG and under-measures the full-page height, so
    // wait for rendered diagram nodes AND a stable document height before reading metrics.
    const settleBudgetMs = Math.min(SCREENSHOT_RENDER_SETTLE_MAX_MS, Math.max(1_000, timeoutMs - 1_000));
    await guard(
      connection.send(
        "Runtime.evaluate",
        {
          expression: renderSettleExpression(settleBudgetMs),
          awaitPromise: true,
          returnByValue: true,
        },
        sessionId,
      ),
    );

    const metrics = await guard(connection.send("Page.getLayoutMetrics", {}, sessionId));
    const content = metrics.cssContentSize || metrics.contentSize;
    if (!content || !Number.isFinite(content.width) || !Number.isFinite(content.height)) {
      throw new ScreenshotError("Chrome did not report the rendered document size", "CDP_ERROR");
    }
    const captureWidth = Math.max(1, Math.ceil(Math.max(content.width, width)));
    const captureHeight = Math.max(1, Math.ceil(content.height));
    const shot = await guard(
      connection.send(
        "Page.captureScreenshot",
        {
          format: "png",
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: captureWidth, height: captureHeight, scale: 1 },
        },
        sessionId,
      ),
    );
    if (!shot || typeof shot.data !== "string" || !shot.data) {
      throw new ScreenshotError("Chrome returned an empty screenshot", "CDP_ERROR");
    }
    await connection.send("Target.closeTarget", { targetId }).catch(() => undefined);
    return { png: Buffer.from(shot.data, "base64"), width: captureWidth, height: captureHeight };
  } finally {
    clearTimeout(deadline);
    connection?.close();
    if (child && !child.killed) child.kill("SIGKILL");
    await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * In-page wait that holds off measurement and capture until asynchronous renderers finish.
 * `document.fonts.ready` covers late font swaps; Mermaid-style diagrams render after `load`
 * (mermaid.run() marks each `.mermaid` container `data-processed="true"` and swaps the source
 * text for an `<svg>`), so every container must reach that state; finally the document scroll
 * height must stay constant across several samples, catching any late layout shift. Everything
 * is bounded by `budgetMs` so a pathological page degrades to a best-effort capture instead of
 * a hang (the CDP-level deadline is the outer guard either way).
 *
 * @param {number} budgetMs maximum time the page-side wait may take
 * @returns {string} JavaScript expression for Runtime.evaluate with awaitPromise
 */
export function renderSettleExpression(budgetMs) {
  const budget = Math.max(0, Math.floor(budgetMs));
  return `(async () => {
  const deadline = Date.now() + ${budget};
  const remaining = () => deadline - Date.now();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    await Promise.race([document.fonts.ready, sleep(Math.max(0, Math.min(remaining(), 3000)))]);
  } catch (error) {}
  // Mermaid-style diagrams render asynchronously after load: mermaid.run() marks each
  // container data-processed="true" and swaps the source text for an <svg>. Wait for every
  // container to reach that state so the diagram is present in the capture.
  const diagrams = Array.from(document.querySelectorAll(".mermaid"));
  while (diagrams.length > 0 && remaining() > 0) {
    const rendered = diagrams.every(
      (el) => el.getAttribute("data-processed") === "true" || el.querySelector("svg") !== null,
    );
    if (rendered) break;
    await sleep(50);
  }
  // Late layout shifts (rendered diagrams, decoding images, font swaps) change the document
  // height; capture only once it has stayed constant across several samples.
  let lastHeight = -1;
  let stableSamples = 0;
  while (remaining() > 0) {
    await sleep(50);
    const height = document.documentElement.scrollHeight;
    if (height === lastHeight) {
      stableSamples += 1;
      if (stableSamples >= 4) break;
    } else {
      stableSamples = 0;
      lastHeight = height;
    }
  }
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return true;
})()`;
}
