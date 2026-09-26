import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The regression boundary for "selected text cannot be copied in annotate mode": the SDK once
// opened a text annotation card on mouseup, which moved focus into the card and cleared the
// document selection, so Cmd/Ctrl+C copied nothing while a fake highlight stayed on screen.
// This suite runs the real SDK in the sandboxed artifact iframe behind the real chrome and
// requires a drag-select to leave the selection intact while a plain click still annotates.
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

// The artifact's own driver script performs the gestures inside the sandboxed frame, where the
// SDK listens: a press at one end of the paragraph, a selection over a phrase, and a release
// further along is what a drag-select delivers. It reports its verdict through the artifact's
// <title>, which the chrome snapshot exposes on the iframe's RootWebArea.
const ARTIFACT_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>e2e-selection</title></head>
<body>
<p id="copy-me" style="font-size:24px;width:600px">The quick brown fox jumps over the lazy dog.</p>
<script>
(function () {
  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }
  function mark(state) {
    document.title = "e2e-" + state;
  }
  function card() {
    var host = document.querySelector(".lavish-annotation-root");
    return host && host.shadowRoot ? host.shadowRoot.querySelector(".lavish-annotation-card") : null;
  }
  function mouse(type, el, fraction) {
    var rect = el.getBoundingClientRect();
    el.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        button: 0,
        clientX: rect.left + rect.width * fraction,
        clientY: rect.top + rect.height / 2,
      }),
    );
  }
  async function drive() {
    try {
      for (var i = 0; i < 100 && !document.getElementById("lavish-cursor-style"); i += 1) await sleep(100);
      if (!document.getElementById("lavish-cursor-style")) throw new Error("annotate mode never started");
      var p = document.getElementById("copy-me");
      var text = p.firstChild;
      var start = text.data.indexOf("quick brown fox");

      mouse("mousedown", p, 0.05);
      var range = document.createRange();
      range.setStart(text, start);
      range.setEnd(text, start + "quick brown fox".length);
      var selection = document.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      mouse("mouseup", p, 0.5);
      mouse("click", p, 0.5);
      await sleep(300);

      if (card()) throw new Error("drag-select opened an annotation card");
      if (String(document.getSelection()) !== "quick brown fox") {
        throw new Error("selection lost: " + JSON.stringify(String(document.getSelection())));
      }
      var active = document.activeElement;
      if (active && active.closest && active.closest("[data-lavish-ui]")) throw new Error("focus moved into Lavish UI");

      // A click without a drag inside the existing selection still annotates the element.
      mouse("mousedown", p, 0.3);
      mouse("mouseup", p, 0.3);
      mouse("click", p, 0.3);
      await sleep(300);
      if (!card()) throw new Error("plain click did not open an annotation card");
      mark("pass");
    } catch (error) {
      mark("fail-" + error.message);
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", drive);
  else drive();
})();
</script>
</body>
</html>
`;

test(
  "a drag-select in annotate mode keeps the selection copyable and a plain click still annotates",
  { skip: !runBrowserE2e, timeout: 180_000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "lavish-selection-e2e-"));
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
      CHROME_DEVTOOLS_AXI_SESSION: `lavish-selection-e2e-${process.pid}`,
      CHROME_DEVTOOLS_AXI_USER_DATA_DIR: path.join(temp, "chrome"),
    };

    try {
      const artifact = path.join(temp, "selection.html");
      await writeFile(artifact, ARTIFACT_HTML);
      const output = run(process.execPath, ["bin/lavish-axi.js", artifact, "--no-open"], lavishEnv);
      const url = output.match(/url:\s*"([^"]+)"/)?.[1];
      assert.ok(url, output);

      run("chrome-devtools-axi", ["open", url], chromeEnv);
      const deadline = Date.now() + 60_000;
      let title = "";
      for (;;) {
        const snapshot = run("chrome-devtools-axi", ["snapshot"], chromeEnv);
        title =
          snapshot
            .split("\n")
            .find((line) => /RootWebArea/.test(line) && /\/artifact\//.test(line))
            ?.match(/"(e2e-[^"]*)"/)?.[1] || "";
        if (/^e2e-(pass|fail)/.test(title) || Date.now() > deadline) break;
        // Sleep in Node: `chrome-devtools-axi wait` is unreliable in some releases.
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      assert.equal(title, "e2e-pass");
    } finally {
      run(process.execPath, ["bin/lavish-axi.js", "stop", "--port", String(port)], lavishEnv, 15_000);
      run("chrome-devtools-axi", ["stop"], chromeEnv);
      await rm(temp, { recursive: true, force: true });
    }
  },
);
