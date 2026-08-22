import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The phone-width conversation surface, measured in a real browser. Before this change the panel
// was a fixed-fraction strip under the artifact: at 390x844 the composer alone consumed it and
// left the chat log a 72px sliver, and on a short phone the chat log had no height at all while
// the Send row ran past the viewport. The sheet replaces that split, and these assertions are the
// geometry an end user would notice: nothing clipped, every control inside the viewport, the
// artifact never under the dock, and the desktop layout untouched.
const runBrowserE2e = process.env.LAVISH_AXI_BROWSER_E2E === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, env, timeout = 45_000) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return `${result.stdout || ""}${result.stderr || ""}`;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => resolve(undefined));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate a TCP port");
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  return address.port;
}

const ARTIFACT = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sheet fixture</title>
<style>body{margin:0;padding:24px;font-family:Georgia,serif;background:#fffbf3;color:#17130a}h1{margin:0 0 12px}section{border:1px solid #e8e1cf;border-radius:12px;padding:16px;margin:16px 0;background:#fff}</style>
</head><body>
<h1>Checkout redesign</h1>
<section><h2>Step 1</h2><p>Autofill the address from the browser profile.</p></section>
<section><h2>Step 2</h2><p>Card, Apple Pay, and Link.</p></section>
<section><h2>Step 3</h2><p>Review the order before paying.</p></section>
<section><h2>Open questions</h2><p>Do we keep guest checkout?</p></section>
</body></html>`;

// Enough replies to make the chat log taller than any phone's sheet can show at once.
const REPLIES = [
  "Here is the first draft of the checkout redesign plan. I collapsed the three steps into one page.",
  "I also added an open-questions card at the bottom. Let me know whether guest checkout stays in scope.",
  "Updated the review table with real line items so the totals read correctly.",
  "The payment step now uses hosted fields so PCI scope stays small.",
  "Address lookup falls back to manual entry when the postcode service is down.",
];

const GEOMETRY = `() => {
  const rect = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), height: Math.round(r.height) }; };
  const scroll = document.getElementById("panelScroll");
  const panel = document.getElementById("panel");
  return JSON.stringify({
    viewport: { width: innerWidth, height: innerHeight },
    open: document.body.classList.contains("sheet-open"),
    panelPosition: getComputedStyle(panel).position,
    panel: rect(panel),
    head: rect(document.getElementById("panelHead")),
    frame: rect(document.getElementById("artifact")),
    chat: { visible: scroll.clientHeight, content: scroll.scrollHeight, inert: scroll.inert },
    composer: {
      ...rect(document.getElementById("chatComposer")),
      visible: document.getElementById("chatComposer").clientHeight,
      content: document.getElementById("chatComposer").scrollHeight,
      scrollTop: document.getElementById("chatComposer").scrollTop,
    },
    attachments: {
      visible: document.getElementById("chatAttachments").clientHeight,
      content: document.getElementById("chatAttachments").scrollHeight,
    },
    actions: rect(document.getElementById("sendActions")),
    send: rect(document.getElementById("send")),
    sendAndEnd: rect(document.getElementById("sendAndEnd")),
    textarea: rect(document.getElementById("chatInput")),
    summary: document.getElementById("panelSummary").textContent,
    toggleLabel: document.getElementById("panelToggle").getAttribute("aria-label"),
    documentScrollable: document.documentElement.scrollHeight > innerHeight || document.documentElement.scrollWidth > innerWidth,
  });
}`;

test(
  "the conversation is a dock and bottom sheet on a phone, and unchanged on desktop",
  { skip: !runBrowserE2e, timeout: 300_000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "lavish-mobile-sheet-"));
    const port = await freePort();
    const lavishEnv = {
      LAVISH_AXI_PORT: String(port),
      LAVISH_AXI_STATE_DIR: path.join(temp, "state"),
      LAVISH_AXI_NO_OPEN: "1",
      LAVISH_AXI_TELEMETRY: "0",
      LAVISH_AXI_HOST: "127.0.0.1",
      LAVISH_AXI_LINK_HOST: "127.0.0.1",
    };
    const chromeEnv = {
      CHROME_DEVTOOLS_AXI_SESSION: `lavish-mobile-sheet-${process.pid}`,
      CHROME_DEVTOOLS_AXI_USER_DATA_DIR: path.join(temp, "chrome"),
    };

    function evaluate(expression) {
      const output = run("chrome-devtools-axi", ["eval", expression], chromeEnv);
      const raw = output.match(/result:\s*("(?:[^"\\]|\\.)*")/s)?.[1];
      assert.ok(raw, output);
      let value = JSON.parse(raw);
      while (typeof value === "string") {
        try {
          value = JSON.parse(value);
        } catch {
          break;
        }
      }
      return value;
    }

    function wait(ms) {
      run("chrome-devtools-axi", ["wait", String(ms)], chromeEnv, ms + 45_000);
    }

    function emulate(viewport) {
      run("chrome-devtools-axi", ["emulate", "--viewport", viewport], chromeEnv);
    }

    function open(url, settleMs = 4000) {
      run("chrome-devtools-axi", ["open", url], chromeEnv);
      wait(settleMs);
    }

    function geometry() {
      return evaluate(GEOMETRY);
    }

    // Everything the user can reach in the sheet sits inside the viewport, and the log scrolls
    // inside the sheet rather than being cut off by it.
    function assertSheetUsable(g) {
      assert.equal(g.open, true);
      assert.equal(g.panelPosition, "fixed");
      assert.ok(g.panel.top >= 56, `sheet clears the bar: ${JSON.stringify(g.panel)}`);
      assert.equal(g.panel.bottom, g.viewport.height, "sheet reaches the bottom edge");
      assert.equal(g.composer.bottom, g.viewport.height, "composer ends at the viewport edge");
      for (const [name, r] of [
        ["send", g.send],
        ["sendAndEnd", g.sendAndEnd],
        ["textarea", g.textarea],
      ]) {
        assert.ok(
          r.top >= g.panel.top && r.bottom <= g.viewport.height,
          `${name} is inside the viewport: ${JSON.stringify(r)}`,
        );
        assert.ok(r.left >= 0 && r.right <= g.viewport.width, `${name} is inside the viewport: ${JSON.stringify(r)}`);
      }
      assert.ok(g.chat.visible >= 120, `chat log keeps real height: ${JSON.stringify(g.chat)}`);
      assert.ok(g.chat.content > g.chat.visible, "fixture chat is taller than the viewport, so it must scroll");
      assert.equal(g.chat.inert, false);
      assert.equal(g.documentScrollable, false, "the page itself never scrolls");
    }

    function populateComposer() {
      evaluate(`() => {
        document.getElementById("presenceBanner").hidden = false;
        document.getElementById("chatAttachments").innerHTML = ${JSON.stringify(
          Array.from(
            { length: 4 },
            (_, index) =>
              `<div class="chat-attachment-chip"><span class="chat-attachment-thumb"></span><span class="chat-attachment-copy"><strong>Screenshot ${index + 1}</strong><span class="chat-attachment-status">Ready</span></span><button type="button">Remove</button></div>`,
          ).join(""),
        )};
        document.getElementById("chatComposer").scrollTop = 0;
        return "ok";
      }`);
      wait(300);
    }

    function assertPopulatedComposerUsable(g) {
      assert.equal(g.open, true);
      assert.equal(g.composer.scrollTop, 0, "send actions are visible before scrolling the composer");
      assert.ok(g.chat.visible >= 56, `chat retains usable height: ${JSON.stringify(g.chat)}`);
      assert.ok(g.composer.bottom <= g.viewport.height, `composer stays in viewport: ${JSON.stringify(g.composer)}`);
      for (const [name, rect] of [
        ["actions", g.actions],
        ["send", g.send],
        ["sendAndEnd", g.sendAndEnd],
      ]) {
        assert.ok(
          rect.top >= g.panel.top && rect.bottom <= g.viewport.height,
          `${name} stays visible: ${JSON.stringify(rect)}`,
        );
      }
      assert.ok(
        g.composer.content > g.composer.visible || g.attachments.content > g.attachments.visible,
        `populated composer contains its overflow: ${JSON.stringify({ composer: g.composer, attachments: g.attachments })}`,
      );
      assert.equal(g.documentScrollable, false);
    }

    function assertDocked(g) {
      assert.equal(g.open, false);
      assert.equal(g.panelPosition, "fixed");
      assert.equal(g.head.bottom, g.viewport.height, "dock sits on the bottom edge");
      assert.ok(g.head.height >= 56, `dock is a touch-sized target: ${JSON.stringify(g.head)}`);
      assert.ok(
        g.frame.bottom <= g.head.top,
        `artifact never runs under the dock: ${JSON.stringify({ frame: g.frame, head: g.head })}`,
      );
      assert.ok(
        g.frame.height >= g.viewport.height * 0.7,
        `artifact owns the screen while docked: ${JSON.stringify(g.frame)}`,
      );
      assert.equal(g.chat.inert, true, "the hidden part of the sheet is unreachable");
      assert.equal(g.toggleLabel, "Show conversation");
      assert.equal(g.documentScrollable, false, "the page itself never scrolls");
    }

    try {
      const artifact = path.join(temp, "review.html");
      await writeFile(artifact, ARTIFACT);
      const output = run(process.execPath, ["bin/lavish-axi.js", artifact, "--no-open"], lavishEnv);
      const url = output.match(/url:\s*"([^"]+)"/)?.[1];
      assert.ok(url, output);
      for (const reply of REPLIES) {
        run(
          process.execPath,
          ["bin/lavish-axi.js", "poll", artifact, "--agent-reply", reply, "--timeout-ms", "200"],
          lavishEnv,
          30_000,
        );
      }

      // ---- Portrait phone ----
      emulate("390x844x3,mobile,touch");
      open(url);
      let g = geometry();
      assertDocked(g);
      assert.equal(g.summary, "Agent not listening");

      evaluate('() => { document.getElementById("panelHead").click(); return "ok"; }');
      wait(500);
      assertSheetUsable(geometry());

      // The scrim lowers it again and the artifact is back to full height.
      evaluate('() => { document.getElementById("panelScrim").click(); return "ok"; }');
      wait(500);
      assertDocked(geometry());

      // ---- Short phone (small-height case) ----
      emulate("375x548x2,mobile,touch");
      open(url);
      g = geometry();
      assertDocked(g);
      evaluate('() => { document.getElementById("panelToggle").click(); return "ok"; }');
      wait(500);
      assertSheetUsable(geometry());

      // The open sheet survives a chrome reload on the same tab.
      open(url, 3000);
      assertSheetUsable(geometry());
      populateComposer();
      assertPopulatedComposerUsable(geometry());

      emulate("844x390x1,mobile,touch");
      open(url, 3000);
      populateComposer();
      g = geometry();
      assert.equal(g.panel.bottom, g.viewport.height);
      assertPopulatedComposerUsable(g);

      // ---- Desktop: a side panel, never a sheet ----
      emulate("1440x1000x1");
      open(url, 3000);
      g = geometry();
      assert.equal(g.open, false);
      assert.notEqual(g.panelPosition, "fixed");
      assert.equal(g.panel.top, 56);
      assert.equal(g.panel.bottom, g.viewport.height);
      assert.equal(g.panel.right - g.panel.left, 360, "desktop panel keeps its width");
      assert.equal(g.chat.inert, false);
      assert.equal(g.frame.right, g.panel.left, "artifact and panel sit side by side");
    } finally {
      run(process.execPath, ["bin/lavish-axi.js", "stop", "--port", String(port)], lavishEnv, 15_000);
      run("chrome-devtools-axi", ["stop"], chromeEnv);
      await rm(temp, { recursive: true, force: true });
    }
  },
);
