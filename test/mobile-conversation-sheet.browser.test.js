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
// artifact never under the dock, and the desktop panel collapsing to a rail without losing the
// conversation behind it.
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
  const toggle = document.getElementById("panelToggle");
  const probe = document.body.appendChild(document.createElement("span"));
  probe.style.color = "var(--accent)";
  const accent = getComputedStyle(probe).color;
  probe.remove();
  return JSON.stringify({
    viewport: { width: innerWidth, height: innerHeight },
    open: document.body.classList.contains("sheet-open"),
    collapsed: document.body.classList.contains("panel-collapsed"),
    panelPosition: getComputedStyle(panel).position,
    panel: rect(panel),
    head: rect(document.getElementById("panelHead")),
    frame: rect(document.getElementById("artifact")),
    chat: { visible: scroll.clientHeight, content: scroll.scrollHeight, inert: scroll.inert, scrollTop: scroll.scrollTop },
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
    toggleLabel: toggle.getAttribute("aria-label"),
    toggleExpanded: toggle.getAttribute("aria-expanded"),
    toggleAccent: getComputedStyle(toggle).color === accent,
    activeElement: document.activeElement?.id || "",
    draft: document.getElementById("chatInput").value,
    documentScrollable: document.documentElement.scrollHeight > innerHeight || document.documentElement.scrollWidth > innerWidth,
  });
}`;

test(
  "the conversation is a dock and bottom sheet on a phone, and collapses to a rail on desktop",
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

    // chrome-devtools-axi 0.1.34 rejects a numeric `wait`, so the pause runs on the page instead.
    function wait(ms) {
      run(
        "chrome-devtools-axi",
        ["eval", `() => new Promise((resolve) => setTimeout(resolve, ${ms}))`],
        chromeEnv,
        ms + 45_000,
      );
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
      open(url);
      emulate("390x844x3,mobile,touch");
      wait(500);
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
      g = geometry();
      assertPopulatedComposerUsable(g);
      assert.ok(g.chat.visible >= 56, `normal visual viewport retains the chat minimum: ${JSON.stringify(g.chat)}`);

      evaluate(`() => {
        document.documentElement.style.setProperty("--vv-top", "0px");
        document.documentElement.style.setProperty("--vv-height", "240px");
        document.getElementById("chatComposer").scrollTop = 0;
        return "ok";
      }`);
      wait(300);
      g = geometry();
      assert.equal(g.composer.scrollTop, 0);
      assert.equal(g.panel.bottom, 240);
      assert.equal(g.composer.bottom, 240);
      assert.ok(g.chat.visible >= 0);
      for (const [name, rect] of [
        ["send", g.send],
        ["sendAndEnd", g.sendAndEnd],
      ]) {
        assert.ok(
          rect.top >= 0 && rect.bottom <= 240,
          `${name} stays inside the short visual viewport: ${JSON.stringify(rect)}`,
        );
      }
      evaluate(`() => {
        document.documentElement.style.removeProperty("--vv-top");
        document.documentElement.style.removeProperty("--vv-height");
        return "ok";
      }`);
      wait(300);

      emulate("844x390x1,mobile,touch");
      open(url, 3000);
      populateComposer();
      g = geometry();
      assert.equal(g.panel.bottom, g.viewport.height);
      assertPopulatedComposerUsable(g);

      // ---- Desktop: a side panel, never a sheet, that collapses to a rail ----
      // Two long replies make the desktop log scroll, so there is a reading position to keep.
      for (const reply of ["Desktop detail one. ", "Desktop detail two. "]) {
        run(
          process.execPath,
          [
            "bin/lavish-axi.js",
            "poll",
            artifact,
            "--agent-reply",
            reply + "Keep this in the conversation while the artifact stays visible. ".repeat(12),
            "--timeout-ms",
            "200",
          ],
          lavishEnv,
          30_000,
        );
      }
      emulate("1440x1000x1");
      open(url, 3000);
      g = geometry();
      assert.equal(g.open, false);
      assert.equal(g.collapsed, false);
      assert.notEqual(g.panelPosition, "fixed");
      assert.equal(g.panel.top, 56);
      assert.equal(g.panel.bottom, g.viewport.height);
      assert.equal(g.panel.right - g.panel.left, 360, "desktop panel keeps its width");
      assert.equal(g.chat.inert, false);
      assert.equal(g.toggleExpanded, "true");
      assert.equal(g.toggleLabel, "Hide conversation");
      assert.equal(g.frame.right, g.panel.left, "artifact and panel sit side by side");

      // Collapse from the keyboard with a reading position and an unsent draft behind the rail.
      const readingPosition = evaluate(`() => {
        const scroll = document.getElementById("panelScroll");
        scroll.scrollTop = 40;
        document.getElementById("chatInput").value = "Keep this draft";
        document.getElementById("panelToggle").focus();
        return scroll.scrollTop;
      }`);
      assert.equal(readingPosition, 40, "the desktop log is tall enough to hold a reading position");
      run("chrome-devtools-axi", ["press", "Space"], chromeEnv);
      wait(300);
      g = geometry();
      assert.equal(g.collapsed, true);
      assert.equal(g.panel.right - g.panel.left, 48, "the rail is only the toggle");
      assert.equal(g.frame.right, g.panel.left, "the artifact takes the reclaimed width");
      assert.equal(g.chat.inert, true);
      assert.equal(g.toggleExpanded, "false");
      assert.equal(g.toggleLabel, "Show conversation");
      assert.equal(g.activeElement, "panelToggle");
      assert.equal(g.toggleAccent, false);
      assert.equal(g.documentScrollable, false);

      // Nothing landed: expanding returns to the reading position with the draft intact.
      run("chrome-devtools-axi", ["press", "Space"], chromeEnv);
      wait(300);
      g = geometry();
      assert.equal(g.collapsed, false);
      assert.equal(g.panel.right - g.panel.left, 360);
      assert.equal(g.chat.inert, false);
      assert.equal(g.chat.scrollTop, 40, "collapsing does not lose the reading position");
      assert.equal(g.draft, "Keep this draft");

      // A reply lands behind the rail: the toggle says so, and expanding lands on the newest bubble.
      run("chrome-devtools-axi", ["press", "Space"], chromeEnv);
      wait(300);
      run(
        process.execPath,
        ["bin/lavish-axi.js", "poll", artifact, "--agent-reply", "Landed behind the rail.", "--timeout-ms", "200"],
        lavishEnv,
        30_000,
      );
      wait(500);
      g = geometry();
      assert.equal(g.collapsed, true);
      assert.equal(g.toggleAccent, true, "the rail signals what landed behind it");
      run("chrome-devtools-axi", ["press", "Space"], chromeEnv);
      wait(300);
      g = geometry();
      assert.equal(g.collapsed, false);
      assert.equal(g.toggleAccent, false);
      assert.ok(
        g.chat.scrollTop + g.chat.visible >= g.chat.content - 1,
        `expanding after a reply opens on the newest bubble: ${JSON.stringify(g.chat)}`,
      );

      // A notice the composer raises behind the rail carries the same signal until it is dismissed.
      run("chrome-devtools-axi", ["press", "Space"], chromeEnv);
      wait(300);
      evaluate('() => { document.getElementById("outdatedBanner").hidden = false; return "ok"; }');
      assert.equal(geometry().toggleAccent, true, "a notice behind the rail is signalled");
      evaluate('() => { document.getElementById("outdatedBanner").hidden = true; return "ok"; }');
      assert.equal(geometry().toggleAccent, false);

      // The rail is desktop state only: at phone width the same tab gets its dock.
      emulate("390x844x3,mobile,touch");
      wait(500);
      g = geometry();
      assert.equal(g.collapsed, false, "the rail never leaks into the phone sheet");
      assert.equal(g.panelPosition, "fixed");
      assert.equal(g.chat.inert, true);
      assert.equal(g.toggleLabel, "Show conversation");
    } finally {
      run(process.execPath, ["bin/lavish-axi.js", "stop", "--port", String(port)], lavishEnv, 15_000);
      run("chrome-devtools-axi", ["stop"], chromeEnv);
      await rm(temp, { recursive: true, force: true });
    }
  },
);
