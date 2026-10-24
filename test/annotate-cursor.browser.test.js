import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The cursor a reviewer sees while annotating. The SDK installs one stylesheet for annotate mode
// and every rule in it is `!important`, so what matters is the computed style in a real browser -
// the artifact's own cursor rules must lose to Lavish's, and a link must end up on the pointer
// now that a plain click follows it.
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
  await new Promise((resolve) => server.close(() => resolve(address.port)));
  return address.port;
}

// The artifact's own CSS asks for cursors the SDK has to override, so a computed style that still
// reads "crosshair" means Lavish's stylesheet never reached the frame. The probe answers a
// request from the chrome page, because the artifact frame is sandboxed and cannot be read
// directly from the page that embeds it.
const ARTIFACT_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Cursor fixture</title>
<style>
a, p, span, textarea, button { cursor: crosshair; }
</style>
</head><body>
<p id="prose">Ordinary prose.</p>
<a id="link" href="https://example.com/spec">Read the spec</a>
<div id="widget" role="button"><a id="widget-link" href="https://example.com/other">A link inside a widget</a></div>
<textarea id="notes"></textarea>
<a id="editable-link" href="https://example.com/e"><span id="editable-in-link" contenteditable="true">Edit me</span></a>
<a href="https://example.com/c"><input id="check-in-link" type="checkbox"><input id="button-in-link" type="button" value="Go"></a>
<button id="go" type="button">Send</button>
<script>
(function () {
  function cursorOf(selector) {
    var el = document.querySelector(selector);
    return el ? getComputedStyle(el).cursor : "missing";
  }
  window.addEventListener("message", function (event) {
    var data = event.data || {};
    if (data.type !== "lavish-cursor-probe") return;
    parent.postMessage(
      {
        type: "lavish-cursor-probe-result",
        cursors: {
          prose: cursorOf("#prose"),
          link: cursorOf("#link"),
          linkInWidget: cursorOf("#widget-link"),
          notes: cursorOf("#notes"),
          editableInLink: cursorOf("#editable-in-link"),
          checkInLink: cursorOf("#check-in-link"),
          buttonInLink: cursorOf("#button-in-link"),
          button: cursorOf("#go"),
        },
        styleInstalled: Boolean(document.getElementById("lavish-cursor-style")),
      },
      "*",
    );
  });
})();
</script>
</body></html>`;

test(
  "annotate mode gives a link the pointer cursor and keeps the artifact's own cursors out",
  { skip: !runBrowserE2e, timeout: 300_000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "lavish-cursor-e2e-"));
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
      CHROME_DEVTOOLS_AXI_SESSION: `lavish-cursor-e2e-${process.pid}`,
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
      evaluate(`() => new Promise((resolve) => setTimeout(() => resolve("waited"), ${ms}))`);
    }

    try {
      const artifact = path.join(temp, "cursor.html");
      await writeFile(artifact, ARTIFACT_HTML);
      const output = run(process.execPath, ["bin/lavish-axi.js", artifact, "--no-open"], lavishEnv);
      const url = output.match(/url:\s*"([^"]+)"/)?.[1];
      assert.ok(url, output);

      run("chrome-devtools-axi", ["open", url], chromeEnv);
      wait(4000);

      // The artifact frame is still loading, so the probe is asked for again until it answers.
      evaluate(`() => {
        window.__lavishCursorProbe = null;
        window.addEventListener("message", (event) => {
          const data = event.data || {};
          if (data.type === "lavish-cursor-probe-result") window.__lavishCursorProbe = data;
        });
        window.__lavishCursorProbeTimer = setInterval(() => {
          const frame = document.getElementById("artifact");
          if (frame && frame.contentWindow) frame.contentWindow.postMessage({ type: "lavish-cursor-probe" }, "*");
        }, 250);
        return "ok";
      }`);

      let probe = null;
      for (let attempt = 0; attempt < 40 && !probe; attempt += 1) {
        wait(500);
        probe = evaluate("window.__lavishCursorProbe");
      }
      assert.ok(probe, "the artifact never answered the cursor probe");

      assert.equal(probe.styleInstalled, true, "annotate mode installed Lavish's cursor stylesheet");
      // A link now follows on a plain click, so it shows the pointer. A link inside an ARIA
      // widget follows too, so it keeps the pointer as well.
      assert.equal(probe.cursors.link, "pointer", probe.cursors.link);
      assert.equal(probe.cursors.linkInWidget, "pointer", probe.cursors.linkInWidget);
      // Everything else keeps the annotate-mode default, and the native controls keep theirs.
      assert.equal(probe.cursors.prose, "default", probe.cursors.prose);
      assert.equal(probe.cursors.notes, "text", probe.cursors.notes);
      assert.equal(probe.cursors.editableInLink, "text", probe.cursors.editableInLink);
      assert.equal(probe.cursors.checkInLink, "pointer", probe.cursors.checkInLink);
      assert.equal(probe.cursors.buttonInLink, "pointer", probe.cursors.buttonInLink);
      assert.equal(probe.cursors.button, "pointer", probe.cursors.button);
    } finally {
      run(process.execPath, ["bin/lavish-axi.js", "stop", "--port", String(port)], lavishEnv, 15_000);
      run("chrome-devtools-axi", ["stop"], chromeEnv);
      await rm(temp, { recursive: true, force: true });
    }
  },
);
