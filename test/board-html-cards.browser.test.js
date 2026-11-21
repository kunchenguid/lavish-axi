import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { chromePath, serveFixture } from "./fixtures/browser-fixture.js";

const WIDTH = 1440;
const HEIGHT = 900;

class Cdp {
  /** @param {WebSocket} socket */
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    /** @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void }>} */
    this.pending = new Map();
    /** @type {Set<string>} */
    this.childSessions = new Set();
    socket.addEventListener("message", (message) => {
      const data = JSON.parse(String(message.data));
      if (data.method === "Target.attachedToTarget") {
        const sessionId = data.params?.sessionId;
        if (sessionId && data.params?.targetInfo?.type === "iframe") {
          this.childSessions.add(sessionId);
        }
      } else if (data.method === "Target.detachedFromTarget") {
        if (data.params?.sessionId) this.childSessions.delete(data.params.sessionId);
      }
      const waiter = data.id ? this.pending.get(data.id) : null;
      if (!waiter) return;
      this.pending.delete(data.id);
      if (data.error) waiter.reject(new Error(`${data.error.message} ${data.error.data || ""}`.trim()));
      else waiter.resolve(data.result);
    });
  }

  /** @param {string} method @param {Record<string, unknown>} [params] @param {string} [sessionId] */
  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  /** @param {string} expression @param {string} [sessionId] */
  async eval(expression, sessionId) {
    const { result, exceptionDetails } = await this.send(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId,
    );
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(label, check, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function openBrowser(chrome, url, profile) {
  const child = spawn(
    chrome,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      `--window-size=${WIDTH},${HEIGHT}`,
      "about:blank",
    ],
    { detached: true, stdio: "ignore" },
  );
  const stop = () => {
    try {
      process.kill(-(child.pid || 0), "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  };
  try {
    const port = await until("DevTools port", async () => {
      try {
        return (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0];
      } catch {
        return "";
      }
    });
    const targets = await until("a page target", async () => {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      return list.find((target) => target.type === "page") ? list : null;
    });
    const socket = new WebSocket(targets.find((target) => target.type === "page").webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    const cdp = new Cdp(socket);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send("Page.navigate", { url });
    await until("the board's cards", () => cdp.eval("Boolean(window.probe?.ready())"));
    return {
      cdp,
      close() {
        socket.close();
        stop();
      },
    };
  } catch (error) {
    stop();
    throw error;
  }
}

async function inspectCardFrames(cdp, backdropRgb) {
  const reports = {};
  const expr = `(() => {
    const section = document.querySelector("[data-hilight-board] > section");
    if (!section) return null;
    const id = section.getAttribute("id") || "";
    const p = section.querySelector("p") || section;
    const toRgba = (color) => {
      const c = document.createElement("canvas");
      c.width = 1; c.height = 1;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "rgba(0,0,0,0)";
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      return [...ctx.getImageData(0, 0, 1, 1).data];
    };
    const comp = (fg, bg) => {
      const fa = fg[3] / 255, ba = bg[3] / 255, a = fa + ba * (1 - fa);
      if (!a) return [0, 0, 0, 0];
      return [
        (fg[0] * fa + bg[0] * ba * (1 - fa)) / a,
        (fg[1] * fa + bg[1] * ba * (1 - fa)) / a,
        (fg[2] * fa + bg[2] * ba * (1 - fa)) / a,
        Math.round(a * 255),
      ];
    };
    const lum = (c) => [0.2126, 0.7152, 0.0722].reduce((sum, w, i) => {
      const s = c[i] / 255;
      return sum + w * (s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4));
    }, 0);
    let bg = ${JSON.stringify([...backdropRgb, 255])};
    for (const el of [document.documentElement, document.body, document.querySelector("[data-hilight-board]"), section]) {
      if (!el) continue;
      bg = comp(toRgba(getComputedStyle(el).backgroundColor), bg);
    }
    const fg = comp(toRgba(getComputedStyle(p).color), bg);
    const l1 = lum(fg), l2 = lum(bg);
    const contrast = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    return {
      id,
      theme: document.documentElement.getAttribute("data-hilight-theme"),
      surface: document.documentElement.getAttribute("data-hilight-surface"),
      palette: document.documentElement.getAttribute("data-hilight-palette"),
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
      color: getComputedStyle(p).color,
      effectiveBg: bg.slice(0, 3).map(Math.round),
      contrast: Math.round(contrast * 100) / 100,
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
      overflowY: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    };
  })()`;
  for (const sessionId of [...cdp.childSessions]) {
    const info = await cdp.eval(expr, sessionId).catch(() => null);
    if (info?.id) reports[info.id] = info;
  }
  if (!Object.keys(reports).length) {
    const { frameTree } = await cdp.send("Page.getFrameTree");
    const frames = [];
    const collect = (node) => {
      for (const child of node?.childFrames || []) {
        frames.push(child.frame.id);
        collect(child);
      }
    };
    collect(frameTree);
    for (const frameId of frames) {
      const world = await cdp
        .send("Page.createIsolatedWorld", { frameId, worldName: "hilight-inspect" })
        .catch(() => null);
      if (!world?.executionContextId) continue;
      const { result } = await cdp
        .send("Runtime.evaluate", {
          expression: expr,
          contextId: world.executionContextId,
          returnByValue: true,
        })
        .catch(() => ({ result: null }));
      const info = result?.value;
      if (info?.id) reports[info.id] = info;
    }
  }
  return reports;
}

async function maybeScreenshot(cdp, name) {
  const dir = process.env.HILIGHT_CAPTURE_SCREENSHOTS;
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  await writeFile(path.join(dir, `${name}.png`), Buffer.from(data, "base64"));
}

test(
  "HTML board cards maintain readable contrast in dark and light modes and auto-size without scrollbars",
  { timeout: 180_000 },
  async (t) => {
    const chrome = await chromePath();
    if (!chrome) {
      t.skip("Chrome or Chromium is required for the HTML card browser regression");
      return;
    }
    const site = await serveFixture("board-html-cards");
    t.after(() => site.close());

    // 1. Plain HTML cards in dark mode: high contrast, auto-sized tall card with zero scrollbars,
    // row 2 reflowed cleanly below row 1, explicit data-h preserved, zero phantom marks, live theme switch.
    await t.test("dark mode plain HTML cards: crisp contrast, auto-size, reflow, and live theme switch", async () => {
      const browser = await openBrowser(
        chrome,
        `${site.url}?theme=dark&style=plain&stale=1`,
        path.join(site.root, "profile-dark-plain"),
      );
      try {
        const { cdp } = browser;
        await until("all four cards fitted and tall card auto-sized", async () => {
          await cdp.eval("window.probe.fit()");
          await sleep(100);
          const cards = await cdp.eval("window.probe.cards()");
          return cards.tall && cards.below && cards.tall.offsetHeight > 340 ? cards : null;
        });
        await sleep(250);
        await cdp.eval("window.probe.fit()");
        await sleep(250);

        const cards = await cdp.eval("window.probe.cards()");
        assert.ok(cards.tall.offsetHeight > 360, `tall card auto-sized (${cards.tall.offsetHeight}px)`);
        assert.equal(cards.fixed.offsetHeight, 220, "explicit data-h card keeps 220px height");
        assert.ok(
          cards.below.y >= cards.tall.y + cards.tall.h - 1,
          `row 2 card (${cards.below.y}) sits cleanly below grown tall card (${cards.tall.y + cards.tall.h})`,
        );

        const darkFrames = await inspectCardFrames(cdp, [27, 28, 30]);
        await maybeScreenshot(cdp, "dark-plain");
        assert.ok(darkFrames.plain && darkFrames.tall, `expected plain & tall frames, got ${Object.keys(darkFrames)}`);
        assert.ok(
          darkFrames.plain.contrast >= 7,
          `plain card dark contrast ${darkFrames.plain.contrast} (${JSON.stringify(darkFrames.plain)})`,
        );
        assert.ok(
          darkFrames.tall.contrast >= 7,
          `tall card dark contrast ${darkFrames.tall.contrast} (${JSON.stringify(darkFrames.tall)})`,
        );
        assert.ok(
          darkFrames.tall.overflowY <= 2,
          `tall card must fit without vertical scrollbar (overflowY=${darkFrames.tall.overflowY})`,
        );
        assert.ok(
          darkFrames.plain.overflowY <= 2,
          `plain card must fit without vertical scrollbar (overflowY=${darkFrames.plain.overflowY})`,
        );
        assert.ok(
          darkFrames.fixed.overflowY > 50,
          `explicit data-h card remains constrained (overflowY=${darkFrames.fixed.overflowY})`,
        );

        // Flush save and confirm summarizeBoardMarks reports zero phantom move/resize marks.
        await cdp.eval("window.probe.flush()");
        const marks = await until("flushed marks", () => cdp.eval("window.probe.marks()"));
        assert.deepEqual(marks.lines, [], `auto-sizing must not report marks: ${JSON.stringify(marks.lines)}`);

        // Live theme switch dark -> light keeps contrast high.
        await cdp.eval('window.probe.setTheme("light")');
        await sleep(250);
        await maybeScreenshot(cdp, "light-plain");
        const lightFrames = await inspectCardFrames(cdp, [255, 255, 255]);
        assert.ok(
          lightFrames.plain.contrast >= 7,
          `plain card light contrast after live switch: ${JSON.stringify(lightFrames.plain)}`,
        );
        assert.ok(
          lightFrames.tall.contrast >= 7,
          `tall card light contrast after live switch: ${JSON.stringify(lightFrames.tall)}`,
        );
      } finally {
        browser.close();
      }
    });

    // 2. Author light-mode CSS variants on a dark canvas never produce dark-on-dark text.
    for (const style of ["light-author", "dark-text-only", "light-bg-only"]) {
      await t.test(`dark canvas preserves readable contrast for ${style} author CSS`, async () => {
        const browser = await openBrowser(
          chrome,
          `${site.url}?theme=dark&style=${style}`,
          path.join(site.root, `profile-dark-${style}`),
        );
        try {
          const { cdp } = browser;
          await until("cards mounted", async () => {
            await cdp.eval("window.probe.fit()");
            await sleep(100);
            const cards = await cdp.eval("window.probe.cards()");
            return cards.plain && cards.tall && cards.tall.offsetHeight > 340 ? cards : null;
          });
          await sleep(200);
          const frames = await inspectCardFrames(cdp, [27, 28, 30]);
          await maybeScreenshot(cdp, `dark-${style}`);
          assert.ok(frames.plain && frames.tall, `frames inspected for ${style}`);
          assert.ok(
            frames.plain.contrast >= 7,
            `${style} plain card contrast ${frames.plain.contrast} (${JSON.stringify(frames.plain)})`,
          );
          assert.ok(
            frames.tall.contrast >= 7,
            `${style} tall card contrast ${frames.tall.contrast} (${JSON.stringify(frames.tall)})`,
          );
          assert.ok(
            frames.tall.overflowY <= 2,
            `${style} tall card fits without scrollbar (overflowY=${frames.tall.overflowY})`,
          );
        } finally {
          browser.close();
        }
      });
    }
  },
);
