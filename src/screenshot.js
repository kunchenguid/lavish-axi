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
class CdpConnection {
  /** @param {string} wsUrl @param {typeof WebSocket} WebSocketImpl */
  constructor(wsUrl, WebSocketImpl = WebSocket) {
    this.ws = new WebSocketImpl(wsUrl);
    this.nextId = 1;
    /** @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void }>} */
    this.pending = new Map();
    /** @type {{ method: string, sessionId: string | undefined, resolve: (params: any) => void }[]} */
    this.eventWaiters = [];
    this.ws.addEventListener("message", (event) => this.handleMessage(String(event.data)));
    this.ws.addEventListener("close", () =>
      this.failAll(new ScreenshotError("Chrome closed the DevTools connection", "BROWSER_LOST")),
    );
    this.opened = new Promise((resolve, reject) => {
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
    return new Promise((resolve) => {
      this.eventWaiters.push({ method, sessionId, resolve });
    });
  }

  /** @param {Error} error */
  failAll(error) {
    for (const slot of this.pending.values()) slot.reject(error);
    this.pending.clear();
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
 * Spawn headless Chrome and return its process plus the browser-level DevTools WebSocket URL,
 * read from the "DevTools listening on ws://..." line Chrome prints to stderr.
 *
 * @param {string} executable
 * @param {{ width: number, profileDir: string, spawnImpl?: typeof spawn }} options
 */
async function launchHeadlessChrome(executable, { width, profileDir, spawnImpl = spawn }) {
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
  const wsUrl = await new Promise((resolve, reject) => {
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
 * }} [options]
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
  const deadline = setTimeout(() => {
    connection?.failAll(new ScreenshotError(`Screenshot capture timed out after ${timeoutMs}ms`, "TIMEOUT"));
    if (child && !child.killed) child.kill("SIGKILL");
  }, timeoutMs);
  // The timer is only a guard; it must not keep the process alive once the capture returns.
  deadline.unref?.();

  try {
    const launched = await launchHeadlessChrome(executable, { width, profileDir });
    child = launched.child;
    connection = new CdpConnection(launched.wsUrl);
    await connection.opened;

    const { targetId } = await connection.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await connection.send("Target.attachToTarget", { targetId, flatten: true });

    await connection.send("Page.enable", {}, sessionId);
    await connection.send(
      "Emulation.setDeviceMetricsOverride",
      { width, height: INITIAL_VIEWPORT_HEIGHT, deviceScaleFactor: 1, mobile: false },
      sessionId,
    );
    const loaded = connection.waitForEvent("Page.loadEventFired", sessionId);
    await connection.send("Page.navigate", { url }, sessionId);
    await loaded;
    // `load` waits for images and stylesheets; fonts can still swap in afterwards, and Mermaid
    // style diagrams render asynchronously. Wait for fonts plus one settled animation frame so
    // the capture reflects what a reviewer would see.
    await connection.send(
      "Runtime.evaluate",
      {
        expression:
          "document.fonts.ready.then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))).then(() => true)",
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId,
    );

    const metrics = await connection.send("Page.getLayoutMetrics", {}, sessionId);
    const content = metrics.cssContentSize || metrics.contentSize;
    if (!content || !Number.isFinite(content.width) || !Number.isFinite(content.height)) {
      throw new ScreenshotError("Chrome did not report the rendered document size", "CDP_ERROR");
    }
    const captureWidth = Math.max(1, Math.ceil(Math.max(content.width, width)));
    const captureHeight = Math.max(1, Math.ceil(content.height));
    const shot = await connection.send(
      "Page.captureScreenshot",
      {
        format: "png",
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: captureWidth, height: captureHeight, scale: 1 },
      },
      sessionId,
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
