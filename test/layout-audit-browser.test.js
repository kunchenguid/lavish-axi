import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runBrowserE2e = process.env.LAVISH_AXI_BROWSER_E2E === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = path.join(repoRoot, "test/fixtures/layout-audit");

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

test(
  "real browser layout audit stays silent on acceptable pages and reports one severe root per broken case",
  { skip: !runBrowserE2e, timeout: 300_000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "lavish-layout-browser-"));
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
      CHROME_DEVTOOLS_AXI_SESSION: `lavish-layout-${process.pid}`,
      CHROME_DEVTOOLS_AXI_USER_DATA_DIR: path.join(temp, "chrome"),
    };

    function openArtifact(file) {
      const output = run(process.execPath, ["bin/lavish-axi.js", file, "--no-open"], lavishEnv);
      const url = output.match(/url:\s*"([^"]+)"/)?.[1];
      assert.ok(url, output);
      return { file, url };
    }

    function openFixture(name) {
      return openArtifact(path.join(fixtures, `${name}.html`));
    }

    function audit(name, viewport, settleMs, expectedCount) {
      const { file, url } = openFixture(name);
      run("chrome-devtools-axi", ["emulate", "--viewport", viewport], chromeEnv);
      run("chrome-devtools-axi", ["open", url], chromeEnv);
      run("chrome-devtools-axi", ["wait", String(settleMs)], chromeEnv, settleMs + 45_000);
      const gate = run(
        "chrome-devtools-axi",
        [
          "eval",
          '() => ({ gate: document.body.classList.contains("layout-gate-active"), bannerHidden: document.getElementById("layoutIssueBanner").hidden })',
        ],
        chromeEnv,
      );
      const pollTimeout = expectedCount === 0 ? "500" : "8000";
      let poll = run(process.execPath, ["bin/lavish-axi.js", "poll", file, "--timeout-ms", pollTimeout], lavishEnv);
      const expectedWarnings = new RegExp(`layout_warnings\\[${expectedCount}\\]`);
      if (expectedCount > 0 && !expectedWarnings.test(poll)) {
        run("chrome-devtools-axi", ["open", url], chromeEnv);
        run("chrome-devtools-axi", ["wait", String(settleMs)], chromeEnv, settleMs + 45_000);
        poll = run(process.execPath, ["bin/lavish-axi.js", "poll", file, "--timeout-ms", pollTimeout], lavishEnv);
      }

      if (expectedCount === 0) {
        assert.match(gate, /gate.*false/, name);
        assert.match(gate, /bannerHidden.*true/, name);
        assert.match(poll, /status:\s*waiting/, name);
        assert.doesNotMatch(poll, /layout_warnings\[/, name);
      } else {
        assert.match(gate, /gate.*true/, name);
        assert.match(poll, expectedWarnings, name);
      }
      return { gate, poll };
    }

    try {
      audit("control-broken-occlusion", "1440x1000x1", 3200, 1);

      const acceptable = [
        "real-plan-clean",
        "real-dashboard",
        "real-editorial",
        "real-carousel",
        "occlusion-exclusions-clean",
        "real-poster-overlap",
        "real-animated-entry",
      ];
      for (const name of acceptable) {
        const settleMs = name === "real-animated-entry" ? 5200 : 3200;
        audit(name, "1440x1000x1", settleMs, 0);
        audit(name, "390x844x1,mobile,touch", settleMs, 0);
      }

      audit("control-broken-overflow", "1440x1000x1", 3200, 0);
      audit("control-broken-overflow", "390x844x1,mobile,touch", 3200, 1);
      audit("control-broken-clipping", "1440x1000x1", 3200, 3);
      audit("control-broken-clipping", "390x844x1,mobile,touch", 3200, 3);
      audit("control-broken-reachability", "1440x1000x1", 3200, 3);
      audit("control-broken-reachability", "390x844x1,mobile,touch", 3200, 3);

      audit("calibration-small-overflow", "390x844x1,mobile,touch", 3200, 0);

      const timeoutResult = audit("real-heavy-clean", "1440x1000x1", 16_000, 0);
      assert.match(timeoutResult.gate, /bannerHidden.*true/);

      const revalidationFile = path.join(temp, "root-lock-revalidation.html");
      await copyFile(path.join(fixtures, "control-broken-reachability.html"), revalidationFile);
      const revalidation = openArtifact(revalidationFile);
      run("chrome-devtools-axi", ["emulate", "--viewport", "390x844x1,mobile,touch"], chromeEnv);
      run("chrome-devtools-axi", ["open", revalidation.url], chromeEnv);
      run("chrome-devtools-axi", ["wait", "3200"], chromeEnv);
      const held = run(
        "chrome-devtools-axi",
        ["eval", '() => document.body.classList.contains("layout-gate-active")'],
        chromeEnv,
      );
      assert.match(held, /true/);
      assert.match(
        run(process.execPath, ["bin/lavish-axi.js", "poll", revalidationFile, "--timeout-ms", "8000"], lavishEnv),
        /layout_warnings\[3\]/,
      );
      await writeFile(
        revalidationFile,
        '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Repaired controls</title></head><body><button>Continue</button></body></html>',
      );
      run("chrome-devtools-axi", ["wait", "3200"], chromeEnv);
      const repaired = run(
        "chrome-devtools-axi",
        [
          "eval",
          '() => ({ gate: document.body.classList.contains("layout-gate-active"), bannerHidden: document.getElementById("layoutIssueBanner").hidden })',
        ],
        chromeEnv,
      );
      assert.match(repaired, /gate.*false/);
      assert.match(repaired, /bannerHidden.*true/);
    } finally {
      run(process.execPath, ["bin/lavish-axi.js", "stop", "--port", String(port)], lavishEnv, 15_000);
      run("chrome-devtools-axi", ["stop"], chromeEnv);
      await rm(temp, { recursive: true, force: true });
    }
  },
);
