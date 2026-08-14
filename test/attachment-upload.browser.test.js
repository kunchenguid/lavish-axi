import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The regression boundary for the attachment upload token break: the SDK once
// sent lavish:uploadAttachment via a raw parent.postMessage with no
// artifact_load_token, and the chrome drops EVERY artifact message whose token
// is not the current load's. Every mocked harness stayed green (one even
// patched the token in silently) while real uploads were discarded. This suite
// runs the whole production path in a real browser - real SDK in the sandboxed
// artifact iframe, real chrome gate, real server - and requires an actual
// image to land in the attachment store and ride a prompt back to the agent.
const runBrowserE2e = process.env.LAVISH_AXI_BROWSER_E2E === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// A 2x1 PNG (the same bytes the server attachment tests use).
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR42mP8z8BQz0BkYGAAADAAA/8W1p0AAAAASUVORK5CYII=";
const PNG_BYTES = Buffer.from(PNG_B64, "base64");
const PNG_ID = `${createHash("sha256").update(PNG_BYTES).digest("hex")}.png`;

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

// The artifact's own driver script: a real artifact author can reach the SDK's
// open shadow root, and attaching an image by paste is exactly what the
// annotation card supports. Everything after the paste - the SDK's upload
// send, the chrome's token gate, the server store - is the unmodified
// production path under test. The driver reports progress through the
// artifact's <title> so a failure is diagnosable from a screenshot.
const ARTIFACT_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>e2e-attachment</title></head>
<body>
<p id="annotate-me">Attach a reference image to this paragraph.</p>
<script>
(function () {
  var PNG_B64 = "${PNG_B64}";
  function shadow() {
    var host = document.querySelector(".lavish-annotation-root");
    return host ? host.shadowRoot : null;
  }
  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }
  function mark(state) {
    document.title = "e2e-" + state;
  }
  async function drive() {
    try {
      var card = null;
      for (var i = 0; i < 100 && !card; i += 1) {
        await sleep(100);
        var root = shadow();
        card = root ? root.querySelector(".lavish-annotation-card") : null;
      }
      if (!card) throw new Error("annotation card never opened");
      mark("card-open");
      var bin = atob(PNG_B64);
      var bytes = new Uint8Array(bin.length);
      for (var j = 0; j < bin.length; j += 1) bytes[j] = bin.charCodeAt(j);
      var dt = new DataTransfer();
      dt.items.add(new File([bytes], "reference.png", { type: "image/png" }));
      var textarea = card.querySelector("textarea");
      textarea.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      mark("pasted");
      for (var k = 0; k < 150; k += 1) {
        await sleep(100);
        var chip = card.querySelector(".lavish-attachment-chip");
        var error = chip ? chip.querySelector(".lavish-attachment-status-error") : null;
        if (error) throw new Error("upload errored: " + error.textContent);
        // A ready chip renders no status line at all; "Uploading…" means the
        // chrome never answered (the token-gate drop this suite guards).
        if (chip && !chip.querySelector(".lavish-attachment-status")) {
          mark("ready");
          textarea.value = "e2e: attachment round trip";
          card.querySelector(".lavish-send").click();
          mark("queued");
          return;
        }
      }
      throw new Error("upload never reached ready");
    } catch (error) {
      mark("driver-error-" + error.message);
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
  "an annotation image upload round-trips through the chrome token gate in a real browser",
  { skip: !runBrowserE2e, timeout: 300_000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "lavish-attach-e2e-"));
    const port = await freePort();
    const stateDir = path.join(temp, "state");
    const lavishEnv = {
      LAVISH_AXI_PORT: String(port),
      LAVISH_AXI_STATE_DIR: stateDir,
      LAVISH_AXI_NO_OPEN: "1",
      LAVISH_AXI_TELEMETRY: "0",
      LAVISH_AXI_HOST: "127.0.0.1",
      LAVISH_AXI_LINK_HOST: "127.0.0.1",
    };
    const chromeEnv = {
      CHROME_DEVTOOLS_AXI_SESSION: `lavish-attach-e2e-${process.pid}`,
      CHROME_DEVTOOLS_AXI_USER_DATA_DIR: path.join(temp, "chrome"),
    };

    function evaluate(expression) {
      return run("chrome-devtools-axi", ["eval", expression], chromeEnv);
    }
    function wait(ms) {
      run("chrome-devtools-axi", ["wait", String(ms)], chromeEnv, ms + 45_000);
    }
    async function waitForAttachmentFile() {
      const dir = path.join(stateDir, "attachments");
      const deadline = Date.now() + 90_000;
      for (;;) {
        try {
          for (const keyDir of await readdir(dir)) {
            for (const name of await readdir(path.join(dir, keyDir))) {
              if (name.endsWith(".png")) return { key: keyDir, name };
            }
          }
        } catch {
          // The attachments dir does not exist until the first upload lands.
        }
        if (Date.now() > deadline) {
          const title = evaluate("document.title");
          assert.fail(`no attachment stored within 90s (chrome page title: ${title})`);
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    try {
      const artifact = path.join(temp, "attach.html");
      await writeFile(artifact, ARTIFACT_HTML);
      const output = run(process.execPath, ["bin/lavish-axi.js", artifact, "--no-open"], lavishEnv);
      const url = output.match(/url:\s*"([^"]+)"/)?.[1];
      assert.ok(url, output);
      const key = new URL(url).pathname.split("/").pop();

      run("chrome-devtools-axi", ["open", url], chromeEnv);
      wait(4500);

      // A REAL click through the chrome into the sandboxed artifact iframe opens
      // the annotation card - the driver only performs the paste a browser cannot
      // synthesize cross-frame.
      const snapshot = run("chrome-devtools-axi", ["snapshot"], chromeEnv);
      const target = snapshot.split("\n").find((line) => /Attach a reference image to this paragraph/.test(line));
      assert.ok(target, `annotatable paragraph missing from snapshot:\n${snapshot}`);
      const uid = target.trim().split(/\s+/)[0].replace(/^uid=/, "");
      run("chrome-devtools-axi", ["click", `@${uid}`], chromeEnv);

      // The upload must pass the chrome's artifact_load_token gate and land in
      // the content-addressed store - named exactly sha256(content) + .png.
      const stored = await waitForAttachmentFile();
      assert.equal(stored.key, key, "the attachment is stored under this session's key");
      assert.equal(stored.name, PNG_ID, "the stored file is content-addressed");
      assert.deepEqual(await readFile(path.join(stateDir, "attachments", key, PNG_ID)), PNG_BYTES);

      // The server serves the uploaded bytes back.
      const served = await fetch(`http://127.0.0.1:${port}/api/${key}/attachments/${PNG_ID}`);
      assert.equal(served.status, 200);
      assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG_BYTES);

      // The driver queued the prompt once the chip went ready; deliver it and
      // require the agent-facing poll to carry the server-vetted local path.
      const deadline = Date.now() + 60_000;
      for (;;) {
        const pills = evaluate('document.querySelectorAll(".pill").length');
        if (pills.includes("1")) break;
        if (Date.now() > deadline) assert.fail(`queued prompt pill never appeared: ${pills}`);
        wait(500);
      }
      evaluate('document.getElementById("send").click()');
      const poll = run(
        process.execPath,
        ["bin/lavish-axi.js", "poll", artifact, "--timeout-ms", "20000"],
        lavishEnv,
        65_000,
      );
      assert.match(poll, /status:\s*"?feedback/, poll);
      assert.match(poll, new RegExp(PNG_ID), `poll must deliver the attachment id:\n${poll}`);
      assert.match(poll, /attachments/, poll);
    } finally {
      run(process.execPath, ["bin/lavish-axi.js", "stop", "--port", String(port)], lavishEnv, 15_000);
      run("chrome-devtools-axi", ["stop"], chromeEnv);
      await rm(temp, { recursive: true, force: true });
    }
  },
);
