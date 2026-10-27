import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

// A slide deck that pages on Space, ArrowRight, and PageDown from a document keydown listener.
const ARTIFACT_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>e2e-keyboard</title></head>
<body style="background:#fff;color:#111">
<p id="slide">Slide 1</p>
<p id="annotate-me">Annotate this paragraph.</p>
<script>
var slide = 1;
document.addEventListener("keydown", function (event) {
  if ([" ", "ArrowRight", "PageDown"].includes(event.key)) {
    event.preventDefault();
    slide += 1;
    document.getElementById("slide").textContent = "Slide " + slide;
  }
});
</script>
</body>
</html>
`;

test(
  "typing in the annotation card does not reach the artifact's own key handlers",
  { skip: !runBrowserE2e, timeout: 180_000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "lavish-keyboard-e2e-"));
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
      CHROME_DEVTOOLS_AXI_SESSION: `lavish-keyboard-e2e-${process.pid}`,
      CHROME_DEVTOOLS_AXI_USER_DATA_DIR: path.join(temp, "chrome"),
    };
    const browser = (...args) => run("chrome-devtools-axi", args, chromeEnv);
    function uidOf(snapshot, pattern) {
      const line = snapshot.split("\n").find((entry) => pattern.test(entry));
      assert.ok(line, `${pattern} missing from snapshot:\n${snapshot}`);
      return line.trim().split(/\s+/)[0].replace(/^uid=/, "");
    }

    try {
      const artifact = path.join(temp, "deck.html");
      await writeFile(artifact, ARTIFACT_HTML);
      const output = run(process.execPath, ["bin/lavish-axi.js", artifact, "--no-open"], lavishEnv);
      const url = output.match(/url:\s*"([^"]+)"/)?.[1];
      assert.ok(url, output);

      browser("open", url);
      browser("wait", "Annotate this paragraph.");
      browser("click", `@${uidOf(browser("snapshot"), /"Annotate this paragraph\."/)}`);
      browser("wait", "Enter to queue");

      const typed = browser("type", "fix this text");
      assert.match(typed, /textbox "Tell the agent[^"]*"[^\n]*value="fix this text"/, typed);
      assert.match(typed, /"Slide 1"/, typed);
      const paged = browser("press", "ArrowRight");
      assert.match(paged, /"Slide 1"/, paged);

      browser("click", `@${uidOf(browser("snapshot"), /button "Cancel"/)}`);
      const outside = browser("press", "ArrowRight");
      assert.match(outside, /"Slide 2"/, outside);
    } finally {
      run(process.execPath, ["bin/lavish-axi.js", "stop", "--port", String(port)], lavishEnv, 15_000);
      run("chrome-devtools-axi", ["stop"], chromeEnv);
      await rm(temp, { recursive: true, force: true });
    }
  },
);
