import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { serve } from "../src/server.js";
import { conversationBrowser, waitForBrowser } from "./support/conversation-browser.js";

const GEOMETRY = `() => {
  const rect = (id) => {
    const r = document.getElementById(id).getBoundingClientRect();
    return { left: r.left, right: r.right, width: r.width, top: r.top, bottom: r.bottom };
  };
  const panel = document.getElementById("panel");
  const toggle = document.getElementById("conversationToggle");
  return JSON.stringify({
    viewport: { width: innerWidth, height: innerHeight },
    frame: rect("artifact"), panel: rect("panel"), toggle: rect("conversationToggle"),
    displayed: getComputedStyle(panel).display !== "none",
    inert: panel.inert, pressed: toggle.getAttribute("aria-pressed"),
    controlVisible: toggle.getClientRects().length > 0,
    mobileOpen: document.body.classList.contains("sheet-open"),
    draft: document.getElementById("chatInput").value,
    status: document.getElementById("conversationStatus").textContent,
    overflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight,
  });
}`;

// Removing the hidden-panel grid rule must fail the full-width assertions. Reusing sheet-open
// for desktop intent must fail the breakpoint and reload assertions.
test(
  "the wide toolbar hides and restores Conversation, preserves intent, and gives the artifact the viewport width",
  { skip: process.env.LAVISH_AXI_BROWSER_E2E !== "1", timeout: 180_000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "lavish-wide-conversation-"));
    let browser;
    let server;
    try {
      browser = await conversationBrowser(temp, `lavish-wide-conversation-${process.pid}`);
      server = await serve({
        port: 0,
        host: "127.0.0.1",
        linkHost: "127.0.0.1",
        stateFile: path.join(temp, "state.json"),
      });
      const artifact = path.join(temp, "review.html");
      await writeFile(
        artifact,
        "<!doctype html><html><head><title>Wide panel fixture</title></head><body><h1>Review this board</h1></body></html>",
      );
      const base = `http://127.0.0.1:${server.port}`;
      const response = await fetch(base + "/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: artifact }),
      });
      assert.equal(response.status, 200);
      const session = await response.json();
      const url = session.url + "?no-gate=1";
      const open = async () => {
        await browser.open(url);
        await waitForBrowser(
          browser,
          '() => Boolean(window.__lavishChromeReady && document.getElementById("artifact").src.includes("artifact_load_token="))',
        );
      };
      const toggle = () =>
        browser.evaluate('() => { document.getElementById("conversationToggle").click(); return true; }');
      const geometry = () => browser.evaluate(GEOMETRY);
      const assertVisible = (g) => {
        assert.equal(g.displayed, true);
        assert.equal(g.inert, false);
        assert.equal(g.pressed, "true");
        assert.equal(g.panel.width, 360);
        assert.equal(g.frame.left, 0);
        assert.equal(g.frame.right, g.panel.left);
        assert.equal(g.panel.right, g.viewport.width);
        assert.equal(g.overflow, false);
      };
      const assertHidden = (g) => {
        assert.equal(g.displayed, false);
        assert.equal(g.inert, true);
        assert.equal(g.pressed, "false");
        assert.equal(g.frame.left, 0);
        assert.equal(g.frame.width, g.viewport.width, "artifact uses every CSS pixel of viewport width");
        assert.equal(g.controlVisible, true);
        assert.ok(g.toggle.left >= 0 && g.toggle.right <= g.viewport.width);
        assert.ok(g.toggle.top >= 0 && g.toggle.bottom <= 56);
        assert.equal(g.overflow, false);
      };

      // 960 CSS pixels also exercises reduced available width, as browser zoom can produce.
      // Device emulation does not verify the browser's native zoom controls.
      for (const viewport of ["1440x1000x1", "960x600x1", "861x600x1"]) {
        await browser.emulate(viewport);
        await open();
        assertVisible(await geometry());
        await browser.evaluate(
          '() => { document.getElementById("chatInput").value = "Keep this draft"; return true; }',
        );
        await toggle();
        let g = await geometry();
        assertHidden(g);
        assert.equal(g.draft, "Keep this draft");
        assert.match(g.status, /Agent not listening/);
        await toggle();
        g = await geometry();
        assertVisible(g);
        assert.equal(g.draft, "Keep this draft");
      }

      await toggle();
      await browser.evaluate(`() => new Promise((resolve) => {
        document.getElementById("artifact").addEventListener("load", () => resolve(true), { once: true });
        document.getElementById("reloadArtifact").click();
      })`);
      assertHidden(await geometry());
      await open();
      assertHidden(await geometry());
      await browser.emulate("390x844x3,mobile,touch");
      await waitForBrowser(
        browser,
        '() => getComputedStyle(document.getElementById("panel")).position === "fixed" && !document.getElementById("panel").inert',
      );
      let g = await geometry();
      assert.equal(g.controlVisible, false);
      assert.equal(g.mobileOpen, false);
      await browser.evaluate('() => { document.getElementById("panelToggle").click(); return true; }');
      assert.equal((await geometry()).mobileOpen, true);
      await browser.emulate("1440x1000x1");
      await waitForBrowser(browser, '() => document.getElementById("panel").inert');
      assertHidden(await geometry());
      await toggle();
      assertVisible(await geometry());
    } finally {
      try {
        await browser?.stop();
      } finally {
        try {
          await server?.close();
        } finally {
          await rm(temp, { recursive: true, force: true });
        }
      }
    }
  },
);
